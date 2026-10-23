import type { Queryable } from "../queue/queue";
import { lerJanelaDeFollowup, proximaAberturaDoFollowup } from "./janela-de-followup";

type Decisao = { tipo: "seguir" } | { tipo: "adiar"; ate: Date } | { tipo: "impedido"; motivo: string };

/** Configuração publicada atual, não a faixa congelada quando a promessa nasceu. */
export async function conferirCallbackAntesDoTurno(
  db: Queryable, org: string, agenteId: string | undefined, agora: Date,
  exigirComercialC01 = false,
): Promise<Decisao> {
  if (!agenteId) return { tipo: "seguir" }; // callback legado, sem mudança retroativa
  const { rows } = await db.query<{
    followup: { callback_enabled?: boolean; c01_callback?: boolean; send_window?: unknown } | null;
    timezone: string; paused_at: string | null; operation_mode: string; archived_at: string | null;
  }>(`select v.followup, o.timezone, a.paused_at, a.operation_mode, a.archived_at
        from ai_agents a
        join ai_agent_versions v on v.id = a.published_version_id and v.organization_id = a.organization_id
        join organizations o on o.id = a.organization_id
       where a.organization_id = $1 and a.id = $2`, [org, agenteId]);
  const atual = rows[0];
  if (!atual || atual.paused_at || atual.archived_at || atual.operation_mode !== "automatic" || atual.followup?.callback_enabled === false ||
      (exigirComercialC01 && (atual.followup?.c01_callback !== true || atual.followup?.callback_enabled !== true))) {
    return { tipo: "impedido", motivo: "callback_nao_autorizado_pelo_agente" };
  }
  if (atual.followup?.send_window != null && !lerJanelaDeFollowup(atual.followup, atual.timezone)) {
    throw new Error("callback_send_window_invalid");
  }
  const ate = proximaAberturaDoFollowup(atual.followup, atual.timezone, agora);
  return ate ? { tipo: "adiar", ate } : { tipo: "seguir" };
}
