import { assertAgentOperationPg, type AgentOperationContext } from "@/lib/ai/agents/operation";
import { assertApprovedReplyPg } from "@/lib/ai/replies/delivery";
import { assertMeetingDeliveryPg } from "@/lib/agenda/meet-delivery";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { withAgendaEffect, guardAgendaEffect } from "@/lib/agenda/efeito";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Queryable, JobRow } from "@/lib/agent-engine/queue/queue";
import type { ToolSet } from "@/lib/agent-engine/edge/llm/run-model-call";
import {
  assertCurrentServiceBoundary,
  JobLeasePerdidoError,
  parseServiceBoundary,
  PrazoDaExecucaoVencidoError,
  type CurrentServiceBoundary,
  type ServiceBoundary,
} from "./fronteira";

const execution = new AsyncLocalStorage<{
  db: Queryable;
  boundary: ServiceBoundary | null;
  job?: JobRow;
  agentOperation?: AgentOperationContext;
  /**
   * (C01) O freio das chamadas de modelo DESTA execução. Dispara em dois casos:
   * o lease do job foi perdido (`assertJobLeaseHeld`) ou o prazo das chamadas
   * venceu (`withServiceJob` com `leaseMs`). `runModelCall` lê o sinal por
   * `sinalDaExecucao()`, então nenhuma chamada de modelo precisa de fiação nova.
   */
  cancelamento: AbortController;
}>();

/**
 * (C01) Quanto do lease as chamadas de modelo podem consumir. A margem cobre o
 * caminho de erro depois do aborto (devolver o job à fila, avisos) e a defasagem
 * entre o claim e o início da execução; em lease curto, metade dele.
 * Caso C54: a execução passou dos 600 s do lease no meio da resposta, o reaper
 * devolveu o job e a segunda execução duplicou o que a primeira já tinha mandado.
 */
export const MARGEM_DO_LEASE_MS = 60_000;
export function prazoDasChamadas(leaseMs: number): number {
  return Math.max(Math.floor(leaseMs / 2), leaseMs - MARGEM_DO_LEASE_MS);
}

/**
 * (C01) A posse do lease conferida pelo MESMO predicado do `completeJob`
 * (`status='running' and locked_by and locked_at` da aquisição). Até aqui essa
 * conferência só existia no complete: uma execução que passasse do visibility
 * timeout seguia mandando mensagem, abrindo caso e gravando checkpoint, e só
 * descobria no fim que tinha sido substituída. Sem claim (execução fora da
 * fila, prévia, testes antigos) não há lease a conferir.
 */
export const LEASE_DO_JOB_SQL =
  "select 1 as lease from job_queue where id=$1 and status='running' and locked_by=$2 and locked_at=$3::timestamptz";
export async function assertJobLeaseHeld(
  db: Queryable,
  job: Pick<JobRow, "id" | "locked_by" | "claim_acquired_at">,
  cancelamento?: AbortController,
): Promise<void> {
  const claim = claimOfJob(job);
  if (!claim) return;
  const { rows } = await db.query(LEASE_DO_JOB_SQL, [job.id, claim.worker_id, claim.acquired_at]);
  if (rows.length > 0) return;
  const erro = new JobLeasePerdidoError(job.id);
  // Execução substituída não tem mais o que fazer: corta as chamadas de modelo
  // em voo em vez de deixar o laço gastar passos num turno que já não é dele.
  if (cancelamento && !cancelamento.signal.aborted) cancelamento.abort(erro);
  throw erro;
}
/** (C01) O sinal de cancelamento da execução corrente; fora de execução, nenhum. */
export function sinalDaExecucao(): AbortSignal | undefined {
  return execution.getStore()?.cancelamento.signal;
}
export const SERVICE_BOUNDARY_SQL = `select c.organization_id, c.contact_id, c.id as conversation_id,
 c.service_revision::float8 as service_revision, c.current_demanda_id as demanda_id,
 d.revision::float8 as demanda_revision, c.status, d.fechada_em::text as demanda_fechada_em
 from conversations c left join demandas d on d.id=c.current_demanda_id and d.organization_id=c.organization_id and d.contact_id=c.contact_id
 where c.organization_id=$1 and c.id=$2`;
export async function readCurrentServiceBoundary(
  db: Queryable,
  org: string,
  conversation: string,
): Promise<CurrentServiceBoundary | null> {
  const { rows } = await db.query<CurrentServiceBoundary>(SERVICE_BOUNDARY_SQL, [
    org,
    conversation,
  ]);
  return rows[0] ?? null;
}
export async function requireCurrentServiceBoundary(
  db: Queryable,
  boundary: ServiceBoundary | null,
): Promise<void> {
  assertCurrentServiceBoundary(
    boundary,
    boundary
      ? await readCurrentServiceBoundary(db, boundary.organization_id, boundary.conversation_id)
      : null,
  );
}
export function currentExecutionBoundary(): ServiceBoundary | null {
  return execution.getStore()?.boundary ?? null;
}
export function currentExecutionJob(): JobRow | null {
  return execution.getStore()?.job ?? null;
}
export function setExecutionAgentOperation(context: AgentOperationContext): void {
  const scope = execution.getStore();
  if (scope) scope.agentOperation = context;
}
export async function guardServiceEffect(): Promise<void> {
  const scope = execution.getStore();
  // (C01) Primeiro a posse do lease: execução substituída não paga as outras
  // consultas — e nenhum efeito dela (envio, caso, nota, etapa, checkpoint) sai.
  if (scope?.job) await assertJobLeaseHeld(scope.db, scope.job, scope.cancelamento);
  if (scope?.agentOperation) await assertAgentOperationPg(scope.db, scope.agentOperation);
  if (scope) await requireCurrentServiceBoundary(scope.db, scope.boundary);
  if (scope?.job?.kind === "transactional_delivery") {
    const claim = claimOfJob(scope.job);
    if (!claim) assertCurrentServiceBoundary(null, null);
    await assertMeetingDeliveryPg(scope.db, {
      organizationId: scope.job.organization_id,
      jobId: scope.job.id,
      jobClaim: claim!,
    });
  }
  if (scope?.job?.kind === "approved_reply") {
    const claim = claimOfJob(scope.job);
    if (!claim) assertCurrentServiceBoundary(null, null);
    await assertApprovedReplyPg(scope.db, {
      organizationId: scope.job.organization_id,
      jobId: scope.job.id,
      jobClaim: claim!,
    });
  }
  await guardAgendaEffect();
}
/** Continuação sem job (ex.: decisão humana sobre um caso já existente). */
export async function withServiceBoundary<T>(
  db: Queryable,
  boundary: ServiceBoundary | null,
  action: () => Promise<T>,
): Promise<T> {
  await requireCurrentServiceBoundary(db, boundary);
  return execution.run({ db, boundary, cancelamento: new AbortController() }, action);
}
/**
 * Trabalho legado é stale. Flywheel/watchdog sem contato não são atendimento.
 *
 * (C01) `opcoes.leaseMs` é o visibility timeout da fila (QUEUE_VISIBILITY_TIMEOUT_MS):
 * com ele, as chamadas de modelo da execução ganham um prazo menor que o lease
 * (`prazoDasChamadas`) e são abortadas antes de o reaper poder devolver o job.
 * Sem ele (entrega transacional, resposta aprovada, testes), nenhum prazo.
 */
export async function withServiceJob<T>(
  db: Queryable,
  job: JobRow,
  action: () => Promise<T>,
  opcoes: { leaseMs?: number } = {},
): Promise<T> {
  if (
    ![
      "inbound_turn",
      "followup_turn",
      "case_reply_turn",
      "operator_turn",
      "transactional_delivery",
      "approved_reply",
    ].includes(job.kind)
  )
    return action();
  const boundary = parseServiceBoundary(job.payload.service_boundary);
  if (
    boundary &&
    (boundary.organization_id !== job.organization_id || boundary.contact_id !== job.contact_id)
  ) {
    assertCurrentServiceBoundary(null, null);
  }
  await requireCurrentServiceBoundary(db, boundary);
  const cancelamento = new AbortController();
  const prazo = opcoes.leaseMs === undefined ? null : prazoDasChamadas(opcoes.leaseMs);
  const relogio =
    prazo === null
      ? null
      : setTimeout(() => {
          if (!cancelamento.signal.aborted)
            cancelamento.abort(new PrazoDaExecucaoVencidoError(job.id, prazo));
        }, prazo);
  // O timer não segura o processo vivo no shutdown; e é limpo quando a execução acaba.
  relogio?.unref();
  try {
    return await execution.run({ db, boundary, job, cancelamento }, () =>
      job.kind === "followup_turn" && job.contact_id
        ? withAgendaEffect(
            db,
            {
              organizationId: job.organization_id,
              contactId: job.contact_id,
              jobId: job.id,
              jobClaim: claimOfJob(job),
              enrollmentId:
                typeof job.payload.followup_enrollment_id === "string"
                  ? job.payload.followup_enrollment_id
                  : undefined,
              nodeId: typeof job.payload.node_id === "string" ? job.payload.node_id : undefined,
            },
            action,
          )
        : action(),
    );
  } finally {
    if (relogio !== null) clearTimeout(relogio);
  }
}
/** Guarda no execute real. Tools desconhecidas são mutáveis por default. */
export function guardServiceTools(tools: ToolSet | undefined): ToolSet | undefined {
  if (!tools || !execution.getStore()) return tools;
  const reads = new Set([
    "get_lead_context",
    "get_lead_note",
    "search_knowledge",
    "read_skill_reference",
    // Leitura do banco externo (Fase 5): não toca o CRM, então não há efeito a
    // proteger com a fronteira de atendimento — o SELECT já corre em transação
    // somente-leitura no banco de origem.
    "crm_describe_external_data",
    "crm_query_external_data",
  ]);
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      if (reads.has(name) || !definition.execute) return [name, definition];
      const execute = definition.execute;
      return [
        name,
        {
          ...definition,
          execute: async (...args: Parameters<typeof execute>) => {
            await guardServiceEffect();
            return execute(...args);
          },
        },
      ];
    }),
  ) as ToolSet;
}
