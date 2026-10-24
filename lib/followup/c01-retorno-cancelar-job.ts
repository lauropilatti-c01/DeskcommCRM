import type { Pool } from "pg";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { cancelJob, type JobRow } from "@/lib/agent-engine/queue/queue";

/** O fato terminal é gravado ANTES da limpeza: se ela falhar, o lease seguinte
 * encontra a revogação nativa e não ressuscita a promessa. Cada commit confere
 * o lease com microssegundos. Não cancela outra inscrição, contato ou tentativa.
 * Sem motivo novo, só limpa callback que JÁ tem a revogação durável.
 */
export async function cancelarRetornoC01DoJob(
  pool: Pool,
  job: JobRow,
  workerId: string,
  reason?: string,
): Promise<boolean> {
  const claim = claimOfJob(job);
  if (
    !claim ||
    job.kind !== "followup_turn" ||
    job.payload.scope !== "commercial" ||
    !job.payload.c01_callback
  )
    return false;
  const tx = await pool.connect();
  try {
    const current = async () =>
      (
        await tx.query(
          `select payload from job_queue where organization_id=$1 and contact_id=$2 and id=$3
       and kind='followup_turn' and status='running' and locked_by=$4 and locked_at=$5::timestamptz
       and payload->>'scope'='commercial' and payload ? 'c01_callback' for update`,
          [job.organization_id, job.contact_id, job.id, workerId, claim.acquired_at],
        )
      ).rows[0];
    await tx.query("begin");
    const row = await current();
    if (!row) {
      await tx.query("commit");
      return true;
    }
    const revoked =
      (
        await tx.query("select public.fn_autonomous_turn_revoked($1,$2) as revoked", [
          job.organization_id,
          job.id,
        ])
      ).rows[0]?.revoked === true;
    if (!reason && !revoked) {
      await tx.query("commit");
      return false;
    }
    if (!revoked) {
      const conversation = row.payload.service_boundary?.conversation_id;
      if (typeof conversation !== "string") throw new Error("c01_callback_boundary_missing");
      await tx.query(
        `/* c01:callback:cancel:revocation */ insert into event_log
         (organization_id,event_type,entity_kind,entity_id,payload,status)
         values($1,'conversation.autonomous_turn_revoked','job',$2,$3,'done')`,
        [job.organization_id, job.id, { conversation_id: conversation, reason }],
      );
    }
    await tx.query("commit");
    // Queda aqui conserva o fato. O worker seguinte usa a mesma limpeza sob seu lease.
    await tx.query("begin");
    if (await current()) {
      await tx.query(
        `/* c01:callback:cancel:messages */ update messages m
         set status='failed',error_code='c01_callback_cancelled',error_message=$4
         from send_ledger s where s.organization_id=$1 and s.job_id=$2 and s.contact_id=$3
          and s.status <> 'accepted'
          and m.organization_id=s.organization_id and m.contact_id=s.contact_id
          and (m.id=s.id or m.id=s.crm_message_id) and m.direction='outbound' and m.status='queued'`,
        [job.organization_id, job.id, job.contact_id, reason ?? "c01_callback_revoked"],
      );
      await tx.query(
        `update send_ledger s set status='failed',last_error=$4,updated_at=now()
         where s.organization_id=$1 and s.job_id=$2 and s.contact_id=$3 and s.status in ('requested','queued')
           and not exists(select 1 from messages m where m.organization_id=s.organization_id
             and (m.id=s.id or m.id=s.crm_message_id) and m.status in ('sent','delivered','read'))`,
        [job.organization_id, job.id, job.contact_id, reason ?? "c01_callback_revoked"],
      );
      await cancelJob(tx, job.id, workerId, reason ?? "c01_callback_revoked", claim.acquired_at);
    }
    await tx.query("commit");
    return true;
  } catch (error) {
    await tx.query("rollback");
    throw error;
  } finally {
    tx.release();
  }
}
