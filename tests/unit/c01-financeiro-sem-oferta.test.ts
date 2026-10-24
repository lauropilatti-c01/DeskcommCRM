import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { lerSituacaoFinanceiraSemOferta } from "@/lib/leads/fonte-financeira-sem-oferta";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-24T18:00:00Z");
const PHONE = "+5511999990001";
const EMAIL = "pessoa@example.test";
function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const guru = {
    enabled: true,
    integrationId: "guru",
    organizationId: ORG,
    provider: "guru",
    sourceAccountId: "conta-guru",
    tokenSha256: "a".repeat(64),
    receiptSigningKey: "chave-sintetica-com-mais-de-trinta-e-dois",
    apiToken: "ficticio",
    baseUrl: "https://guru.example.test",
    historyCoverage: { startedAt: "2026-10-01T00:00:00Z", evidenceHash: "c".repeat(64) },
    products: [
      {
        productId: "produto-mapeado",
        offerId: "oferta-mapeada",
        crmProductKey: "curso",
        crmOfferKey: "anual",
        commercialFlowIds: [],
      },
    ],
  };
  const boleto = {
    ...guru,
    integrationId: "boleto",
    provider: "boleto",
    sourceAccountId: ORG,
    baseUrl: "https://boleto.example.test",
    tokenSha256: "b".repeat(64),
    historyCoverage: undefined,
  };
  const config = () =>
    vi.stubEnv("C01_FINANCIAL_INTEGRATIONS_JSON", JSON.stringify([guru, boleto]));
  config();
  const row = {
    custom_fields: {},
    created_at: "2026-10-20T12:00:00Z",
    status: "open",
    phone_number: PHONE as string | null,
    email: EMAIL as string | null,
    is_anonymized: false,
    is_merged_into: null,
  };
  let contacts = [{ id: CONTACT }],
    opportunities = [{ id: LEAD }];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    expect(params?.[0]).toBe(ORG);
    if (sql.includes("join contacts")) return { rows: [row] };
    if (sql.includes("from contacts")) return { rows: contacts };
    if (sql.includes("from crm_leads")) return { rows: opportunities };
    throw new Error("SQL inesperado");
  });
  const transactions: unknown[] = [],
    orders: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>(
    async (url) =>
      new Response(
        JSON.stringify(
          String(url).includes("boleto.example.test")
            ? orders
            : { data: transactions, has_more_pages: false },
        ),
      ),
  );
  vi.stubGlobal("fetch", fetcher);
  const remote = {
    id: "compra-antiga",
    status: "approved",
    product: { id: "outro-produto-sem-mapa", offer: { id: "outra-oferta" } },
    contact: { phone_number: PHONE, phone_local_code: "55", email: EMAIL },
    payment: { total: 5, currency: "BRL" },
    dates: {
      ordered_at: Date.parse("2026-10-02T12:00:00Z") / 1000,
      confirmed_at: Date.parse("2026-10-02T13:00:00Z") / 1000,
    },
  };
  const read = (override: Record<string, unknown> = {}) =>
    lerSituacaoFinanceiraSemOferta({
      db: { query } as unknown as Queryable,
      organizationId: ORG,
      contactId: CONTACT,
      leadId: LEAD,
      productKey: null,
      finalidade: "sem_oferta",
      now: NOW,
      signal: new AbortController().signal,
      ...override,
    });
  return {
    guru,
    boleto,
    config,
    row,
    query,
    transactions,
    orders,
    fetcher,
    remote,
    read,
    contacts: (v: typeof contacts) => {
      contacts = v;
    },
    opportunities: (v: typeof opportunities) => {
      opportunities = v;
    },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("negativa financeira antes da escolha do produto", () => {
  it("comprova as duas fontes inteiras sem exigir mapa do produto ainda não escolhido", async () => {
    const f = fixture();
    const result = await f.read();
    expect(result).toMatchObject({
      status: "nao_comprou_confirmado",
      complete: true,
      checkedAt: NOW.toISOString(),
    });
    expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      f.fetcher.mock.calls.some(([url]) => String(url).includes("ordered_at_ini=2026-10-01")),
    ).toBe(true);
    expect(
      f.fetcher.mock.calls.some(([url]) => String(url).includes("confirmed_at_ini=2026-10-01")),
    ).toBe(true);
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes("org_id=eq." + ORG))).toBe(
      true,
    );
    expect(f.query.mock.calls.every(([sql]) => /^select /i.test(sql))).toBe(true);
  });
  it("compra antiga de R$ 5 de qualquer produto bloqueia, mesmo antes da oportunidade", async () => {
    const f = fixture();
    f.transactions.push(f.remote);
    expect(await f.read()).toMatchObject({ status: "confirmado", complete: true });
  });
  it("gratuito comprovado não é compra e não enfraquece a confirmação de Ganho", async () => {
    const f = fixture();
    f.transactions.push({ ...f.remote, payment: { ...f.remote.payment, total: 0 } });
    expect(await f.read()).toMatchObject({ status: "nao_comprou_confirmado", complete: true });
    const { criarFonteFinanceira } = await import("@/lib/leads/fontes-financeiras");
    const source = criarFonteFinanceira({ ...f.guru, provider: "guru" });
    f.fetcher.mockResolvedValue(new Response(JSON.stringify({ data: f.transactions[0] })));
    await expect(
      source.readPayment("compra-antiga", new AbortController().signal),
    ).rejects.toThrow();
  });
  it("pedido pendente sem pagamento não é compra", async () => {
    const f = fixture();
    f.transactions.push({
      ...f.remote,
      status: "waiting_payment",
      dates: { ordered_at: f.remote.dates.ordered_at },
    });
    expect(await f.read()).toMatchObject({ status: "nao_comprou_confirmado", complete: true });
  });
  it.each(["refunded", "partially_refunded", "chargeback", "estado-desconhecido"])(
    "%s permanece revisão",
    async (status) => {
      const f = fixture();
      f.transactions.push({ ...f.remote, status });
      expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
    },
  );
  it("gratuito com histórico de reembolso não esconde a ambiguidade", async () => {
    const f = fixture();
    f.transactions.push({
      ...f.remote,
      status: "refunded",
      payment: { total: 0, currency: "BRL" },
    });
    expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
  });
  it.each(["missing", "future", "after_lead", "no_hash"])(
    "cobertura histórica %s bloqueia antes da rede",
    async (mode) => {
      const f = fixture();
      if (mode === "missing") Object.assign(f.guru, { historyCoverage: undefined });
      if (mode === "future") f.guru.historyCoverage.startedAt = "2027-01-01T00:00:00Z";
      if (mode === "after_lead") f.guru.historyCoverage.startedAt = "2026-10-21T00:00:00Z";
      if (mode === "no_hash") f.guru.historyCoverage.evidenceHash = "";
      f.config();
      expect(await f.read()).toMatchObject({ status: "indisponivel", complete: false });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(["phone", "email"])(
    "identidade sem %s usa o identificador disponível e a varredura integral",
    async (field) => {
      const f = fixture();
      if (field === "phone") f.row.phone_number = null;
      else f.row.email = null;
      expect(await f.read()).toMatchObject({
        status: "nao_comprou_confirmado",
        complete: true,
        reason: "sem_compra_na_identidade_e_periodo_conferidos",
      });
      expect(f.fetcher).toHaveBeenCalled();
    },
  );
  it("sem identificador não há consulta de pessoa", async () => {
    const f = fixture();
    f.row.phone_number = null;
    f.row.email = null;
    expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["phone", "email"])(
    "compra é reconhecida também só pelo %s disponível",
    async (field) => {
      const f = fixture();
      if (field === "phone") f.row.email = null;
      else f.row.phone_number = null;
      f.transactions.push(f.remote);
      expect(await f.read()).toMatchObject({ status: "confirmado", complete: true });
    },
  );
  it("mesmo telefone em e-mails diferentes nas origens mantém revisão mesmo sem e-mail no CRM", async () => {
    const f = fixture();
    f.row.email = null;
    f.transactions.push(f.remote, {
      ...f.remote,
      id: "outra-compra",
      contact: { ...f.remote.contact, email: "outra@example.test" },
    });
    expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
  });
  it("contraparte descoberta confere conflito mesmo se registro conflitante veio antes", async () => {
    const f = fixture();
    f.row.email = null;
    f.transactions.push(
      {
        ...f.remote,
        id: "conflitante-primeiro",
        contact: { ...f.remote.contact, phone_number: "+5511999990002" },
      },
      f.remote,
    );
    expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
  });
  it("não presume telefone único no sistema financeiro", async () => {
    const f = fixture();
    f.transactions.push({
      ...f.remote,
      contact: { ...f.remote.contact, email: "outra@example.test" },
    });
    expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
  });
  it("e-mail igual com telefone diferente é ambiguidade, mesmo num pedido pendente", async () => {
    const f = fixture();
    f.transactions.push({
      ...f.remote,
      status: "waiting_payment",
      dates: { ordered_at: f.remote.dates.ordered_at },
      contact: { ...f.remote.contact, phone_number: "+5511999990002" },
    });
    expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
  });
  it.each(["duplicate_contact", "multiple_leads", "closed", "anonymized", "merged"])(
    "não usa identidade/oportunidade %s",
    async (mode) => {
      const f = fixture();
      if (mode === "duplicate_contact") f.contacts([{ id: CONTACT }, { id: "outro" }]);
      if (mode === "multiple_leads") f.opportunities([{ id: LEAD }, { id: "outro" }]);
      if (mode === "closed") f.row.status = "won";
      if (mode === "anonymized") f.row.is_anonymized = true;
      if (mode === "merged") Object.assign(f.row, { is_merged_into: "outro" });
      expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(["off", "missing_boleto", "missing_guru", "other_org"])(
    "fontes %s não comprovam ausência",
    async (mode) => {
      const f = fixture();
      if (mode === "off") {
        f.guru.enabled = false;
        f.boleto.enabled = false;
      }
      if (mode === "missing_boleto") f.boleto.enabled = false;
      if (mode === "missing_guru") f.guru.enabled = false;
      if (mode === "other_org") f.boleto.organizationId = CONTACT;
      f.config();
      expect(await f.read()).toMatchObject({ status: "indisponivel", complete: false });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it("erro de uma fonte depois de compra encontrada não certifica consulta completa", async () => {
    const f = fixture();
    f.transactions.push(f.remote);
    f.fetcher.mockImplementation(async (url) =>
      String(url).includes("boleto")
        ? new Response("privado", { status: 503 })
        : new Response(JSON.stringify({ data: f.transactions, has_more_pages: false })),
    );
    expect(await f.read()).toMatchObject({ status: "indisponivel", complete: false });
  });
  it("cursor ausente ou repetido não vira negativa", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      new Response(JSON.stringify({ data: [], has_more_pages: true, next_cursor: null })),
    );
    expect(await f.read()).toMatchObject({ status: "indisponivel", complete: false });
  });
  it("abort antes da consulta não faz rede", async () => {
    const f = fixture();
    expect(await f.read({ signal: AbortSignal.abort() })).toMatchObject({
      status: "indisponivel",
      complete: false,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("relógio antigo não recebe carimbo fresco de negativa", async () => {
    const f = fixture();
    expect(await f.read({ now: new Date(NOW.getTime() - 61_000) })).toMatchObject({
      status: "indisponivel",
      complete: false,
    });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("hash da cobertura faz parte da evidência de cada consulta", async () => {
    const f = fixture();
    const first = await f.read();
    f.guru.historyCoverage.evidenceHash = createHash("sha256").update("outra ficha").digest("hex");
    f.config();
    expect((await f.read()).evidenceHash).not.toBe(first.evidenceHash);
  });
  it.each(["email", "phone", "opportunity", "duplicate"])(
    "reconfere %s alterado durante os GETs",
    async (mode) => {
      const f = fixture();
      const normal = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation(async (...args) => {
        if (mode === "email") f.row.email = "mudou@example.test";
        if (mode === "phone") f.row.phone_number = "+5511999990002";
        if (mode === "opportunity") f.opportunities([{ id: "outra" }]);
        if (mode === "duplicate") f.contacts([{ id: CONTACT }, { id: "outro" }]);
        return normal(...args);
      });
      expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
    },
  );
  it("pedido boleto com espelho pendente sem prova Asaas mantém revisão", async () => {
    const f = fixture();
    f.orders.push({
      id: "pedido",
      org_id: ORG,
      status: "pending",
      total_value: 200,
      created_at: "2026-10-22T12:00:00Z",
      payments: [],
      customers: { id: "pessoa", org_id: ORG, phone: PHONE, email: EMAIL, anonymized: false },
      products: { id: "produto-boleto", org_id: ORG },
    });
    expect(await f.read()).toMatchObject({
      status: "revisao",
      complete: false,
      reason: "comprovante_financeiro_incompleto",
    });
  });
  it("pedido ambíguo de outra pessoa não vira compra desta identidade", async () => {
    const f = fixture();
    f.transactions.push({
      ...f.remote,
      status: "refunded",
      contact: {
        phone_number: "+5511999990002",
        phone_local_code: "55",
        email: "outra@example.test",
      },
    });
    expect(await f.read()).toMatchObject({ status: "nao_comprou_confirmado", complete: true });
  });
  it("contraparte financeira descoberta que pertence a outro contato mantém revisão", async () => {
    const f = fixture();
    f.row.email = null;
    f.transactions.push(f.remote);
    const normal = f.query.getMockImplementation()!;
    f.query.mockImplementation(async (sql, params) =>
      sql.includes("from contacts") && params?.[2] === EMAIL
        ? { rows: [{ id: CONTACT }, { id: "outra-pessoa" }] }
        : normal(sql, params),
    );
    expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
  });
  it("recusa segundo e-mail da mesma identidade mesmo com gratuito e pendente", async () => {
    const f = fixture();
    f.row.email = null;
    f.transactions.push(
      { ...f.remote, payment: { total: 0, currency: "BRL" } },
      {
        ...f.remote,
        id: "pendente",
        status: "waiting_payment",
        dates: { ordered_at: f.remote.dates.ordered_at },
        contact: { ...f.remote.contact, email: "outra@example.test" },
      },
    );
    expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
  });
  it("produto escolhido no formulário não impede a negativa por pessoa antes da oferta", async () => {
    const f = fixture();
    f.row.custom_fields = { produto_chave: "curso-escolhido" };
    expect(await f.read()).toMatchObject({ status: "nao_comprou_confirmado", complete: true });
  });
  it("mudança do produto durante a leitura invalida a identidade da oportunidade", async () => {
    const f = fixture();
    f.row.custom_fields = { produto_chave: "curso-inicial" };
    const normal = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (...args) => {
      f.row.custom_fields = { produto_chave: "curso-alterado" };
      return normal(...args);
    });
    expect(await f.read()).toMatchObject({
      status: "revisao",
      complete: false,
      reason: "identidade_ou_oportunidade_alterada_durante_consulta",
    });
    expect(f.fetcher).toHaveBeenCalled();
  });
});
