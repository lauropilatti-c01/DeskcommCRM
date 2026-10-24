import { describe, expect, it, vi } from "vitest";
import { avancarEnrollmentAtivo, type AdminClient, type TickDeps } from "./engine";
import type { FlowGraph } from "./graph-schema";
import type { EnrollmentRow } from "./node-handlers";

function fixture(status: "confirmado" | "area_desconhecida" | "sem_material" | "indisponivel") {
  const graph = {
    settings: {
      c01_acompanhamento: { version: 1, kind: "cronograma", activated_at: "2026-10-23T11:00:00Z" },
    },
    nodes: [
      {
        id: "choice",
        type: "condition",
        config: {
          combinator: "or",
          branching: "per_check",
          checks: [
            { id: "known", field: "tag", op: "contains", value: "a1-enfase-com-cronograma" },
            { id: "unknown", field: "tag", op: "contains", value: "a1-area-desconhecida" },
          ],
        },
      },
      {
        id: "known",
        type: "action",
        config: { mode: "text", body: "Material de {{enfase_nome}}" },
      },
      { id: "unknown", type: "action", config: { mode: "text", body: "Qual área?" } },
      { id: "end", type: "end", config: { outcome: "custom" } },
    ],
    edges: [
      {
        id: "a",
        source: "choice",
        target: "known",
        priority: 0,
        condition: { type: "branch", branch_id: "known" },
      },
      {
        id: "b",
        source: "choice",
        target: "unknown",
        priority: 0,
        condition: { type: "branch", branch_id: "unknown" },
      },
      { id: "c", source: "choice", target: "end", priority: 0, condition: { type: "always" } },
    ],
  } as unknown as FlowGraph;
  const db = {
    loadFlowGraph: vi.fn(async () => graph),
    loadLeadFacts: vi.fn(async () => ({
      lead_stage: null,
      tags: ["a1-enfase-com-cronograma"],
      custom_fields: { enfase_nome: "Nome sem prova" },
    })),
    resolverRamoCronogramaC01: vi.fn(async () =>
      status === "indisponivel"
        ? { status, reason: "fonte_indisponivel" }
        : {
            status,
            evidenceHash: "a".repeat(64),
            enfaseNome: "Operação",
            targetNodeId:
              status === "confirmado"
                ? "known"
                : status === "area_desconhecida"
                  ? "unknown"
                  : "end",
            body: "Texto confirmado",
            familyId: "family",
            slug: "operacao",
          },
    ),
    loadEnrollmentEvents: vi.fn(async () => []),
    updateEnrollment: vi.fn(),
    insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
    decidirAcompanhamentoC01: vi.fn(async () => ({ kind: "send", touch: 1, transport: "text" })),
  } as unknown as AdminClient;
  const enqueueJob = vi.fn(),
    deps = { db, enqueueJob, clock: () => new Date("2026-10-24T15:00:00Z") } as TickDeps;
  const row = {
    id: "e",
    organization_id: "org",
    contact_id: "contact",
    version_id: "v",
    current_node_id: "choice",
    steps_taken: 0,
    status: "active",
    started_at: "2026-10-23T12:00:00Z",
  } as EnrollmentRow;
  return { db, deps, row, enqueueJob };
}
describe("A1 no motor real", () => {
  it.each([
    ["confirmado", "known"],
    ["area_desconhecida", "unknown"],
    ["sem_material", "end"],
  ] as const)("%s escolhe %s sem usar a etiqueta manual", async (status, target) => {
    const f = fixture(status);
    await avancarEnrollmentAtivo(f.deps, f.row);
    expect(f.db.updateEnrollment).toHaveBeenCalledWith(
      "e",
      "org",
      expect.objectContaining({ current_node_id: target }),
    );
    expect(f.enqueueJob).not.toHaveBeenCalled();
  });
  it("leitura indisponível retém pendência em vez de concluir como sem material", async () => {
    const f = fixture("indisponivel");
    await avancarEnrollmentAtivo(f.deps, f.row);
    expect(f.db.updateEnrollment).toHaveBeenCalledWith(
      "e",
      "org",
      expect.objectContaining({ status: "paused_manual", last_error: "c01:fonte_indisponivel" }),
    );
    expect(f.enqueueJob).not.toHaveBeenCalled();
  });
  it("mudança de área após a condição não envia o texto anteriormente escolhido", async () => {
    const f = fixture("area_desconhecida");
    await avancarEnrollmentAtivo(f.deps, { ...f.row, current_node_id: "known" });
    expect(f.enqueueJob).not.toHaveBeenCalled();
    expect(f.db.updateEnrollment).toHaveBeenCalledWith(
      "e",
      "org",
      expect.objectContaining({
        status: "paused_manual",
        last_error: "c01:catalogo_alterado_ou_indisponivel",
      }),
    );
  });
  it("texto A1 vai ao resolvedor do worker, nunca como literal inline", async () => {
    const f = fixture("confirmado");
    await avancarEnrollmentAtivo(f.deps, { ...f.row, current_node_id: "known" });
    expect(f.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ c01_resolve: true, node_id: "known" }),
      }),
    );
    expect(f.enqueueJob.mock.calls[0]![0].payload).not.toHaveProperty("fixed_body");
  });
});
