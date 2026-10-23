/**
 * Núcleo candidato, sem rota nem tool registrada. Só configuração do servidor
 * pode ligá-lo e fornecer o adaptador que RELÊ o pagamento na fonte autorizada.
 * O espelho observacional, uma etiqueta e o JSON enviado pelo cliente não são
 * adaptadores. A integração real Guru/boleto ainda precisa ser conferida.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { z } from "zod";

import { comTravaDeEfeito } from "@/lib/agent-engine/db/trava-de-efeito";
import { hashDoCorpo } from "@/lib/api/idempotency";
import { recusaDeMotivoDoGanho, validaCamposExigidos } from "@/lib/leads/campos-exigidos";
import { campoDeConfirmacaoFinanceira } from "@/lib/leads/confirmacao-financeira";

const provaSchema = z.object({
  transactionId: z.string().min(1).max(200),
  sourceAccountId: z.string().min(1),
  productId: z.string().min(1),
  offerId: z.string().min(1).nullable(),
  status: z.literal("paid"),
  paidAt: z.iso.datetime(),
  orderedAt: z.iso.datetime(),
  observedAt: z.iso.datetime(),
  paidCents: z.number().int().positive().safe(),
  totalCents: z.number().int().positive().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  phone: z.string().regex(/^\+\d{8,15}$/).nullable(),
  email: z.email().nullable(),
  /** Hash do recibo de origem relido, nunca segredo ou corpo com dados pessoais. */
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ProvaFinanceira = z.infer<typeof provaSchema>;

export interface IntegracaoFinanceira {
  /** Ausente e false recusam antes de consultar o banco ou o provedor. */
  enabled?: boolean;
  integrationId: string;
  organizationId: string;
  provider: "guru" | "boleto";
  sourceAccountId: string;
  /** Credencial exclusiva da integração, separada do MCP e da assinatura abaixo. */
  tokenSha256: string;
  receiptSigningKey: string;
  products: Array<{
    productId: string;
    offerId: string | null;
    crmProductKey: string;
    crmOfferKey: string;
    commercialFlowIds: string[];
  }>;
  /** Obrigatório. A implementação real deve autenticar a API e reler por ID. */
  readAuthoritativePayment?: (transactionId: string, signal: AbortSignal) => Promise<unknown>;
}

export class CompraRecusada extends Error {
  constructor(public readonly code: string) { super(code); }
}
function recusar(code: string): never { throw new CompraRecusada(code); }
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const emailNormal = (v: unknown) => typeof v === "string" ? v.trim().toLowerCase() : null;

type EtapaDaEscrita = "recibo" | "vinculo" | "ganho" | "cancelamento";
interface Deps {
  pool: pg.Pool;
  integration: IntegracaoFinanceira;
  now?: () => Date;
  /** Instrumentação local: falhas provocadas verificam o rollback real. */
  afterWrite?: (stage: EtapaDaEscrita) => Promise<void>;
}
export type CompraAplicada = {
  status: "applied" | "replay";
  orderId: string;
  leadId: string;
  cancelledEnrollments: string[];
  cancelledCallbacks: string[];
  cancelledJobs: string[];
};

function assinatura(corpo: unknown, key: string): string {
  return createHmac("sha256", key).update(hashDoCorpo(corpo)).digest("hex");
}
function igualSeguro(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function relerFonte(cfg: IntegracaoFinanceira, transactionId: string, lockSignal: AbortSignal): Promise<unknown> {
  const signal = AbortSignal.any([lockSignal, AbortSignal.timeout(8_000)]);
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      cfg.readAuthoritativePayment!(transactionId, signal),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, {once: true});
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

/** Não aceita organization_id, produto ou confirmação no corpo do chamador. */
export async function registrarCompraVerificada(
  deps: Deps,
  request: { token: string; transactionId: string; leadId: string },
): Promise<CompraAplicada> {
  const cfg = deps.integration;
  if (cfg.enabled !== true) recusar("financial_integration_disabled");
  if (!/^[a-f0-9]{64}$/.test(cfg.tokenSha256) || cfg.receiptSigningKey.length < 32 ||
      !cfg.integrationId || !cfg.organizationId || !cfg.sourceAccountId) recusar("financial_configuration_invalid");
  if (!igualSeguro(createHash("sha256").update(request.token).digest("hex"), cfg.tokenSha256)) recusar("financial_unauthorized");
  if (!cfg.readAuthoritativePayment) recusar("financial_source_unavailable");
  if (!z.uuid().safeParse(request.leadId).success || !request.transactionId || request.transactionId.length > 200) recusar("financial_invalid_request");
  const org = cfg.organizationId;
  const inicial = await deps.pool.query<{contact_id: string | null}>(
    "select contact_id from crm_leads where organization_id=$1 and id=$2", [org, request.leadId],
  );
  const contactId = inicial.rows[0]?.contact_id;
  if (!contactId) recusar("financial_lead_not_found");

  const locked = await comTravaDeEfeito(deps.pool, `callback:${org}:${contactId}`, async trava => {
    let bruto: unknown;
    try {
      bruto = await relerFonte(cfg, request.transactionId, trava.signal);
    } catch { return recusar("financial_source_unavailable"); }
    const parsed = provaSchema.safeParse(bruto);
    if (!parsed.success) recusar("financial_evidence_invalid");
    const proof = parsed.data;
    const now = (deps.now ?? (() => new Date()))();
    const observed = Date.parse(proof.observedAt), paid = Date.parse(proof.paidAt), ordered = Date.parse(proof.orderedAt);
    if (proof.transactionId !== request.transactionId || proof.sourceAccountId !== cfg.sourceAccountId ||
        now.getTime() - observed > 60_000 || observed > now.getTime() + 5_000 ||
        paid > observed || ordered > paid || proof.paidCents !== proof.totalCents) recusar("financial_evidence_invalid");
    const produtos = cfg.products.filter(p => p.productId === proof.productId && p.offerId === proof.offerId);
    const produto = produtos.length === 1 ? produtos[0] : undefined;
    if (!produto?.crmProductKey || !produto.crmOfferKey) recusar("financial_product_unmapped");
    if (!Array.isArray(produto.commercialFlowIds) || produto.commercialFlowIds.some(id => !z.uuid().safeParse(id).success)) recusar("financial_configuration_invalid");
    const db = trava.db;
    await trava.conferir();
    await db.query("begin");
    try {
      await db.query("set local lock_timeout='5s'");
      await db.query("set local statement_timeout='10s'");
      // Outra pessoa/oportunidade não pode consumir a mesma transação.
      const externalId = `${cfg.integrationId}:${proof.transactionId}`;
      await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`purchase:${org}:${externalId}`]);
      const lead = (await db.query(
        "select * from crm_leads where organization_id=$1 and id=$2 for update", [org, request.leadId],
      )).rows[0];
      if (!lead || lead.contact_id !== contactId) recusar("financial_lead_changed");
      const contact = (await db.query(
        "select id, phone_number, email, is_anonymized, is_merged_into from contacts where organization_id=$1 and id=$2 for update",
        [org, contactId],
      )).rows[0];
      if (!contact || contact.is_anonymized || contact.is_merged_into) recusar("financial_identity_unavailable");
      const phoneMatch = !!proof.phone && proof.phone === contact.phone_number;
      const emailMatch = !!proof.email && emailNormal(proof.email) === emailNormal(contact.email);
      if ((!phoneMatch && !emailMatch) ||
          (proof.phone && contact.phone_number && !phoneMatch) ||
          (proof.email && contact.email && !emailMatch)) recusar("financial_identity_mismatch");
      const identidades = await db.query(
        `select id from contacts where organization_id=$1 and not is_anonymized and is_merged_into is null
         and (($2::text is not null and phone_number=$2) or ($3::text is not null and email_normalized=$3))`,
        [org, proof.phone, emailNormal(proof.email)],
      );
      if (identidades.rows.length !== 1 || identidades.rows[0]?.id !== contactId) recusar("financial_identity_ambiguous");
      const fields = record(lead.custom_fields);
      if (fields.produto_chave !== produto.crmProductKey || fields.plano_oferecido !== produto.crmOfferKey ||
          lead.currency !== proof.currency || ordered < new Date(lead.created_at as string).getTime()) recusar("financial_opportunity_mismatch");
      const binding = {
        version: 1, integration: cfg.integrationId, provider: cfg.provider, account: cfg.sourceAccountId,
        transaction: proof.transactionId, organization: org, contact: contactId, lead: request.leadId,
        product: proof.productId, offer: proof.offerId, crmProduct: produto.crmProductKey, crmOffer: produto.crmOfferKey,
        paidAt: proof.paidAt, orderedAt: proof.orderedAt, paidCents: proof.paidCents, totalCents: proof.totalCents, currency: proof.currency,
        identity: assinatura({phone: proof.phone, email: emailNormal(proof.email)}, cfg.receiptSigningKey),
      };
      const existing = (await db.query(
        "select id, contact_id, status, total_cents, currency, payload from orders where organization_id=$1 and external_provider='external' and external_id=$2 for update", [org, externalId],
      )).rows[0];
      if (existing) {
        const receipt = record(record(existing.payload).financial_receipt);
        if (!receipt.binding || typeof receipt.binding !== "object" || hashDoCorpo(receipt.binding) !== hashDoCorpo(binding) ||
            typeof receipt.signature !== "string" || !igualSeguro(receipt.signature, assinatura(receipt.binding, cfg.receiptSigningKey)) ||
            existing.contact_id !== contactId || existing.status !== "paid" || lead.status !== "won" || fields.pagamento_confirmado !== true ||
            String(existing.total_cents) !== String(proof.totalCents) || existing.currency !== proof.currency) recusar("financial_receipt_conflict");
        const link = await db.query("select id from crm_lead_links where organization_id=$1 and lead_id=$2 and target_kind='order' and target_id=$3 and link_kind='financial_confirmation'", [org, request.leadId, existing.id]);
        if (link.rows.length !== 1) recusar("financial_receipt_incomplete");
        await db.query("commit");
        return { status: "replay" as const, orderId: existing.id as string, leadId: request.leadId, cancelledEnrollments: [], cancelledCallbacks: [], cancelledJobs: [] };
      }
      if (lead.status !== "open") recusar("financial_opportunity_closed");
      const abertos = await db.query("select id from crm_leads where organization_id=$1 and contact_id=$2 and status='open' for update", [org, contactId]);
      if (abertos.rows.length !== 1) recusar("financial_opportunity_ambiguous");
      const funil = (await db.query("select settings from crm_pipelines where organization_id=$1 and id=$2 for share", [org, lead.pipeline_id])).rows[0];
      if (!funil?.settings || typeof funil.settings !== "object") recusar("financial_pipeline_unavailable");
      const etapa = (await db.query("select id from crm_stages where organization_id=$1 and pipeline_id=$2 and is_won=true and is_archived=false order by position,id limit 1", [org, lead.pipeline_id])).rows[0];
      if (!etapa) recusar("financial_won_stage_unavailable");
      // Só esta chamada, depois de autenticação + prova + vínculo, satisfaz a
      // exigência financeira. Os demais campos obrigatórios continuam exigidos.
      const settings = record(funil.settings);
      const semReserva = {...settings, fields: Array.isArray(settings.fields) ? settings.fields.filter(f => !campoDeConfirmacaoFinanceira(String(record(f).key))) : settings.fields};
      if (validaCamposExigidos({lead, settingsDoFunil: semReserva, destino: {stageId: etapa.id, desfecho: "won"}}).faltando.length) recusar("financial_required_fields_missing");
      if (recusaDeMotivoDoGanho({motivo: lead.won_reason, settingsDoFunil: settings})) recusar("financial_won_reason_invalid");
      const enrollments = await db.query(
        `select id, status, claimed_until from followup_enrollments where organization_id=$1 and contact_id=$2
         and pointer_id=any($3::uuid[]) for update`,
        [org, contactId, produto.commercialFlowIds],
      );
      const vivos = enrollments.rows.filter(r => ['active','waiting_reply','dormente','paused_handoff','paused_manual','coletando'].includes(r.status));
      if (vivos.some(r => r.claimed_until && new Date(r.claimed_until).getTime() > now.getTime())) recusar("financial_followup_busy");
      const callbacks = await db.query(
        `select id, enabled from cron_jobs where organization_id=$1 and contact_id=$2 and kind='at' and job_kind='followup_turn'
         and payload->>'scope'='commercial' and payload->>'lead_id'=$3 and payload->>'product_key'=$4 for update`,
        [org, contactId, request.leadId, produto.crmProductKey],
      );
      const enrollmentIds = vivos.map(r => r.id as string), callbackIds = callbacks.rows.filter(r => r.enabled).map(r => r.id as string);
      const jobs = await db.query(
        `select id,status from job_queue where organization_id=$1 and contact_id=$2 and kind='followup_turn' and status in ('pending','running')
         and (payload->>'followup_enrollment_id'=any($3::text[]) or payload->>'cron_job_id'=any($4::text[])
           or (payload->>'scope'='commercial' and payload->>'lead_id'=$5 and payload->>'product_key'=$6)) for update`,
        [org, contactId, enrollments.rows.map(r => r.id), callbacks.rows.map(r => r.id), request.leadId, produto.crmProductKey],
      );
      if (jobs.rows.some(r => r.status === "running")) recusar("financial_followup_busy");
      const order = (await db.query(
        `insert into orders (organization_id,external_provider,external_id,contact_id,status,total_cents,currency,ordered_at,updated_at_remote,payload)
         values ($1,'external',$2,$3,'paid',$4,$5,$6,$7,$8::jsonb) returning id`,
        [org, externalId, contactId, proof.totalCents, proof.currency, proof.orderedAt, proof.observedAt,
          JSON.stringify({platform: cfg.provider, financial_receipt: {binding, signature: assinatura(binding, cfg.receiptSigningKey), observedAt: proof.observedAt, evidenceHash: proof.evidenceHash}})],
      )).rows[0]!;
      await deps.afterWrite?.("recibo");
      await db.query(`insert into crm_lead_links (organization_id,lead_id,target_kind,target_id,link_kind,metadata)
        values ($1,$2,'order',$3,'financial_confirmation',$4::jsonb)`, [org, request.leadId, order.id, JSON.stringify({integration: cfg.integrationId})]);
      await deps.afterWrite?.("vinculo");
      await db.query(`update crm_leads set custom_fields=coalesce(custom_fields,'{}'::jsonb)||'{"pagamento_confirmado":true}'::jsonb,
        stage_id=$3, updated_at=$4 where organization_id=$1 and id=$2`, [org, request.leadId, etapa.id, now]);
      await deps.afterWrite?.("ganho");
      await db.query(`update followup_enrollments set status='cancelled',cancel_reason='purchase_confirmed',outcome='converted',
        next_eval_at=null,claimed_until=null,completed_at=$3,updated_at=$3 where organization_id=$1 and id=any($2::uuid[])`, [org, enrollmentIds, now]);
      await db.query(`update cron_jobs set enabled=false,cancelled_at=$3,cancel_reason='purchase_confirmed',updated_at=$3
        where organization_id=$1 and id=any($2::uuid[])`, [org, callbackIds, now]);
      const jobIds = jobs.rows.map(r => r.id as string);
      await db.query(`update job_queue set status='failed',last_error='purchase_confirmed',locked_at=null,locked_by=null
        where organization_id=$1 and id=any($2::uuid[]) and status='pending'`, [org, jobIds]);
      await deps.afterWrite?.("cancelamento");
      await trava.conferir();
      await db.query("commit");
      return {status: "applied" as const, orderId: order.id as string, leadId: request.leadId,
        cancelledEnrollments: enrollmentIds, cancelledCallbacks: callbackIds, cancelledJobs: jobIds};
    } catch (error) {
      await db.query("rollback").catch(() => undefined);
      throw error;
    }
  });
  if (locked.ocupado) recusar("financial_contact_busy");
  return locked.resultado;
}
