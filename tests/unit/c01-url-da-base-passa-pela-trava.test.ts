/**
 * (C01) A URL EXATA QUE A BASE DEVOLVEU PASSA PELA TRAVA — a correção 4a.
 *
 * O link de vídeo legítimo da empresa carrega um UUID (`…/embed/?v=<uuid>`) e
 * caía na regra (E2) do detector de vocabulário interno ("identificador
 * interno"): o agente consultava a base, recebia o link certo, e o gate vetava a
 * mensagem com o link certo. O modelo então omitia o link, ou inventava outro.
 *
 * A liberação é por RECURSO, não por domínio: só a ocorrência exata de uma URL
 * que `crm_query_external_data` devolveu NESTE turno é mascarada antes da
 * varredura. UUID solto, a mesma URL com outro identificador e uma URL do mesmo
 * domínio que a base não devolveu continuam barrados. Fora do turno (sem URL
 * liberada) o detector é o de sempre.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { urlsNoResultado } from "@/lib/agent-engine/agent/inbound-turn";
import {
  internalVocabularyGate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import {
  detectarVazamentoInterno,
  MASCARA_DE_URL_DA_BASE,
  mascararUrlsDaBase,
} from "@/lib/agent-engine/guardrails/vazamento-interno";
import { PACING_DEFAULTS } from "@/lib/agent-engine/pacing/defaults";
import { SPINNING_DEFAULTS } from "@/lib/agent-engine/spinning/defaults";

const UUID_DO_VIDEO = "3f9c2b1a-7d4e-4c8b-9a21-5e6f7a8b9c0d";
const OUTRO_UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const URL_DA_BASE = `https://player-vz-1a2b3c4d-5e6.tv.pandavideo.com.br/embed/?v=${UUID_DO_VIDEO}`;
const MESMO_DOMINIO_OUTRO_VIDEO = `https://player-vz-1a2b3c4d-5e6.tv.pandavideo.com.br/embed/?v=${OUTRO_UUID}`;

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

describe("(C01) detector: a URL exata da base é mascarada; o resto continua barrado", () => {
  const mensagem = `Segue a aula de demonstração: ${URL_DA_BASE} — qualquer dúvida, me chama.`;

  it("sem URL liberada, o link legítimo ainda cai como identificador interno (o defeito)", () => {
    const sem = detectarVazamentoInterno(mensagem);
    expect(sem.achou).toBe(true);
    expect(sem.termos).toContain("identificador interno");
  });

  it("com a URL que a base devolveu, a mesma mensagem passa", () => {
    const com = detectarVazamentoInterno(mensagem, { urlsPermitidas: new Set([URL_DA_BASE]) });
    expect(com).toEqual({ achou: false, termos: [], categorias: [] });
  });

  it("UUID solto continua barrado, mesmo com a URL liberada", () => {
    const r = detectarVazamentoInterno(`Seu cadastro é ${UUID_DO_VIDEO}, veja ${URL_DA_BASE}`, {
      urlsPermitidas: [URL_DA_BASE],
    });
    expect(r.achou).toBe(true);
    expect(r.termos).toEqual(["identificador interno"]);
  });

  it("URL do mesmo domínio que a base NÃO devolveu continua barrada", () => {
    const r = detectarVazamentoInterno(`Olha esta: ${MESMO_DOMINIO_OUTRO_VIDEO}`, {
      urlsPermitidas: [URL_DA_BASE],
    });
    expect(r.achou).toBe(true);
    expect(r.termos).toEqual(["identificador interno"]);
  });

  it("a URL da base com UM caractere trocado no identificador é outra URL: barrada", () => {
    const alterada = URL_DA_BASE.replace(/d$/, "e");
    expect(alterada).not.toBe(URL_DA_BASE);
    const r = detectarVazamentoInterno(`Segue: ${alterada}`, { urlsPermitidas: [URL_DA_BASE] });
    expect(r.achou).toBe(true);
  });

  it("a máscara não casa com regra nenhuma, e lixo não vira URL liberada", () => {
    expect(detectarVazamentoInterno(MASCARA_DE_URL_DA_BASE).achou).toBe(false);
    expect(mascararUrlsDaBase(`a ${URL_DA_BASE} b`, [URL_DA_BASE])).toBe(`a ${MASCARA_DE_URL_DA_BASE} b`);
    // Strings curtas ou que não são URL não mascaram nada (não dá para "liberar" um UUID).
    expect(mascararUrlsDaBase(`x ${UUID_DO_VIDEO}`, [UUID_DO_VIDEO, "", "ab"])).toBe(`x ${UUID_DO_VIDEO}`);
    // A mais longa primeiro: a curta (prefixo) não come o começo da longa.
    const curta = "https://exemplo.com.br/v";
    const longa = `${curta}/${UUID_DO_VIDEO}`;
    expect(mascararUrlsDaBase(`veja ${longa} e ${curta}`, [curta, longa])).toBe(
      `veja ${MASCARA_DE_URL_DA_BASE} e ${MASCARA_DE_URL_DA_BASE}`,
    );
  });
});

describe("(C01) gate: `urlsDaBase` libera só o que a base devolveu e o veto ensina a saída", () => {
  it("armado + URL da base no contexto = passa", () => {
    const v = internalVocabularyGate.evaluate(
      baseCtx({
        internalVocabularyEnforced: true,
        urlsDaBase: new Set([URL_DA_BASE]),
        body: `Aqui está a aula: ${URL_DA_BASE}`,
      }),
    );
    expect(v.pass).toBe(true);
  });

  it("armado sem a URL no contexto = veto, e o veto manda copiar o link exatamente como a base devolveu", () => {
    const v = internalVocabularyGate.evaluate(
      baseCtx({ internalVocabularyEnforced: true, body: `Aqui está a aula: ${URL_DA_BASE}` }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.code).toBe("internal_vocabulary_leak");
    expect(v.reason).toMatch(/copie o link EXATAMENTE como a base devolveu/);
  });

  it("UUID fora de link não ganha a dica do link", () => {
    const v = internalVocabularyGate.evaluate(
      baseCtx({ internalVocabularyEnforced: true, body: `Seu protocolo: ${UUID_DO_VIDEO}` }),
    );
    expect(v.pass).toBe(false);
    if (v.pass) throw new Error("inalcançável");
    expect(v.reason).not.toMatch(/copie o link/);
  });
});

describe("(C01) o turno: as URLs do resultado da base chegam ao gate", () => {
  it("urlsNoResultado acha toda URL em qualquer profundidade e tira a pontuação final", () => {
    const resultado = {
      ok: true,
      linhas: [
        { nome: "Aula 1", url: URL_DA_BASE, descricao: "sem link aqui" },
        { nome: "Página", texto: `Veja em https://site.exemplo.com.br/matricula, ou ligue.` },
      ],
      meta: { aninhado: { mais: [`(${MESMO_DOMINIO_OUTRO_VIDEO})`] } },
      numero: 42,
      nada: null,
    };
    expect([...urlsNoResultado(resultado)].sort()).toEqual(
      [URL_DA_BASE, "https://site.exemplo.com.br/matricula", MESMO_DOMINIO_OUTRO_VIDEO].sort(),
    );
    expect(urlsNoResultado("texto sem link").size).toBe(0);
    expect(urlsNoResultado(undefined).size).toBe(0);
  });

  it("a fiação: o turno embrulha crm_query_external_data, guarda as URLs e passa `urlsDaBase` ao gate", () => {
    const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    expect(turno).toMatch(/const FERRAMENTA_DA_BASE = 'crm_query_external_data';/);
    expect(turno).toMatch(/name === FERRAMENTA_DA_BASE[\s\S]{0,600}for \(const url of urlsNoResultado\(resultado\)\) urlsDaBase\.add\(url\);/);
    expect(turno).toMatch(/enforceInternalVocabulary: true,[\s\S]{0,200}urlsDaBase,/);
    const beforeSend = readFileSync("lib/agent-engine/guardrails/before-send.ts", "utf8");
    expect(beforeSend).toMatch(/urlsDaBase: args\.urlsDaBase/);
    expect(beforeSend).toMatch(/detectarVazamentoInterno\(ctx\.body, \{ urlsPermitidas: ctx\.urlsDaBase \?\? \[\] \}\)/);
  });
});
