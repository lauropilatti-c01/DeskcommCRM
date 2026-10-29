import type pg from "pg";
import { randomUUID } from "node:crypto";
import { comTravaDeEfeito } from "@/lib/agent-engine/db/trava-de-efeito";
import { c01AcompanhamentoSchema } from "./c01-acompanhamento";
import {
  assinarOrigemC01,
  conferirOrigemC01,
  configOrigemC01,
  hashDoConteudoDaOrigem,
  type ConfigOrigemC01,
  type OrigemC01,
} from "./c01-origem";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { flowGraphSchema } from "./graph-schema";
import { parseServiceBoundary } from "@/lib/atendimento/fronteira";
import { politicaDoVideoValidaC01, videoDaOrigemValido } from "./c01-video-curso";

export class OrigemRecusada extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
const recusar = (code: string): never => {
  throw new OrigemRecusada(code);
};

/** Origem e matrícula são atômicas. Nenhum campo comercial ou mensagem é alterado. */
export async function registrarOrigemEntregueC01(
  pool: pg.Pool,
  cfg: ConfigOrigemC01,
  input: OrigemC01 & { messageId: string },
  now = new Date(),
): Promise<{ status: "enrolled" | "replay"; enrollment_id: string }> {
  if (!cfg.enabled) recusar("integration_disabled");
  if (!cfg.allowedKinds.includes(input.kind)) recusar("origin_kind_forbidden");
  const org = cfg.organizationId;
  const initial = (
    await pool.query("select contact_id from messages where organization_id=$1 and id=$2", [
      org,
      input.messageId,
    ])
  ).rows[0];
  if (!initial?.contact_id) recusar("message_not_found");
  const held = await comTravaDeEfeito(
    pool,
    `callback:${org}:${initial.contact_id}`,
    async (lock) => {
      const db = lock.db;
      await db.query("begin");
      try {
        const previous = (
          await db.query(
            `select enrollment_id,payload from followup_enrollment_events
        where organization_id=$1 and event_type='c01_origem_entregue' and idempotency_key=$2`,
            [org, `c01-origin:${input.kind}:${input.messageId}`],
          )
        ).rows;
        if (previous.length > 1) recusar("origin_conflict");
        if (previous[0]) {
          const proof = conferirOrigemC01(cfg, previous[0].payload);
          if (!proof || proof.leadId !== input.leadId || proof.productKey !== input.productKey || proof.videoKey !== input.videoKey)
            recusar("origin_conflict");
          await db.query("commit");
          return { status: "replay" as const, enrollment_id: previous[0].enrollment_id as string };
        }
        const row = (
          await db.query(
            `select m.*,l.custom_fields,l.status as lead_status,
        cv.status as conversation_status,cv.service_revision,cv.current_demanda_id,
        d.revision as demanda_revision,d.fechada_em,cv.assignee_kind,cv.bot_silenced_until,cv.last_inbound_at,
        c.is_blocked,c.ai_opt_out,c.force_human,c.is_anonymized,c.is_merged_into
        from messages m join crm_leads l on l.organization_id=m.organization_id and l.contact_id=m.contact_id
        join contacts c on c.organization_id=m.organization_id and c.id=m.contact_id
        join conversations cv on cv.organization_id=m.organization_id and cv.id=m.conversation_id and cv.contact_id=m.contact_id
        left join demandas d on d.organization_id=cv.organization_id and d.id=cv.current_demanda_id
        where m.organization_id=$1 and m.id=$2 and l.id=$3 for update of cv,l`,
            [org, input.messageId, input.leadId],
          )
        ).rows[0];
        if (
          !row ||
          row.contact_id !== initial.contact_id ||
          row.custom_fields?.produto_chave !== input.productKey
        )
          recusar("origin_scope_mismatch");
        const delivered = row.delivered_at ?? row.read_at;
        if (
          !delivered ||
          !row.external_id ||
          row.direction !== "outbound" ||
          row.error_code ||
          // a Cloud API grava só `sent | failed` (lib/channels/meta/status-update.ts): a entrega é a data
          !["sent", "delivered", "read"].includes(row.status)
        )
          recusar("delivery_unconfirmed");
        if (new Date(delivered) > now || new Date(row.sent_at) > new Date(delivered))
          recusar("origin_clock_invalid");
        if (
          ["won", "lost"].includes(row.lead_status) ||
          row.is_blocked ||
          row.ai_opt_out ||
          row.force_human ||
          row.is_anonymized ||
          row.is_merged_into ||
          row.fechada_em ||
          !["open", "pending", "ai_handling"].includes(row.conversation_status) ||
          ["human", "user"].includes(row.assignee_kind) ||
          row.bot_silenced_until === "infinity" ||
          (row.bot_silenced_until && new Date(row.bot_silenced_until) > now)
        )
          recusar("contact_restricted");
        if (!row.last_inbound_at || new Date(row.last_inbound_at) > new Date(row.sent_at))
          recusar("new_reply");
        if (input.kind === "video_curso") {
          const proof = conferirOrigemC01(cfg, row.metadata?.c01_origin);
          if (!proof || proof.kind !== input.kind || proof.videoKey !== input.videoKey ||
            proof.leadId !== input.leadId || proof.productKey !== input.productKey ||
            proof.messageId !== input.messageId || proof.contactId !== row.contact_id ||
            proof.conversationId !== row.conversation_id || proof.contentHash !== hashDoConteudoDaOrigem(row) ||
            !videoDaOrigemValido(cfg, proof, row)) recusar("video_origin_untrusted");
          const seen = (await db.query(`select enrollment_id,payload from followup_enrollment_events
            where organization_id=$1 and event_type='c01_origem_entregue'
              and payload->>'kind'='video_curso' and payload->>'contactId'=$2
              and payload->>'conversationId'=$3 and payload->>'leadId'=$4 and payload->>'videoKey'=$5`,
            [org,row.contact_id,row.conversation_id,input.leadId,input.videoKey])).rows;
          const prior = seen.find(e => conferirOrigemC01(cfg,e.payload));
          if (prior) {
            await db.query("commit");
            return {status:"replay" as const,enrollment_id:prior.enrollment_id as string};
          }
          const omitted = (await db.query(`select * from messages where organization_id=$1 and contact_id=$2
            and conversation_id=$3 and id<>$4 and metadata->'c01_video_omitted' is not null
            and metadata->'c01_origin'->>'leadId'=$5 and metadata->'c01_origin'->>'videoKey'=$6`,
            [org,row.contact_id,row.conversation_id,input.messageId,input.leadId,input.videoKey])).rows;
          if (omitted.some(m => conferirOrigemC01(cfg,m.metadata?.c01_origin))) recusar("video_already_omitted");
        }
        const versions = (
          await db.query(
            `select p.id,p.active_version_id,v.graph from followup_flow_pointers p
        join followup_flow_versions v on v.organization_id=p.organization_id and v.id=p.active_version_id
        where p.organization_id=$1 and p.status='active' and v.graph->'settings'->'c01_acompanhamento'->>'kind'=$2`,
            [org, input.kind],
          )
        ).rows;
        if (versions.length !== 1) recusar("active_policy_not_unique");
        const version = versions[0]!;
        const graph = flowGraphSchema.parse(version.graph);
        const policy = c01AcompanhamentoSchema.parse(graph.settings?.c01_acompanhamento);
        if (input.kind === "video_curso" && !politicaDoVideoValidaC01(graph,cfg)) recusar("video_policy_invalid");
        if (!policy.activated_at || new Date(row.sent_at) < new Date(policy.activated_at))
          recusar("origin_before_activation");
        const trigger = graph.nodes.find((n) => n.type === "trigger");
        if (!trigger) recusar("policy_without_trigger");
        const callback = (
          await db.query(
            `select 1 from cron_jobs where organization_id=$1 and contact_id=$2 and kind='at'
        and job_kind='followup_turn' and enabled and cancelled_at is null
        union all select 1 from job_queue where organization_id=$1 and contact_id=$2 and kind='followup_turn'
        and status in ('pending','running') and not(payload ? 'followup_enrollment_id') and payload ? 'promised_at' limit 1`,
            [org, row.contact_id],
          )
        ).rows;
        if (callback.length) recusar("callback_has_priority");
        const lives = (
          await db.query(
            `select e.id,v.graph from followup_enrollments e join followup_flow_versions v
        on v.organization_id=e.organization_id and v.id=e.version_id where e.organization_id=$1 and e.contact_id=$2
        and e.status in ('active','waiting_reply','paused_handoff','paused_manual','dormente','coletando') for update of e`,
            [org, row.contact_id],
          )
        ).rows;
        for (const live of lives) {
          const old = c01AcompanhamentoSchema.safeParse(live.graph?.settings?.c01_acompanhamento);
          if (input.kind !== "oferta" || !old.success || !["cronograma","video_curso"].includes(old.data.kind))
            recusar("another_sequence_live");
          const reason = old.success && old.data.kind === "video_curso" ? "oferta_substitui_toque_do_video" : "oferta_substitui_retomada_do_cronograma";
          if (old.success && old.data.kind === "video_curso") {
            const prior = (await db.query(`select payload from followup_enrollment_events where organization_id=$1
              and enrollment_id=$2 and event_type='c01_origem_entregue'`,[org,live.id])).rows;
            if (prior.length !== 1 || !conferirOrigemC01(cfg,prior[0].payload) ||
              new Date(prior[0].payload.createdAt) >= new Date(row.sent_at)) recusar("offer_not_newer_than_video");
          }
          await db.query(
            `update followup_enrollments set status='cancelled',cancel_reason=$4,
          completed_at=$3,next_eval_at=null,claimed_until=null where organization_id=$1 and id=$2`,
            [org, live.id, now, reason],
          );
          await db.query(`insert into followup_enrollment_events
            (organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
            values($1,$2,'c01-origin','c01_sequencia_substituida',$3,$4)`,
            [org,live.id,{reason,messageId:input.messageId},`c01-replace:${input.messageId}`]);
          await db.query(
            `update job_queue set status='done',last_error='c01_origin_replaced' where organization_id=$1 and contact_id=$2
          and kind='followup_turn' and payload->>'followup_enrollment_id'=$3 and status in ('pending','running')`,
            [org, row.contact_id, live.id],
          );
        }
        const agents = (
          await db.query(
            `select a.id from ai_agents a join ai_agent_versions v
        on v.organization_id=a.organization_id and v.id=a.published_version_id
        where a.organization_id=$1 and a.paused_at is null and a.archived_at is null
          and a.operation_mode='automatic' and v.followup->>'enabled'='true'
          and v.followup->'flow_pointer_ids' ? $2 order by a.id limit 2`,
            [org, version.id],
          )
        ).rows;
        if (agents.length !== 1) recusar("active_agent_not_unique");
        const id = randomUUID();
        // pg entrega bigint como string; o JSON canônico conserva revisões
        // numéricas. Capturar aqui, com a conversa travada, nunca no retry.
        const current = (await db.query(
          "select public.fn_service_boundary($1,$2) as boundary", [org, row.conversation_id],
        )).rows[0]?.boundary;
        const boundary = parseServiceBoundary(current);
        if (!boundary || boundary.organization_id !== org ||
            boundary.contact_id !== row.contact_id ||
            boundary.conversation_id !== row.conversation_id ||
            boundary.demanda_id !== row.current_demanda_id ||
            !["open", "pending", "ai_handling"].includes(current.status) ||
            current.demanda_fechada_em) recusar("service_boundary_invalid");
        // Nasce vencido: o default now() do banco usa o mesmo relógio do claim.
        // O relógio do processo serve à elegibilidade, nunca a este agendamento.
        await db.query(
          `insert into followup_enrollments
        (id,organization_id,pointer_id,version_id,contact_id,conversation_id,current_node_id,status,service_boundary,agent_id)
        values($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)`,
          [
            id,
            org,
            version.id,
            version.active_version_id,
            row.contact_id,
            row.conversation_id,
            trigger!.id,
            boundary,
            agents[0]!.id,
          ],
        );
        const proof = assinarOrigemC01(cfg, {
          ...input,
          organizationId: org,
          contactId: row.contact_id,
          conversationId: row.conversation_id,
          createdAt: new Date(row.sent_at).toISOString(),
          contentHash: hashDoConteudoDaOrigem(row),
        });
        await db.query(
          `insert into followup_enrollment_events
        (organization_id,enrollment_id,node_id,event_type,payload,idempotency_key) values($1,$2,$3,'c01_origem_entregue',$4,$5)`,
          [org, id, trigger!.id, proof, `c01-origin:${input.kind}:${input.messageId}`],
        );
        await lock.conferir();
        await db.query("commit");
        return { status: "enrolled" as const, enrollment_id: id };
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    },
  );
  if (held.ocupado) return recusar("contact_busy");
  return held.resultado;
}

/** O relógio existente descobre recibos novos. Paginação não esconde o 201º contato. */
export async function inscreverOrigensConfirmadasC01(
  pool?: pg.Pool,
  now = new Date(),
): Promise<void> {
  const cfg = configOrigemC01();
  if (!cfg?.enabled) return;
  const db = pool ?? getRequestPool();
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = (
      await db.query(
        `select *,metadata->'c01_origin' as origin
      from messages m where organization_id=$1 and id>$2 and direction='outbound' and status in ('sent','delivered','read')
      and coalesce(delivered_at,read_at) is not null
      -- recusa passageira (contato ocupado, humano) é tentada de novo a cada ciclo: sem idade máxima,
      -- a inscrição sairia dias depois com a âncora velha e os toques vencidos em sequência (-c01.13)
      and m.sent_at > $3::timestamptz - interval '6 hours'
      and metadata->'c01_origin' is not null and metadata->'c01_origin' <> 'null'::jsonb
      and metadata->'c01_video_omitted' is null and metadata->>'c01_video_processed' is distinct from 'true'
      and not exists(select 1 from followup_enrollment_events ev where ev.organization_id=m.organization_id
        and ev.event_type='c01_origem_entregue' and ev.payload->>'messageId'=m.id::text)
      order by id limit 200`,
        [cfg.organizationId, cursor, now.toISOString()],
      )
    ).rows;
    for (const row of rows) {
      const proof = conferirOrigemC01(cfg, row.origin);
      if (
        !proof ||
        proof.messageId !== row.id ||
        proof.contactId !== row.contact_id ||
        proof.conversationId !== row.conversation_id ||
        proof.contentHash !== hashDoConteudoDaOrigem(row)
      )
        continue;
      try {
        await registrarOrigemEntregueC01(db, cfg, proof, now);
        if (proof.kind === "video_curso") await db.query(`update messages set metadata=metadata||'{"c01_video_processed":true}'::jsonb
          where organization_id=$1 and id=$2`,[cfg.organizationId,row.id]);
      } catch (err) {
        if (!(err instanceof OrigemRecusada)) throw err;
        // Omitido não fica esperando a outra sequência acabar para disparar
        // retroativamente. O motivo fica no registro nativo da mensagem.
        if (proof.kind === "video_curso" && ["another_sequence_live","callback_has_priority","new_reply",
          "contact_restricted","origin_before_activation","video_already_omitted"].includes(err.code))
          await db.query(`update messages set metadata=metadata||jsonb_build_object('c01_video_omitted',$3::jsonb)
            where organization_id=$1 and id=$2`,[cfg.organizationId,row.id,{reason:err.code,at:now.toISOString()}]);
      }
    }
    if (rows.length < 200) break;
    cursor = rows.at(-1)!.id;
  }
  const {inscreverContinuacoesC01}=await import("./c01-continuacao-runtime");
  const {lerSituacaoFinanceira}=await import("@/lib/leads/fonte-financeira");
  const {lerSituacaoFinanceiraSemOferta}=await import("@/lib/leads/fonte-financeira-sem-oferta");
  await inscreverContinuacoesC01(db,now,{financeiro:lerSituacaoFinanceira,semOferta:lerSituacaoFinanceiraSemOferta});
}
