import { describe, expect, it } from "vitest";
import { rotaDeContinuacaoC01 } from "./c01-continuacao-grafo";

function graph(kind = "oferta", count = 4) {
  const nodes = [
    { id: "start", type: "trigger", config: {} },
    ...Array.from({ length: count }, (_, i) => ({
      id: `t${i + 1}`,
      type: "action",
      config: { mode: "text", body: `Mensagem ${i + 1}` },
    })),
    { id: "end", type: "end", config: { outcome: "custom" } },
  ].map((n, i) => ({ ...n, label: n.id, position: { x: 0, y: i * 100 } }));
  return {
    nodes,
    edges: nodes.slice(0, -1).map((n, i) => ({
      id: `e${i}`,
      source: n.id,
      target: nodes[i + 1]!.id,
      priority: 0,
      condition: { type: "always" },
    })),
    settings: { c01_acompanhamento: { version: 1, kind, activated_at: null } },
  };
}
it("L1 não admite efeito de funil nem mídia no grafo de um toque", () => {
  const a = graph("conversa", 1);
  Object.assign(a.nodes[1]!.config, { media_url: "https://example.invalid/video.mp4" });
  expect(rotaDeContinuacaoC01(a, "L1", 1)).toBeNull();
  const b = graph("conversa", 1);
  b.nodes.splice(
    2,
    0,
    Object.assign({}, b.nodes[0]!, {
      id: "move",
      type: "move_lead",
      label: "move",
      position: { x: 0, y: 200 },
      config: { stage_id: "22222222-2222-4222-8222-222222222222" },
    }),
  );
  b.edges[1]!.target = "move";
  b.edges.push({
    id: "e-move",
    source: "move",
    target: "end",
    priority: 0,
    condition: { type: "always" },
  });
  expect(rotaDeContinuacaoC01(b, "L1", 1)).toBeNull();
});
describe("rota fechada de continuação no mesmo motor", () => {
  it("L2 escolhe exatamente o toque restante, sem voltar ao trigger", () => {
    const g = graph();
    expect(rotaDeContinuacaoC01(g, "L2", 3)).toEqual({
      nodeId: "t3",
      touchNodes: ["t1", "t2", "t3", "t4"],
    });
    expect(rotaDeContinuacaoC01(g, "L2", 5)).toBeNull();
  });
  it("L1 aceita somente o grafo distinto de um toque", () => {
    expect(rotaDeContinuacaoC01(graph("conversa", 1), "L1", 1)?.nodeId).toBe("t1");
    expect(rotaDeContinuacaoC01(graph(), "L1", 1)).toBeNull();
  });
  it("bifurcação, ciclo e ações desconectadas não têm orçamento seguro", () => {
    const a = graph();
    a.edges.push({ ...a.edges[0]!, id: "branch", target: "t3" });
    expect(rotaDeContinuacaoC01(a, "L2", 1)).toBeNull();
    const b = graph();
    b.edges[2]!.target = "t1";
    expect(rotaDeContinuacaoC01(b, "L2", 1)).toBeNull();
    const c = graph();
    c.edges[0]!.target = "t2";
    expect(rotaDeContinuacaoC01(c, "L2", 1)).toBeNull();
  });
});
