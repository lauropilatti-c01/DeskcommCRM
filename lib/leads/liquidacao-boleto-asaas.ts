import { z } from "zod";
import { CompraRecusada } from "./compra-verificada";
import { intervaloDoPagamento } from "./periodo-financeiro";
import { lerContratoBoletoAceito } from "./contrato-boleto-aceito";
import { clicksignReadSchema, conferirDocumentoClicksign } from "./documento-boleto-clicksign";

/** Somente leitura. Nem URL arbitrária nem operação financeira são configuráveis. */
export const asaasSettlementSchema = z
  .object({
    enabled: z.boolean().default(false),
    environment: z.enum(["production", "sandbox"]),
    walletId: z.uuid(),
    apiToken: z.string().min(1),
    clicksign: clicksignReadSchema.optional(),
  })
  .strict();
export type ConfiguracaoLiquidacaoAsaas = z.infer<typeof asaasSettlementSchema>;
type Objeto = Record<string, unknown>;
const rec = (v: unknown): Objeto =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Objeto) : {};
function cents(v: unknown): number | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  if (!/^[0-9]+(?:\.[0-9]{1,2})?$/.test(String(v))) return null;
  const n = Math.round(Number(v) * 100);
  return Number.isSafeInteger(n) ? n : null;
}
export async function lerLiquidacaoAsaas(
  order: Objeto,
  cfg: ConfiguracaoLiquidacaoAsaas,
  deps: {
    fetch: typeof fetch;
    now: Date;
    signal: AbortSignal;
    getBoleto?: (path: string, signal: AbortSignal) => Promise<unknown>;
  },
): Promise<{
  status: "paid" | "review";
  paidCents: number;
  paidAt: string | null;
  evidence: unknown;
  totalCents?: number;
}> {
  const config = asaasSettlementSchema.safeParse(cfg);
  if (!config.success || !config.data.enabled)
    throw new CompraRecusada("financial_configuration_invalid");
  const origin =
    cfg.environment === "production" ? "https://api.asaas.com" : "https://api-sandbox.asaas.com";
  const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(6_000)]);
  async function get(path: string, document = false): Promise<Objeto> {
    let cancel = () => {};
    try {
      signal.throwIfAborted();
      const load = async () => {
        const url = document
          ? `https://${cfg.environment === "production" ? "app" : "sandbox"}.clicksign.com/api/v1/${path}`
          : `${origin}/v3/${path}`;
        const response = await deps.fetch(url, {
          method: "GET",
          headers: document
            ? { Authorization: cfg.clicksign!.apiToken, Accept: "application/json" }
            : { access_token: cfg.apiToken, Accept: "application/json" },
          redirect: "error",
          cache: "no-store",
          signal,
        });
        if (!response.ok) throw new Error();
        const text = await response.text();
        if (text.length > 256_000) throw new Error();
        return rec(JSON.parse(text));
      };
      return await Promise.race([
        load(),
        new Promise<never>((_resolve, reject) => {
          cancel = () => reject(new Error());
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        }),
      ]);
    } catch {
      throw new CompraRecusada("financial_source_unavailable");
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  const wallet = await get("wallets/");
  if (
    wallet.hasMore !== false ||
    wallet.totalCount !== 1 ||
    !Array.isArray(wallet.data) ||
    wallet.data.length !== 1 ||
    rec(wallet.data[0]).id !== cfg.walletId
  )
    throw new CompraRecusada("financial_source_account_mismatch");
  const evidence: unknown[] = [{ walletId: cfg.walletId, environment: cfg.environment }];
  const review = () => ({ status: "review" as const, paidCents: 0, paidAt: null, evidence });
  const contract = lerContratoBoletoAceito(order, deps.now);
  if (!contract || !cfg.clicksign) return review();
  evidence.push(contract.evidence);
  const document = await get(`documents/${contract.document.key}`, true);
  const signature = conferirDocumentoClicksign(
    document,
    contract,
    cfg.clicksign.accountKeySha256,
    deps.now,
  );
  if (!signature) return review();
  evidence.push(signature);
  const customer = rec(order.customers);
  const payments = order.payments;
  if (
    !Array.isArray(payments) ||
    payments.length === 0 ||
    payments.length > 100 ||
    !/^cus_[a-zA-Z0-9]+$/.test(String(customer.external_customer_id_asaas)) ||
    ["cancelled", "delinquent", "refunded"].includes(String(order.status))
  )
    return review();
  const localIds = new Set<string>(),
    providerIds = new Set<string>();
  const dates: string[] = [];
  const pairs: { local: Objeto; remote: Objeto }[] = [];
  let sum = 0;
  for (const item of payments) {
    const local = rec(item);
    const id = local.asaas_payment_id;
    if (
      typeof local.id !== "string" ||
      localIds.has(local.id) ||
      typeof id !== "string" ||
      !/^pay_[a-zA-Z0-9]+$/.test(id) ||
      providerIds.has(id) ||
      local.org_id !== order.org_id ||
      local.order_id !== order.id ||
      local.marked_paid_manually_at ||
      local.refunded_at ||
      Number(local.refund_amount) > 0 ||
      (local.refund_lifecycle != null && local.refund_lifecycle !== "none") ||
      ["refunded", "chargeback", "cancelled"].includes(String(local.status))
    )
      return review();
    localIds.add(local.id);
    providerIds.add(id);
    const remote = await get(`payments/${id}`);
    evidence.push(remote);
    const gross = cents(remote.value),
      expected = cents(local.amount);
    const net = remote.netValue == null ? null : cents(remote.netValue);
    if (
      remote.id !== id ||
      remote.customer !== customer.external_customer_id_asaas ||
      remote.status !== "RECEIVED" ||
      !["BOLETO", "PIX"].includes(String(remote.billingType)) ||
      remote.deleted === true ||
      remote.chargeback ||
      (remote.refunds != null && (!Array.isArray(remote.refunds) || remote.refunds.length > 0)) ||
      gross === null ||
      gross <= 0 ||
      gross !== expected ||
      remote.dueDate !== local.due_date ||
      (remote.originalValue != null && cents(remote.originalValue) !== gross) ||
      (remote.interestValue != null && cents(remote.interestValue) !== 0) ||
      (rec(remote.discount).value != null && cents(rec(remote.discount).value) !== 0) ||
      (remote.netValue != null && (net === null || net > gross))
    )
      return review();
    if (typeof remote.paymentDate !== "string") return review();
    const range = intervaloDoPagamento(remote.paymentDate, "day");
    const ordered = typeof order.created_at === "string" ? Date.parse(order.created_at) : NaN;
    if (
      !range ||
      !Number.isFinite(ordered) ||
      range.earliest < ordered ||
      range.latest > deps.now.getTime()
    )
      return review();
    dates.push(remote.paymentDate);
    pairs.push({ local, remote });
    sum += gross;
    if (!Number.isSafeInteger(sum)) return review();
  }
  if (sum <= 0 || sum !== contract.totalCents) return review();
  // O caminho antigo permanece exato. A exceção Pix exige uma cadeia completa
  // e unívoca; QR/cliente/status local isolados nunca vinculam compra a pedido.
  if (!pairs.every(({ remote }) => remote.externalReference === order.id)) {
    const authId = order.pix_automatic_authorization_id;
    if (
      !z.uuid().safeParse(order.id).success ||
      !z.uuid().safeParse(authId).success ||
      !deps.getBoleto
    )
      return review();
    const entries = pairs.filter(({ local }) => local.type === "entry_pix");
    const installments = pairs.filter(({ local }) => local.type === "installment_pix_automatic");
    if (
      entries.length !== 1 ||
      installments.length < 1 ||
      entries.length + installments.length !== pairs.length ||
      pairs.some(({ remote }) => remote.billingType !== "PIX")
    )
      return review();
    const entry = entries[0]!;
    const qr = entry.local.external_id;
    if (
      typeof qr !== "string" ||
      !/^[a-zA-Z0-9]{1,100}$/.test(qr) ||
      entry.remote.pixQrCodeId !== qr ||
      entry.remote.externalReference != null ||
      installments.some(
        ({ local, remote }) =>
          !Number.isSafeInteger(local.installment_number) ||
          Number(local.installment_number) < 1 ||
          remote.externalReference !==
            `pix_instruction:${order.id}:${local.installment_number}:${local.due_date}`,
      )
    )
      return review();
    const authorization = await get(`pix/automatic/authorizations/${authId}`);
    evidence.push(authorization);
    const e2e = authorization.endToEndIdentifier;
    if (
      authorization.id !== authId ||
      authorization.customerId !== customer.external_customer_id_asaas ||
      !["ACTIVE", "EXPIRED"].includes(String(authorization.status)) ||
      authorization.cancellationDate != null ||
      authorization.cancellationReason != null ||
      typeof e2e !== "string" ||
      !/^[a-zA-Z0-9]{1,100}$/.test(e2e) ||
      rec(authorization.immediateQrCode).conciliationIdentifier !== qr
    )
      return review();
    const instructions = await get(
      `pix/automatic/paymentInstructions?authorizationId=${authId}&limit=100&offset=0`,
    );
    evidence.push(instructions);
    if (
      instructions.hasMore !== false ||
      instructions.offset !== 0 ||
      !Array.isArray(instructions.data) ||
      instructions.totalCount !== instructions.data.length ||
      instructions.data.length !== installments.length
    )
      return review();
    const instructionIds = new Set<string>(),
      paymentIds = new Set<string>();
    for (const raw of instructions.data) {
      const instruction = rec(raw),
        auth = rec(instruction.authorization);
      const pair = installments.find(({ remote }) => remote.id === instruction.paymentId);
      if (
        typeof instruction.id !== "string" ||
        !z.uuid().safeParse(instruction.id).success ||
        instructionIds.has(instruction.id) ||
        typeof instruction.paymentId !== "string" ||
        paymentIds.has(instruction.paymentId) ||
        !pair ||
        instruction.status !== "DONE" ||
        instruction.dueDate !== pair.local.due_date ||
        auth.id !== authId ||
        auth.customerId !== customer.external_customer_id_asaas ||
        auth.endToEndIdentifier !== e2e ||
        instruction.refusalReason != null ||
        instruction.retryAttempt != null
      )
        return review();
      instructionIds.add(instruction.id);
      paymentIds.add(instruction.paymentId);
    }
    // Não presumir que a migration UNIQUE do produtor está aplicada. Consulta
    // global limitada a dois registros detecta colisões entre pedidos/contas.
    async function unique(path: string, expected: Objeto): Promise<boolean> {
      const rows = await deps.getBoleto!(path, signal);
      evidence.push(rows);
      return (
        Array.isArray(rows) &&
        rows.length === 1 &&
        Object.entries(expected).every(([key, value]) => rec(rows[0])[key] === value)
      );
    }
    if (
      !(await unique(
        `rest/v1/orders?select=id,org_id&pix_automatic_authorization_id=eq.${authId}&limit=2`,
        { id: order.id, org_id: order.org_id },
      ))
    )
      return review();
    for (const { local } of pairs) {
      if (
        !(await unique(
          `rest/v1/payments?select=id,org_id,order_id&asaas_payment_id=eq.${local.asaas_payment_id}&limit=2`,
          { id: local.id, org_id: order.org_id, order_id: order.id },
        ))
      )
        return review();
    }
    if (
      !(await unique(`rest/v1/payments?select=id,org_id,order_id&external_id=eq.${qr}&limit=2`, {
        id: entry.local.id,
        org_id: order.org_id,
        order_id: order.id,
      }))
    )
      return review();
  }
  return {
    status: "paid",
    paidCents: sum,
    totalCents: contract.totalCents,
    paidAt: dates.sort().at(-1)!,
    evidence,
  };
}
