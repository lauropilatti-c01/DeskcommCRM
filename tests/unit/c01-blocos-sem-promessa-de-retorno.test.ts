/**
 * (C01, -c01.3, item 4) OS BLOCOS FIXOS DO MOTOR NÃO MANDAM PROMETER RETORNO.
 *
 * O defeito: dois blocos residentes do prompt mandavam o modelo dizer ao lead que ia
 * "verificar/ajustar e volta com uma resposta" (`CASES_SYSTEM_BLOCK`) e "verificar/
 * confirmar e volta com a resposta, peça mais um instante" (`TRANSPARENCIA_SYSTEM_BLOCK`).
 * O texto do vendedor diz o contrário (`docs/comercial/02`, seção 7: "não diga que alguém
 * já está analisando nem prometa prazo ou resultado"), e o bloco fixo vencia: "a equipe
 * vai conferir o pagamento e te avisar por aqui assim que possível" (C10).
 *
 * A correção: os blocos dizem o que foi registrado e o que a pessoa pode fazer agora,
 * sem prometer retorno, prazo nem resultado. O texto exportado se prova pelo conteúdo;
 * a ausência das frases antigas, no arquivo inteiro; a presença no prompt, pelo código.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as turno from "@/lib/agent-engine/agent/inbound-turn";
import {
  CASES_SYSTEM_BLOCK_SEM_PASSAGEM,
  TRANSPARENCIA_SYSTEM_BLOCK_SEM_PASSAGEM,
} from "@/lib/c01/passagem-desligada";

const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
const blocos = (): Record<string, string> => {
  const t = turno as unknown as Record<string, unknown>;
  const casos = t.CASES_SYSTEM_BLOCK;
  const transparencia = t.TRANSPARENCIA_SYSTEM_BLOCK;
  expect(typeof casos, "CASES_SYSTEM_BLOCK exportado").toBe("string");
  expect(typeof transparencia, "TRANSPARENCIA_SYSTEM_BLOCK exportado").toBe("string");
  return { casos: casos as string, transparencia: transparencia as string };
};

/** As frases que mandavam prometer retorno, como estavam no arquivo. */
const PROMESSAS_ANTIGAS = [
  /vai verificar\/ajustar\s*'?\s*\+?\s*'?\s*e volta com uma resposta/,
  /diga que vai verificar\/confirmar e volta com a resposta/,
  /peça mais um instante/,
];

describe("(C01) os blocos de caso e de transparência", () => {
  it("o bloco de casos diz o que foi registrado e o que a pessoa pode fazer agora, sem prometer retorno", () => {
    const { casos } = blocos();
    expect(casos).toMatch(/o que ficou registrado e o que ele pode fazer agora/);
    expect(casos).toMatch(/sem prometer retorno, prazo nem resultado/);
    expect(casos).toMatch(/não diga que alguém já está analisando, que vai verificar e voltar, nem quando/);
    // O que já valia continua: caso antes de prometer pessoa, e nada de diagnóstico ao lead.
    expect(casos).toMatch(/sem antes chamar open_human_case/);
    expect(casos).toMatch(/NUNCA narre a causa técnica ou interna/);
    expect(casos).not.toMatch(/volta com uma resposta/);
  });

  it("o bloco de transparência dá a saída sem promessa: registrado, o que fazer agora, ou perguntar", () => {
    const { transparencia } = blocos();
    expect(transparencia).toMatch(/o que ficou registrado e o que ele pode fazer neste momento/);
    expect(transparencia).toMatch(/Não prometa por conta própria retorno, prazo nem resultado/);
    expect(transparencia).toMatch(/nunca admita/);
    expect(transparencia).not.toMatch(/volta com a resposta/);
    expect(transparencia).not.toMatch(/mais um instante/);
  });

  it("as frases antigas não estão em nenhum lugar do arquivo", () => {
    for (const re of PROMESSAS_ANTIGAS) expect(FONTE, String(re)).not.toMatch(re);
  });

  it("os dois blocos continuam residentes no prompt (transparência sempre; casos com casos ligados)", () => {
    // (-c01.15) Com a passagem desligada, as versões "vou verificar e já te retorno"; com
    // ela ligada, os blocos de sempre.
    expect(FONTE).toMatch(
      /const blocosResidentes = \[\s*systemWithMemory,\s*semPassagem \? TRANSPARENCIA_SYSTEM_BLOCK_SEM_PASSAGEM : TRANSPARENCIA_SYSTEM_BLOCK,\s*\];/,
    );
    expect(FONTE).toMatch(
      /if \(agentConfig !== null && agentConfig\.casesEnabled\)\s*blocosResidentes\.push\(semPassagem \? CASES_SYSTEM_BLOCK_SEM_PASSAGEM : CASES_SYSTEM_BLOCK\);/,
    );
    expect(FONTE).toMatch(/const semPassagem = passagemDesligada\(agentConfig\);/);
  });
});

describe("(C01, -c01.15) os blocos com a passagem desligada", () => {
  it("o bloco de casos manda \"vou verificar e já te retorno\" depois do caso e proíbe \"ficou registrado/anotado\"", () => {
    expect(CASES_SYSTEM_BLOCK_SEM_PASSAGEM).toMatch(/vou verificar e já te retorno/);
    expect(CASES_SYSTEM_BLOCK_SEM_PASSAGEM).toMatch(/Nunca diga que o pedido "ficou registrado" ou "anotado"/);
    expect(CASES_SYSTEM_BLOCK_SEM_PASSAGEM).toMatch(/sem prometer prazo nem resultado/);
    // O que já valia continua: caso antes de prometer, e nada de diagnóstico ao lead.
    expect(CASES_SYSTEM_BLOCK_SEM_PASSAGEM).toMatch(/sem antes chamar open_human_case/);
    expect(CASES_SYSTEM_BLOCK_SEM_PASSAGEM).toMatch(/NUNCA narre a causa técnica ou interna/);
    expect(CASES_SYSTEM_BLOCK_SEM_PASSAGEM).not.toMatch(/o que ficou registrado e o que ele pode fazer/);
  });

  it("o bloco de transparência manda a mesma frase e proíbe \"ficou registrado\" e \"a equipe vai te avisar\"", () => {
    expect(TRANSPARENCIA_SYSTEM_BLOCK_SEM_PASSAGEM).toMatch(/vou verificar e já te retorno/);
    expect(TRANSPARENCIA_SYSTEM_BLOCK_SEM_PASSAGEM).toMatch(/Nunca diga que o pedido "ficou registrado" ou "anotado"/);
    expect(TRANSPARENCIA_SYSTEM_BLOCK_SEM_PASSAGEM).toMatch(/a equipe vai te avisar/);
    expect(TRANSPARENCIA_SYSTEM_BLOCK_SEM_PASSAGEM).toMatch(/nunca\s+admita/);
    expect(TRANSPARENCIA_SYSTEM_BLOCK_SEM_PASSAGEM).not.toMatch(/o que ficou registrado e o que ele pode fazer/);
  });

  it("com a passagem ligada, os blocos de sempre não mudam (não mandam verificar e voltar)", () => {
    const { casos, transparencia } = blocos();
    expect(casos).not.toMatch(/vou verificar e já te retorno/);
    expect(transparencia).not.toMatch(/vou verificar e já te retorno/);
  });
});
