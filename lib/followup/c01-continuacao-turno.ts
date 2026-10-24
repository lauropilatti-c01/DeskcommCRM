import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { hashDoCorpo } from "@/lib/api/idempotency";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { hashDoConteudoDaOrigem, type ConfigOrigemC01 } from "./c01-origem";
import { propostaContinuacaoC01Schema } from "./c01-continuacao";

export interface EscopoTurnoContinuacaoC01 {
  organizationId: string;
  contactId: string;
  conversationId: string;
  jobId: string;
  workerId: string;
  acquiredAt: string;
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const candidaturaContinuacaoSchema = z.strictObject({
  version: z.literal(1),
  organizationId: z.uuid(),
  contactId: z.uuid(),
  conversationId: z.uuid(),
  leadId: z.uuid(),
  productKey: z.string().min(1).max(200).nullable(),
  financialScope: z.enum(["sem_oferta", "oferta_exata"]),
  jobId: z.uuid(),
  attempt: z.number().int().nonnegative(),
  inboundMessageId: z.uuid(),
  inboundHash: hash,
  finalMessageId: z.uuid(),
  finalHash: hash,
  concludedAt: z.iso.datetime(),
  activatedAt: z.iso.datetime(),
  proposal: propostaContinuacaoC01Schema,
  signature: hash,
});
export type CandidaturaContinuacaoC01 = z.infer<typeof candidaturaContinuacaoSchema>;

export function continuacaoDoTurnoHabilitada(
  cfg: ConfigOrigemC01 | null,
  organizationId: string,
): boolean {
  return !!(
    cfg?.enabled &&
    cfg.organizationId === organizationId &&
    cfg.continuation?.enabled &&
    cfg.continuation.policyStatus === "approved" &&
    cfg.continuation.activatedAt
  );
}

/** O job ainda está running: isto registra candidatura, nunca matrícula. */
export async function gravarCandidaturaContinuacaoC01(
  db: Queryable,
  cfg: ConfigOrigemC01 | null,
  scope: EscopoTurnoContinuacaoC01,
  proposal: unknown,
  now: Date,
): Promise<{ status: "off" | "blocked" | "recorded"; reason?: string }> {
  if (!cfg || !continuacaoDoTurnoHabilitada(cfg, scope.organizationId)) return { status: "off" };
  const block = (reason: string) => ({ status: "blocked" as const, reason });
  const parsed = propostaContinuacaoC01Schema.safeParse(proposal);
  if (!parsed.success || parsed.data.estado !== "pendente") return block("sem_pedido_aberto");
  const p = parsed.data;
  const job = (
    await db.query(
      `/* c01:continuacao:job */
    select id,kind,status,locked_by,locked_at::text as claim_acquired_at,created_at,attempts,payload
    from job_queue where organization_id=$1 and contact_id=$2 and id=$3`,
      [scope.organizationId, scope.contactId, scope.jobId],
    )
  ).rows[0];
  if (
    !job ||
    job.kind !== "inbound_turn" ||
    job.status !== "running" ||
    job.locked_by !== scope.workerId ||
    job.claim_acquired_at !== scope.acquiredAt ||
    job.payload?.conversation_id !== scope.conversationId ||
    job.payload?.inbound_message_id !== p.mensagem_entrada_id
  )
    return block("turno_ou_lease_invalido");
  const activatedAt = cfg.continuation!.activatedAt!;
  if (
    !Number.isFinite(+now) ||
    !Number.isFinite(+new Date(job.created_at)) ||
    +new Date(job.created_at) < Date.parse(activatedAt) ||
    +new Date(job.created_at) > +now
  )
    return block("turno_anterior_a_ativacao");
  const inbound = (
    await db.query(
      `/* c01:continuacao:entrada */
    select * from messages where organization_id=$1 and contact_id=$2 and conversation_id=$3
      and id=$4 and direction='inbound'`,
      [scope.organizationId, scope.contactId, scope.conversationId, p.mensagem_entrada_id],
    )
  ).rows[0];
  if (
    !inbound ||
    inbound.revoked_at ||
    typeof inbound.body !== "string" ||
    !inbound.body.includes(p.trecho_do_pedido)
  )
    return block("pedido_sem_evidencia");
  // A última intenção é decisiva. Uma bolha anterior aceita não cobre a última retida.
  const final = (
    await db.query(
      `/* c01:continuacao:saida */
    select m.*,s.status as ledger_status from send_ledger s left join messages m
      on m.organization_id=s.organization_id and m.contact_id=s.contact_id and m.id=s.crm_message_id
      and m.conversation_id=$3
    where s.organization_id=$1 and s.contact_id=$2 and s.job_id=$4 order by s.seq desc limit 1`,
      [scope.organizationId, scope.contactId, scope.conversationId, scope.jobId],
    )
  ).rows[0];
  if (
    !final?.id ||
    final.ledger_status !== "accepted" ||
    final.direction !== "outbound" ||
    !final.external_id ||
    final.error_code ||
    !["sent", "delivered", "read"].includes(final.status) ||
    !Number.isFinite(+new Date(final.sent_at)) ||
    +new Date(final.sent_at) > +now ||
    +new Date(final.sent_at) < +new Date(inbound.sent_at)
  )
    return block("saida_final_nao_enviada");
  const leads = (
    await db.query(
      `/* c01:continuacao:negocio */
    select id,custom_fields->>'produto_chave' as product_key from crm_leads
    where organization_id=$1 and contact_id=$2 and status='open' order by created_at,id limit 2`,
      [scope.organizationId, scope.contactId],
    )
  ).rows;
  if (leads.length !== 1 || (p.caminho === "L2" && !leads[0]!.product_key))
    return block("negocio_ou_produto_ambiguo");
  const body = {
    version: 1 as const,
    organizationId: scope.organizationId,
    contactId: scope.contactId,
    conversationId: scope.conversationId,
    leadId: leads[0]!.id as string,
    productKey:
      typeof leads[0]!.product_key === "string" && leads[0]!.product_key.trim()
        ? (leads[0]!.product_key as string)
        : null,
    financialScope: p.caminho === "L1" ? ("sem_oferta" as const) : ("oferta_exata" as const),
    jobId: scope.jobId,
    attempt: Number(job.attempts),
    inboundMessageId: inbound.id as string,
    inboundHash: hashDoConteudoDaOrigem(inbound),
    finalMessageId: final.id as string,
    finalHash: hashDoConteudoDaOrigem(final),
    concludedAt: now.toISOString(),
    activatedAt,
    proposal: p,
  };
  const proof = {
    ...body,
    signature: createHmac("sha256", cfg.signingKey).update(hashDoCorpo(body)).digest("hex"),
  };
  if (!candidaturaContinuacaoSchema.safeParse(proof).success) return block("prova_incompleta");
  const changed = await db.query(
    `/* c01:continuacao:gravar */
    update job_queue set payload=jsonb_set(payload,'{c01_continuation}',$6::jsonb)
    where organization_id=$1 and contact_id=$2 and id=$3 and status='running'
      and locked_by=$4 and locked_at=$5::timestamptz returning id`,
    [scope.organizationId, scope.contactId, scope.jobId, scope.workerId, scope.acquiredAt, proof],
  );
  return changed.rows.length === 1 ? { status: "recorded" } : block("lease_perdido");
}

export function conferirCandidaturaContinuacaoC01(
  cfg: ConfigOrigemC01,
  raw: unknown,
): CandidaturaContinuacaoC01 | null {
  const parsed = candidaturaContinuacaoSchema.safeParse(raw);
  if (
    !parsed.success ||
    !continuacaoDoTurnoHabilitada(cfg, parsed.data.organizationId) ||
    parsed.data.activatedAt !== cfg.continuation?.activatedAt
  )
    return null;
  const { signature, ...body } = parsed.data;
  const expected = createHmac("sha256", cfg.signingKey).update(hashDoCorpo(body)).digest();
  return timingSafeEqual(Buffer.from(signature, "hex"), expected) ? parsed.data : null;
}
