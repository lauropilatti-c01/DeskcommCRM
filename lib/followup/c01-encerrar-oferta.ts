import type pg from "pg";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { comTravaDeEfeito } from "@/lib/agent-engine/db/trava-de-efeito";
import { assertCurrentServiceBoundary, parseServiceBoundary } from "@/lib/atendimento/fronteira";
import { buildLeadActivityRow } from "@/lib/leads/activity-emitter";
import { validaCamposExigidos } from "@/lib/leads/campos-exigidos";
import { lerSituacaoFinanceira } from "@/lib/leads/fonte-financeira";
import { avaliarAcompanhamento, type DecisaoAcompanhamento } from "./c01-acompanhamento";
import { lerFatosAcompanhamentoC01, type LeitorFinanceiroC01 } from "./c01-acompanhamento-fatos";
import { configOrigemC01, conferirOrigemC01, type ConfigOrigemC01 } from "./c01-origem";
import { flowGraphSchema } from "./graph-schema";
import type { EnrollmentRow } from "./node-handlers";

export type ResultadoEncerramentoC01 = { kind: "closed" | "replay" | "held" };
interface Dependencias {
  pool?: pg.Pool;
  config?: ConfigOrigemC01 | null;
  financeiro?: LeitorFinanceiroC01;
}

/** Oferta C01 somente. A perda e o recibo do passo compartilham o commit.
 * callback coordena compra/retorno; service coordena inbound e atendimento humano.
 * O grafo legado nunca passa por esta porta. Não há esquema/persistência paralelos. */
export async function encerrarOfertaC01(
  esperado: EnrollmentRow,
  now: Date,
  deps: Dependencias = {},
): Promise<ResultadoEncerramentoC01> {
  const startedAt = Date.now();
  const effectNow = () => new Date(+now + Math.max(0, Date.now() - startedAt));
  const cfg = deps.config === undefined ? configOrigemC01() : deps.config;
  if (!cfg?.enabled || cfg.organizationId !== esperado.organization_id) return { kind: "held" };
  const org = esperado.organization_id,
    contact = esperado.contact_id;
  const locked = await comTravaDeEfeito(
    deps.pool ?? getRequestPool(),
    `callback:${org}:${contact}`,
    async (trava) => {
      const db = trava.db;
      await db.query("begin");
      try {
        await db.query("set local lock_timeout='5s'");
        await db.query("set local statement_timeout='10s'");
        await db.query("select public.fn_service_lock($1,$2)", [org, contact]);
        const row = (
          await db.query(
            `select e.*,v.graph,p.status as pointer_status from followup_enrollments e
         join followup_flow_versions v on v.organization_id=e.organization_id and v.id=e.version_id
         join followup_flow_pointers p on p.organization_id=e.organization_id and p.id=e.pointer_id
         where e.organization_id=$1 and e.contact_id=$2 and e.id=$3 for update of e for share of v,p`,
            [org, contact, esperado.id],
          )
        ).rows[0];
        if (!row) throw new Error("c01_inscricao_indisponivel");
        const receipt = await db.query(
          `select id from followup_enrollment_events where organization_id=$1 and enrollment_id=$2
         and event_type='c01_oferta_encerrada'`,
          [org, esperado.id],
        );
        if (receipt.rows.length === 1) {
          await db.query("commit");
          return { kind: "replay" } as const;
        }
        if (receipt.rows.length > 1) throw new Error("c01_recibo_de_perda_incoerente");
        if (
          String(row.revision) !== String(esperado.revision) ||
          row.current_node_id !== esperado.current_node_id ||
          row.version_id !== esperado.version_id ||
          row.conversation_id !== esperado.conversation_id ||
          row.pointer_status !== "active" ||
          !["active", "waiting_reply"].includes(row.status)
        ) {
          await db.query("rollback");
          return { kind: "held" } as const;
        }
        const graph = flowGraphSchema.parse(row.graph);
        const policy = graph.settings?.c01_acompanhamento;
        const node = graph.nodes.find((n) => n.id === row.current_node_id);
        const exits = graph.edges.filter((e) => e.source === node?.id);
        const end = graph.nodes.find((n) => n.id === exits[0]?.target);
        if (
          policy?.kind !== "oferta" ||
          node?.type !== "move_lead" ||
          node.config.lost_reason !== "no_response" ||
          exits.length !== 1 ||
          exits[0]?.condition.type !== "always" ||
          end?.type !== "end" ||
          end.config.outcome !== "exhausted" ||
          graph.edges.some((e) => e.source === end.id)
        ) {
          throw new Error("c01_encerramento_nao_terminal_ou_nao_aprovado");
        }
        const hold = async (decision: DecisaoAcompanhamento): Promise<ResultadoEncerramentoC01> => {
          const reason = "reason" in decision ? decision.reason : "politica_nao_autoriza_perda";
          const cancel = decision.kind === "cancel";
          const patch =
            decision.kind === "defer"
              ? { next_eval_at: decision.until, claimed_until: null, last_error: `c01:${reason}` }
              : {
                  status: cancel ? "cancelled" : "paused_manual",
                  next_eval_at: null,
                  claimed_until: null,
                  last_error: `c01:${reason}`,
                  ...(cancel ? { cancel_reason: reason, completed_at: now.toISOString() } : {}),
                };
          await db.query("select public.fn_followup_apply_step($1,$2,$3,$4::jsonb,$5::jsonb)", [
            org,
            row.id,
            row.revision,
            JSON.stringify(patch),
            JSON.stringify({
              node_id: node.id,
              event_type: "c01_acompanhamento_retido",
              payload: { decision: decision.kind, reason },
              idempotency_key: `${node.id}:${row.steps_taken}:perda_retida:${row.revision}`,
            }),
          ]);
          await trava.conferir();
          await db.query("commit");
          return { kind: "held" };
        };
        if (!policy.activated_at) return hold({ kind: "blocked", reason: "ativacao_pendente" });
        const origins = (
          await db.query(
            `select payload from followup_enrollment_events where organization_id=$1 and enrollment_id=$2
         and event_type='c01_origem_entregue'`,
            [org, row.id],
          )
        ).rows;
        const origin = origins.length === 1 ? conferirOrigemC01(cfg, origins[0]?.payload) : null;
        if (
          !origin ||
          origin.kind !== "oferta" ||
          origin.organizationId !== org ||
          origin.contactId !== contact ||
          origin.conversationId !== row.conversation_id
        )
          return hold({ kind: "blocked", reason: "origem_invalida" });
        // service vem antes do contato (mesma ordem do inbound/humano).
        // FOR UPDATE no contato impede novos negócios pelas FKs enquanto a
        // prova financeira é lida; SHARE permitiria o phantom de uma 2ª aberta.
        await db.query("select id from contacts where organization_id=$1 and id=$2 for update", [
          org,
          contact,
        ]);
        await db.query(
          "select id from conversations where organization_id=$1 and contact_id=$2 and id=$3 for share",
          [org, contact, row.conversation_id],
        );
        // Trava também as encerradas: reabrir uma delas muda a unicidade sem
        // trocar a FK. A ordem estável evita que dois leitores invertam linhas.
        const opportunities = (
          await db.query(
            "select * from crm_leads where organization_id=$1 and contact_id=$2 order by id for update",
            [org, contact],
          )
        ).rows;
        const lead = opportunities.find((item) => item.id === origin.leadId);
        if (
          !lead ||
          lead.status !== "open" ||
          lead.custom_fields?.produto_chave !== origin.productKey
        )
          return hold({ kind: "blocked", reason: "negocio_alterado_ou_encerrado" });
        if (opportunities.filter((item) => item.status === "open").length !== 1)
          return hold({ kind: "blocked", reason: "oportunidade_ambigua" });
        const boundary = (
          await db.query("select public.fn_service_boundary($1,$2) as boundary", [
            org,
            row.conversation_id,
          ])
        ).rows[0]?.boundary;
        const parsed = parseServiceBoundary(boundary);
        assertCurrentServiceBoundary(
          row.service_boundary,
          parsed
            ? {
                ...parsed,
                status: boundary.status,
                demanda_fechada_em: boundary.demanda_fechada_em,
              }
            : null,
        );
        // Um recibo tardio de erro não pode trocar sob a leitura do encerramento.
        await db.query(
          `select m.id from messages m where m.organization_id=$1 and m.contact_id=$2 and
        (m.id=$3 or m.id in (select sl.crm_message_id from job_queue j join send_ledger sl
         on sl.organization_id=j.organization_id and sl.job_id=j.id and sl.contact_id=j.contact_id
         where j.organization_id=$1 and j.contact_id=$2 and j.payload->>'followup_enrollment_id'=$4)) for share`,
          [org, contact, origin.messageId, row.id],
        );
        const stage = (
          await db.query(
            `select s.*,p.settings from crm_stages s join crm_pipelines p
        on p.organization_id=s.organization_id and p.id=s.pipeline_id where s.organization_id=$1 and s.id=$2 for share of s,p`,
            [org, node.config.stage_id],
          )
        ).rows[0];
        if (
          !stage ||
          stage.pipeline_id !== lead.pipeline_id ||
          !stage.is_lost ||
          stage.is_won ||
          stage.is_archived
        )
          return hold({ kind: "blocked", reason: "etapa_de_perda_incompativel" });
        if (
          validaCamposExigidos({
            lead,
            settingsDoFunil: stage.settings,
            destino: { stageId: stage.id, desfecho: "lost" },
          }).faltando.length
        )
          return hold({ kind: "blocked", reason: "campos_obrigatorios_ausentes" });
        const closedNodes = (
          await db.query(
            `select node_id from followup_enrollment_events where organization_id=$1 and enrollment_id=$2
           and event_type='action_sent' for share`,
            [org, row.id],
          )
        ).rows.map((r) => r.node_id as string);
        const receipts = (
          await db.query(
            `select j.payload->>'node_id' as node_id,j.kind,j.status as job_status,sl.status as ledger_status,
           m.conversation_id,m.direction,m.external_id,m.revoked_at from job_queue j
           join send_ledger sl on sl.organization_id=j.organization_id and sl.contact_id=j.contact_id and sl.job_id=j.id
           left join messages m on m.organization_id=sl.organization_id and m.contact_id=sl.contact_id and m.id=sl.crm_message_id
           where j.organization_id=$1 and j.contact_id=$2 and j.payload->>'followup_enrollment_id'=$3
           for share of j,sl`,
            [org, contact, row.id],
          )
        ).rows;
        if (
          closedNodes.length !== 4 ||
          new Set(closedNodes).size !== 4 ||
          closedNodes.some(
            (id) =>
              !graph.nodes.some((n) => n.id === id && n.type === "action") ||
              !receipts.some((r) => r.node_id === id),
          ) ||
          receipts.some(
            (r) =>
              !closedNodes.includes(r.node_id) ||
              r.kind !== "followup_turn" ||
              r.job_status !== "done" ||
              r.ledger_status !== "accepted" ||
              r.conversation_id !== origin.conversationId ||
              r.direction !== "outbound" ||
              !r.external_id ||
              r.revoked_at,
          )
        ) {
          return hold({ kind: "blocked", reason: "recibos_fora_da_inscricao_ou_incompletos" });
        }
        const facts = await lerFatosAcompanhamentoC01(
          db,
          cfg,
          { organizationId: org, contactId: contact, enrollmentId: row.id },
          effectNow(),
          deps.financeiro ?? lerSituacaoFinanceira,
          trava.signal,
        );
        const decision = facts
          ? avaliarAcompanhamento(policy, facts, effectNow())
          : { kind: "blocked" as const, reason: "origem_ou_fatos_indisponiveis" };
        if (decision.kind !== "lost") return hold(decision);
        await trava.conferir();
        const currentOpen = (
          await db.query(
            "select id from crm_leads where organization_id=$1 and contact_id=$2 and status='open'",
            [org, contact],
          )
        ).rows;
        if (currentOpen.length !== 1 || currentOpen[0]?.id !== origin.leadId)
          return hold({ kind: "blocked", reason: "oportunidade_ambigua" });
        const moved = await db.query(
          `update crm_leads set stage_id=$4,lost_reason='no_response'
        where organization_id=$1 and contact_id=$2 and id=$3 and status='open' returning status`,
          [org, contact, origin.leadId, stage.id],
        );
        if (moved.rows.length !== 1 || moved.rows[0]?.status !== "lost")
          throw new Error("c01_perda_nao_confirmada");
        const activity = buildLeadActivityRow({
          organizationId: org,
          leadId: origin.leadId,
          contactId: contact,
          type: "stage_changed",
          sourceModule: "followup",
          sourceId: row.id,
          actor: { type: "webhook_source", id: `followup:${row.id}` },
          reason: "Perdido — sem resposta após quatro entregas e conferência de compras",
          payload: {
            from_stage_id: lead.stage_id,
            to_stage_id: stage.id,
            lost_reason: "no_response",
          },
        });
        await db.query(
          `insert into crm_lead_activities(organization_id,lead_id,contact_id,type,source_module,source_id,actor_kind,reason,payload)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [
            org,
            origin.leadId,
            contact,
            activity.type,
            activity.source_module,
            activity.source_id,
            activity.actor_kind,
            activity.reason,
            JSON.stringify(activity.payload),
          ],
        );
        const payload = {
          lead_id: origin.leadId,
          product_key: origin.productKey,
          stage_id: stage.id,
          lost_reason: "no_response",
          origin_message_id: origin.messageId,
          financial_checked_at: facts!.purchase!.checkedAt,
          message_ids: facts!.touches.flatMap((t) => t.messageIds),
        };
        await db.query(
          "select public.emit_event('lead.stage_changed','crm_lead',$1,$2::jsonb,$3::jsonb,$4)",
          [
            origin.leadId,
            JSON.stringify({
              ...payload,
              pipeline_id: lead.pipeline_id,
              from_stage_id: lead.stage_id,
              to_stage_id: stage.id,
              status: "lost",
              service_origin: { kind: "continuation", boundary: row.service_boundary },
            }),
            JSON.stringify({ actor_type: "webhook_source", actor_id: `followup:${row.id}` }),
            org,
          ],
        );
        await db.query(
          `insert into api_audit_log(organization_id,action,resource_type,resource_id,request_id,metadata)
        values($1,'lead.lost','crm_lead',$2,$3,$4::jsonb)`,
          [org, origin.leadId, `followup:${row.id}`, JSON.stringify(payload)],
        );
        await db.query("select public.fn_followup_apply_step($1,$2,$3,$4::jsonb,$5::jsonb)", [
          org,
          row.id,
          row.revision,
          JSON.stringify({
            current_node_id: end.id,
            status: "completed",
            outcome: "exhausted",
            completed_at: now.toISOString(),
            next_eval_at: null,
            claimed_until: null,
            last_error: null,
            steps_taken: row.steps_taken + 1,
          }),
          JSON.stringify({
            node_id: node.id,
            event_type: "c01_oferta_encerrada",
            payload,
            idempotency_key: `${node.id}:${row.steps_taken}:c01_perda`,
          }),
        ]);
        await trava.conferir();
        await db.query("commit");
        return { kind: "closed" } as const;
      } catch (error) {
        await db.query("rollback").catch(() => undefined);
        throw error;
      }
    },
  );
  return locked.ocupado ? { kind: "held" } : locked.resultado;
}
