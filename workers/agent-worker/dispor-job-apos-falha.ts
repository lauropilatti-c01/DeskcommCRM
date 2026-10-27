import { cancelarRetornoC01DoJob } from "@/lib/followup/c01-retorno-cancelar-job";
import { RetornoC01CanceladoError } from "@/lib/followup/c01-retorno-cancelado";
import type { Pool } from "pg";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { cancelJob, failJob, rescheduleJob, type JobRow } from "@/lib/agent-engine/queue/queue";
import { avisarRespostaDeCasoObsoleto } from "@/lib/atendimento/aviso-caso-obsoleto";
import { descartarFollowupObsoleto } from "@/lib/atendimento/descartar-followup-obsoleto";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";

/** CRM-115: a coleta de compras deixa a conferência sem resposta por ~11 de cada
 * 15 min, e o backoff comum (10+20+40+80 s) mata o retorno em ~150 s. Enquanto o
 * retorno não passou 20 min da hora prometida, ele espera 2 min sem gastar
 * tentativa e refaz a conferência inteira; nada foi enviado antes dela falhar.
 * Passado o prazo, volta ao retry comum (5 tentativas e `job_dead`). */
export const ESPERA_COLETA_RETORNO_C01_MS = 2 * 60_000;
export const PRAZO_COLETA_RETORNO_C01_MS = 20 * 60_000;

function esperaColetaDoRetornoC01(job: JobRow, error: unknown, now = Date.now()): boolean {
  if (job.kind !== "followup_turn" || !(error instanceof Error)) return false;
  if (error.message !== "c01_callback_purchase_unconfirmed") return false;
  const promisedAt = Date.parse(String(job.payload.promised_at));
  return Number.isFinite(promisedAt) && now < promisedAt + PRAZO_COLETA_RETORNO_C01_MS;
}

/** Disposição usada pelo catch real do worker, sem iniciar seus loops no teste.
 * O lease original protege toda escrita; nunca cancela o trabalho de outro ciclo.
 */
export async function disporJobAposFalha(
  pool: Pool,
  job: JobRow,
  workerId: string,
  error: unknown,
  terminal: boolean,
  log: Pick<Logger, "warn">,
): Promise<void> {
  if (error instanceof RetornoC01CanceladoError || error instanceof StaleServiceBoundaryError) {
    if (
      await cancelarRetornoC01DoJob(
        pool,
        job,
        workerId,
        error instanceof RetornoC01CanceladoError ? error.message : undefined,
      )
    )
      return;
  }
  if (
    error instanceof StaleServiceBoundaryError &&
    job.kind === "case_reply_turn" &&
    typeof job.payload.case_id === "string"
  ) {
    await avisarRespostaDeCasoObsoleto(pool, job.organization_id, job.payload.case_id);
  }
  if (!terminal && esperaColetaDoRetornoC01(job, error)) {
    await rescheduleJob(pool, job.id, workerId, {
      delayMs: ESPERA_COLETA_RETORNO_C01_MS,
      reason: "c01_callback_purchase_unconfirmed",
      acquiredAt: claimOfJob(job)?.acquired_at,
    });
  } else if (error instanceof StaleServiceBoundaryError && job.kind === "followup_turn") {
    await descartarFollowupObsoleto(pool, job, workerId, log);
  } else if (terminal) {
    const reason = error instanceof Error ? error.message : String(error);
    await cancelJob(pool, job.id, workerId, (reason.split("\n", 1)[0] ?? "").slice(0, 300), claimOfJob(job)?.acquired_at);
  } else {
    await failJob(pool, job.id, workerId, error, claimOfJob(job)?.acquired_at);
  }
}
