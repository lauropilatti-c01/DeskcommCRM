import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { configOrigemC01, type OrigemC01 } from "./c01-origem";
import { linksNoTexto } from "@/lib/agent-engine/guardrails/link-permitido";

export interface OfertaConsultadaC01 {
  productKey: string;
  urls: string[];
}
/** Só o resultado estruturado da conexão configurada: RAG, nota e argumento do
 * modelo não são oferta. O filtro executado pode carregar a ênfase omitida das colunas. */
export function ofertasDaConsultaC01(
  input: unknown,
  output: unknown,
  connectionId: string,
): OfertaConsultadaC01[] {
  if (!input || typeof input !== "object" || !output || typeof output !== "object") return [];
  const a = input as Record<string, unknown>,
    envelope = output as Record<string, unknown>;
  if (envelope.isError) return [];
  let unwrapped = envelope.structuredContent ?? envelope;
  if (!envelope.structuredContent && Array.isArray(envelope.content)) {
    const parts = envelope.content.filter((p: { type?: string }) => p?.type === "text");
    if (parts.length !== 1 || typeof parts[0]?.text !== "string") return [];
    try {
      unwrapped = JSON.parse(parts[0].text);
    } catch {
      return [];
    }
  }
  if (!unwrapped || typeof unwrapped !== "object") return [];
  const r = unwrapped as Record<string, unknown>;
  if (
    r.erro ||
    r.isError ||
    r.truncado ||
    r.schema !== "c01" ||
    !["agente_pagina", "agente_links"].includes(String(r.tabela)) ||
    (r.conexao as { id?: string })?.id !== connectionId ||
    !Array.isArray(r.linhas)
  )
    return [];
  const filters = Array.isArray(a.filtros) ? (a.filtros as Record<string, unknown>[]) : [];
  const products = filters
    .filter((f) => f.coluna === "enfase_id" && f.operador === "eq" && typeof f.valor === "string")
    .map((f) => f.valor as string);
  if (new Set(products).size !== 1) return [];
  const product = products[0]!;
  return r.linhas.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    if (row.enfase_id !== undefined && row.enfase_id !== product) return [];
    if (typeof row.plano_id !== "string" || !row.plano_id) return [];
    if (r.tabela === "agente_links" && (row.status !== "confirmado" || row.pode_enviar !== true))
      return [];
    if (r.tabela === "agente_pagina" && row.pode_afirmar !== true) return [];
    const urls = (
      r.tabela === "agente_pagina" ? [row.link_cartao, row.link_sem_cartao] : [row.url]
    ).filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u));
    return urls.length ? [{ productKey: product, urls }] : [];
  });
}
export async function origemDaOfertaEnviadaC01(
  db: Queryable,
  org: string,
  contact: string,
  body: string,
  offers: OfertaConsultadaC01[],
): Promise<OrigemC01 | undefined> {
  const cfg = configOrigemC01();
  if (
    !cfg?.enabled ||
    cfg.organizationId !== org ||
    !cfg.offerConnectionId ||
    !cfg.allowedKinds.includes("oferta")
  )
    return;
  const sent = new Set(linksNoTexto(body));
  const products = [
    ...new Set(offers.filter((o) => o.urls.some((u) => sent.has(u))).map((o) => o.productKey)),
  ];
  if (products.length !== 1) return;
  const leads = (
    await db.query(
      `select id,custom_fields from crm_leads where organization_id=$1 and contact_id=$2
    and status='open' and custom_fields->>'produto_chave'=$3 order by created_at,id limit 2`,
      [org, contact, products[0]],
    )
  ).rows;
  if (leads.length !== 1) return;
  return { kind: "oferta", leadId: leads[0]!.id, productKey: products[0]! };
}

/** Complementa a projeção da leitura real; não fabrica os campos omitidos. */
export function completarConsultaOfertaC01(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const a = input as Record<string, unknown>;
  if (
    a.tabela !== "agente_links" ||
    (a.schema !== undefined && a.schema !== "c01") ||
    !Array.isArray(a.colunas)
  )
    return input;
  return {
    ...a,
    colunas: [...new Set([...a.colunas, "enfase_id", "plano_id", "status", "pode_enviar"])],
  };
}
