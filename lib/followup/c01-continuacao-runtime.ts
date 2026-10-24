import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { comTravaDeEfeito } from "@/lib/agent-engine/db/trava-de-efeito";
import { configOrigemC01, type ConfigOrigemC01 } from "./c01-origem";
import type { LeitorFinanceiroC01 } from "./c01-acompanhamento-fatos";
import { continuacaoDoTurnoHabilitada } from "./c01-continuacao-turno";
import { planejarContinuacaoC01 } from "./c01-continuacao";
import {
  assinarVinculoContinuacaoC01,
  conferirVinculoContinuacaoC01,
  lerOfertaAnteriorC01,
  lerTurnoContinuacaoC01,
  lerToquesDaCadeiaC01,
  isoContinuacao,
  type VinculoContinuacaoC01,
} from "./c01-continuacao-fontes";
import { rotaDeContinuacaoC01 } from "./c01-continuacao-grafo";
import { flowGraphSchema } from "./graph-schema";
import { estadoDoToque, type FatosAcompanhamento } from "./c01-acompanhamento";
import { resolverModeloOfertaC01 } from "./c01-acompanhamento-conteudo";
import { coletaFinanceiraViva } from "@/lib/leads/coleta-financeira";
import { prazoDaColetaSchema } from "./c01-financeiro-espera";
import { z } from "zod";

export type LeitorFinanceiroSemOfertaC01 = (input: {
  db: Queryable;
  organizationId: string;
  contactId: string;
  leadId: string;
  productKey: null;
  finalidade: "sem_oferta";
  now: Date;
  signal: AbortSignal;
}) => ReturnType<LeitorFinanceiroC01>;
export interface DependenciasContinuacaoC01 {
  financeiro: LeitorFinanceiroC01;
  semOferta?: LeitorFinanceiroSemOfertaC01;
}
type Resultado = {
  status: "off" | "blocked" | "enrolled" | "replay";
  reason?: string;
  enrollmentId?: string;
};
const recusado = (reason: string): Resultado => ({ status: "blocked", reason });
const terminal = new Set([
  "conversa_mudou",
  "prioridade_ou_bloqueio_atual",
  "sem_pedido_aberto",
  "pedido_sem_evidencia",
  "L1_sem_janela",
  "compra_confirmada",
  "prazo_da_coleta_financeira_esgotado",
  "prazo_financeiro_incoerente",
  "compras_sem_conferencia_univoca",
]);

export async function registrarContinuacaoC01(
  pool: pg.Pool,
  cfg: ConfigOrigemC01,
  jobId: string,
  now: Date,
  deps: DependenciasContinuacaoC01,
): Promise<Resultado> {
  if (!continuacaoDoTurnoHabilitada(cfg, cfg.organizationId)) return { status: "off" };
  const initial = (
    await pool.query("select contact_id from job_queue where organization_id=$1 and id=$2", [
      cfg.organizationId,
      jobId,
    ])
  ).rows[0];
  if (!initial?.contact_id) return recusado("turno_ausente");
  const org = cfg.organizationId,
    contact = initial.contact_id as string;
  const held = await comTravaDeEfeito(pool, `callback:${org}:${contact}`, async (lock) => {
    const db = lock.db;
    await db.query("begin");
    try {
      await db.query("set local lock_timeout='5s'");
      await db.query("select public.fn_service_lock($1,$2)", [org, contact]);
      await db.query("select id from contacts where organization_id=$1 and id=$2 for update", [
        org,
        contact,
      ]);
      await db.query(
        "select id from crm_leads where organization_id=$1 and contact_id=$2 for share",
        [org, contact],
      );
      const finish = async (result: Resultado) => {
        if (result.status === "blocked" && terminal.has(result.reason ?? ""))
          await db.query(
            "update job_queue set payload=jsonb_set(payload,'{c01_continuation_omitted}',$3::jsonb) where organization_id=$1 and id=$2",
            [org, jobId, { reason: result.reason, at: now.toISOString() }],
          );
        await lock.conferir();
        await db.query("commit");
        return result;
      };
      const previous = (
        await db.query(
          `select enrollment_id,payload from followup_enrollment_events where organization_id=$1
        and event_type='c01_continuacao_entregue' and idempotency_key=$2`,
          [org, `c01-continuation:${jobId}`],
        )
      ).rows;
      if (previous.length) {
        const proof =
          previous.length === 1 ? conferirVinculoContinuacaoC01(cfg, previous[0]!.payload) : null;
        return finish(
          proof !== null &&
            proof.enrollmentId === previous[0]!.enrollment_id &&
            proof.candidate.jobId === jobId &&
            proof.candidate.contactId === contact
            ? { status: "replay", enrollmentId: previous[0]!.enrollment_id }
            : recusado("deduplicacao_incoerente"),
        );
      }
      const turn = await lerTurnoContinuacaoC01(db, cfg, jobId, now);
      if (!turn) return finish(recusado("turno_ou_fontes_incompletos"));
      const p = turn.candidate;
      if (p.proposal.estado !== "pendente") return finish(recusado("sem_pedido_aberto"));
      const offer = await lerOfertaAnteriorC01(db, cfg, p);
      if (p.proposal.caminho === "L2" && !offer)
        return finish(recusado("oferta_original_sem_prova"));
      if (offer)
        turn.facts.offer = {
          enrollmentId: offer.ancestors[0]!,
          originMessageId: offer.origin.messageId,
          organizationId: org,
          contactId: contact,
          conversationId: p.conversationId,
          leadId: p.leadId,
          productKey: offer.origin.productKey,
          deliveredAt: offer.deliveredAt,
          trusted: true,
          touches: offer.touches,
        };
      // L1 não pode ignorar uma oferta enviada só porque a inscrição antiga está em outro estado.
      if (p.proposal.caminho === "L1") {
        const existing = (
          await db.query(
            `select 1 from followup_enrollment_events where organization_id=$1
          and event_type='c01_origem_entregue' and payload->>'kind'='oferta' and payload->>'contactId'=$2
          and payload->>'conversationId'=$3 limit 1`,
            [org, contact, p.conversationId],
          )
        ).rows;
        if (existing.length) return finish(recusado("L1_tem_oferta"));
      }
      const plan = planejarContinuacaoC01(p.proposal, turn.facts, now);
      if (plan.kind !== "candidate") return finish(recusado(plan.reason));
      const versions = offer
        ? [offer.previous]
        : (
            await db.query(
              `select p.id as pointer_id,p.active_version_id as version_id,p.trigger_config,v.graph
        from followup_flow_pointers p join followup_flow_versions v on v.organization_id=p.organization_id and v.id=p.active_version_id
        where p.organization_id=$1 and p.status='active' and v.graph->'settings'->'c01_acompanhamento'->>'kind'='conversa' for share of p,v`,
              [org],
            )
          ).rows;
      if (versions.length !== 1) return finish(recusado("politica_ativa_nao_unica"));
      const version = versions[0]!,
        graph = flowGraphSchema.parse(version.graph),
        policy = graph.settings?.c01_acompanhamento;
      const route = rotaDeContinuacaoC01(graph, p.proposal.caminho, plan.nextTouch);
      if (
        !route ||
        !policy?.activated_at ||
        version.trigger_config?.cancel_on_reply !== true ||
        Date.parse(plan.anchorAt) < Date.parse(policy.activated_at)
      )
        return finish(recusado("politica_incompativel_ou_desligada"));
      const rawWait = (
        await db.query(
          "select payload->'c01_financial_wait' as wait from job_queue where organization_id=$1 and id=$2 and contact_id=$3 and status='done' for update",
          [org, jobId, contact],
        )
      ).rows[0]?.wait;
      // O prazo básico é lido separadamente porque os dois objetos são estritos.
      const parsedWait = rawWait
        ? prazoDaColetaSchema.safeParse({
            generationId: rawWait.generationId,
            startedAt: rawWait.startedAt,
            deadlineAt: rawWait.deadlineAt,
          })
        : null;
      if (
        rawWait &&
        (!parsedWait?.success ||
          !z.string().datetime({ offset: true }).safeParse(rawWait.nextCheckAt).success)
      )
        return finish(recusado("prazo_financeiro_incoerente"));
      const oldWait = parsedWait?.success ? parsedWait.data : null;
      if (oldWait && +now >= Date.parse(oldWait.deadlineAt))
        return finish(recusado("prazo_da_coleta_financeira_esgotado"));
      if (oldWait && +now < Date.parse(rawWait.nextCheckAt))
        return finish(recusado("projecao_em_coleta"));
      const financial = await financeiroDaContinuacao(db, p, now, deps, lock.signal);
      const collecting =
        financial?.status === "indisponivel" && financial.reason === "projecao_em_coleta"
          ? coletaFinanceiraViva(financial.collection, now)
          : null;
      if (collecting) {
        const end = Math.min(
          Date.parse(oldWait?.deadlineAt ?? collecting.deadlineAt),
          Date.parse(turn.facts.inbound.at) + 24 * 3600_000,
        );
        if (+now >= end) return finish(recusado("prazo_da_coleta_financeira_esgotado"));
        const wait = {
          generationId: oldWait?.generationId ?? collecting.generationId,
          startedAt: oldWait?.startedAt ?? collecting.startedAt,
          deadlineAt: new Date(end).toISOString(),
          nextCheckAt: new Date(Math.min(+now + 60_000, end)).toISOString(),
        };
        await db.query(
          "update job_queue set payload=jsonb_set(payload,'{c01_financial_wait}',$4::jsonb) where organization_id=$1 and id=$2 and contact_id=$3 and status='done'",
          [org, jobId, contact, wait],
        );
        return finish(recusado("projecao_em_coleta"));
      }
      const financialReady =
        !!financial?.complete &&
        Number.isFinite(Date.parse(financial.checkedAt)) &&
        +now - Date.parse(financial.checkedAt) >= 0 &&
        +now - Date.parse(financial.checkedAt) <= 15 * 60000;
      if (!financialReady || financial?.status !== "nao_comprou_confirmado")
        return finish(
          recusado(
            financialReady && financial?.status === "confirmado"
              ? "compra_confirmada"
              : "compras_sem_conferencia_univoca",
          ),
        );
      const agents = (
        await db.query(
          `select a.id from ai_agents a join ai_agent_versions v on v.organization_id=a.organization_id and v.id=a.published_version_id
        where a.organization_id=$1 and a.paused_at is null and a.archived_at is null and a.operation_mode='automatic'
        and v.followup->>'enabled'='true' and v.followup->'flow_pointer_ids' ? $2 order by a.id limit 2`,
          [org, version.pointer_id],
        )
      ).rows;
      if (agents.length !== 1) return finish(recusado("agente_ativo_nao_unico"));
      const id = randomUUID(),
        proof = assinarVinculoContinuacaoC01(cfg, {
          enrollmentId: id,
          candidate: p,
          ancestors: offer?.ancestors ?? [],
          original: offer?.origin ?? null,
          notBefore: plan.dueAt,
          firstTouch: plan.nextTouch,
        });
      await db.query(
        `insert into followup_enrollments(id,organization_id,pointer_id,version_id,contact_id,conversation_id,current_node_id,status,next_eval_at,service_boundary,agent_id)
        values($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,$10)`,
        [
          id,
          org,
          version.pointer_id,
          version.version_id,
          contact,
          p.conversationId,
          route.nodeId,
          plan.dueAt,
          turn.state.service_boundary,
          agents[0]!.id,
        ],
      );
      await db.query(
        `insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
        values($1,$2,$3,'c01_continuacao_entregue',$4,$5)`,
        [org, id, route.nodeId, proof, plan.idempotencyKey],
      );
      if (offer)
        await db.query(
          `insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
        values($1,$2,$3,'c01_origem_entregue',$4,$5)`,
          [org, id, route.nodeId, offer.origin, `c01-continuation-origin:${jobId}`],
        );
      return finish({ status: "enrolled", enrollmentId: id });
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
  return held.ocupado ? recusado("pessoa_ocupada") : held.resultado;
}

async function financeiroDaContinuacao(
  db: Queryable,
  p: VinculoContinuacaoC01["candidate"],
  now: Date,
  deps: DependenciasContinuacaoC01,
  signal: AbortSignal,
) {
  const scope = {
    db,
    organizationId: p.organizationId,
    contactId: p.contactId,
    leadId: p.leadId,
    now,
    signal,
  };
  if (p.financialScope === "sem_oferta")
    return deps.semOferta?.({ ...scope, productKey: null, finalidade: "sem_oferta" }) ?? null;
  return p.productKey ? deps.financeiro({ ...scope, productKey: p.productKey }) : null;
}

/** Scheduler existente: apenas candidatos recentes e explícitos, nunca varredura de leads antigos. */
export async function inscreverContinuacoesC01(
  pool: pg.Pool,
  now: Date,
  deps: DependenciasContinuacaoC01,
): Promise<void> {
  const cfg = configOrigemC01();
  if (!cfg || !continuacaoDoTurnoHabilitada(cfg, cfg.organizationId)) return;
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = (
      await pool.query(
        `select j.id from job_queue j where j.organization_id=$1 and j.id>$2 and j.kind='inbound_turn' and j.status='done'
      and j.created_at>=$3::timestamptz and j.payload?'c01_continuation' and not(j.payload?'c01_continuation_omitted')
      and not exists(select 1 from followup_enrollment_events e where e.organization_id=j.organization_id and e.event_type='c01_continuacao_entregue'
        and e.idempotency_key='c01-continuation:'||j.id::text) order by j.id limit 200`,
        [cfg.organizationId, cursor, cfg.continuation!.activatedAt],
      )
    ).rows;
    for (const r of rows) await registrarContinuacaoC01(pool, cfg, r.id, now, deps);
    if (rows.length < 200) return;
    cursor = rows.at(-1)!.id;
  }
}

/** Mesmo vínculo no tick e na porta de envio; financeiro é relido, nunca o snapshot da matrícula. */
export async function lerFatosContinuacaoC01(
  db: Queryable,
  cfg: ConfigOrigemC01,
  scope: { organizationId: string; contactId: string; enrollmentId: string },
  raw: unknown,
  now: Date,
  deps: DependenciasContinuacaoC01,
  signal: AbortSignal,
): Promise<FatosAcompanhamento | null> {
  const proof = conferirVinculoContinuacaoC01(cfg, raw),
    p = proof?.candidate;
  if (
    !proof ||
    proof.enrollmentId !== scope.enrollmentId ||
    !p ||
    p.organizationId !== scope.organizationId ||
    p.contactId !== scope.contactId ||
    p.proposal.estado !== "pendente"
  )
    return null;
  const turn = await lerTurnoContinuacaoC01(db, cfg, p.jobId, now, scope.enrollmentId);
  if (!turn || turn.candidate.signature !== p.signature) return null;
  const touches = await lerToquesDaCadeiaC01(
    db,
    p.organizationId,
    p.contactId,
    [...proof.ancestors, scope.enrollmentId],
    true,
  );
  if (!touches) return null;
  const finalReceipt = turn.facts.final.receipt;
  let anchorAt = ultimaConfirmacao(turn.final.delivered_at, turn.final.read_at),
    delivered = estadoDoToque(finalReceipt) === "delivered";
  if (proof.original) {
    const original = proof.original;
    const msg = (
      await db.query(
        "select * from messages where organization_id=$1 and contact_id=$2 and conversation_id=$3 and id=$4",
        [p.organizationId, p.contactId, p.conversationId, original.messageId],
      )
    ).rows[0];
    const { hashDoConteudoDaOrigem } = await import("./c01-origem");
    if (!msg || original.contentHash !== hashDoConteudoDaOrigem(msg)) return null;
    anchorAt = ultimaConfirmacao(msg.delivered_at, msg.read_at);
    delivered =
      !!msg.external_id &&
      msg.direction === "outbound" &&
      estadoDoToque({
        index: 0,
        messageIds: [msg.id],
        receipts: [
          {
            id: msg.id,
            status: msg.status,
            delivered_at: isoContinuacao(msg.delivered_at),
            read_at: isoContinuacao(msg.read_at),
            error_code: msg.error_code ?? null,
          },
        ],
      }) === "delivered";
  }
  if (!anchorAt || !delivered) return null;
  const state = (
    await db.query(
      "select status,version_id,current_node_id from followup_enrollments where organization_id=$1 and contact_id=$2 and id=$3",
      [p.organizationId, p.contactId, scope.enrollmentId],
    )
  ).rows[0];
  const paid = await financeiroDaContinuacao(db, p, now, deps, signal);
  const model =
    proof.original && state
      ? await resolverModeloOfertaC01(db, cfg, {
          organizationId: p.organizationId,
          versionId: state.version_id,
          nodeId: state.current_node_id,
          productKey: proof.original.productKey,
          connectionId: turn.state.channel_session_id,
        })
      : null;
  return {
    organizationId: p.organizationId,
    contactId: p.contactId,
    opportunityId: p.leadId,
    anchor: { kind: proof.original ? "oferta" : "conversa", at: anchorAt, delivered },
    continuation: {
      replyBarrierAt: turn.facts.inbound.at,
      notBefore: proof.notBefore,
      ready: true,
    },
    lastInboundAt: isoContinuacao(turn.state.last_inbound_at),
    hasNewReply: turn.facts.latestInboundId !== p.inboundMessageId,
    offerAfterAnchor: false,
    human: turn.facts.human || turn.facts.openCase || turn.facts.pause,
    optedOut: turn.facts.refused,
    restricted: turn.facts.restricted || !["active", "waiting_reply"].includes(state?.status),
    callbackPending: turn.facts.callback,
    anotherSequence: turn.facts.liveSequence,
    ...(paid?.status === "indisponivel" && paid.reason === "projecao_em_coleta" && paid.collection
      ? { financialCollection: paid.collection }
      : {}),
    purchase:
      paid && ["confirmado", "nao_comprou_confirmado"].includes(paid.status)
        ? {
            source: "aplicada",
            organizationId: p.organizationId,
            contactId: p.contactId,
            opportunityId: p.leadId,
            checkedAt: paid.checkedAt,
            complete: paid.complete,
            identity: "univoca",
            result: paid.status === "confirmado" ? "comprou" : "nao_comprou",
          }
        : null,
    template: { approved: !!model, accountReady: !!model },
    touches,
  };
}

function ultimaConfirmacao(delivered: unknown, read: unknown): string | null {
  const dates = [isoContinuacao(delivered), isoContinuacao(read)].filter(
    (s): s is string => s !== null,
  );
  return dates.length ? new Date(Math.max(...dates.map(Date.parse))).toISOString() : null;
}
