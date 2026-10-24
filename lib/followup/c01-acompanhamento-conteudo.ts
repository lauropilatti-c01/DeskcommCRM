import { AsyncLocalStorage } from "node:async_hooks";
import { hashDoCorpo } from "@/lib/api/idempotency";
import { exigeCatalogoCronogramaC01, resolverRamoCronogramaC01 } from "./c01-cronograma-catalogo";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { resolveModeloAprovado } from "@/lib/channels/meta/resolve-modelo-followup";
import { ApiError } from "@/lib/api/types";
import { configOrigemC01, conferirOrigemC01, type ConfigOrigemC01 } from "./c01-origem";
import { conferirVinculoContinuacaoC01, lerTurnoContinuacaoC01 } from "./c01-continuacao-fontes";
import { flowGraphSchema } from "./graph-schema";

export async function resolverModeloOfertaC01(
  db: Queryable,
  cfg: ConfigOrigemC01,
  scope: {
    organizationId: string;
    versionId: string;
    nodeId: string;
    productKey: string;
    connectionId: string;
  },
) {
  if (
    !cfg.enabled ||
    cfg.organizationId !== scope.organizationId ||
    !cfg.offerTemplates?.enabled ||
    cfg.offerTemplates.policyStatus !== "approved"
  )
    return null;
  const matches = cfg.offerTemplates.bindings.filter(
    (b) =>
      b.versionId === scope.versionId &&
      b.nodeId === scope.nodeId &&
      b.productKey === scope.productKey &&
      b.connectionId === scope.connectionId,
  );
  if (matches.length !== 1) return null;
  const binding = matches[0]!;
  const ready = (
    await db.query("select status from channel_sessions where organization_id=$1 and id=$2", [
      scope.organizationId,
      scope.connectionId,
    ])
  ).rows;
  if (ready.length !== 1 || ready[0]?.status !== "WORKING") return null;
  const definition = (
    await db.query(
      "select language,category from meta_templates where organization_id=$1 and id=$2",
      [scope.organizationId, binding.templateId],
    )
  ).rows;
  if (
    definition.length !== 1 ||
    definition[0]?.language !== binding.language ||
    definition[0]?.category !== binding.category
  )
    return null;
  const result = await resolveModeloAprovado(
    db,
    scope.organizationId,
    scope.connectionId,
    binding.templateId,
    binding.contentHash,
  );
  return result?.tipo === "modelo_aprovado" ? result : null;
}

/** Lê o nó pinado e a proposta assinada; nunca usa placeholder ou texto mutável do payload. */
export async function resolverPassoC01(
  db: Queryable,
  scope: {
    organizationId: string;
    contactId: string;
    enrollmentId: string;
    nodeId: string;
    connectionId: string;
  },
  now: Date,
) {
  const rows = (
    await db.query(
      `/* c01:conteudo:passo */ select e.status,e.current_node_id,e.version_id,e.conversation_id,v.graph,
    p.status as pointer_status,cv.channel_session_id,cv.last_inbound_at,ct.payload as continuation,ev.payload as origin
    from followup_enrollments e join followup_flow_versions v on v.organization_id=e.organization_id and v.id=e.version_id
    join followup_flow_pointers p on p.organization_id=e.organization_id and p.id=e.pointer_id
    join conversations cv on cv.organization_id=e.organization_id and cv.contact_id=e.contact_id and cv.id=e.conversation_id
    left join followup_enrollment_events ct on ct.organization_id=e.organization_id and ct.enrollment_id=e.id and ct.event_type='c01_continuacao_entregue'
    left join followup_enrollment_events ev on ev.organization_id=e.organization_id and ev.enrollment_id=e.id and ev.event_type='c01_origem_entregue'
    where e.organization_id=$1 and e.contact_id=$2 and e.id=$3`,
      [scope.organizationId, scope.contactId, scope.enrollmentId],
    )
  ).rows;
  const row = rows[0];
  if (row?.graph?.settings?.c01_acompanhamento === undefined) return null;
  const block = (reason: string): never => {
    throw new ApiError(
      409,
      "c01_conteudo_indisponivel",
      { reason, terminal: false },
      scope.enrollmentId,
    );
  };
  if (rows.length !== 1) return block("origem_duplicada");
  const cfg = configOrigemC01();
  if (!cfg?.enabled || cfg.organizationId !== scope.organizationId)
    return block("integracao_desligada");
  const graph = flowGraphSchema.parse(row.graph),
    policy = graph.settings?.c01_acompanhamento;
  if (
    !policy?.activated_at ||
    row.pointer_status !== "active" ||
    !["active", "waiting_reply"].includes(row.status) ||
    row.current_node_id !== scope.nodeId ||
    row.channel_session_id !== scope.connectionId
  )
    return block("passo_ou_canal_alterado");
  const node = graph.nodes.find((n) => n.id === scope.nodeId);
  if (node?.type !== "action") return block("no_nao_e_envio");
  const last = new Date(row.last_inbound_at ?? "invalid");
  if (!Number.isFinite(+last) || +last > +now) return block("janela_desconhecida");
  const closed = +now - +last >= 24 * 3600000;
  if (exigeCatalogoCronogramaC01(graph)) {
    if (closed) return block("janela_fechada");
    const catalog = await resolverRamoCronogramaC01(db, scope, graph, row.version_id);
    if (
      catalog.status === "indisponivel" ||
      catalog.status === "sem_material" ||
      catalog.targetNodeId !== scope.nodeId ||
      !catalog.body
    )
      return block("catalogo_do_cronograma_indisponivel");
    return { tipo: "texto" as const, body: catalog.body };
  }
  if (policy.kind === "conversa") {
    const proof = conferirVinculoContinuacaoC01(cfg, row.continuation),
      p = proof?.candidate;
    if (
      !proof ||
      proof.enrollmentId !== scope.enrollmentId ||
      !p ||
      p.organizationId !== scope.organizationId ||
      p.contactId !== scope.contactId ||
      p.conversationId !== row.conversation_id ||
      p.proposal.estado !== "pendente" ||
      p.proposal.caminho !== "L1" ||
      !p.proposal.texto ||
      closed
    )
      return block("L1_sem_prova_ou_janela");
    const turn = await lerTurnoContinuacaoC01(db, cfg, p.jobId, now, scope.enrollmentId);
    if (
      !turn ||
      turn.candidate.signature !== p.signature ||
      turn.facts.latestInboundId !== p.inboundMessageId
    )
      return block("turno_alterado");
    return { tipo: "texto" as const, body: p.proposal.texto };
  }
  const origin = conferirOrigemC01(cfg, row.origin);
  if (
    !origin ||
    origin.organizationId !== scope.organizationId ||
    origin.contactId !== scope.contactId ||
    origin.conversationId !== row.conversation_id
  )
    return block("origem_invalida");
  if (closed || node.config.mode === "template") {
    if (policy.kind !== "oferta") return block("janela_fechada");
    const modelo = await resolverModeloOfertaC01(db, cfg, {
      organizationId: scope.organizationId,
      versionId: row.version_id,
      nodeId: scope.nodeId,
      productKey: origin.productKey,
      connectionId: scope.connectionId,
    });
    return modelo ?? block("modelo_exato_indisponivel");
  }
  if (node.config.mode !== "text" || node.config.media_url)
    return block("conteudo_nao_deterministico");
  return { tipo: "texto" as const, body: node.config.body };
}

type EscopoConteudoC01 = {
  organizationId: string;
  contactId: string;
  enrollmentId: string;
  nodeId: string;
  connectionId: string;
  jobId: string;
};
const conteudoEmEnvio = new AsyncLocalStorage<{ scope: EscopoConteudoC01; hash: string }>();
/** Vincula a resolução à chamada física. Sem esse contexto, watchdog/replay não
 * transforma um corpo antigo em conteúdo autorizado depois de o perfil mudar. */
export function comConteudoResolvidoC01<T>(
  scope: EscopoConteudoC01,
  content: unknown,
  action: () => Promise<T>,
): Promise<T> {
  return conteudoEmEnvio.run({ scope, hash: hashDoCorpo(content) }, action);
}
export function escopoDoConteudoC01(context: {
  organizationId: string;
  contactId: string;
  enrollmentId?: string;
  jobId?: string;
}) {
  const value = conteudoEmEnvio.getStore();
  if (
    !value ||
    value.scope.organizationId !== context.organizationId ||
    value.scope.contactId !== context.contactId ||
    value.scope.enrollmentId !== context.enrollmentId ||
    value.scope.jobId !== context.jobId
  )
    throw new Error("c01_conteudo_sem_contexto_de_envio");
  return value.scope;
}
export function conferirConteudoResolvidoC01(
  context: { organizationId: string; contactId: string; enrollmentId?: string; jobId?: string },
  current: unknown,
) {
  escopoDoConteudoC01(context);
  if (current === null || hashDoCorpo(current) !== conteudoEmEnvio.getStore()!.hash)
    throw new Error("c01_conteudo_alterado_antes_do_envio");
}
