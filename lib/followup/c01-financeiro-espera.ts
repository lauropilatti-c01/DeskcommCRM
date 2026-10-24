import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { z } from "zod";
import { coletaFinanceiraViva } from "@/lib/leads/coleta-financeira";
import {
  limiteDaColetaC01,
  type ConfigAcompanhamento,
  type FatosAcompanhamento,
} from "./c01-acompanhamento";

export const prazoDaColetaSchema = z
  .object({
    generationId: z.uuid(),
    startedAt: z.string().datetime({ offset: true }),
    deadlineAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .refine((p) => Date.parse(p.deadlineAt) <= Date.parse(p.startedAt) + 900_000);

/** Evento idempotente por passo. Conflito conserva sempre o primeiro prazo. */
export async function vincularEsperaFinanceiraC01(
  db: Queryable,
  config: ConfigAcompanhamento,
  scope: { organizationId: string; contactId: string; enrollmentId: string },
  facts: FatosAcompanhamento,
  now: Date,
): Promise<FatosAcompanhamento | null> {
  const params = [scope.organizationId, scope.contactId, scope.enrollmentId];
  const row = (
    await db.query(
      `select status,current_node_id,steps_taken from followup_enrollments where organization_id=$1 and contact_id=$2 and id=$3`,
      params,
    )
  ).rows[0];
  if (!row || !["active", "waiting_reply"].includes(row.status))
    return { ...facts, restricted: true };
  const key = `${row.current_node_id}:${row.steps_taken}:coleta_financeira`;
  const collection = coletaFinanceiraViva(facts.financialCollection, now);
  if (collection && !facts.optedOut && !facts.human && !facts.restricted && !facts.hasNewReply) {
    const proof = {
      generationId: collection.generationId,
      startedAt: collection.startedAt,
      deadlineAt: limiteDaColetaC01(config, facts, collection, now),
    };
    await db.query(
      `insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key)
      select organization_id,id,current_node_id,'c01_financeiro_em_coleta',$4,$5 from followup_enrollments
      where organization_id=$1 and contact_id=$2 and id=$3 and status in ('active','waiting_reply') and current_node_id=$6 and steps_taken=$7
      on conflict(enrollment_id,idempotency_key) where idempotency_key is not null do nothing`,
      [...params, proof, key, row.current_node_id, row.steps_taken],
    );
  }
  const waits = (
    await db.query(
      `select payload from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='c01_financeiro_em_coleta' and idempotency_key=$3`,
      [scope.organizationId, scope.enrollmentId, key],
    )
  ).rows;
  if (!waits.length) return facts;
  const proof = prazoDaColetaSchema.safeParse(waits[0]?.payload);
  if (waits.length !== 1 || !proof.success) return null;
  return { ...facts, financialWait: proof.data };
}

/** Propaga até a disposição da fila, sem virar erro genérico de transporte. */
export class EsperaFinanceiraC01Error extends Error {
  readonly name = "c01_financeiro_em_coleta";
  constructor(readonly until: string) {
    super("projecao_em_coleta");
  }
}
export class BloqueioFinanceiroC01Error extends Error {
  readonly terminal = true;
  readonly name = "c01_financeiro_bloqueado";
}
