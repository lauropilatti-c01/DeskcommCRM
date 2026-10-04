/**
 * (C01, -c01.3, item 1c-i) A FALHA QUE ESGOTA AS TENTATIVAS DO JOB.
 *
 * O turno que falha volta à fila (`failJob`) até `max_attempts`; a última falha leva o
 * job a 'dead', com o alerta `job_dead` na Central. Se nenhuma mensagem tinha saído, o
 * lead fica mudo: foi o desfecho possível da C41 (volta 19-A2), com as tentativas
 * gastas por requisições penduradas.
 *
 * Esta régua diz, ANTES de o erro subir ao worker, se ele vai matar o job — para o turno
 * ainda poder abrir o caso, mandar a frase de espera e gravar a passagem (o fail-safe do
 * corte). Espelha a disposição de `workers/agent-worker/main.ts`: não matam o job o que
 * não gasta tentativa (agenda adiada, espera de saldo), o que cancela sem retry
 * (fronteira obsoleta, lease perdido, veto permanente de negócio) e o que o próprio run
 * já resolveu (`JobSettledError`). O teto de orçamento também fica de fora: tem
 * passagem própria (`comHandoffSeOrcamentoAcabar`), com aviso ao lead. Mudou a
 * disposição do worker, muda aqui.
 */
import { AgendaDeferredError } from '@/lib/agenda/protecao-followup';
import { StaleServiceBoundaryError } from '@/lib/atendimento/fronteira';

import { LlmBudgetExceededError } from '../edge/llm/run-model-call';
import { deveEsperarSaldo } from '../queue/espera-de-saldo';
import type { JobRow } from '../queue/queue';

/** `attempts` já vem incrementado pelo claim: a execução corrente é a de número `attempts`. */
export function falhaEsgotaAsTentativas(
  job: Pick<JobRow, 'attempts' | 'max_attempts' | 'created_at'>,
  err: unknown,
  agora: number = Date.now(),
): boolean {
  if (job.attempts < job.max_attempts) return false;
  if (err instanceof StaleServiceBoundaryError) return false;
  if (typeof err === 'object' && err !== null && (err as { terminal?: unknown }).terminal === true) {
    return false;
  }
  // `JobSettledError` (inbound-turn.ts), pelo nome: importar a classe daqui faria ciclo.
  if (err instanceof Error && err.name === 'job_settled') return false;
  if (err instanceof AgendaDeferredError && err.protection.motivo !== 'leitura_indisponivel') {
    return false;
  }
  if (err instanceof LlmBudgetExceededError) return false;
  if (deveEsperarSaldo(job, err, agora)) return false;
  return true;
}
