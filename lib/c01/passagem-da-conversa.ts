/**
 * (C01, -c01.15, P3) SENTIMENTO BAIXO SEM SILÊNCIO QUANDO A PASSAGEM ESTÁ DESLIGADA.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O alerta de clima (`ai.sentiment_alert`) chama `triggerHandoff`, que grava
 * `bot_silenced_until = 'infinity'` e tira a conversa da IA. Num agente com a
 * passagem desligada na tela (`ai_agent_versions.handoff_tool_enabled = false`),
 * a C01 não quer passar a conversa a ninguém: a IA continua atendendo, e quem
 * precisa olhar é a equipe, pelo caso. Com o silêncio, o cliente insatisfeito
 * ficava sem resposta nenhuma até alguém devolver a conversa pela tela.
 *
 * ─── O que este arquivo faz ─────────────────────────────────────────────────
 *
 * `passagemDesligadaNaConversa` diz se o agente que atende a conversa tem a
 * passagem desligada; `abrirCasoSemPassagem` abre o caso para a equipe, na mesma
 * forma de `openCase` (`lib/agent-engine/agent/human-cases.ts`), sem `force_human`
 * e sem silêncio. Com a passagem ligada, sem agente resolvido ou com erro de
 * leitura, o handler segue o caminho de hoje (`triggerHandoff`).
 */
import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
import { assertServiceBoundarySupabase } from "@/lib/atendimento/origem";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Os status de caso aberto — os mesmos de `OPEN_STATUSES` em `human-cases.ts`. */
const CASO_ABERTO = ["awaiting_human", "awaiting_lead"] as const;

const detalhe = (err: unknown): string =>
  (err instanceof Error ? err.message : typeof err === "string" ? err : "erro desconhecido").slice(0, 160);

/**
 * True só quando o agente que atende a conversa tem a versão PUBLICADA com
 * `handoff_tool_enabled === false`. Nunca lança: erro, conversa sem agente
 * resolvido ou versão fora do ar → `false`, que é o comportamento de hoje.
 *
 * Qual agente: o que a conversa tem fixado (`conversations.active_ai_agent_id`,
 * a aderência do roteador); sem ele, o agente publicado e não arquivado ligado à
 * conexão da conversa, na mesma ordem do loader do turno
 * (`loadPublishedAgentConfig`: `priority` maior, depois o mais antigo). Conversa
 * atendida por roteador sem aderência gravada não resolve agente aqui e segue o
 * caminho de hoje.
 */
export async function passagemDesligadaNaConversa(
  admin: Admin,
  organizationId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .select("active_ai_agent_id, channel_session_id")
      .eq("organization_id", organizationId)
      .eq("id", conversationId)
      .maybeSingle();
    if (erroConversa) throw new Error(erroConversa.message);
    if (!conversa) return false;
    const { active_ai_agent_id: fixado, channel_session_id: conexao } = conversa as {
      active_ai_agent_id: string | null;
      channel_session_id: string | null;
    };

    const versaoId =
      fixado !== null
        ? await versaoPublicadaDoAgente(admin, organizationId, fixado)
        : conexao !== null
          ? await versaoPublicadaDaConexao(admin, organizationId, conexao)
          : null;
    if (versaoId === null) return false;

    const { data: versao, error: erroVersao } = await admin
      .from("ai_agent_versions")
      .select("handoff_tool_enabled, status")
      .eq("organization_id", organizationId)
      .eq("id", versaoId)
      .maybeSingle();
    if (erroVersao) throw new Error(erroVersao.message);
    const v = versao as { handoff_tool_enabled: boolean | null; status: string } | null;
    return v !== null && v.status === "published" && v.handoff_tool_enabled === false;
  } catch (err) {
    logger.warn("[passagem-da-conversa] agente da conversa não lido — segue o caminho de hoje", {
      organization_id: organizationId,
      conversation_id: conversationId,
      detail: detalhe(err),
    });
    return false;
  }
}

/** A versão publicada de um agente não arquivado, ou `null`. */
async function versaoPublicadaDoAgente(
  admin: Admin,
  organizationId: string,
  agentId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("ai_agents")
    .select("published_version_id, archived_at")
    .eq("organization_id", organizationId)
    .eq("id", agentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const a = data as { published_version_id: string | null; archived_at: string | null } | null;
  return a !== null && a.archived_at === null ? a.published_version_id : null;
}

/**
 * A versão publicada do agente que o turno escolheria para a conexão: entre os
 * agentes não arquivados com versão publicada ligada a ela, o de `priority` maior
 * e, no empate, o mais antigo (a ordem de `loadPublishedAgentConfig`).
 */
async function versaoPublicadaDaConexao(
  admin: Admin,
  organizationId: string,
  channelSessionId: string,
): Promise<string | null> {
  const { data: agentes, error } = await admin
    .from("ai_agents")
    .select("id, published_version_id, priority, created_at")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .not("published_version_id", "is", null);
  if (error) throw new Error(error.message);
  const lista = (agentes ?? []) as Array<{
    id: string;
    published_version_id: string;
    priority: number | null;
    created_at: string;
  }>;
  if (lista.length === 0) return null;

  const { data: versoes, error: erroVersoes } = await admin
    .from("ai_agent_versions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("channel_session_id", channelSessionId)
    .eq("status", "published")
    .in(
      "id",
      lista.map((a) => a.published_version_id),
    );
  if (erroVersoes) throw new Error(erroVersoes.message);
  const daConexao = new Set(((versoes ?? []) as Array<{ id: string }>).map((v) => v.id));

  const escolhido = lista
    .filter((a) => daConexao.has(a.published_version_id))
    .sort(
      (x, y) =>
        (y.priority ?? 0) - (x.priority ?? 0) ||
        new Date(x.created_at).getTime() - new Date(y.created_at).getTime(),
    )[0];
  return escolhido?.published_version_id ?? null;
}

/** O que o caso do sentimento baixo diz à equipe. Sem texto do cliente: só o placar e o motor. */
export const TITULO_DO_CASO_POR_SENTIMENTO = "Cliente insatisfeito (sentimento baixo)";
export const BLOQUEIO_DO_CASO_POR_SENTIMENTO =
  "Aberto automaticamente: a leitura de clima da conversa marcou o cliente como insatisfeito. " +
  "A passagem de atendimento está desligada neste agente, então a IA continua atendendo: " +
  "uma pessoa da equipe precisa olhar a conversa.";

export function resumoDoCasoPorSentimento(score: number | null, motor: string | null): string {
  const placar = score === null ? "sem placar" : `placar ${score}`;
  return `Sentimento baixo na conversa (${placar}${motor ? `, medido por ${motor}` : ""}).`;
}

export type DesfechoDoCasoSemPassagem =
  | { aberto: true; caseId: string }
  | { aberto: false; motivo: "case_already_open" };

/**
 * Abre o caso, na forma de `openCase`: `agent_cases` em `awaiting_human`, `source`
 * `agent`, `kind` `outro`, e o evento `opened` com `actor_kind` `agent`. Não abre
 * se a conversa já tem caso aberto (`case_already_open`, que o chamador trata como
 * sucesso: a equipe já tem o que olhar).
 *
 * ⚠️ A dedup NÃO é atômica como a de `openCase` (um INSERT … WHERE NOT EXISTS num
 * statement só): pelo cliente do Supabase são duas idas ao banco, a leitura e a
 * escrita. Dois alertas da mesma conversa processados ao mesmo tempo por duas
 * instâncias do drain do event_log (cada uma reivindica o SEU evento) ou um alerta
 * junto do `open_human_case` do turno podem abrir dois casos. O drain processa os
 * eventos de uma instância em sequência, então a janela é a corrida entre
 * instâncias; o pior desfecho é um caso a mais na fila, não um cliente calado.
 *
 * Lança em erro de banco: o handler devolve `error` e o event_log re-tenta.
 */
export async function abrirCasoSemPassagem(
  admin: Admin,
  input: {
    organizationId: string;
    conversationId: string;
    serviceBoundary: ServiceBoundary | null;
    title: string;
    summary: string;
    blocker: string;
  },
): Promise<DesfechoDoCasoSemPassagem> {
  const { data: aberto, error: erroLeitura } = await admin
    .from("agent_cases")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("conversation_id", input.conversationId)
    .in("status", CASO_ABERTO as unknown as string[])
    .limit(1)
    .maybeSingle();
  if (erroLeitura) throw new Error(`caso aberto não lido: ${erroLeitura.message}`);
  if (aberto) return { aberto: false, motivo: "case_already_open" };

  // A mesma régua de `triggerHandoff`: a escrita só sai se o atendimento ainda é o
  // que o alerta mediu (a conversa não trocou de mãos nem de demanda no meio).
  await assertServiceBoundarySupabase(admin, input.serviceBoundary);
  const { data: caso, error: erroCaso } = await admin
    .from("agent_cases")
    .insert({
      organization_id: input.organizationId,
      conversation_id: input.conversationId,
      title: input.title,
      summary: input.summary,
      blocker: input.blocker,
      context_snapshot: input.serviceBoundary ? { service_boundary: input.serviceBoundary } : {},
      source: "agent",
      kind: "outro",
    })
    .select("id")
    .single();
  if (erroCaso || !caso) throw new Error(`caso não aberto: ${erroCaso?.message ?? "sem id"}`);
  const caseId = (caso as { id: string }).id;

  const { error: erroEvento } = await admin.from("agent_case_events").insert({
    organization_id: input.organizationId,
    case_id: caseId,
    kind: "opened",
    actor_kind: "agent",
  });
  if (erroEvento) {
    // O caso já está na fila da equipe: falhar aqui faria o retry abrir o mesmo
    // caso de novo (a leitura acima o acharia, então não duplica, mas o handler
    // devolveria erro à toa). Fica no log.
    logger.warn("[passagem-da-conversa] evento 'opened' do caso não gravado", {
      organization_id: input.organizationId,
      case_id: caseId,
      detail: detalhe(erroEvento.message),
    });
  }
  return { aberto: true, caseId };
}
