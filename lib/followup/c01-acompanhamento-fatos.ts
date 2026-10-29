import {exigeCatalogoCronogramaC01,resolverRamoCronogramaC01} from "./c01-cronograma-catalogo";
import { modelosQueOFluxoEnvia } from "./modelos-aprovados";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { FatosAcompanhamento, Toque } from "./c01-acompanhamento";
import { conferirOrigemC01, hashDoConteudoDaOrigem, type ConfigOrigemC01 } from "./c01-origem";
import { politicaDoVideoValidaC01, videoDaOrigemValido } from "./c01-video-curso";
import { lerFatosContinuacaoC01, type LeitorFinanceiroSemOfertaC01 } from "./c01-continuacao-runtime";
import { resolverModeloOfertaC01 } from "./c01-acompanhamento-conteudo";
import type { ColetaFinanceira } from "@/lib/leads/coleta-financeira";

export interface EscopoFinanceiroC01 {
  db: Queryable;
  organizationId: string;
  contactId: string;
  leadId: string;
  productKey: string;
  now: Date;
  signal: AbortSignal;
}
export type LeitorFinanceiroC01 = (input: EscopoFinanceiroC01) => Promise<{
  status: "confirmado" | "revisao" | "indisponivel" | "nao_comprou_confirmado";
  checkedAt: string;
  complete: boolean;
  reason?: string;
  collection?: ColetaFinanceira;
}>;
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;

/** Leituras com escopo em TODAS as junções; nenhum campo preenchido pela IA prova compra/origem. */
export async function lerFatosAcompanhamentoC01(
  db: Queryable,
  cfg: ConfigOrigemC01,
  scope: { organizationId: string; contactId: string; enrollmentId: string },
  now: Date,
  financeiro: LeitorFinanceiroC01,
  signal = AbortSignal.timeout(15_000),
  semOferta?: LeitorFinanceiroSemOfertaC01,
): Promise<FatosAcompanhamento | null> {
  const { organizationId: org, contactId: contact, enrollmentId: enrollment } = scope;
  const r = (
    await db.query(
      `/* c01:fatos:origem */ select e.status, e.version_id,e.current_node_id, e.conversation_id, ev.payload, v.graph,ct.payload as continuation,
       c.is_blocked, c.ai_opt_out, c.force_human, c.is_anonymized, c.is_merged_into,
       cv.status as conversation_status, cv.assignee_kind, cv.bot_silenced_until, cv.last_inbound_at,cv.channel_session_id
     from followup_enrollments e
     join followup_flow_versions v on v.organization_id=e.organization_id and v.id=e.version_id
     left join followup_enrollment_events ev on ev.organization_id=e.organization_id and ev.enrollment_id=e.id
       and ev.event_type='c01_origem_entregue'
     left join followup_enrollment_events ct on ct.organization_id=e.organization_id and ct.enrollment_id=e.id
       and ct.event_type='c01_continuacao_entregue'
     join contacts c on c.organization_id=e.organization_id and c.id=e.contact_id
     join conversations cv on cv.organization_id=e.organization_id and cv.id=e.conversation_id and cv.contact_id=e.contact_id
     where e.organization_id=$1 and e.contact_id=$2 and e.id=$3
     order by ev.created_at,ev.id limit 2`,
      [org, contact, enrollment],
    )
  ).rows;
  if (r.length !== 1) return null;
  const row = r[0]!;
  if (row.continuation) return lerFatosContinuacaoC01(db,cfg,scope,row.continuation,now,{financeiro,semOferta},signal);
  const origin = conferirOrigemC01(cfg, row.payload);
  if (
    !origin ||
    origin.organizationId !== org ||
    origin.contactId !== contact ||
    origin.conversationId !== row.conversation_id
  )
    return null;
  const anchor = (
    await db.query(
      `/* c01:fatos:mensagem */ select m.*,
        l.custom_fields,l.status as lead_status
     from messages m join crm_leads l on l.organization_id=m.organization_id and l.contact_id=m.contact_id
     where m.organization_id=$1 and m.contact_id=$2 and m.id=$3 and m.conversation_id=$4 and l.id=$5`,
      [org, contact, origin.messageId, origin.conversationId, origin.leadId],
    )
  ).rows[0];
  if (
    !anchor ||
    anchor.custom_fields?.produto_chave !== origin.productKey ||
    origin.contentHash !== hashDoConteudoDaOrigem(anchor)
  )
    return null;
  const deliveredAt = iso(anchor.delivered_at) ?? iso(anchor.read_at);
  const anchorAt = deliveredAt ?? origin.createdAt;
  const protectedState = (
    await db.query(
      `/* c01:fatos:exclusividade */ select
       exists(select 1 from cron_jobs where organization_id=$1 and contact_id=$2 and kind='at'
         and job_kind='followup_turn' and enabled and cancelled_at is null) as callback,
       exists(select 1 from job_queue where organization_id=$1 and contact_id=$2 and kind='followup_turn'
         and status in ('pending','running') and not (payload ? 'followup_enrollment_id')
         and payload ? 'promised_at') as callback_queued,
       exists(select 1 from followup_enrollments where organization_id=$1 and contact_id=$2 and id<>$3
         and status in ('active','waiting_reply','paused_handoff','paused_manual','dormente','coletando')) as another`,
      [org, contact, enrollment],
    )
  ).rows[0];
  // Somente nós concluídos viram toques. A bolha em construção pertence ao toque
  // atual; contá-la antes do envio bloquearia a segunda bolha do próprio turno.
  const closed = (
    await db.query(
      `/* c01:fatos:toques */ select ev.node_id,min(ev.created_at) as at
     from followup_enrollment_events ev where ev.organization_id=$1 and ev.enrollment_id=$2
       and ev.event_type='action_sent' group by ev.node_id order by min(ev.created_at),ev.node_id`,
      [org, enrollment],
    )
  ).rows;
  const touches: Toque[] = [];
  for (const [index, event] of closed.entries()) {
    const receipts = (
      await db.query(
        `/* c01:fatos:recibos */ select sl.id as ledger_id,sl.crm_message_id,sl.status as ledger_status,
         m.id,m.status,m.delivered_at,m.read_at,m.error_code
       from job_queue j join send_ledger sl on sl.organization_id=j.organization_id and sl.job_id=j.id and sl.contact_id=j.contact_id
       left join messages m on m.organization_id=sl.organization_id and m.contact_id=sl.contact_id and m.id=sl.crm_message_id
       where j.organization_id=$1 and j.contact_id=$2 and j.payload->>'followup_enrollment_id'=$3
         and j.payload->>'node_id'=$4 order by j.created_at,j.id,sl.seq`,
        [org, contact, enrollment, event.node_id],
      )
    ).rows;
    touches.push({
      index: index + 1,
      messageIds: receipts.map((m) => String(m.crm_message_id ?? m.ledger_id)),
      receipts: receipts
        .filter((m) => m.id)
        .map((m) => ({
          id: m.id,
          status: m.status,
          delivered_at: iso(m.delivered_at),
          read_at: iso(m.read_at),
          error_code: m.error_code == null ? null : String(m.error_code),
        })),
    });
  }
  const later = (
    await db.query(
      `/* c01:fatos:oferta-posterior */ select * from messages
    where organization_id=$1 and contact_id=$2 and direction='outbound' and sent_at>$3
      and metadata->'c01_origin'->>'kind'='oferta' order by sent_at,id`,
      [org, contact, origin.createdAt],
    )
  ).rows;
  const offerAfterAnchor = later.some((m) => {
    const proof = conferirOrigemC01(cfg, m.metadata?.c01_origin);
    return (
      !!proof &&
      proof.messageId === m.id &&
      proof.contactId === contact &&
      proof.organizationId === org &&
      proof.contentHash === hashDoConteudoDaOrigem(m) &&
      !!m.external_id &&
      !!(m.delivered_at ?? m.read_at) &&
      !m.error_code &&
      ["sent", "delivered", "read"].includes(m.status)
    );
  });
  const node = row.graph?.nodes?.find((n: { id: string }) => n.id === row.current_node_id);
  const templateId = node?.config?.fallback_template_id ?? node?.config?.template_id;
  let template = { approved: false, accountReady: false };
  if (templateId) {
    const models = (
      await db.query(
        `/* c01:fatos:modelo */ select t.id,t.name,t.language,t.status,t.parameter_format,t.components,
      s.status as session_status from meta_templates t join channel_sessions s
      on s.organization_id=t.organization_id and s.id=t.channel_session_id
      where t.organization_id=$1 and t.id=$2 and t.channel_session_id=$3`,
        [org, templateId, row.channel_session_id],
      )
    ).rows;
    if (models.length === 1) {
      const m = models[0]!;
      const approved =
        modelosQueOFluxoEnvia([
          {
            id: m.id,
            name: m.name,
            language: m.language,
            status: m.status,
            parameter_format: m.parameter_format,
            components: m.components,
          },
        ]).length === 1;
      // Pré-voo técnico. A aceitação financeira do envio é decisão do provedor;
      // recusas (inclusive pagamento/marketing) jamais contam como toque entregue.
      template = { approved, accountReady: approved && m.session_status === "WORKING" };
    }
  }
  if (origin.kind === "oferta" && cfg.offerTemplates?.enabled) {
    const exact=await resolverModeloOfertaC01(db,cfg,{organizationId:org,versionId:row.version_id,nodeId:row.current_node_id,
      productKey:origin.productKey,connectionId:row.channel_session_id});
    template={approved:!!exact,accountReady:!!exact};
  }
  const catalog=exigeCatalogoCronogramaC01(row.graph)?await resolverRamoCronogramaC01(db,scope,row.graph,row.version_id):null;
  const paid = await financeiro({
    db,
    organizationId: org,
    contactId: contact,
    leadId: origin.leadId,
    productKey: origin.productKey,
    now,
    signal,
  });
  return {
    organizationId: org,
    contactId: contact,
    opportunityId: origin.leadId,
    ...(catalog?{cronogramaCatalogReady:catalog.status!=="indisponivel" && catalog.status!=="sem_material" && catalog.targetNodeId===row.current_node_id}:{}),
    ...(origin.kind === "video_curso" ? {
      videoPolicyReady: politicaDoVideoValidaC01(row.graph, cfg) && videoDaOrigemValido(cfg, origin, anchor),
    } : {}),
    anchor: {
      kind: origin.kind,
      at: anchorAt,
      delivered:
        !!deliveredAt &&
        !!anchor.external_id &&
        anchor.direction === "outbound" &&
        !anchor.error_code &&
        // a Cloud API grava só `sent | failed`: a entrega é `delivered_at`/`read_at` (exigido acima)
        ["sent", "delivered", "read"].includes(anchor.status),
    },
    lastInboundAt: iso(row.last_inbound_at),
    hasNewReply:
      !!row.last_inbound_at && +new Date(row.last_inbound_at) > +new Date(origin.createdAt),
    offerAfterAnchor,
    human:
      row.force_human === true ||
      row.assignee_kind === "user" ||
      row.assignee_kind === "human" ||
      row.status === "paused_handoff" ||
      row.bot_silenced_until === "infinity" ||
      (!!row.bot_silenced_until && +new Date(row.bot_silenced_until) > +now),
    optedOut: row.ai_opt_out === true,
    restricted:
      ["won", "lost"].includes(anchor.lead_status) ||
      row.is_blocked === true ||
      row.is_anonymized === true ||
      !!row.is_merged_into ||
      !["open", "pending", "ai_handling"].includes(row.conversation_status) ||
      !["active", "waiting_reply"].includes(row.status),
    callbackPending: protectedState?.callback === true || protectedState?.callback_queued === true,
    anotherSequence: protectedState?.another === true,
    ...(paid.status === "indisponivel" && paid.reason === "projecao_em_coleta" && paid.collection
      ? { financialCollection: paid.collection }
      : {}),
    purchase:
      paid.status === "confirmado" || paid.status === "nao_comprou_confirmado"
        ? {
            source: "aplicada",
            organizationId: org,
            contactId: contact,
            opportunityId: origin.leadId,
            checkedAt: paid.checkedAt,
            complete: paid.complete,
            identity: "univoca",
            result: paid.status === "confirmado" ? "comprou" : "nao_comprou",
          }
        : null,
    template,
    touches,
  };
}
