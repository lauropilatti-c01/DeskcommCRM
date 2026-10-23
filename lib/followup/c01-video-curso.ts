/** Toque único pós-vídeo: identidade canônica, sem decidir copy nem chamar IA. */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { linksNoTexto } from "@/lib/agent-engine/guardrails/link-permitido";
import { configOrigemC01, type ConfigOrigemC01, type OrigemC01 } from "./c01-origem";

export interface VideoConsultadoC01 {
  key: string;
  productKey: string;
  url: string;
}
export function videoCursoHabilitado(cfg: ConfigOrigemC01): boolean {
  return (
    cfg.enabled &&
    cfg.allowedKinds.includes("video_curso") &&
    cfg.videoCourse?.enabled === true &&
    cfg.videoCourse.copyStatus === "approved"
  );
}
export function videoDaOrigemValido(
  cfg: ConfigOrigemC01,
  origin: OrigemC01,
  message: Record<string, unknown>,
): boolean {
  if (!videoCursoHabilitado(cfg) || origin.kind !== "video_curso") return false;
  const item = cfg.videoCourse!.catalog.find(
    (c) => c.key === origin.videoKey && c.productKey === origin.productKey,
  );
  if (!item) return false;
  return (
    linksNoTexto(String(message.body ?? "")).includes(item.url) ||
    (message.type === "video" &&
      !!item.sha256 &&
      message.media_storage_path ===
        `${cfg.organizationId}/${message.conversation_id}/video-${item.sha256}.mp4`)
  );
}
/** Somente agente_pagina da conexão canônica executada; nota/RAG não são prova. */
export function videosDaConsultaC01(
  input: unknown,
  output: unknown,
  cfg: ConfigOrigemC01,
): VideoConsultadoC01[] {
  if (
    !videoCursoHabilitado(cfg) ||
    !input ||
    typeof input !== "object" ||
    !output ||
    typeof output !== "object"
  )
    return [];
  const args = input as Record<string, unknown>,
    envelope = output as Record<string, unknown>;
  if (
    envelope.isError ||
    args.tabela !== "agente_pagina" ||
    (args.schema !== undefined && args.schema !== "c01")
  )
    return [];
  let raw = envelope.structuredContent ?? envelope;
  if (!envelope.structuredContent && Array.isArray(envelope.content)) {
    const parts = envelope.content.filter((p: { type?: string }) => p?.type === "text");
    if (parts.length !== 1 || typeof parts[0]?.text !== "string") return [];
    try {
      raw = JSON.parse(parts[0].text);
    } catch {
      return [];
    }
  }
  if (!raw || typeof raw !== "object") return [];
  const data = raw as Record<string, unknown>;
  if (
    data.erro ||
    data.isError ||
    data.truncado ||
    data.schema !== "c01" ||
    data.tabela !== "agente_pagina" ||
    (data.conexao as { id?: string })?.id !== cfg.videoCourse!.connectionId ||
    !Array.isArray(data.linhas)
  )
    return [];
  const filters = Array.isArray(args.filtros) ? (args.filtros as Record<string, unknown>[]) : [];
  const products = filters
    .filter((f) => f.coluna === "enfase_id" && f.operador === "eq" && typeof f.valor === "string")
    .map((f) => f.valor);
  if (products.length !== 1) return [];
  return data.linhas.flatMap((r: unknown) => {
    if (!r || typeof r !== "object") return [];
    const row = r as Record<string, unknown>;
    // pode_afirmar autoriza argumentos comerciais do plano, não o vídeo. A URL
    // já precisa vir da consulta canônica e coincidir com o catálogo revisado.
    if (row.enfase_id !== undefined && row.enfase_id !== products[0]) return [];
    return cfg
      .videoCourse!.catalog.filter(
        (c) => c.productKey === products[0] && c.url === row.video_curso_url,
      )
      .map(({ key, productKey, url }) => ({ key, productKey, url }));
  });
}

/** A mídia nativa já foi preparada/verificada por V1; o caminho imutável vincula
 * o SHA aprovado, a organização e a conversa. Link precisa da consulta do turno. */
export async function origemDoVideoEnviadoC01(
  db: Queryable,
  org: string,
  contact: string,
  conversation: string,
  body: string,
  media: { type?: string; storagePath?: string } | undefined,
  consulted: VideoConsultadoC01[],
): Promise<OrigemC01 | undefined> {
  const cfg = configOrigemC01();
  if (!cfg || cfg.organizationId !== org || !videoCursoHabilitado(cfg)) return;
  const links = new Set(linksNoTexto(body));
  const matches = cfg.videoCourse!.catalog.filter(
    (c) =>
      (media?.type === "video" &&
        !!c.sha256 &&
        media.storagePath === `${org}/${conversation}/video-${c.sha256}.mp4`) ||
      (links.has(c.url) &&
        consulted.some((v) => v.key === c.key && v.productKey === c.productKey && v.url === c.url)),
  );
  if (matches.length !== 1) return;
  const item = matches[0]!;
  const leads = (
    await db.query(
      `select id from crm_leads where organization_id=$1 and contact_id=$2
    and status='open' and custom_fields->>'produto_chave'=$3 order by created_at,id limit 2`,
      [org, contact, item.productKey],
    )
  ).rows;
  if (leads.length !== 1) return;
  return {
    kind: "video_curso",
    leadId: leads[0]!.id,
    productKey: item.productKey,
    videoKey: item.key,
  };
}

/** Configuração não vira atalho para IA, vários toques, template ou Perdido. */
export function politicaDoVideoValidaC01(raw: unknown, cfg: ConfigOrigemC01): boolean {
  if (!videoCursoHabilitado(cfg) || !raw || typeof raw !== "object") return false;
  const graph = raw as {
    nodes?: { id: string; type: string; config: Record<string, unknown> }[];
    edges?: { source: string; target: string; condition?: { type?: string } }[];
  };
  if (
    !Array.isArray(graph.nodes) ||
    graph.nodes.length !== 3 ||
    !Array.isArray(graph.edges) ||
    graph.edges.length !== 2
  )
    return false;
  const start = graph.nodes.find((n) => n.type === "trigger"),
    action = graph.nodes.find((n) => n.type === "action"),
    end = graph.nodes.find((n) => n.type === "end");
  if (
    !start ||
    !action ||
    !end ||
    action.config.mode !== "text" ||
    action.config.body !== cfg.videoCourse!.question ||
    action.config.fallback_template_id ||
    action.config.template_id ||
    action.config.media_url ||
    end.config.outcome !== "custom"
  )
    return false;
  return (
    graph.edges.some(
      (e) => e.source === start.id && e.target === action.id && e.condition?.type === "always",
    ) &&
    graph.edges.some(
      (e) => e.source === action.id && e.target === end.id && e.condition?.type === "always",
    )
  );
}
