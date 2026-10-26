import { describe, expect, it, vi } from "vitest";
import { criarFonteFinanceira, type FonteConfig } from "@/lib/leads/fontes-financeiras";
import {
  contratoFicticio,
  clicksignFicticio,
  documentoFicticio,
} from "../helpers/boleto-contrato-ficticio";

const org = "11111111-1111-4111-8111-111111111111";
const orderId = "22222222-2222-4222-8222-222222222222";
const authId = "88888888-8888-4888-8888-888888888888";
const walletId = "33333333-3333-4333-8333-333333333333";
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
    clicksign: clicksignFicticio,
  },
};
function fixture() {
  const local = {
    org_id: org,
    order_id: orderId,
    status: "pending",
    amount_paid: null,
    paid_at: null,
    refunded_at: null,
    refund_amount: null,
    refund_lifecycle: null,
    marked_paid_manually_at: null,
  };
  const order = contratoFicticio(
    {
      id: orderId,
      org_id: org,
      status: "completed",
      total_value: 100,
      created_at: "2026-10-19T12:00:00Z",
      pix_automatic_authorization_id: authId,
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
          ...local,
          id: "entrada",
          asaas_payment_id: "pay_entrada",
          type: "entry_pix",
          installment_number: null as number | null,
          amount: 20,
          due_date: "2026-10-21",
          external_id: "QRficticio",
        },
        {
          ...local,
          id: "parcela",
          asaas_payment_id: "pay_parcela",
          type: "installment_pix_automatic",
          installment_number: 1,
          amount: 80,
          due_date: "2026-11-21",
          external_id: null,
        },
      ],
    },
    [80],
    20,
  );
  const base = {
    customer: "cus_ficticio",
    billingType: "PIX",
    status: "RECEIVED",
    deleted: false,
    refunds: [] as unknown[],
    paymentDate: "2026-10-21",
    interestValue: 0,
  };
  const entry = {
    ...base,
    id: "pay_entrada",
    value: 20,
    dueDate: "2026-10-21",
    externalReference: null as string | null,
    pixQrCodeId: "QRficticio",
  };
  const installment = {
    ...base,
    id: "pay_parcela",
    value: 80,
    dueDate: "2026-11-21",
    externalReference: `pix_instruction:${orderId}:1:2026-11-21`,
  };
  const authorization = {
    id: authId,
    customerId: "cus_ficticio",
    endToEndIdentifier: "E2Eficticio",
    status: "EXPIRED",
    cancellationDate: null as string | null,
    immediateQrCode: { conciliationIdentifier: "QRficticio" },
  };
  const instructions = {
    hasMore: false,
    totalCount: 1,
    offset: 0,
    limit: 100,
    data: [
      {
        id: "99999999-9999-4999-8999-999999999999",
        paymentId: "pay_parcela",
        status: "DONE",
        dueDate: "2026-11-21",
        authorization: {
          id: authId,
          customerId: "cus_ficticio",
          endToEndIdentifier: "E2Eficticio",
        },
        refusalReason: null,
        retryAttempt: null,
      },
    ],
  };
  return { order, entry, installment, authorization, instructions, collision: "" };
}
function harness(f = fixture()) {
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const u = new URL(String(url));
    if (u.hostname === "example.supabase.co") {
      if (u.pathname === "/rest/v1/payments") {
        const field = u.searchParams.has("asaas_payment_id") ? "asaas_payment_id" : "external_id";
        const value = u.searchParams.get(field)?.slice(3);
        const rows = f.order.payments.filter((p) => p[field] === value);
        if (f.collision === field)
          rows.push({ ...rows[0]!, id: "outro", order_id: "outro-pedido" });
        return Response.json(rows);
      }
      if (f.collision === "autorizacao" && u.searchParams.has("pix_automatic_authorization_id"))
        return Response.json([f.order, { ...f.order, id: "outro-pedido" }]);
      return Response.json([f.order]);
    }
    if (u.hostname === "app.clicksign.com") return Response.json(documentoFicticio(f.order));
    if (u.pathname === "/v3/wallets/")
      return Response.json({ hasMore: false, totalCount: 1, data: [{ id: walletId }] });
    if (u.pathname === "/v3/payments/pay_entrada") return Response.json(f.entry);
    if (u.pathname === "/v3/payments/pay_parcela") return Response.json(f.installment);
    if (u.pathname === `/v3/pix/automatic/authorizations/${authId}`)
      return Response.json(f.authorization);
    if (
      u.pathname === "/v3/pix/automatic/paymentInstructions" &&
      u.search === `?authorizationId=${authId}&limit=100&offset=0`
    )
      return Response.json(f.instructions);
    throw new Error("URL inesperada");
  });
  const source = criarFonteFinanceira(cfg, {
    fetch: fetcher,
    now: () => new Date("2026-10-23T20:00:00Z"),
  });
  return { fetcher, source };
}
const signal = () => new AbortController().signal;

describe("Pix: entrada e parcela ancoradas na mesma autorização remota", () => {
  it("aceita apenas a cadeia completa, relida em cada consulta, sem depender de paid local", async () => {
    const { source, fetcher } = harness();
    const first = await source.readPayment(orderId, signal());
    expect(first).toMatchObject({
      status: "paid",
      paidCents: 10000,
      totalCents: 10000,
      paidAt: "2026-10-21",
    });
    expect(await source.readPayment(orderId, signal())).toEqual(first);
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("paymentInstructions")),
    ).toHaveLength(2);
    const selection = new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("select");
    expect(selection).toContain("pix_automatic_authorization_id");
    expect(selection).toContain("external_id");
    for (const [, init] of fetcher.mock.calls)
      expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
  });
  it("a ordem das parcelas locais não determina a âncora", async () => {
    const f = fixture();
    f.order.payments.reverse();
    expect((await harness(f).source.readPayment(orderId, signal())).paidCents).toBe(10000);
  });
  it.each([
    "outro-pedido",
    "substring",
    "sufixo",
    "ordinal",
    "data-referencia",
    "ledger",
    "qr-remoto",
    "qr-local",
    "entrada-com-referencia",
    "sem-ancora",
    "tipo",
    "autorizacao",
    "cliente-autorizacao",
    "e2e",
    "autorizacao-instrucao",
    "cliente-instrucao",
    "pagamento-instrucao",
    "data-instrucao",
    "instrucao-pendente",
    "instrucao-duplicada",
    "lista-incompleta",
    "contagem",
    "paginacao",
    "sem-instrucao",
    "autorizacao-cancelada",
    "id-invalido",
    "mesmo-dia",
    "parcial",
    "estorno",
    "local-manual",
    "cliente-cobranca",
    "valor",
    "cobranca-duplicada",
    "colisao-autorizacao",
    "colisao-cobranca",
    "colisao-qr",
    "e2e-vazio",
  ])("recusa cadeia ou quitação ambígua: %s", async (mode) => {
    const f = fixture();
    if (mode === "outro-pedido")
      f.installment.externalReference = `pix_instruction:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1:2026-11-21`;
    if (mode === "substring")
      f.installment.externalReference = `prefix:${f.installment.externalReference}`;
    if (mode === "sufixo") f.installment.externalReference += ":extra";
    if (mode === "ordinal")
      f.installment.externalReference = `pix_instruction:${orderId}:2:2026-11-21`;
    if (mode === "data-referencia")
      f.installment.externalReference = `pix_instruction:${orderId}:1:2026-11-20`;
    if (mode === "ledger") f.installment.externalReference = `billing_obligation:${orderId}`;
    if (mode === "qr-remoto") f.entry.pixQrCodeId = "QRoutro";
    if (mode === "qr-local") f.order.payments[0]!.external_id = "QRoutro";
    if (mode === "entrada-com-referencia") f.entry.externalReference = "outro";
    if (mode === "sem-ancora") f.installment.externalReference = orderId;
    if (mode === "tipo") f.order.payments[1]!.type = "installment_pix";
    if (mode === "autorizacao") f.authorization.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    if (mode === "cliente-autorizacao") f.authorization.customerId = "cus_outro";
    if (mode === "e2e") f.instructions.data[0]!.authorization.endToEndIdentifier = "E2Eoutro";
    if (mode === "autorizacao-instrucao")
      f.instructions.data[0]!.authorization.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    if (mode === "cliente-instrucao")
      f.instructions.data[0]!.authorization.customerId = "cus_outro";
    if (mode === "pagamento-instrucao") f.instructions.data[0]!.paymentId = "pay_outro";
    if (mode === "data-instrucao") f.instructions.data[0]!.dueDate = "2026-11-22";
    if (mode === "instrucao-pendente") f.instructions.data[0]!.status = "SCHEDULED";
    if (mode === "instrucao-duplicada") {
      f.instructions.data.push({ ...f.instructions.data[0]! });
      f.instructions.totalCount = 2;
    }
    if (mode === "lista-incompleta") f.instructions.hasMore = true;
    if (mode === "contagem") f.instructions.totalCount = 2;
    if (mode === "paginacao") f.instructions.offset = 1;
    if (mode === "sem-instrucao") {
      f.instructions.data = [];
      f.instructions.totalCount = 0;
    }
    if (mode === "autorizacao-cancelada") f.authorization.cancellationDate = "2026-10-22";
    if (mode === "id-invalido") f.order.pix_automatic_authorization_id = "../payments/pay_outro";
    if (mode === "mesmo-dia") f.order.created_at = "2026-10-21T01:00:00Z";
    if (mode === "parcial") f.installment.status = "PENDING";
    if (mode === "estorno") f.entry.refunds = [{ value: 1 }];
    if (mode === "local-manual")
      Object.assign(f.order.payments[0]!, { marked_paid_manually_at: "2026-10-21" });
    if (mode === "cliente-cobranca") f.entry.customer = "cus_outro";
    if (mode === "valor") f.entry.value = 21;
    if (mode === "colisao-autorizacao") f.collision = "autorizacao";
    if (mode === "colisao-cobranca") f.collision = "asaas_payment_id";
    if (mode === "colisao-qr") f.collision = "external_id";
    if (mode === "e2e-vazio") {
      f.authorization.endToEndIdentifier = "";
      f.instructions.data[0]!.authorization.endToEndIdentifier = "";
    }
    if (mode === "cobranca-duplicada") f.order.payments[1]!.asaas_payment_id = "pay_entrada";
    expect((await harness(f).source.readRecord(orderId, signal())).status).toBe("review");
  });
});
