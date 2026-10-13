import { beforeEach, describe, expect, it, vi } from "vitest";
const dep = vi.hoisted(() => ({ auth: vi.fn(), flag: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: dep.auth }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: dep.flag }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/env", () => ({
  env: {
    C01_JORNADAS_URL: "http://127.0.0.1:8879",
    C01_JORNADAS_SECRET: "segredo-interno-exclusivo-do-teste-1234",
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
import { handleJornadas } from "@/lib/c01/jornadas/api";
const org = "00000000-0000-4000-8000-000000000001";
const foto = {
  schema_version: 1,
  snapshot_id: "s",
  organization_id: org,
  environment: "example",
  captured_at: "2026-10-13T12:00:00Z",
  completeness: "unverified",
  sources: [],
  flows: [],
  graph: { nodes: [], edges: [] },
  divergences: [],
  scenarios: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", dep.fetch);
  dep.auth.mockResolvedValue({ ok: true, org: { orgId: org }, user: { id: "u" } });
  dep.flag.mockResolvedValue(true);
  dep.fetch.mockResolvedValue(new Response(JSON.stringify(foto), { status: 200 }));
});
describe("API de Jornadas", () => {
  it("nega sessão ausente antes de alcançar qualquer fonte", async () => {
    dep.auth.mockResolvedValue({ ok: false, response: new Response("", { status: 401 }) });
    expect((await handleJornadas(new Request("http://crm/api"), "snapshot")).status).toBe(401);
    expect(dep.fetch).not.toHaveBeenCalled();
  });
  it("nega módulo desligado inclusive por URL direta", async () => {
    dep.flag.mockResolvedValue(false);
    expect((await handleJornadas(new Request("http://crm/api"), "snapshot")).status).toBe(404);
    expect(dep.fetch).not.toHaveBeenCalled();
  });
  it("deriva organização da sessão e não repassa seletor do cliente", async () => {
    const r = await handleJornadas(new Request("http://crm/api?organization_id=outra"), "snapshot");
    expect(r.status).toBe(200);
    const [, opts] = dep.fetch.mock.calls[0]!;
    expect(new Headers(opts.headers).get("X-Organization-Id")).toBe(org);
    expect(await r.json()).toEqual({ data: foto });
  });
  it("recusa resposta de outra organização", async () => {
    dep.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ ...foto, organization_id: "00000000-0000-4000-8000-000000000002" }),
      ),
    );
    expect((await handleJornadas(new Request("http://crm/api"), "snapshot")).status).toBe(502);
  });
  it("não transforma falha em inventário vazio ou vaza texto interno", async () => {
    dep.fetch.mockResolvedValue(new Response("senha-secreta", { status: 500 }));
    const r = await handleJornadas(new Request("http://crm/api"), "snapshot");
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain("senha-secreta");
  });
  it("recusa origem externa no refresh e não alcança leitor", async () => {
    const r = await handleJornadas(
      new Request("https://crm/api", { method: "POST", headers: { origin: "https://invasor" } }),
      "refresh",
    );
    expect(r.status).toBe(403);
    expect(dep.fetch).not.toHaveBeenCalled();
  });
  it("valida o corpo da simulação antes de chamar o executor", async () => {
    const r = await handleJornadas(
      new Request("http://crm/api", {
        method: "POST",
        body: JSON.stringify({ flow_id: "f", organization_id: org }),
      }),
      "simulate",
    );
    expect(r.status).toBe(400);
    expect(dep.fetch).not.toHaveBeenCalled();
  });
  it("recusa resultado do cenário com fotografia diferente", async () => {
    dep.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          snapshot_id: "outra",
          flow_id: "f",
          steps: [],
          fields: {},
          outcome: "fim",
          verified: true,
        }),
      ),
    );
    const r = await handleJornadas(
      new Request("http://crm/api", {
        method: "POST",
        body: JSON.stringify({ snapshot_id: "s", flow_id: "f", answers: [] }),
      }),
      "simulate",
    );
    expect(r.status).toBe(502);
  });
});
