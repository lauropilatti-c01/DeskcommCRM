/**
 * (C01) `read_skill`: o modelo puxa uma skill do índice que a palavra-chave não trouxe.
 *
 * Três garantias de fonte, que um teste de turno inteiro não isolaria:
 *   1. a tool entra pela condição ESTÁVEL `skills.length > 0` (o prefixo em cache
 *      não muda de turno para turno) e respeita o teto por turno;
 *   2. o resultado NÃO passa por `registrarConsulta`: preço ou link que estiver no
 *      texto da skill não fica liberado pelas travas de envio por julgamento;
 *   3. a tool é LEITURA nas três listas — fora delas vira escrita e cai na trava de
 *      atendimento (fronteira) ou na recusa da prévia.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ler = (arquivo: string) => readFileSync(join(process.cwd(), arquivo), "utf8");
const TURNO = ler("lib/agent-engine/agent/inbound-turn.ts");

function blocoDaTool(): string {
  const inicio = TURNO.indexOf("rawTools.read_skill = tool(");
  expect(inicio, "montagem de read_skill não encontrada").toBeGreaterThan(0);
  return TURNO.slice(inicio, TURNO.indexOf("rawTools.read_skill_reference = tool(", inicio));
}

describe("read_skill (skill por julgamento)", () => {
  it("entra pela condição estável skills.length > 0", () => {
    expect(TURNO).toMatch(/if \(skills\.length > 0\) \{\s*const skillsNoTurno = [^\n]*\n\s*let skillsPorJulgamento = 0;\s*rawTools\.read_skill = tool\(/);
  });

  it("respeita o teto por turno e conta casadas + roteiro como já no turno", () => {
    expect(TURNO).toMatch(/const skillsNoTurno = new Set\(\[\.\.\.skillMatch\.matched, \.\.\.skillsDoRoteiro\]/);
    expect(blocoDaTool()).toContain("skillsPorJulgamento >= MAX_SKILLS_POR_JULGAMENTO");
  });

  it("não libera preço nem link: sem registrarConsulta", () => {
    expect(blocoDaTool()).not.toContain("registrarConsulta(");
  });

  it("registra o motivo loaded_by_judgment fora da prévia e só com a knob", () => {
    const bloco = blocoDaTool();
    expect(bloco).toContain("!preview && deps.knobs.goldenCandidates === true");
    expect(bloco).toContain("reason: 'loaded_by_judgment'");
  });

  it("é leitura nas três listas", () => {
    expect(ler("lib/agent-engine/agent/tool-breaker.ts")).toMatch(/'read_skill',/);
    expect(ler("lib/atendimento/fronteira-server.ts")).toMatch(/"read_skill",/);
    expect(ler("lib/agent-engine/agent/preview.ts")).toMatch(/'read_skill',/);
  });
});
