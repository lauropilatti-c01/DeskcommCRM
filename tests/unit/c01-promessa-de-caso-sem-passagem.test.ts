/**
 * (C01, junção da 1.86.0) A TRAVA DE PROMESSA SEM CASO COM A PASSAGEM DESLIGADA.
 *
 * Até a -c01.16 o `casePromiseGate` lia só o léxico de humano (`detectHumanPromise`). A
 * 1.86 soma em OU o retorno humano do classificador semântico (`prometeuRetornoHumano`,
 * cuja instrução cita "te retorno") e o léxico de retorno do próprio assistente
 * (`detectarPromessaDeRetornoDoAssistente`: "a gente se fala", "te chamo"…). A produção
 * (v27) tem casos ligados e a passagem desligada, e o texto da Marina diz "vou verificar
 * e já te retorno". O que vale, e este arquivo prende (o turno inteiro roda no
 * invariante `tests/invariants/c01-promessa-de-caso-sem-passagem.test.ts`):
 *
 *   - com o caso aberto no turno (ou antes dele), a frase da Marina passa: sem volta ao
 *     modelo e sem caso a mais;
 *   - sem caso, a 1ª tentativa volta ao modelo; na 2ª o sistema abre o caso e reenvia
 *     pela cadeia: a mensagem SAI;
 *   - abrir o caso não silencia a conversa: o movimento do card é só o funil, e o motor
 *     não lê a etapa `requires_human` (`checkG4Stage` é do worker legado).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { casePromiseGate, type GateContext } from "@/lib/agent-engine/guardrails/before-send";
import { detectHumanPromise } from "@/lib/agent-engine/guardrails/human-promise";
import { detectarPromessaDeRetornoDoAssistente } from "@/lib/agent-engine/guardrails/retorno-do-assistente";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";
import { RETORNO_DO_CASO_SEM_PASSAGEM } from "@/lib/c01/passagem-desligada";

const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

function trecho(inicio: string, fim: string): string {
  const i = FONTE.indexOf(inicio);
  const f = FONTE.indexOf(fim, i);
  expect(i, inicio).toBeGreaterThan(-1);
  expect(f, fim).toBeGreaterThan(i);
  return FONTE.slice(i, f);
}

/** As duas frases do texto da Marina (v27, linhas 80 e 88). */
const MARINA = ["Vou verificar pra ti e já te retorno", "Entendi! vou verificar e já te retorno"];

function ctx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-10-21T12:00:00Z"),
    body: "",
    optedOut: false,
    provider: "waha",
    pacing: { knobs: PACING_DEFAULTS, state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null }, crmDailyLimit: null },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: true,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

/** O que o classificador responde para "te retorno", como a instrução dele manda. */
const RETORNO_HUMANO = {
  isPromise: false,
  suspectPhrase: null,
  prometeuRetornoHumano: true,
  retornoSoDoAssistente: false,
};

describe("(C01, 1.86) o que a trava pega nas frases da Marina", () => {
  it("o léxico não pega 'te retorno' (o autor o deixou para o semântico); 'a gente se fala' é do léxico novo", () => {
    for (const frase of MARINA) {
      expect(detectHumanPromise(frase, []), frase).toBe(false);
      expect(detectarPromessaDeRetornoDoAssistente(frase), frase).toBe(false);
    }
    expect(detectarPromessaDeRetornoDoAssistente("Perfeito, qualquer coisa a gente se fala!")).toBe(true);
  });

  it("sem caso, com o sinal semântico: veta (a mensagem volta ao modelo)", () => {
    for (const body of MARINA) {
      const v = casePromiseGate.evaluate(ctx({ body, semanticPromise: RETORNO_HUMANO }));
      expect(v.pass, body).toBe(false);
      if (!v.pass) expect(v.code).toBe("case_promise_without_case");
    }
  });

  it("caso aberto no turno ou antes dele: passa", () => {
    for (const body of MARINA) {
      expect(casePromiseGate.evaluate(ctx({ body, semanticPromise: RETORNO_HUMANO, openedCaseThisTurn: true })).pass).toBe(true);
      expect(casePromiseGate.evaluate(ctx({ body, semanticPromise: RETORNO_HUMANO, hasOpenCase: true })).pass).toBe(true);
    }
  });

  it("o retorno do caso sem passagem é o que manda o modelo dizer 'vou verificar e já te retorno'", () => {
    expect(RETORNO_DO_CASO_SEM_PASSAGEM).toMatch(/vou verificar e já te retorno/);
  });
});

describe("(C01, 1.86) a ligação no turno", () => {
  it("open_human_case sem passagem marca o caso do turno antes de devolver o 'vou verificar'", () => {
    const ferramenta = trecho("rawTools.open_human_case = tool({", "rawTools.provide_case_update = tool({");
    const marca = ferramenta.indexOf("openedCaseThisTurn = true;");
    const retorno = ferramenta.indexOf("if (semPassagem) return { ok: true, case_id: res.caseId, message: RETORNO_DO_CASO_SEM_PASSAGEM }");
    expect(marca).toBeGreaterThan(-1);
    expect(retorno).toBeGreaterThan(marca);
  });

  it("o caso aberto é lido de novo a cada envio (o open_human_case anterior no turno vale)", () => {
    const envio = trecho("const hasOpenCase =", "const beforeSendArgs = {");
    expect(envio).toMatch(/await hasOpenCaseForContact\(pool, tenantId, input\.conversationId\)/);
  });

  it("2º veto: o sistema abre o caso e reenvia pela cadeia com o caso aberto — a mensagem sai", () => {
    const failSafe = trecho(
      "if (chain.status === 'vetoed' && chain.code === 'case_promise_without_case') {",
      "if (chain.status === 'vetoed' && chain.code === 'clinical_claim') {",
    );
    expect(failSafe).toMatch(/if \(casePromiseVetoCount < 2\) \{\s*return \{ ok: false/);
    expect(failSafe).toMatch(/source: 'guardrail_autofallback'/);
    expect(failSafe).toMatch(/moverParaHandoffBestEffort\('case_promise_autofallback'\)/);
    expect(failSafe).toMatch(/hasOpenCase: true,\s*openedCaseThisTurn: true,/);
    // Nada de passagem aqui: o caso é o registro, a conversa segue.
    expect(failSafe).not.toMatch(/performHumanHandoff|force_human|bot_silenced/);
  });

  it("mover o card para 'chamar-humano' não silencia: só o funil, e o motor não lê `requires_human`", () => {
    const mover = trecho("const moverParaHandoffBestEffort = (reason: string): void => {", "};");
    expect(mover).toMatch(/moverLeadParaEtapaDeHandoff\(/);
    expect(mover).not.toMatch(/performHumanHandoff|force_human|bot_silenced/);
    expect(FONTE).not.toMatch(/checkG4Stage/);
    const etapa = readFileSync("lib/leads/handoff-stage-move.ts", "utf8");
    expect(etapa).not.toMatch(/force_human|bot_silenced/);
  });
});
