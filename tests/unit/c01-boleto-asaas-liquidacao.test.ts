import { afterEach, describe, expect, it, vi } from "vitest";
import { criarFonteFinanceira, type FonteConfig } from "@/lib/leads/fontes-financeiras";
import { configuracoesFinanceiras } from "@/lib/leads/configuracao-financeira";
import { intervaloDoPagamento } from "@/lib/leads/periodo-financeiro";
afterEach(() => {
  vi.unstubAllEnvs();
});

const org = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const walletId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-10-23T20:00:00Z");
const cfg: FonteConfig = {
  provider: "boleto",
  sourceAccountId: org,
  baseUrl: "https://example.supabase.co",
  apiToken: "local-ficticio",
  asaasSettlement: {
    enabled: true,
    environment: "production",
    walletId,
    apiToken: "asaas-ficticio",
  },
};
function fixture() {
  return {
    id: orderId,
    org_id: org,
    status: "completed",
    total_value: 100,
    created_at: "2026-10-19T12:00:00Z",
    customers: {
      id: "cliente",
      org_id: org,
      phone: "11999990001",
      email: "pessoa@example.test",
      anonymized: false,
      external_customer_id_asaas: "cus_ficticio",
    },
    products: { id: "produto", org_id: org },
    payments: [
      {
        id: "local1",
        org_id: org,
        order_id: orderId,
        asaas_payment_id: "pay_ficticio",
        status: "paid",
        amount: 100,
        amount_paid: 96.5,
        paid_at: "2026-10-21T18:00:00Z",
        refunded_at: null,
        refund_amount: null,
        refund_lifecycle: null,
        marked_paid_manually_at: null,
      },
    ],
  };
}
function provider() {
  return {
    id: "pay_ficticio",
    customer: "cus_ficticio",
    externalReference: orderId,
    billingType: "BOLETO",
    status: "RECEIVED",
    value: 100,
    netValue: 96.5,
    originalValue: null,
    interestValue: null,
    paymentDate: "2026-10-21",
    clientPaymentDate: "2026-10-21",
    deleted: false,
    refunds: [],
  };
}
function harness(order = fixture(), payment = provider(), config = cfg, wallet = walletId) {
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const u = new URL(String(url));
    if (u.hostname === "example.supabase.co") return Response.json([order]);
    if (u.pathname === "/v3/wallets/")
      return Response.json({ hasMore: false, totalCount: 1, data: [{ id: wallet }] });
    if (u.pathname === "/v3/payments/pay_ficticio") return Response.json(payment);
    throw new Error("URL inesperada");
  });
  return { fetcher, source: criarFonteFinanceira(config, { fetch: fetcher, now: () => now }) };
}
const signal = () => new AbortController().signal;

describe("boleto: confirmação atual de quitação integral no Asaas", () => {
  it("usa bruto recebido, preserva data sem hora e autentica conta e cobrança com GET", async () => {
    const { source, fetcher } = harness();
    expect(await source.readPayment(orderId, signal())).toMatchObject({
      paidCents: 10000,
      totalCents: 10000,
      paidAt: "2026-10-21",
      paidAtPrecision: "day",
      status: "paid",
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toContain(
      "https://api.asaas.com/v3/payments/pay_ficticio",
    );
    for (const [url, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
      if (String(url).includes("api.asaas.com")) {
        expect(init?.headers).toMatchObject({ access_token: "asaas-ficticio" });
        expect(JSON.stringify(init?.headers)).not.toContain("local-ficticio");
      } else expect(JSON.stringify(init?.headers)).not.toContain("asaas-ficticio");
    }
  });
  it("repete a leitura atual sem reaproveitar prova paga nem duplicar o bruto", async () => {
    const { source, fetcher } = harness();
    const first = await source.readPayment(orderId, signal());
    const second = await source.readPayment(orderId, signal());
    expect(second).toEqual(first);
    expect(fetcher.mock.calls.filter(([u]) => String(u).includes("/payments/"))).toHaveLength(2);
  });
  it.each([
    "PENDING",
    "CONFIRMED",
    "REFUNDED",
    "REFUND_REQUESTED",
    "REFUND_IN_PROGRESS",
    "CHARGEBACK_REQUESTED",
    "RECEIVED_IN_CASH",
  ])("estado local pago e provedor %s fica em revisão", async (status) => {
    const p = provider();
    p.status = status;
    const { source } = harness(fixture(), p);
    expect((await source.readRecord(orderId, signal())).status).toBe("review");
  });
  it.each([
    "parcial",
    "manual",
    "estorno-local",
    "estorno-provedor",
    "cliente",
    "pedido",
    "id",
    "valor",
    "valor-malformado",
    "juros",
    "desconto",
    "data-ausente",
    "data-inválida",
    "mesmo-dia",
    "data-futura",
    "repetido",
    "sem-id",
    "tipo-manual",
  ])("não confirma: %s", async (mode) => {
    const order = fixture(),
      p = provider();
    if (mode === "parcial") {
      order.total_value = 200;
      order.status = "entry_paid";
    }
    if (mode === "manual")
      Object.assign(order.payments[0]!, { marked_paid_manually_at: "2026-10-21T18:00:00Z" });
    if (mode === "estorno-local")
      Object.assign(order.payments[0]!, { refund_lifecycle: "requested" });
    if (mode === "estorno-provedor")
      Object.assign(p, { refunds: [{ value: 1, status: "PENDING" }] });
    if (mode === "cliente") p.customer = "cus_outro";
    if (mode === "pedido") p.externalReference = "outro-pedido";
    if (mode === "id") p.id = "pay_outro";
    if (mode === "valor") p.value = 101;
    if (mode === "valor-malformado") Object.assign(p, { value: [100] });
    if (mode === "juros") Object.assign(p, { originalValue: 99, interestValue: 1 });
    if (mode === "desconto") Object.assign(p, { discount: { value: 5, type: "FIXED" } });
    if (mode === "data-ausente") Object.assign(p, { paymentDate: null });
    if (mode === "data-inválida") p.paymentDate = "2026-02-30";
    if (mode === "mesmo-dia") order.created_at = "2026-10-21T17:00:00Z";
    if (mode === "data-futura") p.paymentDate = "2026-10-24";
    if (mode === "repetido") order.payments.push({ ...order.payments[0]!, id: "local2" });
    if (mode === "sem-id") order.payments[0]!.asaas_payment_id = "";
    if (mode === "tipo-manual") p.billingType = "RECEIVED_IN_CASH";
    const { source } = harness(order, p);
    expect((await source.readRecord(orderId, signal())).status).toBe("review");
    await expect(source.readPayment(orderId, signal())).rejects.toThrow();
  });
  it("falha na conta não vira ausência de compra", async () => {
    const { source } = harness(fixture(), provider(), cfg, "outra-conta");
    await expect(source.readRecord(orderId, signal())).rejects.toThrow(
      "financial_source_account_mismatch",
    );
  });
  it("seleciona sandbox explicitamente, sem permitir host fornecido pelo pedido", async () => {
    const { source, fetcher } = harness(fixture(), provider(), {
      ...cfg,
      asaasSettlement: { ...cfg.asaasSettlement!, environment: "sandbox" },
    });
    await source.readPayment(orderId, signal());
    expect(
      fetcher.mock.calls
        .filter(([url]) => String(url).includes("/v3/"))
        .every(([url]) => new URL(String(url)).hostname === "api-sandbox.asaas.com"),
    ).toBe(true);
  });
  it("configuração ausente ou desligada não acessa Asaas nem muda a leitura anterior", async () => {
    for (const asaasSettlement of [undefined, { ...cfg.asaasSettlement!, enabled: false }]) {
      const order = fixture();
      order.payments[0]!.amount_paid = 100;
      const { source, fetcher } = harness(order, provider(), { ...cfg, asaasSettlement });
      expect((await source.readPayment(orderId, signal())).paidAt).toBe("2026-10-21T18:00:00.000Z");
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it("scan não transforma entrada paga em não comprador", async () => {
    const order = fixture();
    order.total_value = 200;
    order.status = "entry_paid";
    const { source } = harness(order);
    expect((await source.scan(new Date("2026-10-01"), now, signal()))[0]!.status).toBe("review");
  });
  it("confirma todas as parcelas e ignora o líquido e a data locais atrasados", async () => {
    const order = fixture();
    order.total_value = 200;
    order.payments.push({ ...order.payments[0]!, id: "local2", asaas_payment_id: "pay_segundo" });
    Object.assign(order.payments[0]!, { status: "pending", amount_paid: null, paid_at: null });
    const { fetcher } = harness(order);
    const fetchFull = vi.fn<typeof fetch>(async (url, init) =>
      String(url).endsWith("/pay_segundo")
        ? Response.json({ ...provider(), id: "pay_segundo", paymentDate: "2026-10-22" })
        : fetcher(url, init),
    );
    const source = criarFonteFinanceira(cfg, { fetch: fetchFull, now: () => now });
    expect(await source.readPayment(orderId, signal())).toMatchObject({
      paidCents: 20000,
      paidAt: "2026-10-22",
      paidAtPrecision: "day",
    });
    expect(fetchFull.mock.calls.filter(([url]) => String(url).includes("/payments/"))).toHaveLength(
      2,
    );
  });
  it.each(["http", "json", "redirect", "aborto"])(
    "transporte %s não vira ausência ou prova local",
    async (mode) => {
      const { fetcher } = harness();
      const fetchBroken = vi.fn<typeof fetch>(async (url, init) => {
        if (!String(url).includes("/payments/")) return fetcher(url, init);
        if (mode === "http") return new Response("segredo remoto", { status: 503 });
        if (mode === "json") return new Response("segredo remoto");
        if (mode === "redirect")
          return new Response(null, {
            status: 302,
            headers: { Location: "https://example.invalid/" },
          });
        return new Promise<Response>(() => {});
      });
      const source = criarFonteFinanceira(cfg, { fetch: fetchBroken, now: () => now });
      await expect(source.readPayment(orderId, AbortSignal.timeout(40))).rejects.toThrow(
        "financial_source_unavailable",
      );
    },
  );
  it("configuração privada ausente permanece OFF e recusa expansão de host ou uso no Guru", () => {
    vi.stubEnv("C01_FINANCIAL_INTEGRATIONS_JSON", "");
    expect(configuracoesFinanceiras()).toEqual([]);
    const valid = {
      ...cfg,
      enabled: false,
      integrationId: "boleto-ficticio",
      organizationId: org,
      tokenSha256: "a".repeat(64),
      receiptSigningKey: "ficticio".repeat(5),
      products: [
        {
          productId: "p",
          offerId: null,
          crmProductKey: "p",
          crmOfferKey: "o",
          commercialFlowIds: [],
        },
      ],
    };
    vi.stubEnv("C01_FINANCIAL_INTEGRATIONS_JSON", JSON.stringify([valid]));
    expect(configuracoesFinanceiras()[0]!.enabled).toBe(false);
    for (const invalid of [
      { ...valid, provider: "guru" },
      {
        ...valid,
        asaasSettlement: { ...valid.asaasSettlement, baseUrl: "https://example.invalid" },
      },
      { ...valid, asaasSettlement: { ...valid.asaasSettlement, environment: "outro" } },
    ]) {
      vi.stubEnv("C01_FINANCIAL_INTEGRATIONS_JSON", JSON.stringify([invalid]));
      expect(() => configuracoesFinanceiras()).toThrow();
    }
  });
  it("precisão é explícita: data sem marcador não vira um instante", () => {
    expect(intervaloDoPagamento("2026-10-21")).toBeNull();
    expect(intervaloDoPagamento("2026-02-30", "day")).toBeNull();
    expect(intervaloDoPagamento("2026-10-21T18:00:00Z")).toEqual({
      earliest: Date.parse("2026-10-21T18:00:00Z"),
      latest: Date.parse("2026-10-21T18:00:00Z"),
    });
  });
  it("guarda consulta cobranças só da identidade em análise, mantendo as demais para revisão", async () => {
    const order = fixture(),
      other = fixture();
    other.id = "outro-pedido";
    other.customers.phone = "21999990002";
    other.customers.email = "outra@example.test";
    other.payments[0]!.asaas_payment_id = "pay_nao_consultar";
    const { fetcher } = harness();
    const scopedFetch = vi.fn<typeof fetch>(async (url, init) =>
      String(url).includes("example.supabase.co")
        ? Response.json([order, other])
        : fetcher(url, init),
    );
    const source = criarFonteFinanceira(cfg, { fetch: scopedFetch, now: () => now });
    const rows = await source.scan(new Date("2026-10-01"), now, signal(), {
      phone: "+5511999990001",
      email: "pessoa@example.test",
    });
    expect(rows.map((r) => r.status)).toEqual(["paid", "review"]);
    expect(
      scopedFetch.mock.calls.filter(([url]) => String(url).includes("/payments/")),
    ).toHaveLength(1);
    expect(rows[1]!.proof).toBeUndefined();
  });
});
