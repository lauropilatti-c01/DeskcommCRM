import { describe, expect, it } from "vitest";
import exemploDoLeitor from "../fixtures/c01-jornadas/exemplo.json";
import { snapshotSchema, simulationRequestSchema } from "@/lib/c01/jornadas/contrato";
const foto = {
  schema_version: 1,
  snapshot_id: "foto-1",
  organization_id: "00000000-0000-4000-8000-000000000001",
  environment: "example",
  captured_at: "2026-10-13T12:00:00Z",
  completeness: "unverified",
  sources: [],
  flows: [],
  graph: { nodes: [], edges: [] },
  divergences: [],
  scenarios: [],
};
describe("contrato de leitura de Jornadas", () => {
  it("aceita a fixture exportada pelo leitor Python sem tradução intermediária", () => {
    const result = snapshotSchema.safeParse(exemploDoLeitor);
    expect(result.success, result.success ? undefined : JSON.stringify(result.error.issues)).toBe(true);
  });
  it("recusa versão desconhecida e organização ausente", () => {
    expect(snapshotSchema.safeParse({ ...foto, schema_version: 2 }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...foto, organization_id: undefined }).success).toBe(false);
  });
  it("retira campos não contratados antes de expor o leitor ao navegador", () => {
    expect(
      snapshotSchema.parse({ ...foto, token: "segredo", contacts: [{ phone: "nunca" }] }),
    ).toEqual(foto);
  });
  it("recusa aresta apontando para uma etapa ausente", () => {
    expect(
      snapshotSchema.safeParse({
        ...foto,
        graph: {
          nodes: [],
          edges: [{ id: "e", source: "a", target: "b", label: "Teste", verified: true }],
        },
      }).success,
    ).toBe(false);
  });
  it("cenário exige fotografia e não aceita organização enviada pelo cliente", () => {
    expect(simulationRequestSchema.safeParse({ flow_id: "f", answers: [] }).success).toBe(false);
    expect(
      simulationRequestSchema.safeParse({
        snapshot_id: "s",
        flow_id: "f",
        answers: [],
        organization_id: foto.organization_id,
      }).success,
    ).toBe(false);
  });
});
