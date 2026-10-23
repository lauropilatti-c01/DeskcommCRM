import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProactiveContext } from "@/lib/agenda/efeito";
import { ApiError } from "@/lib/api/types";
import {
  avaliarAcompanhamento,
  c01AcompanhamentoSchema,
  type ConfigAcompanhamento,
  type DecisaoAcompanhamento,
  type FatosAcompanhamento,
} from "./c01-acompanhamento";

export interface EscopoAcompanhamento {
  organizationId: string;
  contactId: string;
  enrollmentId: string;
}
/**
 * Porta para a futura integração aplicada. Ela precisa reconciliar identidade,
 * negócio, origem e recibos. O sincronizador em observação NÃO implementa esta
 * porta e campos/tags editáveis pela IA NÃO são prova financeira.
 */
export type FonteAcompanhamento = (
  scope: EscopoAcompanhamento,
) => Promise<FatosAcompanhamento | null>;
const fonteAindaIndisponivel: FonteAcompanhamento = async () => null;

export async function decidirAcompanhamentoC01(
  config: ConfigAcompanhamento,
  scope: EscopoAcompanhamento,
  now: Date,
  fonte: FonteAcompanhamento = fonteAindaIndisponivel,
): Promise<DecisaoAcompanhamento> {
  if (!config.activated_at) return { kind: "blocked", reason: "ativacao_pendente" };
  const facts = await fonte(scope);
  if (!facts) return { kind: "blocked", reason: "integracao_aplicada_indisponivel" };
  if (facts.organizationId !== scope.organizationId || facts.contactId !== scope.contactId)
    return { kind: "blocked", reason: "fonte_fora_do_escopo" };
  return avaliarAcompanhamento(config, facts, now);
}

/**
 * Última defesa na porta comum de texto, mídia e template. Sempre relê o grafo
 * pinado, incluindo jobs já enfileirados: tirar a flag do payload não a apaga.
 * Opt-in ainda bloqueado no runtime até existir a fonte aplicada e sua prova.
 */
export async function assertAcompanhamentoC01Supabase(
  db: SupabaseClient,
  context: ProactiveContext,
  organizationId: string,
  now = new Date(),
): Promise<void> {
  if (!context.enrollmentId) return; // Retornos legados têm sua própria política.
  const refuse = (reason: string): never => {
    throw new ApiError(
      409,
      "c01_acompanhamento_bloqueado",
      { terminal: true, reason },
      context.jobId ?? "followup",
      "Acompanhamento C01 bloqueado; confira as pendências do fluxo.",
    );
  };
  if (context.organizationId !== organizationId) refuse("organizacao_incompativel");
  const { data: enrollment, error: enrollmentError } = await db
    .from("followup_enrollments")
    .select("version_id,contact_id")
    .eq("organization_id", organizationId)
    .eq("id", context.enrollmentId)
    .eq("contact_id", context.contactId)
    .maybeSingle();
  if (enrollmentError || !enrollment) return refuse("inscricao_indisponivel");
  const { data: version, error: versionError } = await db
    .from("followup_flow_versions")
    .select("graph")
    .eq("organization_id", organizationId)
    .eq("id", enrollment.version_id)
    .maybeSingle();
  if (versionError || !version) return refuse("versao_indisponivel");
  const raw = version.graph?.settings?.c01_acompanhamento;
  if (raw === undefined) return;
  const config = c01AcompanhamentoSchema.safeParse(raw);
  if (!config.success) return refuse("politica_invalida");
  const decision = await decidirAcompanhamentoC01(
    config.data,
    { organizationId, contactId: context.contactId, enrollmentId: context.enrollmentId },
    now,
  );
  // Esta implementação não oferece uma chave para o operador afirmar que a
  // integração está pronta. Só código de uma fonte aplicada pode liberar.
  if (decision.kind !== "send")
    refuse("reason" in decision ? decision.reason : "envio_nao_autorizado");
}
