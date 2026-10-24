import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { hashDoCorpo } from "@/lib/api/idempotency";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import {
  conferirOrigemC01,
  hashDoConteudoDaOrigem,
  type ConfigOrigemC01,
  type ProvaOrigemC01,
} from "./c01-origem";
import {
  candidaturaContinuacaoSchema,
  conferirCandidaturaContinuacaoC01,
  type CandidaturaContinuacaoC01,
} from "./c01-continuacao-turno";
import { estadoDoToque, type Toque } from "./c01-acompanhamento";
import type { FatosContinuacaoC01 } from "./c01-continuacao";
import { rotaDeContinuacaoC01 } from "./c01-continuacao-grafo";

export const isoContinuacao = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;
const vinculoSchema = z.strictObject({
  version: z.literal(1),
  enrollmentId: z.uuid(),
  candidate: candidaturaContinuacaoSchema,
  ancestors: z.array(z.uuid()).max(64),
  original: z.unknown().nullable(),
  notBefore: z.iso.datetime(),
  firstTouch: z.number().int().min(1).max(4),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});
export type VinculoContinuacaoC01 = Omit<z.infer<typeof vinculoSchema>, "original"> & {
  original: ProvaOrigemC01 | null;
};
export function assinarVinculoContinuacaoC01(
  cfg: ConfigOrigemC01,
  input: Omit<VinculoContinuacaoC01, "version" | "signature">,
): VinculoContinuacaoC01 {
  const body = { version: 1 as const, ...input };
  return {
    ...body,
    signature: createHmac("sha256", cfg.signingKey).update(hashDoCorpo(body)).digest("hex"),
  };
}
export function conferirVinculoContinuacaoC01(
  cfg: ConfigOrigemC01,
  raw: unknown,
): VinculoContinuacaoC01 | null {
  const parsed = vinculoSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { signature, ...body } = parsed.data;
  const expected = createHmac("sha256", cfg.signingKey).update(hashDoCorpo(body)).digest();
  if (!timingSafeEqual(Buffer.from(signature, "hex"), expected)) return null;
  const p = conferirCandidaturaContinuacaoC01(cfg, body.candidate);
  if (
    !p ||
    p.proposal.estado !== "pendente" ||
    new Set(body.ancestors).size !== body.ancestors.length
  )
    return null;
  const original = body.original == null ? null : conferirOrigemC01(cfg, body.original);
  if (p.proposal.caminho === "L1") {
    if (
      body.original !== null ||
      body.ancestors.length ||
      body.firstTouch !== 1 ||
      p.financialScope !== "sem_oferta"
    )
      return null;
  } else if (
    !original ||
    original.kind !== "oferta" ||
    !body.ancestors.length ||
    p.financialScope !== "oferta_exata" ||
    original.organizationId !== p.organizationId ||
    original.contactId !== p.contactId ||
    original.conversationId !== p.conversationId ||
    original.leadId !== p.leadId ||
    original.productKey !== p.productKey
  )
    return null;
  return { ...parsed.data, original };
}

/** Relê fontes do turno, inclusive tentativa: uma execução posterior não herda a proposta anterior. */
export async function lerTurnoContinuacaoC01(
  db: Queryable,
  cfg: ConfigOrigemC01,
  jobId: string,
  now: Date,
  enrollmentId?: string,
) {
  const job = (
    await db.query(
      `/* c01:continuacao:concluido */ select * from job_queue where organization_id=$1 and id=$2`,
      [cfg.organizationId, jobId],
    )
  ).rows[0];
  const p = conferirCandidaturaContinuacaoC01(cfg, job?.payload?.c01_continuation);
  if (
    !p ||
    job?.payload?.c01_continuation_omitted ||
    job?.status !== "done" ||
    job.kind !== "inbound_turn" ||
    job.contact_id !== p.contactId ||
    job.attempts !== p.attempt ||
    job.payload?.conversation_id !== p.conversationId ||
    job.payload?.inbound_message_id !== p.inboundMessageId
  )
    return null;
  const rows = (
    await db.query(
      `/* c01:continuacao:mensagens */ select m.*,s.job_id,s.status as ledger_status from messages m
    left join send_ledger s on s.organization_id=m.organization_id and s.contact_id=m.contact_id and s.crm_message_id=m.id and s.job_id=$5
    where m.organization_id=$1 and m.contact_id=$2 and m.conversation_id=$3 and m.id=any($4::uuid[])`,
      [
        p.organizationId,
        p.contactId,
        p.conversationId,
        [p.inboundMessageId, p.finalMessageId],
        p.jobId,
      ],
    )
  ).rows;
  const inbound = rows.find((m) => m.id === p.inboundMessageId),
    final = rows.find((m) => m.id === p.finalMessageId);
  if (
    rows.length !== 2 ||
    !inbound ||
    !final ||
    final.job_id !== p.jobId ||
    final.ledger_status !== "accepted" ||
    hashDoConteudoDaOrigem(inbound) !== p.inboundHash ||
    hashDoConteudoDaOrigem(final) !== p.finalHash
  )
    return null;
  const leads = (
    await db.query(
      `/* c01:continuacao:oportunidades */ select id,custom_fields,status from crm_leads
    where organization_id=$1 and contact_id=$2 and status='open' order by id`,
      [p.organizationId, p.contactId],
    )
  ).rows;
  if (
    leads.length !== 1 ||
    leads[0]?.id !== p.leadId ||
    (leads[0].custom_fields?.produto_chave || null) !== p.productKey
  )
    return null;
  const state = (
    await db.query(
      `/* c01:continuacao:estado */ select c.is_blocked,c.ai_opt_out,c.force_human,c.is_anonymized,c.is_merged_into,
    cv.status,cv.assignee_kind,cv.bot_silenced_until,cv.channel_session_id,cv.last_inbound_at,
    public.fn_service_boundary(cv.organization_id,cv.id) as service_boundary,
    (select id from messages where organization_id=$1 and contact_id=$2 and conversation_id=$3 and direction='inbound' order by sent_at desc,id desc limit 1) as latest_inbound,
    (select id from messages where organization_id=$1 and contact_id=$2 and conversation_id=$3 and direction='outbound' order by sent_at desc,id desc limit 1) as latest_outbound,
    exists(select 1 from agent_cases where organization_id=$1 and conversation_id=$3 and status in ('awaiting_human','awaiting_lead','escalated')) as open_case,
    exists(select 1 from cron_jobs where organization_id=$1 and contact_id=$2 and kind='at' and job_kind='followup_turn' and enabled and cancelled_at is null) as callback,
    exists(select 1 from job_queue where organization_id=$1 and contact_id=$2 and kind='followup_turn' and status in ('pending','running') and not(payload?'followup_enrollment_id') and payload?'promised_at') as callback_queued,
    exists(select 1 from followup_enrollments where organization_id=$1 and contact_id=$2 and ($4::uuid is null or id<>$4) and status in ('active','waiting_reply','paused_handoff','paused_manual','dormente','coletando')) as live
    from conversations cv join contacts c on c.organization_id=cv.organization_id and c.id=cv.contact_id
    where cv.organization_id=$1 and cv.contact_id=$2 and cv.id=$3`,
      [p.organizationId, p.contactId, p.conversationId, enrollmentId ?? null],
    )
  ).rows[0];
  if (!state) return null;
  const facts: FatosContinuacaoC01 = {
    enabled: cfg.enabled,
    approved: cfg.continuation?.policyStatus === "approved",
    activatedAt: p.activatedAt,
    organizationId: p.organizationId,
    contactId: p.contactId,
    conversationId: p.conversationId,
    leadId: p.leadId,
    productKey: p.productKey,
    job: {
      id: p.jobId,
      organizationId: p.organizationId,
      contactId: p.contactId,
      conversationId: p.conversationId,
      kind: job.kind,
      status: job.status,
      createdAt: isoContinuacao(job.created_at)!,
      completedAt: p.concludedAt,
      inboundMessageId: p.inboundMessageId,
    },
    inbound: {
      id: inbound.id,
      organizationId: inbound.organization_id,
      contactId: inbound.contact_id,
      conversationId: inbound.conversation_id,
      direction: inbound.direction,
      body: inbound.body ?? "",
      at: isoContinuacao(inbound.sent_at)!,
      revoked: !!inbound.revoked_at,
    },
    final: {
      id: final.id,
      jobId: final.job_id,
      organizationId: final.organization_id,
      contactId: final.contact_id,
      conversationId: final.conversation_id,
      direction: final.direction,
      externalId: final.external_id,
      sentAt: isoContinuacao(final.sent_at)!,
      receipt: {
        index: 0,
        messageIds: [final.id],
        receipts: [
          {
            id: final.id,
            status: final.status,
            delivered_at: isoContinuacao(final.delivered_at),
            read_at: isoContinuacao(final.read_at),
            error_code: final.error_code == null ? null : String(final.error_code),
          },
        ],
      },
    },
    latestInboundId: state.latest_inbound,
    latestOutboundId: state.latest_outbound,
    human: !!state.force_human || ["human", "user"].includes(state.assignee_kind),
    openCase: !!state.open_case,
    refused: !!state.ai_opt_out,
    restricted:
      !!state.is_blocked ||
      !!state.is_anonymized ||
      !!state.is_merged_into ||
      !["open", "pending", "ai_handling"].includes(state.status),
    pause:
      state.bot_silenced_until === "infinity" ||
      (!!state.bot_silenced_until && +new Date(state.bot_silenced_until) > +now),
    purchaseReported: p.proposal.estado === "compra_informada",
    callback: !!state.callback || !!state.callback_queued,
    liveSequence: !!state.live,
    offer: null,
  };
  return { candidate: p, facts, state, inbound, final };
}

/** Recibos continuam no enrollment que realmente os produziu; não são copiados. */
export async function lerToquesDaCadeiaC01(
  db: Queryable,
  org: string,
  contact: string,
  enrollments: string[],
  currentInFlight = false,
): Promise<Toque[] | null> {
  if (!enrollments.length) return [];
  const closed = (
    await db.query(
      `/* c01:continuacao:toques */ select enrollment_id,node_id,min(created_at) as at
    from followup_enrollment_events where organization_id=$1 and enrollment_id=any($2::uuid[]) and event_type='action_sent'
    group by enrollment_id,node_id order by array_position($2::uuid[],enrollment_id),min(created_at),node_id`,
      [org, enrollments],
    )
  ).rows;
  const all = (
    await db.query(
      `/* c01:continuacao:recibos */ select j.payload->>'followup_enrollment_id' as enrollment_id,j.payload->>'node_id' as node_id,
    sl.id as ledger_id,sl.crm_message_id,sl.status as ledger_status,m.id,m.status,m.delivered_at,m.read_at,m.error_code
    from job_queue j join send_ledger sl on sl.organization_id=j.organization_id and sl.contact_id=j.contact_id and sl.job_id=j.id
    left join messages m on m.organization_id=sl.organization_id and m.contact_id=sl.contact_id and m.id=sl.crm_message_id
    where j.organization_id=$1 and j.contact_id=$2 and j.payload->>'followup_enrollment_id'=any($3::text[]) order by j.created_at,j.id,sl.seq`,
      [org, contact, enrollments],
    )
  ).rows;
  // Um aceite sem conclusão não desaparece do orçamento só porque o cliente respondeu.
  if (new Set(closed.map((c) => c.node_id)).size !== closed.length) return null;
  if (
    all.some(
      (r) =>
        !(currentInFlight && r.enrollment_id === enrollments.at(-1)) &&
        !closed.some((c) => c.enrollment_id === r.enrollment_id && c.node_id === r.node_id),
    )
  )
    return null;
  return closed.map((c, index) => {
    const receipts = all.filter(
      (r) => r.enrollment_id === c.enrollment_id && r.node_id === c.node_id,
    );
    return {
      index: index + 1,
      messageIds: receipts.map((r) => String(r.crm_message_id ?? r.ledger_id)),
      receipts: receipts
        .filter((r) => r.id)
        .map((r) => ({
          id: r.id,
          status: r.status,
          delivered_at: isoContinuacao(r.delivered_at),
          read_at: isoContinuacao(r.read_at),
          error_code: r.error_code == null ? null : String(r.error_code),
        })),
    };
  });
}

/** A folha única da mesma oferta, encerrada por resposta, é a única antecessora admissível. */
export async function lerOfertaAnteriorC01(
  db: Queryable,
  cfg: ConfigOrigemC01,
  p: CandidaturaContinuacaoC01,
) {
  const rows = (
    await db.query(
      `/* c01:continuacao:oferta-anterior */ select e.*,v.graph,p.trigger_config,p.active_version_id,p.status as pointer_status,
    ev.payload as origin,ct.payload as continuation from followup_enrollments e
    join followup_flow_versions v on v.organization_id=e.organization_id and v.id=e.version_id
    join followup_flow_pointers p on p.organization_id=e.organization_id and p.id=e.pointer_id
    join followup_enrollment_events ev on ev.organization_id=e.organization_id and ev.enrollment_id=e.id and ev.event_type='c01_origem_entregue'
    left join followup_enrollment_events ct on ct.organization_id=e.organization_id and ct.enrollment_id=e.id and ct.event_type='c01_continuacao_entregue'
    where e.organization_id=$1 and e.contact_id=$2 and e.conversation_id=$3 and ev.payload->>'kind'='oferta'
    order by e.started_at,e.id`,
      [p.organizationId, p.contactId, p.conversationId],
    )
  ).rows;
  const scoped = rows.filter((r) => {
    const o = conferirOrigemC01(cfg, r.origin);
    return o?.leadId === p.leadId && o.productKey === p.productKey;
  });
  if (!scoped.length || new Set(scoped.map((r) => r.origin.messageId)).size !== 1) return null;
  if (
    scoped.some(
      (r) =>
        r.continuation && conferirVinculoContinuacaoC01(cfg, r.continuation)?.enrollmentId !== r.id,
    )
  )
    return null;
  const leaves = scoped.filter(
    (r) =>
      !scoped.some((s) => {
        const c = conferirVinculoContinuacaoC01(cfg, s.continuation);
        return c?.ancestors.includes(r.id);
      }),
  );
  if (leaves.length !== 1) return null;
  const previous = leaves[0]!,
    origin = conferirOrigemC01(cfg, previous.origin)!;
  if (
    previous.status !== "cancelled" ||
    !["cancel_on_reply", "respondeu"].includes(previous.cancel_reason) ||
    previous.pointer_status !== "active" ||
    previous.active_version_id !== previous.version_id ||
    previous.trigger_config?.cancel_on_reply !== true
  )
    return null;
  const prior = previous.continuation
    ? conferirVinculoContinuacaoC01(cfg, previous.continuation)
    : null;
  if (previous.continuation && !prior) return null;
  const ancestors = [...(prior?.ancestors ?? []), previous.id as string];
  if (
    ancestors.length > 64 ||
    new Set(ancestors).size !== ancestors.length ||
    ancestors.some((id) => !scoped.some((r) => r.id === id))
  )
    return null;
  const touches = await lerToquesDaCadeiaC01(db, p.organizationId, p.contactId, ancestors);
  if (
    !touches ||
    touches.some((t) => estadoDoToque(t) !== "delivered") ||
    !rotaDeContinuacaoC01(previous.graph, "L2", touches.length + 1)
  )
    return null;
  const message = (
    await db.query(
      `select * from messages where organization_id=$1 and contact_id=$2 and conversation_id=$3 and id=$4`,
      [p.organizationId, p.contactId, p.conversationId, origin.messageId],
    )
  ).rows[0];
  if (
    !message ||
    origin.contentHash !== hashDoConteudoDaOrigem(message) ||
    !message.external_id ||
    message.direction !== "outbound"
  )
    return null;
  const receipt = {
    id: message.id,
    status: message.status,
    delivered_at: isoContinuacao(message.delivered_at),
    read_at: isoContinuacao(message.read_at),
    error_code: message.error_code == null ? null : String(message.error_code),
  };
  if (estadoDoToque({ index: 0, messageIds: [message.id], receipts: [receipt] }) !== "delivered")
    return null;
  const delivery = Math.max(
    ...[receipt.delivered_at, receipt.read_at]
      .filter((x): x is string => !!x && Number.isFinite(Date.parse(x)))
      .map(Date.parse),
  );
  return {
    previous,
    origin,
    ancestors,
    touches,
    message,
    deliveredAt: new Date(delivery).toISOString(),
  };
}
