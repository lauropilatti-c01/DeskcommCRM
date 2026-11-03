/**
 * (C01, -c01.15) O teto de envios por turno é 6 sem depender do ambiente da VPS.
 * Até a c01.14 o 6 vivia num override manual; a recriação pela publicação o perdeu
 * e a produção voltou ao padrão 3 (arte do preço sem vaga, 03/11/2026).
 */
import { describe, expect, it } from "vitest";
import { loadEnv } from "@/lib/agent-engine/env";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";

const base = {
  SUPABASE_DB_URL: "postgres://u:p@localhost:5432/db",
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
};

describe("teto de envios por turno", () => {
  it("sem MAX_SENDS_PER_TURN no ambiente, o turno recebe 6", () => {
    expect(loadEnv({ ...base } as unknown as NodeJS.ProcessEnv).MAX_SENDS_PER_TURN).toBe(6);
    expect(turnKnobsFromEnv(loadEnv({ ...base } as unknown as NodeJS.ProcessEnv)).maxSendsPerTurn).toBe(6);
  });

  it("valor explícito no ambiente ainda vence", () => {
    expect(loadEnv({ ...base, MAX_SENDS_PER_TURN: "4" } as unknown as NodeJS.ProcessEnv).MAX_SENDS_PER_TURN).toBe(4);
  });
});
