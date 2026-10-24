/** Leitores GET das fontes financeiras. Nenhum corpo recebido do CRM vira prova. */
import { createHash } from "node:crypto";
import { CompraRecusada, type ProvaFinanceira } from "./compra-verificada";
import {
  asaasSettlementSchema,
  lerLiquidacaoAsaas,
  type ConfiguracaoLiquidacaoAsaas,
} from "./liquidacao-boleto-asaas";
export interface FonteConfig {
  provider: "guru" | "boleto";
  sourceAccountId: string;
  baseUrl: string;
  apiToken: string;
  asaasSettlement?: ConfiguracaoLiquidacaoAsaas;
}
export interface RegistroFinanceiro {
  transactionId: string;
  productId: string;
  offerId: string | null;
  phone: string | null;
  email: string | null;
  orderedAt: string;
  status: "paid" | "pending" | "review";
  proof?: ProvaFinanceira;
  reviewReason?: "comprovante_financeiro_incompleto";
}
interface IdentidadeConsultada {
  phone: string | null;
  email: string | null;
}
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
function erro(code = "financial_evidence_invalid"): never {
  throw new CompraRecusada(code);
}
function str(v: unknown): string {
  return typeof v === "string" && v.trim()
    ? v.trim()
    : typeof v === "number" && Number.isSafeInteger(v)
      ? String(v)
      : erro();
}
function money(v: unknown): number {
  const s = typeof v === "number" || typeof v === "string" ? String(v) : "";
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return erro();
  const n = Math.round(Number(s) * 100);
  return Number.isSafeInteger(n) && n >= 0 ? n : erro();
}
function iso(v: unknown, epoch = false): string {
  const n =
    epoch && (typeof v === "number" || typeof v === "string")
      ? Number(v) * 1000
      : typeof v === "string"
        ? Date.parse(v)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return erro();
  return new Date(n).toISOString();
}
function telefone(v: unknown, country: unknown = ""): string | null {
  if (!v) return null;
  const raw = str(v);
  let d = raw.replace(/[^0-9]/g, "");
  const c = country ? str(country).replace(/[^0-9]/g, "") : "";
  if (c === "55" && !raw.startsWith("+")) {
    if (d.length === 10 || d.length === 11) d = c + d;
    else if (!([12, 13].includes(d.length) && d.startsWith(c))) return erro();
  } else if (c && !raw.startsWith("+") && !d.startsWith(c)) d = c + d;
  if (!/^\d{8,15}$/.test(d)) return erro();
  return "+" + d;
}
function email(v: unknown): string | null {
  if (!v) return null;
  const e = str(v).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : erro();
}
const BOLETO_SELECT =
  "id,org_id,status,total_value,created_at,customers(id,org_id,phone,email,anonymized),products(id,org_id),payments(id,org_id,status,amount_paid,paid_at,refunded_at,refund_amount,marked_paid_manually_at)";
const BOLETO_ASAAS_SELECT =
  "id,org_id,status,total_value,created_at,external_ref,entry_value,installment_count,installment_value,discount_applied_at,discount_applied_pct,parcelamento_snapshot,customers(id,org_id,name,cpf,phone,email,anonymized,external_customer_id_asaas),products(id,org_id,name),contracts(id,org_id,order_id,provider,status,external_id,external_envelope_id,external_signer_id,template_used,rendered_text_hash,created_at,signed_at,cancelled_at,remote_cancel_status),payments(id,org_id,order_id,asaas_payment_id,type,installment_number,due_date,status,amount,amount_paid,paid_at,refunded_at,refund_amount,refund_lifecycle,marked_paid_manually_at)";
export function criarFonteFinanceira(
  cfg: FonteConfig,
  deps: { fetch?: typeof fetch; now?: () => Date } = {},
) {
  const fetcher = deps.fetch ?? fetch,
    now = deps.now ?? (() => new Date());
  const base = new URL(cfg.baseUrl);
  if (
    cfg.asaasSettlement &&
    (cfg.provider !== "boleto" || !asaasSettlementSchema.safeParse(cfg.asaasSettlement).success)
  )
    erro("financial_configuration_invalid");
  const boletoSelect = cfg.asaasSettlement?.enabled ? BOLETO_ASAAS_SELECT : BOLETO_SELECT;
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !cfg.apiToken ||
    !cfg.sourceAccountId
  )
    erro("financial_configuration_invalid");
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiToken}`,
    Accept: "application/json",
  };
  if (cfg.provider === "boleto") headers.apikey = cfg.apiToken;
  async function comCancelamento<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let stop: () => void = () => {};
    try {
      return await Promise.race([
        run(),
        new Promise<never>((_resolve, reject) => {
          stop = () => reject(signal.reason);
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  async function get(path: string, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await comCancelamento(
          () =>
            fetcher(`${base.href.replace(/\/$/, "")}/${path}`, {
              method: "GET",
              headers,
              signal,
              cache: "no-store",
              redirect: "error",
            }),
          signal,
        );
      } catch {
        if (signal.aborted || attempt === 1) return erro("financial_source_unavailable");
        continue;
      }
      if (!response.ok) {
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          const requested = Number(response.headers.get("retry-after") ?? "0");
          // Um Retry-After maior não cabe na guarda final; conserva a pendência.
          if (!Number.isFinite(requested) || requested > 1)
            return erro("financial_source_unavailable");
          await comCancelamento(
            () =>
              new Promise<void>((resolve) => setTimeout(resolve, Math.max(100, requested * 1000))),
            signal,
          );
          continue;
        }
        return erro("financial_source_unavailable");
      }
      const text = await comCancelamento(() => response.text(), signal);
      if (text.length > 4_000_000) return erro("financial_source_incomplete");
      try {
        return JSON.parse(text);
      } catch {
        return erro("financial_source_unavailable");
      }
    }
    return erro("financial_source_unavailable");
  }
  async function decode(
    raw: unknown,
    signal: AbortSignal,
    identity?: IdentidadeConsultada,
  ): Promise<RegistroFinanceiro> {
    const row = rec(raw),
      id = str(row.id);
    let p: Record<string, unknown>,
      c: Record<string, unknown>,
      orderedAt: string,
      paidAt: string | null = null,
      paidCents = 0,
      totalCents = 0,
      currency = "BRL",
      status: RegistroFinanceiro["status"];
    let phone: string | null, offerId: string | null;
    let evidenceIncomplete = false;
    let providerEvidence: unknown;
    if (cfg.provider === "guru") {
      p = rec(row.product);
      c = rec(row.contact);
      const pay = rec(row.payment),
        dates = rec(row.dates);
      orderedAt = iso(dates.ordered_at, true);
      totalCents = money(pay.total);
      currency = str(pay.currency);
      offerId = str(rec(p.offer).id);
      phone = telefone(c.phone_number, c.phone_local_code);
      status = ["approved", "paid", "complete", "completed"].includes(String(row.status))
        ? "paid"
        : [
              "waiting_payment",
              "pending",
              "processing",
              "expired",
              "canceled",
              "cancelled",
              "refused",
            ].includes(String(row.status))
          ? "pending"
          : "review";
      if (status === "paid") {
        paidAt = iso(dates.confirmed_at, true);
        paidCents = totalCents;
      }
      if (
        dates.canceled_at ||
        dates.refunded_at ||
        pay.refund_reason ||
        (status !== "paid" && dates.confirmed_at) ||
        (Array.isArray(row.items) && row.items.length > 1) ||
        Number(p.qty) > 1 ||
        totalCents === 0
      )
        status = "review";
    } else {
      if (row.org_id !== cfg.sourceAccountId) erro("financial_source_account_mismatch");
      p = rec(row.products);
      c = rec(row.customers);
      if (
        p.org_id !== cfg.sourceAccountId ||
        c.org_id !== cfg.sourceAccountId ||
        c.anonymized === true
      )
        erro("financial_identity_unavailable");
      orderedAt = iso(row.created_at);
      totalCents = money(row.total_value);
      offerId = null;
      phone = telefone(c.phone, "55");
      if (cfg.asaasSettlement?.enabled) {
        // A guarda ainda vê todos os registros e os conflitos de identidade.
        // Cobranças de outra pessoa não consomem o prazo da consulta atual e
        // jamais recebem um estado negativo fabricado por não terem sido lidas.
        const relevant =
          !identity ||
          (!!identity.phone && identity.phone === phone) ||
          (!!identity.email && identity.email === email(c.email));
        const settlement = relevant
          ? await lerLiquidacaoAsaas(row, cfg.asaasSettlement, {
              fetch: fetcher,
              now: now(),
              signal,
            })
          : { status: "review" as const, paidCents: 0, paidAt: null, evidence: undefined };
        status = settlement.status;
        if (
          settlement.status === "paid" &&
          "totalCents" in settlement &&
          settlement.totalCents != null
        )
          totalCents = settlement.totalCents;
        paidCents = settlement.paidCents;
        paidAt = settlement.paidAt;
        providerEvidence = settlement.evidence;
        evidenceIncomplete = status === "review";
      } else {
        const payments = row.payments;
        if (!Array.isArray(payments) || payments.length >= 1000)
          erro("financial_source_incomplete");
        const ids = new Set<string>();
        const times: string[] = [];
        let review = false;
        for (const item of payments) {
          const pay = rec(item);
          const pid = str(pay.id);
          if (ids.has(pid) || pay.org_id !== cfg.sourceAccountId)
            erro("financial_evidence_invalid");
          ids.add(pid);
          if (
            pay.refunded_at ||
            Number(pay.refund_amount) > 0 ||
            pay.marked_paid_manually_at ||
            ["refunded", "chargeback"].includes(String(pay.status))
          )
            review = true;
          if (pay.status === "paid") {
            try {
              const amount = money(pay.amount_paid);
              const date = iso(pay.paid_at);
              paidCents += amount;
              times.push(date);
            } catch (error) {
              if (!(error instanceof CompraRecusada)) throw error;
              // Identidade e produto continuam conhecidos. A ausência do recibo
              // bloqueia esta pessoa, sem virar ausência nem derrubar outras.
              review = true;
              evidenceIncomplete = true;
            }
          }
        }
        status =
          review || ["cancelled", "delinquent", "refunded"].includes(String(row.status))
            ? "review"
            : paidCents === totalCents && paidCents > 0
              ? "paid"
              : paidCents > 0
                ? "review"
                : "pending";
        paidAt = times.sort().at(-1) ?? null;
      }
    }
    const result: RegistroFinanceiro = {
      transactionId: id,
      productId: str(p.id),
      offerId,
      phone,
      email: email(c.email),
      orderedAt,
      status,
      ...(evidenceIncomplete ? { reviewReason: "comprovante_financeiro_incompleto" as const } : {}),
    };
    if (status === "paid") {
      if (
        !paidAt ||
        paidCents <= 0 ||
        paidCents !== totalCents ||
        (!result.phone && !result.email) ||
        !/^[A-Z]{3}$/.test(currency)
      )
        erro();
      result.proof = {
        transactionId: id,
        sourceAccountId: cfg.sourceAccountId,
        productId: result.productId,
        offerId,
        status: "paid",
        paidAt,
        ...(providerEvidence ? { paidAtPrecision: "day" as const } : {}),
        orderedAt,
        observedAt: now().toISOString(),
        paidCents,
        totalCents,
        currency,
        phone,
        email: result.email,
        evidenceHash: createHash("sha256")
          .update(JSON.stringify(providerEvidence ? { raw, providerEvidence } : raw))
          .digest("hex"),
      };
    }
    return result;
  }
  async function readRecord(id: string, signal: AbortSignal): Promise<RegistroFinanceiro> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) erro("financial_invalid_request");
    const response = await get(
      cfg.provider === "guru"
        ? `transactions/${encodeURIComponent(id)}`
        : `rest/v1/orders?select=${boletoSelect}&id=eq.${encodeURIComponent(id)}&org_id=eq.${encodeURIComponent(cfg.sourceAccountId)}&limit=2`,
      signal,
    );
    const raw = cfg.provider === "guru" ? (rec(response).data ?? response) : response;
    const one = Array.isArray(raw)
      ? raw.length === 1
        ? raw[0]
        : erro("financial_evidence_invalid")
      : raw;
    const result = await decode(one, signal);
    if (result.transactionId !== id) erro();
    return result;
  }
  async function scan(
    from: Date,
    to: Date,
    signal: AbortSignal,
    identity?: IdentidadeConsultada,
  ): Promise<RegistroFinanceiro[]> {
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to)
      erro("financial_invalid_period");
    const found = new Map<string, RegistroFinanceiro>();
    let requests = 0;
    async function limited(path: string) {
      if (++requests > 512) erro("financial_source_incomplete");
      return get(path, signal);
    }
    if (cfg.provider === "guru") {
      async function window(
        start: Date,
        end: Date,
        field: "ordered_at" | "confirmed_at",
      ): Promise<void> {
        let cursor: string | null = null;
        const cursors = new Set<string>(),
          rows: unknown[] = [];
        do {
          const data = rec(
            await limited(
              `transactions?${field}_ini=${start.toISOString().slice(0, 10)}&${field}_end=${end.toISOString().slice(0, 10)}&per_page=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            ),
          );
          if (
            !Array.isArray(data.data) ||
            ![true, false, 0, 1].includes(data.has_more_pages as boolean)
          )
            erro("financial_source_incomplete");
          rows.push(...data.data);
          if (rows.length >= 4900) break;
          if (data.has_more_pages === true || data.has_more_pages === 1) {
            cursor =
              typeof data.next_cursor === "string" && data.next_cursor
                ? data.next_cursor
                : erro("financial_source_incomplete");
            if (cursors.has(cursor)) erro("financial_source_incomplete");
            cursors.add(cursor);
          } else cursor = null;
        } while (cursor);
        if (rows.length >= 4900) {
          const days = Math.round((end.getTime() - start.getTime()) / 86400000);
          if (days < 1) erro("financial_source_incomplete");
          const mid = new Date(start.getTime() + Math.floor(days / 2) * 86400000);
          await window(start, mid, field);
          await window(new Date(mid.getTime() + 86400000), end, field);
          return;
        }
        for (const raw of rows) {
          const r = await decode(raw, signal, identity);
          if (
            found.has(r.transactionId) &&
            (JSON.stringify({ ...found.get(r.transactionId), proof: undefined }) !==
              JSON.stringify({ ...r, proof: undefined }) ||
              found.get(r.transactionId)?.proof?.evidenceHash !== r.proof?.evidenceHash)
          )
            erro("financial_source_inconsistent");
          found.set(r.transactionId, r);
        }
      }
      const end = new Date(to.toISOString().slice(0, 10) + "T00:00:00Z");
      let start = new Date(from.toISOString().slice(0, 10) + "T00:00:00Z");
      while (start <= end) {
        const last = new Date(Math.min(start.getTime() + 6 * 86400000, end.getTime()));
        await window(start, last, "ordered_at");
        await window(start, last, "confirmed_at");
        start = new Date(last.getTime() + 86400000);
      }
    } else {
      for (let offset = 0; ; offset += 500) {
        const rows = await limited(
          `rest/v1/orders?select=${boletoSelect}&org_id=eq.${encodeURIComponent(cfg.sourceAccountId)}&created_at=lte.${encodeURIComponent(to.toISOString())}&order=id.asc&limit=500&offset=${offset}`,
        );
        if (!Array.isArray(rows)) erro("financial_source_incomplete");
        for (const raw of rows) {
          const r = await decode(raw, signal, identity);
          if (found.has(r.transactionId)) erro("financial_source_inconsistent");
          found.set(r.transactionId, r);
        }
        if (rows.length < 500) break;
      }
    }
    return [...found.values()];
  }
  return {
    readRecord,
    scan,
    async readPayment(id: string, signal: AbortSignal): Promise<ProvaFinanceira> {
      const r = await readRecord(id, signal);
      if (!r.proof) erro("financial_payment_not_confirmed");
      return r.proof;
    },
  };
}
