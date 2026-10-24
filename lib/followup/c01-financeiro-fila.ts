import type { Pool } from "pg";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { cancelJob } from "@/lib/agent-engine/queue/queue";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import { completeTurnForEnrollment, createPgAdminClient } from "./turn-bridge";
import {
  type EsperaFinanceiraC01Error,
  BloqueioFinanceiroC01Error,
  prazoDaColetaSchema,
} from "./c01-financeiro-espera";

/** Mesma aquisição e mesmo passo: o job espera, sem consumir tentativa nem emitir mensagem. */
export async function disporJobFinanceiroC01(
  pool: Pool,
  job: Pick<
    JobRow,
    "id" | "organization_id" | "contact_id" | "payload" | "locked_by" | "claim_acquired_at"
  >,
  error: EsperaFinanceiraC01Error | BloqueioFinanceiroC01Error,
  now = new Date(),
): Promise<void> {
  const claim = claimOfJob(job),
    enrollmentId = job.payload.followup_enrollment_id,
    nodeId = job.payload.node_id;
  if (!claim || !job.contact_id || typeof enrollmentId !== "string" || typeof nodeId !== "string")
    throw new StaleServiceBoundaryError();
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local lock_timeout='5s'");
    await db.query("select public.fn_service_lock($1,$2)", [job.organization_id, job.contact_id]);
    const current = (
      await db.query(
        "select id from job_queue where organization_id=$1 and id=$2 and contact_id=$3 and kind='followup_turn' and status='running' and locked_by=$4 and locked_at=$5 for update",
        [job.organization_id, job.id, job.contact_id, claim.worker_id, claim.acquired_at],
      )
    ).rows;
    if (current.length !== 1) throw new StaleServiceBoundaryError();
    const bridge = createPgAdminClient(db);
    if (error instanceof BloqueioFinanceiroC01Error) {
      const e = await bridge.loadEnrollmentById(job.organization_id, enrollmentId);
      if (
        !e ||
        !["active", "waiting_reply"].includes(e.status) ||
        e.contact_id !== job.contact_id ||
        e.current_node_id !== nodeId
      )
        throw new StaleServiceBoundaryError();
      await bridge.assertFollowupJob!(job.organization_id, job.id, enrollmentId, nodeId, claim);
      await bridge.assertServiceBoundary!(e);
      await bridge.applyEnrollmentStep!(
        enrollmentId,
        job.organization_id,
        {
          status: "paused_manual",
          next_eval_at: null,
          claimed_until: null,
          last_error: `c01:${error.message}`,
        },
        {
          job_id: job.id,
          job_claim: claim,
          node_id: nodeId,
          event_type: "c01_acompanhamento_retido",
          payload: { decision: "blocked", reason: error.message },
          idempotency_key: `${nodeId}:${e.steps_taken}:financeiro:${job.id}`,
        },
      );
      // Linha preparada não é recibo: a espera conserva queued; bloqueio final
      // encerra só o que ainda não foi aceito, na transação da inscrição/job.
      await db.query(
        `update messages m set status='failed',error_code='c01_financeiro_bloqueado',error_message=$4
         from send_ledger s where s.organization_id=$1 and s.job_id=$2 and s.contact_id=$3
          and s.status <> 'accepted' and m.organization_id=s.organization_id and m.contact_id=s.contact_id
          and (m.id=s.id or m.id=s.crm_message_id) and m.direction='outbound' and m.status='queued'
          and m.external_id is null`,
        [job.organization_id,job.id,job.contact_id,error.message],
      );
      await db.query(
        `update send_ledger s set status='failed',last_error=$4,updated_at=now()
         where s.organization_id=$1 and s.job_id=$2 and s.contact_id=$3 and s.status in ('requested','queued')
          and not exists(select 1 from messages m where m.organization_id=s.organization_id
           and (m.id=s.id or m.id=s.crm_message_id) and (m.status in ('sent','delivered','read') or m.external_id is not null))`,
        [job.organization_id,job.id,job.contact_id,error.message],
      );
      await cancelJob(db, job.id, claim.worker_id, error.message, claim.acquired_at);
      await db.query("commit");
      return;
    }
    const rows = (
      await db.query(
        `select ev.payload from followup_enrollments e join followup_enrollment_events ev on ev.organization_id=e.organization_id and ev.enrollment_id=e.id
      and ev.event_type='c01_financeiro_em_coleta' and ev.idempotency_key=e.current_node_id||':'||e.steps_taken::text||':coleta_financeira'
      where e.organization_id=$1 and e.id=$2 and e.contact_id=$3 and e.current_node_id=$4 and e.status in ('active','waiting_reply') for update of e`,
        [job.organization_id, enrollmentId, job.contact_id, nodeId],
      )
    ).rows;
    const proof = prazoDaColetaSchema.safeParse(rows[0]?.payload),
      until = Date.parse(error.until);
    if (
      rows.length !== 1 ||
      !proof.success ||
      !Number.isFinite(until) ||
      until <= +now ||
      until > +now + 60_000 ||
      until > Date.parse(proof.data.deadlineAt)
    )
      throw new StaleServiceBoundaryError();
    await completeTurnForEnrollment(
      bridge,
      job.organization_id,
      enrollmentId,
      nodeId,
      { kind: "deferred", until: new Date(until), reason: "projecao_em_coleta" },
      () => now,
      job.id,
      claim,
    );
    const settled = await db.query(
      "select public.fn_followup_inline_settle($1,$2,$3,false,$4,$5,true,$6) as held",
      [job.organization_id, job.id, claim.worker_id, error.message, error.until, claim.acquired_at],
    );
    if (settled.rows[0]?.held !== true) throw new StaleServiceBoundaryError();
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}
