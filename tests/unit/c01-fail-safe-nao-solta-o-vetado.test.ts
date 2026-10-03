/**
 * (C01) O FAIL-SAFE NÃO SOLTA O TEXTO VETADO — a correção 4b.
 *
 * Até aqui, no 2º veto de `internal_vocabulary_leak` o turno re-rodava a cadeia
 * com o gate DESARMADO e o texto saía "com registro": o vocabulário interno
 * chegava ao cliente, só que medido. Agora: 1º veto ensina; 2º ensina e avisa
 * que é a última tentativa; 3º: o texto vetado não sai, o cliente recebe uma
 * frase curta de espera, um caso aciona uma pessoa da equipe e o lead vai à
 * etapa de passagem. Três invariantes, nesta ordem de importância:
 *
 *   1. o conteúdo vetado NUNCA sai (não há mais re-run com o gate desarmado);
 *   2. o cliente NUNCA fica sem resposta (a frase de espera sai pela cadeia);
 *   3. a frase NUNCA sai sozinha (sem caso aberto, a própria cadeia a veta —
 *      ela promete uma pessoa, e promessa de pessoa sem caso é vetada).
 *
 * O turno inteiro com modelo falso não roda em unidade neste repo (ver o
 * cabeçalho de `tests/unit/send-template-wiring.test.ts`); por isso a prova é
 * em duas partes: as PEÇAS (frase, gates, aviso, knob) por comportamento, e a
 * LIGAÇÃO no `send_message.execute` por leitura do código que roda — o mesmo
 * padrão que o autor usa em `gate-vazamento-interno.test.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  FRASE_DE_ESPERA_PADRAO,
  MAX_VETOS_DE_VOCABULARIO_INTERNO,
} from "@/lib/agent-engine/agent/inbound-turn";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";
import { loadEnv } from "@/lib/agent-engine/env";
import {
  agendaStallGate,
  casePromiseGate,
  internalVocabularyGate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import {
  AVISO_DE_ULTIMA_TENTATIVA,
  detectarVazamentoInterno,
  renderVetoDeVazamento,
} from "@/lib/agent-engine/guardrails/vazamento-interno";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

function baseCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    now: new Date("2026-09-28T12:00:00Z"),
    body: "",
    optedOut: false,
    provider: "waha",
    pacing: {
      knobs: PACING_DEFAULTS,
      state: { lastSentAt: null, sentToday: 0, numberActivatedAt: null },
      crmDailyLimit: null,
    },
    spinning: { knobs: SPINNING_DEFAULTS, window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: null, isFirstOutbound: false, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    ...overrides,
  };
}

const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
function corpoDoExecute(inicio: string, fim: string): string {
  const i = FONTE.indexOf(inicio);
  expect(i, `âncora ${inicio} sumiu`).toBeGreaterThan(-1);
  const j = FONTE.indexOf(fim, i);
  expect(j, `âncora ${fim} sumiu`).toBeGreaterThan(i);
  return FONTE.slice(i, j);
}

describe("(C01) a frase de espera", () => {
  it("é curta, em português com acentos, sem prazo e sem nome de ferramenta", () => {
    expect(FRASE_DE_ESPERA_PADRAO.length).toBeLessThan(160);
    expect(FRASE_DE_ESPERA_PADRAO).toMatch(/[áéíóúâêôãõç]/i);
    // Sem promessa de prazo: nada de minutos, horas, "hoje", "amanhã", "já já", "em breve".
    expect(FRASE_DE_ESPERA_PADRAO).not.toMatch(/\b(minutos?|horas?|hoje|amanh[ãa]|em breve|j[áa] j[áa]|logo|rapidinho)\b/i);
    expect(detectarVazamentoInterno(FRASE_DE_ESPERA_PADRAO).achou).toBe(false);
  });

  it("passa pelos gates de conteúdo COM caso aberto — e sem caso a própria cadeia a veta (nunca sai sozinha)", () => {
    const comCaso = baseCtx({
      body: FRASE_DE_ESPERA_PADRAO,
      internalVocabularyEnforced: true,
      casesEnabled: true,
      hasOpenCase: true,
      openedCaseThisTurn: true,
      agenda: { active: true, ferramentas: ["crm_find_free_slots"], toolCalledThisTurn: false },
    });
    expect(internalVocabularyGate.evaluate(comCaso).pass).toBe(true);
    expect(casePromiseGate.evaluate(comCaso).pass).toBe(true);
    expect(agendaStallGate.evaluate(comCaso).pass).toBe(true);

    // A frase promete uma pessoa da equipe: sem caso, `casePromiseGate` a barra.
    // É isso que garante "a frase nunca sai sem a página".
    const semCaso = baseCtx({ body: FRASE_DE_ESPERA_PADRAO, casesEnabled: true });
    const veto = casePromiseGate.evaluate(semCaso);
    expect(veto.pass).toBe(false);
    if (veto.pass) throw new Error("inalcançável");
    expect(veto.code).toBe("case_promise_without_case");
  });

  it("é configurável por AGENT_FRASE_DE_ESPERA; sem a variável, o knob fica ausente e o turno usa o padrão", () => {
    const base: Record<string, string> = {
      SUPABASE_DB_URL: "postgres://u:p@localhost:5432/db",
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
    };
    const semVariavel = turnKnobsFromEnv(loadEnv({ ...base } as unknown as NodeJS.ProcessEnv));
    expect(semVariavel.fraseDeEspera).toBeUndefined();
    const comVariavel = turnKnobsFromEnv(
      loadEnv({ ...base, AGENT_FRASE_DE_ESPERA: "  Um instante, por favor: uma pessoa da equipe vai te responder.  " } as unknown as NodeJS.ProcessEnv),
    );
    expect(comVariavel.fraseDeEspera).toBe("Um instante, por favor: uma pessoa da equipe vai te responder.");
  });
});

describe("(C01) os degraus do fail-safe", () => {
  it("são três: ensina, ensina avisando que é a última, age", () => {
    expect(MAX_VETOS_DE_VOCABULARIO_INTERNO).toBe(3);
  });

  it("o aviso de última tentativa entra no veto e diz o que acontece se repetir", () => {
    const comAviso = renderVetoDeVazamento(["crm_leads"], { ultimaTentativa: true });
    expect(comAviso).toContain(AVISO_DE_ULTIMA_TENTATIVA);
    expect(AVISO_DE_ULTIMA_TENTATIVA).toMatch(/ÚLTIMA tentativa/);
    expect(AVISO_DE_ULTIMA_TENTATIVA).toMatch(/passa a uma pessoa da equipe/);
    expect(renderVetoDeVazamento(["crm_leads"])).not.toContain(AVISO_DE_ULTIMA_TENTATIVA);
  });
});

describe("(C01) a ligação no send_message.execute", () => {
  const corpo = corpoDoExecute("send_message: tool({", "update_lead_state: tool({");
  const failSafe = corpo.slice(corpo.indexOf("chain.code === 'internal_vocabulary_leak'"));

  it("não existe mais re-run com o gate desarmado: o texto vetado nunca sai", () => {
    expect(corpo).not.toMatch(/enforceInternalVocabulary: false/);
    // O texto do modelo (`body`) só volta a entrar na cadeia como `summary` do caso,
    // nunca como `body` de um runBeforeSend depois do veto.
    expect(failSafe).not.toMatch(/runBeforeSend\(\{\s*\.\.\.beforeSendArgs,\s*(?:openedCaseThisTurn|hasOpenCase)[^}]*\}\)/);
  });

  it("1º e 2º vetos devolvem erro de ensino; o 2º leva o aviso de última tentativa", () => {
    expect(failSafe).toMatch(/internalVocabularyVetoCount < MAX_VETOS_DE_VOCABULARIO_INTERNO/);
    expect(failSafe).toMatch(/internalVocabularyVetoCount === MAX_VETOS_DE_VOCABULARIO_INTERNO - 1/);
    expect(failSafe).toMatch(/\$\{chain\.message\} \$\{AVISO_DE_ULTIMA_TENTATIVA\}/);
  });

  it("no último veto: caso ANTES da frase, frase pela cadeia com caso aberto, lead à etapa de passagem, turno encerrado", () => {
    const caso = failSafe.indexOf("await openCase(");
    const passagem = failSafe.indexOf("moverParaHandoffBestEffort('vocabulario_interno_autofallback')");
    const frase = failSafe.indexOf("body: deps.knobs.fraseDeEspera ?? FRASE_DE_ESPERA_PADRAO");
    expect(caso).toBeGreaterThan(-1);
    expect(passagem).toBeGreaterThan(caso);
    expect(frase).toBeGreaterThan(passagem);
    // O caso carrega o texto que o modelo tentou mandar (é o que a pessoa precisa ver)
    // e a origem de fail-safe; sem caso (erro que não seja "já existe um"), nada sai.
    expect(failSafe).toMatch(/source: 'guardrail_autofallback'/);
    expect(failSafe).toMatch(/summary: body,/);
    expect(failSafe).toMatch(/!caso\.ok && caso\.error\.code !== 'case_already_open'/);
    // A frase vai pela cadeia INTEIRA com o caso declarado (é o que o casePromiseGate
    // exige para uma promessa de pessoa) e sem spinning (texto fixo, como o aviso de escalação).
    expect(failSafe).toMatch(/runBeforeSend\(\{\s*\.\.\.beforeSendArgs,\s*body: deps\.knobs\.fraseDeEspera \?\? FRASE_DE_ESPERA_PADRAO,\s*hasOpenCase: true,\s*openedCaseThisTurn: true,\s*enforceSpinning: false,\s*\}\)/);
    // Depois dela, o turno encerra: erro ao modelo e trava para qualquer outro envio.
    expect(failSafe).toMatch(/passadoAoHumano = true;/);
    expect(failSafe).toMatch(/code: 'internal_vocabulary_leak_handoff'/);
    expect(corpo).toMatch(/if \(passadoAoHumano\) \{[\s\S]*?code: 'turno_passado_ao_humano'/);
    expect(FONTE).toMatch(/turnoDescartado: turnoDescartado \|\| passadoAoHumano/);
  });
});
