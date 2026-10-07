// @vitest-environment node
/**
 * (C01, -c01.7) Segurança da rota das travas que se ligam pela tela
 * (`/api/v1/ai/send-guards`), no molde de `security-ajustes-de-estilo-org.test.ts`.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CAMINHO_DA_ROTA = path.join(process.cwd(), "app/api/v1/ai/send-guards/route.ts");
const rota = fs.existsSync(CAMINHO_DA_ROTA) ? fs.readFileSync(CAMINHO_DA_ROTA, "utf8") : "";
const runtime = fs.readFileSync(
  path.join(process.cwd(), "lib/agent-engine/guardrails/travas-de-envio.ts"),
  "utf8",
);

describe("(C01) segurança das travas de envio ligadas pela tela", () => {
  it("a rota existe; escrita exige admin e respeita o bloqueio do suporte; leitura, gerente", () => {
    expect(rota).not.toBe("");
    expect(rota).toContain("requireSupportWrite()");
    expect(rota).toContain('requireRole("admin", { resource: "ai_send_guards" })');
    expect(rota).toContain('requireRole("manager", { resource: "ai_send_guards" })');
  });

  it("leitura e escrita prendem a organização autenticada; o turno lê a linha da própria organização", () => {
    expect(rota).toContain('.eq("organization_id", org.orgId)');
    expect(rota).toContain("organization_id: org.orgId");
    expect(runtime).toContain("where l.organization_id = organizations.id");
    expect(runtime).toContain("from organizations where id = $1");
  });

  it("lista fechada: só as travas com interruptor, nenhuma trava fixa da cadeia, nada além de ligar e desligar", () => {
    expect(rota).toContain("z.enum(TRAVAS_COM_INTERRUPTOR)");
    expect(rota).toContain("enabled: z.boolean()");
    expect(rota).toContain(".strict()");
    expect(rota).toContain("layer: chaveDoInterruptor(parsed.data.trava)");
  });

  it("não usa service role numa rota de usuário, e audita a troca", () => {
    expect(rota).toContain("createClient()");
    expect(rota).not.toMatch(/service.?role|createAdminClient|supabaseAdmin/i);
    expect(rota).toContain('action: "ai.send_guard_changed"');
  });
});
