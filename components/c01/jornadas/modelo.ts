import type { Flow, Screen, Snapshot } from "@/lib/c01/jornadas/contrato";

export const metaLabels: Record<Flow["status"], string> = {
  PUBLISHED: "Publicado na Meta",
  DRAFT: "Rascunho na Meta",
  DEPRECATED: "Descontinuado na Meta",
  UNKNOWN: "Publicação não conferida",
};
export const activationLabels: Record<Flow["activation"], string> = {
  enabled: "Habilitado para novas entradas",
  disabled: "Sem novas entradas",
  unknown: "Ativação não conferida",
};
export function normalizar(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
export function buscarEtapas(snapshot: Snapshot, query: string) {
  const term = normalizar(query.trim());
  if (!term) return [];
  return snapshot.flows.flatMap((flow) =>
    flow.screens
      .filter((screen) =>
        normalizar(
          [
            flow.name,
            screen.title,
            ...screen.texts,
            ...screen.fields.flatMap((field) => [
              field.label,
              ...field.options.map((option) => option.title),
            ]),
          ].join(" "),
        ).includes(term),
      )
      .map((screen) => ({ flow, screen })),
  );
}

export type MapNode = {
  id: string;
  label: string;
  detail?: string;
  kind: string;
  flow_id?: string;
};
export type MapEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  verified: boolean;
};
export function mapaFormulario(flow: Flow): { nodes: MapNode[]; edges: MapEdge[] } {
  return {
    nodes: flow.screens.map((screen) => ({
      id: screen.id,
      label: screen.title,
      kind: screen.terminal ? "exit" : "form",
      detail: screen.terminal ? "Envio das respostas" : `${screen.fields.length} campo(s)`,
      flow_id: flow.id,
    })),
    edges: flow.screens.flatMap((screen) =>
      screen.next.map((edge, index) => ({
        id: `${screen.id}:${index}`,
        source: screen.id,
        target: edge.target,
        label: edge.label,
        verified: edge.verified,
      })),
    ),
  };
}
/** Ordenação por camadas, limitada ao número de nós mesmo quando há retorno. */
export function posicionar(nodes: MapNode[], edges: MapEdge[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const targets = new Set(edges.map((edge) => edge.target));
  const roots = nodes.filter((node) => !targets.has(node.id));
  const ranks = new Map<string, number>();
  const queue = (roots.length ? roots : nodes.slice(0, 1)).map((node) => ({
    id: node.id,
    rank: 0,
  }));
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index]!;
    if (ranks.has(entry.id)) continue;
    ranks.set(entry.id, entry.rank);
    edges
      .filter((edge) => edge.source === entry.id && ids.has(edge.target) && !ranks.has(edge.target))
      .forEach((edge) => queue.push({ id: edge.target, rank: entry.rank + 1 }));
  }
  const detachedRank = Math.max(0, ...ranks.values()) + 1;
  const counts = new Map<number, number>();
  return nodes.map((node) => {
    const rank = ranks.get(node.id) ?? detachedRank;
    const column = counts.get(rank) ?? 0;
    counts.set(rank, column + 1);
    return { ...node, position: { x: column * 330, y: rank * 175 } };
  });
}
export function formatarData(value: string, languageTag: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Horário indisponível"
    : date.toLocaleString(languageTag, { dateStyle: "short", timeStyle: "short" });
}
export function textoValor(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}
export function telaPorId(flow: Flow | undefined, id: string | null): Screen | undefined {
  return flow?.screens.find((screen) => screen.id === id);
}
