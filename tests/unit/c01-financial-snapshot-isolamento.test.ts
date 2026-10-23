import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import type * as AuthModule from "@/lib/mcp/auth";

const fake = vi.hoisted(() => ({
  table: vi.fn(() => {
    throw new Error("Não deve consultar dados");
  }),
  audit: vi.fn(),
}));
const AUTH = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  role: "viewer" as const,
  actor: { type: "api_token" as const, id: "token-ficticio", role: "viewer" as const },
  apiTokenId: "token-ficticio",
  scopes: ["financial:snapshot:read", "role:viewer"],
};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fake.table, rpc: fake.table }),
}));
vi.mock("@/lib/mcp/audit", () => ({ auditMcpToolCall: fake.audit }));
vi.mock("@/lib/mcp/rate-limit", () => ({ verificarTetoMcp: vi.fn(async () => undefined) }));
vi.mock("@/lib/mcp/auth", async (original) => ({
  ...(await original<typeof AuthModule>()),
  validateBearerToken: vi.fn(async () => AUTH),
}));
const { createMcpServer } = await import("@/lib/mcp/server");
const { allTools } = await import("@/lib/mcp/tools");
const { GET: contactsGET } = await import("@/app/api/v1/contacts/route");

beforeEach(() => {
  fake.table.mockClear();
  fake.audit.mockClear();
});
it("a rota REST genérica de contatos recusa a chave exclusiva antes da consulta", async () => {
  const response = await contactsGET(
    new NextRequest("https://crm.example.test/api/v1/contacts", {
      headers: { Authorization: "Bearer dsk_ficticio_somente-teste" },
    }),
  );
  expect(response.status).toBe(403);
  expect(fake.table).not.toHaveBeenCalled();
});
it("nenhuma ferramenta MCP herda o escopo financeiro", () => {
  expect(allTools.length).toBeGreaterThan(0);
  expect(
    allTools.filter((tool) => AUTH.scopes.includes(tool.requiresScope)).map((tool) => tool.name),
  ).toEqual([]);
});
it.each([
  { name: "crm_search_contacts", args: { query: "ficticio" } },
  { name: "crm_list_leads", args: {} },
  { name: "crm_list_conversations", args: {} },
])("MCP real recusa $name mesmo autenticado como viewer", async ({ name, args }) => {
  const server = createMcpServer(AUTH, "req-ficticio");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "teste-financeiro", version: "0.0.0" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("scope");
    expect(fake.table).not.toHaveBeenCalled();
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  } finally {
    await client.close();
    await server.close();
  }
});
