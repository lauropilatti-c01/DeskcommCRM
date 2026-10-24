import type { SupabaseClient } from "@supabase/supabase-js";
import type { FlowGraph } from "./graph-schema";
import { rotaDeContinuacaoC01 } from "./c01-continuacao-grafo";
import { configOrigemC01 } from "./c01-origem";
import { politicaDoVideoValidaC01 } from "./c01-video-curso";
import { configuracoesFinanceiras } from "@/lib/leads/configuracao-financeira";
/** Pré-voo no servidor. Não há booleano de prontidão vindo do formulário.
 * Credencial/mapa disponível não é prova de ausência de compra: o envio ainda
 * relê as duas fontes para a pessoa e a oportunidade sob trava.
 * Depois das guardas, prepara a ativação na cópia do grafo do servidor. */
export async function conferirPublicacaoC01(
  admin: SupabaseClient,
  params: {
    orgId: string;
    pointerId: string;
    graph: FlowGraph;
  },
  now = new Date(),
): Promise<string | null> {
  const policy = params.graph.settings?.c01_acompanhamento;
  if (!policy) return null;
  const cfg = configOrigemC01();
  if (
    !cfg?.enabled ||
    cfg.organizationId !== params.orgId ||
    (policy.kind === "conversa"
      ? !cfg.continuation?.enabled ||
        cfg.continuation.policyStatus !== "approved" ||
        !cfg.continuation.activatedAt
      : !cfg.allowedKinds.includes(policy.kind))
  )
    return "A integração de acompanhamentos está desligada ou não pertence a esta organização.";
  if (
    policy.kind === "video_curso" &&
    (!cfg.videoCourse?.catalog.length || !politicaDoVideoValidaC01(params.graph, cfg))
  )
    return "A pergunta após o vídeo precisa de catálogo, texto aprovado e grafo de toque único habilitado.";
  if (policy.kind === "conversa" && !rotaDeContinuacaoC01(params.graph, "L1", 1))
    return "A continuação exige o grafo de um toque, distinto da oferta.";
  const { data: pointer, error } = await admin
    .from("followup_flow_pointers")
    .select("id,active_version_id,trigger_config")
    .eq("organization_id", params.orgId)
    .eq("id", params.pointerId)
    .maybeSingle();
  if (error || !pointer) return "Não foi possível conferir a versão deste fluxo.";
  if (policy.kind === "conversa" && pointer.trigger_config?.cancel_on_reply !== true)
    return "A continuação exige cancelamento por resposta; não desative cancel_on_reply.";
  let previousAt: string | null = null;
  if (pointer.active_version_id) {
    const { data: version, error: e } = await admin
      .from("followup_flow_versions")
      .select("graph")
      .eq("organization_id", params.orgId)
      .eq("id", pointer.active_version_id)
      .maybeSingle();
    if (e || !version) return "A versão publicada não pôde ser conferida.";
    const previous = version.graph?.settings?.c01_acompanhamento;
    if (previous && previous.kind !== policy.kind)
      return "Uma modalidade diferente exige outro fluxo; não reutilize a ativação anterior.";
    previousAt = previous?.activated_at ?? null;
    if (previous && (!previousAt || !Number.isFinite(Date.parse(previousAt))))
      return "A origem da versão anterior não pôde ser conferida.";
  }
  let financial;
  try {
    financial = configuracoesFinanceiras().filter(
      (c) => c.enabled && c.organizationId === params.orgId,
    );
  } catch {
    return "A configuração financeira do servidor é inválida.";
  }
  const providers = ["guru", "boleto"] as const;
  const mapped = providers.map((provider) =>
    financial
      .filter((c) => c.provider === provider)
      .flatMap((c) => c.products)
      .filter((p) => p.commercialFlowIds.includes(params.pointerId))
      .map((p) => `${p.crmProductKey}::${p.crmOfferKey}`),
  );
  if (
    policy.kind === "conversa" &&
    (!providers.every((provider) => financial.some((c) => c.provider === provider)) ||
      financial.some((c) => c.provider === "guru" && !c.historyCoverage))
  )
    return "Falta a cobertura financeira integral por pessoa, comprovada nas duas fontes.";
  if (
    policy.kind !== "conversa" &&
    (mapped.some((xs) => !xs.length) ||
      mapped[0]!.some((key) => !mapped[1]!.includes(key)) ||
      mapped[1]!.some((key) => !mapped[0]!.includes(key)))
  )
    return "Faltam mapas equivalentes de produto/oferta deste fluxo nas fontes Guru e boleto habilitadas.";
  const { data: channels, error: ce } = await admin
    .from("channel_sessions")
    .select("id,status")
    .eq("organization_id", params.orgId)
    .is("archived_at", null);
  if (ce || !channels?.some((c) => c.status === "WORKING"))
    return "Nenhum canal desta organização está conectado.";
  if (policy.kind === "oferta" || policy.kind === "video_curso") {
    const connectionId =
      policy.kind === "oferta" ? cfg.offerConnectionId : cfg.videoCourse?.connectionId;
    if (!connectionId)
      return "Falta a conexão comercial autorizada para comprovar a origem das ofertas.";
    const { data: connection, error: e } = await admin
      .from("external_db_connections")
      .select("id,enabled")
      .eq("organization_id", params.orgId)
      .eq("id", connectionId)
      .maybeSingle();
    if (e || !connection?.enabled) return "A conexão comercial da origem está indisponível.";
  }
  const { data: others, error: oe } = await admin
    .from("followup_flow_pointers")
    .select("id,active_version_id")
    .eq("organization_id", params.orgId)
    .eq("status", "active")
    .neq("id", params.pointerId);
  if (oe) return "Não foi possível conferir outros acompanhamentos ativos.";
  for (const other of others ?? []) {
    if (!other.active_version_id) continue;
    const { data: v, error: e } = await admin
      .from("followup_flow_versions")
      .select("graph")
      .eq("organization_id", params.orgId)
      .eq("id", other.active_version_id)
      .maybeSingle();
    if (e || !v) return "Não foi possível conferir outra versão ativa.";
    if (v.graph?.settings?.c01_acompanhamento?.kind === policy.kind)
      return "Já existe um acompanhamento ativo desta modalidade.";
  }
  // O cliente não escolhe o passado. O clique recebe a hora do servidor;
  // versões seguintes preservam exatamente a primeira ativação válida.
  policy.activated_at = previousAt ?? now.toISOString();
  return null;
}
