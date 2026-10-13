import { describe, expect, it } from "vitest";
import { versionCreateSchema, versionPatchSchema } from "@/lib/ai/agents/validation";

/**
 * c01: o teto das instruções do agente é 24.000 caracteres, não os 20.000 do autor.
 *
 * O texto do vendedor da C01 chegou a 19.992 caracteres, e a regra dos vídeos do
 * canal pede uns 550 a mais. Cortar regra que já foi testada para caber no teto
 * troca um erro conhecido por um desconhecido; o teto é só a validação do
 * servidor e da tela (o banco não limita o tamanho).
 */
const base = {
  provider: "openrouter",
  model: "openai/gpt-5.1",
  credential_id: null,
  channel_session_id: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
};

describe("c01: teto das instruções do agente", () => {
  it("aceita o texto do vendedor com a regra dos vídeos (20.547 caracteres)", () => {
    const r = versionCreateSchema.safeParse({ ...base, system_prompt: "a".repeat(20_547) });
    expect(r.success, JSON.stringify(r.error?.issues?.[0])).toBe(true);
  });

  it("aceita exatamente 24.000, contando como o servidor conta (sem os brancos do fim)", () => {
    const r = versionPatchSchema.safeParse({ system_prompt: "a".repeat(24_000) + "\n\n   " });
    expect(r.success).toBe(true);
  });

  it("recusa 24.001 na criação e na edição", () => {
    const longo = "a".repeat(24_001);
    expect(versionCreateSchema.safeParse({ ...base, system_prompt: longo }).success).toBe(false);
    expect(versionPatchSchema.safeParse({ system_prompt: longo }).success).toBe(false);
  });
});
