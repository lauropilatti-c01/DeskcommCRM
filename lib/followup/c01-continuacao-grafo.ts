import { flowGraphSchema, type FlowNode } from "./graph-schema";

/** Só uma linha determinística; bifurcações não têm orçamento dedutível. */
export function rotaDeContinuacaoC01(
  raw: unknown,
  path: "L1" | "L2",
  nextTouch: number,
): { nodeId: string; touchNodes: string[] } | null {
  const parsed = flowGraphSchema.safeParse(raw);
  if (!parsed.success) return null;
  const g = parsed.data,
    kind = g.settings?.c01_acompanhamento?.kind;
  if (kind !== (path === "L1" ? "conversa" : "oferta")) return null;
  const starts = g.nodes.filter((n) => n.type === "trigger");
  if (starts.length !== 1) return null;
  let node: FlowNode | undefined = starts[0];
  const seen = new Set<string>(),
    touchNodes: string[] = [];
  while (node) {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    if (path === "L1" && node.type === "move_lead") return null;
    if (node.type === "action") {
      if (path === "L1" && (node.config.mode !== "text" || node.config.media_url)) return null;
      if (node.config.mode !== "text" && node.config.mode !== "template") return null;
      touchNodes.push(node.id);
    } else if (!["trigger", "wait", "end", "move_lead"].includes(node.type)) return null;
    const edges = g.edges.filter((e) => e.source === node!.id);
    if (node.type === "end") {
      if (edges.length) return null;
      break;
    }
    if (edges.length !== 1 || edges[0]!.condition.type !== "always") return null;
    node = g.nodes.find((n) => n.id === edges[0]!.target);
    if (!node) return null;
  }
  if (
    seen.size !== g.nodes.length ||
    touchNodes.length !== (path === "L1" ? 1 : 4) ||
    !Number.isInteger(nextTouch)
  )
    return null;
  const nodeId = touchNodes[nextTouch - 1];
  return nodeId ? { nodeId, touchNodes } : null;
}
