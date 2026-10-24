import { describe, expect, it, vi } from "vitest";
import { criarFonteFinanceira, type FonteConfig } from "@/lib/leads/fontes-financeiras";
import {
  contratoFicticio,
  clicksignFicticio,
  documentoFicticio,
} from "../helpers/boleto-contrato-ficticio";

const org = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const cfg: FonteConfig = {
  provider: "boleto",
  sourceAccountId: org,
  baseUrl: "https://example.supabase.co",
  apiToken: "ficticio",
  asaasSettlement: {
    enabled: true,
    environment: "production",
    walletId: "33333333-3333-4333-8333-333333333333",
    apiToken: "ficticio",
    clicksign: clicksignFicticio,
  },
};
const now = new Date("2026-10-23T20:00:00Z");
function fixture() {
  const order = contratoFicticio({
    id,
    org_id: org,
    status: "completed",
    total_value: 120,
    created_at: "2026-10-19T12:00:00Z",
    customers: {
      id: "cliente",
      org_id: org,
      phone: "11999990001",
      email: "teste@example.test",
      external_customer_id_asaas: "cus_ficticio",
    },
    products: { id: "produto", org_id: org },
  });
  const payments = [
    {
      id: "entrada",
      org_id: org,
      order_id: id,
      asaas_payment_id: "pay_entrada",
      type: "entry_pix",
      installment_number: null,
      amount: 20,
      status: "paid",
      due_date: "2026-10-19",
    },
    {
      id: "parcela",
      org_id: org,
      order_id: id,
      asaas_payment_id: "pay_parcela",
      type: "installment_boleto",
      installment_number: 1,
      amount: 110,
      status: "paid",
      due_date: "2026-11-21",
    },
  ];
  return { ...order, payments };
}
function harness(
  order = fixture(),
  mutate: (p: Record<string, unknown>) => void = () => {},
  mutateDocument: (d: ReturnType<typeof documentoFicticio>["document"]) => void = () => {},
  config = cfg,
) {
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const u = new URL(String(url));
    if (u.hostname === "example.supabase.co") return Response.json([order]);
    if (u.hostname.endsWith("clicksign.com")) {
      const doc = documentoFicticio(order);
      mutateDocument(doc.document);
      return Response.json(doc);
    }
    if (u.pathname === "/v3/wallets/")
      return Response.json({
        hasMore: false,
        totalCount: 1,
        data: [{ id: cfg.asaasSettlement!.walletId }],
      });
    const local = order.payments.find((p) => u.pathname === `/v3/payments/${p.asaas_payment_id}`);
    if (!local) throw new Error("GET inesperado");
    const payment = {
      id: local.asaas_payment_id,
      customer: "cus_ficticio",
      externalReference: id,
      billingType: local.type === "entry_pix" ? "PIX" : "BOLETO",
      status: "RECEIVED",
      value: local.amount,
      netValue: local.amount - 1,
      paymentDate: "2026-10-21",
      dueDate: local.due_date,
    };
    mutate(payment);
    return Response.json(payment);
  });
  return { fetcher, source: criarFonteFinanceira(config, { fetch: fetcher, now: () => now }) };
}
const signal = () => new AbortController().signal;

describe("boleto: total financiado vinculado ao contrato aceito", () => {
  it("aceita identificador UUID do PostgreSQL sem impor versão RFC à organização", async () => {
    const o = fixture(),
      sourceOrg = "00000000-0000-0000-0000-000000000009";
    o.org_id = sourceOrg;
    o.customers.org_id = sourceOrg;
    o.products.org_id = sourceOrg;
    o.contracts[0]!.org_id = sourceOrg;
    for (const p of o.payments) p.org_id = sourceOrg;
    const { source } = harness(o, undefined, undefined, { ...cfg, sourceAccountId: sourceOrg });
    expect((await source.readRecord(id, signal())).status).toBe("paid");
  });
  it("não autentica assinatura só porque o espelho local diz signed", async () => {
    const { source } = harness(fixture(), undefined, undefined, {
      ...cfg,
      asaasSettlement: { ...cfg.asaasSettlement!, clicksign: undefined },
    });
    // Nenhuma configuração/GET do documento existe nesta configuração legada.
    expect((await source.readRecord(id, signal())).status).toBe("review");
  });
  it.each([
    "running",
    "cancelado",
    "conta",
    "documento",
    "modelo",
    "signatario",
    "assinatura-ausente",
    "cpf",
    "nome",
    "total",
    "entrada",
    "quantidade",
    "parcela",
    "vencimento",
    "juros",
    "produto",
    "sem-checksum",
    "futuro",
  ])("assinatura/condições remotas divergentes ficam em revisão: %s", async (mode) => {
    const { source } = harness(fixture(), undefined, (d) => {
      if (mode === "running") d.status = "running";
      if (mode === "cancelado") d.status = "canceled";
      if (mode === "conta") d.account_key = "outra-conta";
      if (mode === "documento") d.key = "88888888-8888-4888-8888-888888888888";
      if (mode === "modelo") d.template.key = "88888888-8888-4888-8888-888888888888";
      if (mode === "signatario") d.signers[0]!.key = "88888888-8888-4888-8888-888888888888";
      if (mode === "assinatura-ausente") Object.assign(d.signers[0]!, { signature: null });
      if (mode === "cpf") d.signers[0]!.signature.documentation = "11111111111";
      if (mode === "nome") d.signers[0]!.signature.name = "Outra pessoa";
      if (mode === "total") d.template.data.valor_total = "R$ 120,00";
      if (mode === "entrada") d.template.data.valor_entrada = "R$ 10,00";
      if (mode === "quantidade") d.template.data.numero_parcelas = "2";
      if (mode === "parcela") d.template.data.valor_parcela = "R$ 110,01";
      if (mode === "vencimento") d.template.data.data_primeira_parcela = "22/11/2026";
      if (mode === "juros") d.template.data.juros_mensal = "0% a.m.";
      if (mode === "produto") d.template.data.nome_produto = "Outro produto";
      if (mode === "sem-checksum") d.downloads.signed_file_checksum = "";
      if (mode === "futuro") d.finished_at = "2026-10-25T14:00:00Z";
    });
    expect((await source.readRecord(id, signal())).status).toBe("review");
  });
  it("prova o total aceito com juros, sem confundir principal, bruto e líquido", async () => {
    const { source, fetcher } = harness();
    expect(await source.readPayment(id, signal())).toMatchObject({
      totalCents: 13000,
      paidCents: 13000,
      status: "paid",
      paidAtPrecision: "day",
    });
    const select = new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("select")!;
    expect(select).toContain("parcelamento_snapshot");
    expect(select).toContain("contracts(");
    expect(select).toContain("template_used");
    const documentCall = fetcher.mock.calls.find(([url]) => String(url).includes("clicksign.com"))!;
    expect(String(documentCall[0])).toBe(
      "https://app.clicksign.com/api/v1/documents/55555555-5555-4555-8555-555555555555",
    );
    expect(documentCall[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: { Authorization: "clicksign-ficticio" },
    });
    expect(JSON.stringify(documentCall[1])).not.toContain("access_token");
  });
  it.each(["http", "json", "redirect", "aborto"])(
    "falha %s ao autenticar o documento não vira assinatura nem negativa",
    async (mode) => {
      const { fetcher } = harness();
      const broken = vi.fn<typeof fetch>(async (url, init) => {
        if (!String(url).includes("clicksign.com")) return fetcher(url, init);
        if (mode === "http") return new Response("segredo-remoto", { status: 401 });
        if (mode === "json") return new Response("segredo-remoto");
        if (mode === "redirect")
          return new Response(null, {
            status: 302,
            headers: { Location: "https://example.invalid" },
          });
        return new Promise<Response>(() => {});
      });
      const source = criarFonteFinanceira(cfg, { fetch: broken, now: () => now });
      await expect(source.readPayment(id, AbortSignal.timeout(50))).rejects.toThrow(
        "financial_source_unavailable",
      );
      expect(broken.mock.calls.filter(([url]) => String(url).includes("/payments/"))).toHaveLength(
        0,
      );
    },
  );
  it.each([
    "sem-snapshot",
    "sem-contrato",
    "hash-vazio",
    "hash-divergente",
    "sem-versao",
    "outra-org",
    "outro-pedido",
    "duplicado",
    "sem-assinatura",
    "cancelamento",
    "desconto-posterior",
    "nome-alterado",
    "cpf-alterado",
    "produto-alterado",
    "entrada-sozinha",
    "centavo",
    "numero-parcela",
    "vencimento",
    "schema-desconhecido",
    "total-principal-alterado",
    "parcela-local-alterada",
  ])("mantém revisão sem prova negativa: %s", async (mode) => {
    const o = fixture();
    const c = o.contracts[0]!;
    if (mode === "sem-snapshot") Object.assign(o, { parcelamento_snapshot: undefined });
    if (mode === "sem-contrato") o.contracts = [];
    if (mode === "hash-vazio")
      c.rendered_text_hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    if (mode === "hash-divergente") c.rendered_text_hash = "a".repeat(64);
    if (mode === "sem-versao") c.template_used = "legado";
    if (mode === "outra-org") c.org_id = "outra";
    if (mode === "outro-pedido") c.order_id = "outro";
    if (mode === "duplicado") o.contracts.push({ ...c });
    if (mode === "sem-assinatura") c.signed_at = null;
    if (mode === "cancelamento") c.remote_cancel_status = "requested";
    if (mode === "desconto-posterior") o.discount_applied_at = "2026-10-20T14:00:00Z";
    if (mode === "nome-alterado") o.customers.name += " alterado";
    if (mode === "cpf-alterado") o.customers.cpf = "11111111111";
    if (mode === "produto-alterado") o.products.name += " alterado";
    if (mode === "entrada-sozinha") o.payments.pop();
    if (mode === "centavo") o.payments[1]!.amount += 0.01;
    if (mode === "numero-parcela") o.payments[1]!.installment_number = 2;
    if (mode === "vencimento") o.payments[1]!.due_date = "2026-12-21";
    if (mode === "schema-desconhecido") o.parcelamento_snapshot.schemaVersion = 2;
    if (mode === "total-principal-alterado") o.total_value = 130;
    if (mode === "parcela-local-alterada") o.installment_value = 109;
    const { source } = harness(o);
    expect((await source.readRecord(id, signal())).status).toBe("review");
    expect((await source.scan(new Date("2026-10-01"), now, signal()))[0]!.status).toBe("review");
    await expect(source.readPayment(id, signal())).rejects.toThrow();
  });
  it.each([null, "auto_sub:outro:1", `auto_sub:${id}:1`])(
    "referência não provada não vira vínculo por cliente/valor: %s",
    async (reference) => {
      const { source } = harness(fixture(), (p) => {
        p.externalReference = reference;
      });
      expect((await source.readRecord(id, signal())).status).toBe("review");
    },
  );
  it("releitura detecta mutação posterior do snapshot e mantém revisão", async () => {
    const o = fixture();
    const { source } = harness(o);
    expect((await source.readRecord(id, signal())).status).toBe("paid");
    o.parcelamento_snapshot.grandTotal = "129.99";
    expect((await source.readRecord(id, signal())).status).toBe("review");
  });
});
