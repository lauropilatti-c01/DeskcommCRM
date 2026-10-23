import { describe, expect, it, vi } from "vitest";
import { criarFonteFinanceira } from "@/lib/leads/fonte-financeira";
const now = new Date("2026-10-23T02:00:00Z");
const tx = {
  id: "tx-1",
  status: "approved",
  product: { id: "123", offer: { id: "oferta-1" } },
  payment: { total: 100, currency: "BRL" },
  dates: { ordered_at: 1792692000, confirmed_at: 1792695600 },
  contact: { phone_number: "11999990001", phone_local_code: "55", email: "pessoa@example.test" },
};
const cfg = {
  provider: "guru" as const,
  sourceAccountId: "conta-1",
  baseUrl: "https://digitalmanager.guru/api/v2",
  apiToken: "somente-teste",
};
describe("fontes financeiras autorizadas", () => {
  it("relê transação Guru por GET autenticado e usa id transacional do produto", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: tx })));
    const fonte = criarFonteFinanceira(cfg, { fetch: fetcher as typeof fetch, now: () => now });
    expect(await fonte.readPayment("tx-1", new AbortController().signal)).toMatchObject({
      transactionId: "tx-1",
      productId: "123",
      offerId: "oferta-1",
      paidCents: 10000,
      phone: "+5511999990001",
      status: "paid",
    });
    expect(fetcher.mock.calls[0]![0]).toBe("https://digitalmanager.guru/api/v2/transactions/tx-1");
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: "Bearer somente-teste" },
    });
  });
  it.each([
    { dates: { ordered_at: 1792692000 } },
    { status: "refunded" },
    { id: "outra" },
    { payment: { total: "100.001", currency: "BRL" } },
  ])("recusa evidência insuficiente ou divergente %j", async (patch) => {
    const fonte = criarFonteFinanceira(cfg, {
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ data: { ...tx, ...patch } })),
      ) as typeof fetch,
      now: () => now,
    });
    await expect(fonte.readPayment("tx-1", new AbortController().signal)).rejects.toThrow();
  });
  it("falha HTTP não vira ausência nem imprime conteúdo remoto", async () => {
    const fonte = criarFonteFinanceira(cfg, {
      fetch: vi.fn(async () => new Response("segredo remoto", { status: 503 })) as typeof fetch,
      now: () => now,
    });
    await expect(fonte.readPayment("tx-1", new AbortController().signal)).rejects.toThrow(
      "financial_source_unavailable",
    );
  });
});

const BORG = "11111111-1111-4111-8111-111111111111";
const boleto = {
  id: "22222222-2222-4222-8222-222222222222",
  org_id: BORG,
  status: "completed",
  total_value: 100,
  created_at: "2026-10-22T20:00:00Z",
  customers: {
    id: "c1",
    org_id: BORG,
    phone: "+5511999990001",
    email: "pessoa@example.test",
    anonymized: false,
  },
  products: { id: "p1", org_id: BORG },
  payments: [
    {
      id: "pag1",
      org_id: BORG,
      status: "paid",
      amount_paid: 100,
      paid_at: "2026-10-22T21:00:00Z",
      refunded_at: null,
      refund_amount: null,
      marked_paid_manually_at: null,
    },
  ],
};
describe("boleto autoritativo e cobertura das fontes", () => {
  const bcfg = {
    provider: "boleto" as const,
    sourceAccountId: BORG,
    baseUrl: "https://exemplo.supabase.co",
    apiToken: "teste",
  };
  it("pagamento integral com data e valor realmente registrados gera prova", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([boleto])));
    const f = criarFonteFinanceira(bcfg, { fetch: fetcher as typeof fetch, now: () => now });
    expect(await f.readPayment(boleto.id, new AbortController().signal)).toMatchObject({
      paidCents: 10000,
      productId: "p1",
      offerId: null,
      status: "paid",
    });
    expect(String(fetcher.mock.calls[0]![0])).toContain("org_id=eq." + BORG);
  });
  it.each(["partial", "no_date", "no_amount", "other_org", "manual", "refund"] as const)(
    "não inventa pagamento integral: %s",
    async (mode) => {
      const r = structuredClone(boleto);
      if (mode === "partial") r.payments[0]!.amount_paid = 10;
      if (mode === "no_date") Object.assign(r.payments[0]!, { paid_at: null });
      if (mode === "no_amount") Object.assign(r.payments[0]!, { amount_paid: null, amount: 100 });
      if (mode === "other_org") r.org_id = "outro";
      if (mode === "manual")
        Object.assign(r.payments[0]!, { marked_paid_manually_at: now.toISOString() });
      if (mode === "refund") Object.assign(r.payments[0]!, { refunded_at: now.toISOString() });
      const f = criarFonteFinanceira(bcfg, {
        fetch: vi.fn(async () => new Response(JSON.stringify([r]))) as typeof fetch,
        now: () => now,
      });
      await expect(f.readPayment(boleto.id, new AbortController().signal)).rejects.toThrow();
    },
  );
  it("cancelado depois de confirmação exige revisão, sem negativa de compra", async () => {
    const f = criarFonteFinanceira(cfg, {
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ data: { ...tx, status: "canceled" } })),
      ) as typeof fetch,
      now: () => now,
    });
    expect((await f.readRecord("tx-1", new AbortController().signal)).status).toBe("review");
  });
  it.each([
    { has_more_pages: true, next_cursor: null },
    { has_more_pages: "false", next_cursor: null },
  ])("paginação sem prova não vira ausência %j", async (paging) => {
    const f = criarFonteFinanceira(cfg, {
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ data: [], ...paging })),
      ) as typeof fetch,
      now: () => now,
    });
    await expect(f.scan(new Date("2026-10-22"), now, new AbortController().signal)).rejects.toThrow(
      "financial_source_incomplete",
    );
  });
});

it.each(["55999990001", "+5555999990001", "5555999990001"])(
  "Guru preserva DDD55 em %s",
  async (phone) => {
    const f = criarFonteFinanceira(cfg, {
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: { ...tx, contact: { ...tx.contact, phone_number: phone } } }),
          ),
      ) as typeof fetch,
      now: () => now,
    });
    expect((await f.readPayment("tx-1", new AbortController().signal)).phone).toBe(
      "+5555999990001",
    );
  },
);
it("boleto usa telefone nacional salvo pelo checkout", async () => {
  const f = criarFonteFinanceira(
    {
      provider: "boleto",
      sourceAccountId: BORG,
      baseUrl: "https://exemplo.supabase.co",
      apiToken: "teste",
    },
    {
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              { ...boleto, customers: { ...boleto.customers, phone: "55999990001" } },
            ]),
          ),
      ) as typeof fetch,
      now: () => now,
    },
  );
  expect((await f.readPayment(boleto.id, new AbortController().signal)).phone).toBe(
    "+5555999990001",
  );
});

it("paginação repetida e resposta interrompida não produzem ausência", async () => {
  const f = criarFonteFinanceira(cfg, {
    fetch: vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [], has_more_pages: true, next_cursor: "mesmo" })),
    ) as typeof fetch,
    now: () => now,
  });
  await expect(f.scan(new Date("2026-10-22"), now, new AbortController().signal)).rejects.toThrow(
    "financial_source_incomplete",
  );
});
it("GET temporariamente indisponível tem uma nova tentativa, sem repetir escrita", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("", { status: 503 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: tx })));
  const f = criarFonteFinanceira(cfg, { fetch: fetcher, now: () => now });
  expect(await f.readPayment("tx-1", new AbortController().signal)).toMatchObject({
    status: "paid",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("cancelamento limita a espera mesmo quando o transporte ignora signal", async () => {
  const f = criarFonteFinanceira(cfg, {
    fetch: vi.fn(async () => new Promise<Response>(() => {})) as typeof fetch,
    now: () => now,
  });
  await expect(f.readPayment("tx-1", AbortSignal.timeout(20))).rejects.toThrow(
    "financial_source_unavailable",
  );
});
it("vários itens e gratuidade não viram pagamento integral de um único produto", async () => {
  for (const patch of [{ items: [{}, {}] }, { payment: { total: 0, currency: "BRL" } }]) {
    const f = criarFonteFinanceira(cfg, {
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ data: { ...tx, ...patch } })),
      ) as typeof fetch,
      now: () => now,
    });
    expect((await f.readRecord("tx-1", new AbortController().signal)).status).toBe("review");
  }
});

it("parcela paga sem recibo fica em revisão sem derrubar outras identidades", async () => {
  const row = { ...boleto, payments: [{ ...boleto.payments[0], amount_paid: null }] };
  const f = criarFonteFinanceira(
    {
      provider: "boleto",
      sourceAccountId: BORG,
      baseUrl: "https://exemplo.supabase.co",
      apiToken: "teste",
    },
    {
      fetch: vi.fn(async () => new Response(JSON.stringify([row]))) as typeof fetch,
      now: () => now,
    },
  );
  const records = await f.scan(new Date("2026-10-22"), now, new AbortController().signal);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    status: "review",
    reviewReason: "comprovante_financeiro_incompleto",
    productId: "p1",
    phone: "+5511999990001",
  });
  expect(records[0]!.proof).toBeUndefined();
  await expect(f.readPayment(row.id, new AbortController().signal)).rejects.toThrow(
    "financial_payment_not_confirmed",
  );
});
