import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/v1/integrations/financial/snapshot/route";
import { lerRetratoFinanceiro, MAX_SNAPSHOT_ROWS } from "@/lib/leads/retrato-financeiro";
import { isPublicPath } from "@/lib/auth/public-paths";
import { McpAuthError } from "@/lib/mcp/auth";
import type * as AuthModule from "@/lib/mcp/auth";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), rate: vi.fn(), pool: vi.fn() }));
vi.mock("@/lib/mcp/auth", async (original) => ({
  ...(await original<typeof AuthModule>()),
  validateBearerToken: mocks.auth,
}));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: mocks.rate }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: mocks.pool }));
const ORG = "00000000-0000-4000-8000-000000000001";
const CONTACT = "00000000-0000-4000-8000-000000000002";
const LEAD = "00000000-0000-4000-8000-000000000003";
const auth = {
  organizationId: ORG,
  apiTokenId: LEAD,
  role: "viewer",
  scopes: ["financial:snapshot:read", "role:viewer"],
};
const fixture = () => ({
  schema: 1,
  complete: true,
  organization_id: ORG,
  collected_at: new Date().toISOString(),
  contacts: [
    {
      id: CONTACT,
      organization_id: ORG,
      phone_number: "+5511999990001",
      email: "ficticio@example.test",
    },
  ],
  opportunities: [
    {
      id: LEAD,
      organization_id: ORG,
      contact_id: CONTACT,
      status: "open",
      created_at: "2026-10-01T00:00:00.000Z",
      custom_fields: { produto_chave: "produto-ficticio", plano_oferecido: null },
      product_keys: [],
    },
  ],
});
function database(photo: unknown = fixture()) {
  const query = vi.fn(async (sql: string) =>
    sql.includes("WITH pessoas") ? { rows: [{ snapshot: photo }] } : { rows: [] },
  );
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as pg.Pool, query, release, connect };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(auth);
  mocks.rate.mockResolvedValue({ allowed: true });
  mocks.pool.mockReturnValue(database().pool);
});
const request = (suffix = "") =>
  new Request("https://crm.example.test/api/v1/integrations/financial/snapshot" + suffix, {
    headers: { Authorization: "Bearer dsk_ficticio_credencial-apenas-de-teste" },
  });

describe("retrato financeiro restrito", () => {
  it("GET devolve somente o conjunto mínimo, sem cache", async () => {
    const r = await GET(request());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(body.data).toMatchObject({ complete: true, organization_id: ORG });
    expect(Object.keys(body.data).sort()).toEqual(
      ["schema", "complete", "organization_id", "collected_at", "contacts", "opportunities"].sort(),
    );
    expect(mocks.auth).toHaveBeenCalledWith(request().headers.get("authorization"));
  });
  it.each(
    [
      [],
      ["mcp:read", "role:viewer"],
      ["financial:snapshot:read"],
      [...auth.scopes, "mcp:read"],
      [...auth.scopes, "mcp:write"],
      [...auth.scopes, "role:admin"],
    ].map((scopes) => ({ scopes })),
  )("recusa escopos não exclusivos %j antes de consultar o banco", async ({ scopes }) => {
    mocks.auth.mockResolvedValue({ ...auth, scopes });
    expect((await GET(request())).status).toBe(403);
    expect(mocks.pool).not.toHaveBeenCalled();
  });
  it.each(["revogado", "vencido", "cookie sem token"])(
    "autenticação nativa recusa %s sem vazar detalhe",
    async () => {
      mocks.auth.mockRejectedValue(new McpAuthError(-32001, 401, "detalhe-secreto-remoto"));
      const r = await GET(new Request(request().url, { headers: { Cookie: "sessao-ficticia" } }));
      expect(r.status).toBe(401);
      expect(await r.text()).not.toContain("detalhe-secreto");
      expect(mocks.pool).not.toHaveBeenCalled();
    },
  );
  it("não aceita trocar a organização ou paginar pelo cliente", async () => {
    expect((await GET(request("?organization_id=outra"))).status).toBe(400);
    expect(mocks.pool).not.toHaveBeenCalled();
  });
  it("limite de leitura evita consulta pesada", async () => {
    mocks.rate.mockResolvedValue({ allowed: false });
    expect((await GET(request())).status).toBe(429);
    expect(mocks.pool).not.toHaveBeenCalled();
  });
  it("exceção no proxy é exata, sem liberar confirmação ou descendentes", () => {
    expect(isPublicPath("/api/v1/integrations/financial/snapshot")).toBe(true);
    expect(isPublicPath("/api/v1/integrations/financial/snapshot/other")).toBe(false);
  });
  it("consulta tenant parametrizado em transação somente leitura e devolve conexão limpa", async () => {
    const db = database();
    await lerRetratoFinanceiro(db.pool, ORG);
    expect(db.query.mock.calls[0]?.[0]).toMatch(/BEGIN.*REPEATABLE READ.*READ ONLY/);
    const sql = db.query.mock.calls.find(([q]) => q.includes("WITH pessoas"))!;
    expect(sql[0].match(/organization_id = \$1/g)).toHaveLength(2);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("WITH pessoas"), [
      ORG,
      MAX_SNAPSHOT_ROWS + 1,
    ]);
    expect(db.query).toHaveBeenCalledWith("SET LOCAL row_security = off");
    expect(db.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith();
  });
  it.each(["parcial", "outro-tenant", "nome", "limite", "duplicado", "data-velha"])(
    "retrato %s falha fechado sem conteúdo",
    async (kind) => {
      const p = fixture();
      if (kind === "parcial") p.complete = false;
      if (kind === "outro-tenant") p.contacts[0]!.organization_id = LEAD;
      if (kind === "nome")
        Object.assign(p.contacts[0]!, { display_name: "nome que não deve sair" });
      if (kind === "limite")
        p.contacts = Array.from({ length: MAX_SNAPSHOT_ROWS + 1 }, () => p.contacts[0]!);
      if (kind === "duplicado") p.contacts.push(p.contacts[0]!);
      if (kind === "data-velha") p.collected_at = "2020-01-01T00:00:00.000Z";
      mocks.pool.mockReturnValue(database(p).pool);
      const r = await GET(request());
      expect(r.status).toBe(503);
      const text = await r.text();
      expect(text).not.toContain("ficticio@example.test");
      expect(text).not.toContain("nome que");
    },
  );
  it("erro de banco sempre tenta rollback e descarta conexão, sem SQL/segredo no erro", async () => {
    const db = database();
    db.query.mockRejectedValue(new Error("segredo-database"));
    await expect(lerRetratoFinanceiro(db.pool, ORG)).rejects.toThrow(
      "financial_snapshot_unavailable",
    );
    expect(db.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(db.release).toHaveBeenCalledWith(expect.any(Error));
  });
});
