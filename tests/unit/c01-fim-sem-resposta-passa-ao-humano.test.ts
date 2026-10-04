/**
 * (C01, -c01.3, item 1c) OS DOIS BURACOS DO FAIL-SAFE: O TURNO QUE ACABA SEM NENHUMA
 * MENSAGEM AO LEAD PASSA À EQUIPE.
 *
 * O fail-safe da rodada 8 (caso aberto, frase de espera pelo `send` exclusivo, passagem
 * gravada) só cobria o corte pelo teto de tokens. Ficavam de fora:
 *   (i)  a ÚLTIMA tentativa do job que falha sem nenhuma mensagem enviada: o job vai a
 *        'dead' (alerta `job_dead`) e o lead fica mudo — o desfecho possível da C41
 *        (requisições penduradas comendo as tentativas, volta 19-A2);
 *   (ii) o laço que acaba no teto de etapas (`max_steps`) ainda pedindo ferramenta, sem
 *        ter mandado nada: o job concluía "ok" com o lead mudo. Junto, o fim pelo teto
 *        de saída por requisição (`finishReason` 'length'), que a -c01.3 introduz.
 *
 * As peças se provam por comportamento (o seam com modelo falso, a régua da última
 * tentativa, os textos); a ligação no turno, por leitura do código — não há harness de
 * turno inteiro em unidade (o de `tests/invariants/` pede Postgres).
 */
import { readFileSync } from "node:fs";
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import * as seam from "@/lib/agent-engine/edge/llm/run-model-call";
import * as turno from "@/lib/agent-engine/agent/inbound-turn";
import { AgendaDeferredError } from "@/lib/agenda/protecao-followup";
import {
  JobLeasePerdidoError,
  PrazoDaExecucaoVencidoError,
  StaleServiceBoundaryError,
} from "@/lib/atendimento/fronteira";

const ORG = "11111111-1111-4111-8111-111111111111";

/** A régua da última tentativa, importada na hora: sem a mudança o módulo não existe e cada caso reprova por si. */
const CAMINHO_DA_REGUA = "@/lib/agent-engine/agent/ultima-tentativa";
async function regua(): Promise<(job: object, err: unknown, agora?: number) => boolean> {
  const m = (await import(/* @vite-ignore */ CAMINHO_DA_REGUA)) as {
    falhaEsgotaAsTentativas: (job: object, err: unknown, agora?: number) => boolean;
  };
  return m.falhaEsgotaAsTentativas;
}

function poolDoModelo() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: { provider: "anthropic", default_model: "claude-padrao", params: {}, enabled_models: [], monthly_budget_cents: null },
          },
        ],
      };
    }
    if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-1" }] };
    return { rows: [] };
  });
  return { query } as never;
}

const uso = (entrada: number, saida: number) => ({
  inputTokens: { total: entrada, noCache: entrada, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: saida, text: saida, reasoning: 0 },
});

type Etapa = { tipo: "consulta" | "texto"; fim: "tool-calls" | "stop" | "length"; saida?: number };

/** Modelo falso que segue um roteiro de etapas; esgotado, encerra com texto. */
function modelo(roteiro: Etapa[]) {
  const estado = { etapas: 0 };
  const fabrica = () =>
    ({
      specificationVersion: "v3",
      provider: "anthropic",
      modelId: "claude-padrao",
      doGenerate: async () => {
        const e = roteiro[estado.etapas] ?? { tipo: "texto", fim: "stop" };
        estado.etapas += 1;
        return {
          content:
            e.tipo === "consulta"
              ? [{ type: "tool-call", toolCallId: `c${estado.etapas}`, toolName: "consulta", input: JSON.stringify({ q: "x" }) }]
              : [{ type: "text", text: "texto" }],
          finishReason: { unified: e.fim, raw: undefined },
          usage: uso(100, e.saida ?? 10),
          warnings: [],
        };
      },
    }) as never;
  return { estado, registry: { anthropic: fabrica } };
}

const consulta = tool({
  description: "consulta de teste",
  inputSchema: z.object({ q: z.string() }),
  execute: async () => ({ ok: true }),
});
const cfg = { anthropicApiKey: "sk-ant-x", cacheTtl: "1h" } as const;
const entrada = {
  tenantId: ORG,
  purpose: "agent_turn",
  messages: [{ role: "user" as const, content: "oi" }],
  tools: { consulta },
};

describe("(C01) (ii) o fim por limite volta ao turno em `corte`", () => {
  it("teto de etapas com a última etapa ainda pedindo ferramenta → `limite_de_etapas`", async () => {
    const m = modelo([
      { tipo: "consulta", fim: "tool-calls" },
      { tipo: "consulta", fim: "tool-calls" },
      { tipo: "consulta", fim: "tool-calls" },
    ]);
    const r = await seam.runModelCall(poolDoModelo(), cfg, { ...entrada, maxSteps: 3 }, { registry: m.registry });
    expect(m.estado.etapas).toBe(3);
    expect(r.corte).toEqual({ motivo: "limite_de_etapas", teto: 3, gastos: 3, etapas: 3 });
  });

  it("etapa que para no teto de saída → `teto_de_saida`, com o teto e a saída da etapa", async () => {
    const m = modelo([
      { tipo: "consulta", fim: "tool-calls" },
      { tipo: "texto", fim: "length", saida: 8_000 },
    ]);
    const r = await seam.runModelCall(
      poolDoModelo(),
      cfg,
      { ...entrada, maxSteps: 8, maxOutputTokens: 8_000 },
      { registry: m.registry },
    );
    expect(r.corte).toEqual({ motivo: "teto_de_saida", teto: 8_000, gastos: 8_000, etapas: 2 });
  });

  it("o laço que acaba sozinho continua sem motivo (calar é decisão do modelo), inclusive quando acaba na última etapa permitida", async () => {
    const sozinho = modelo([{ tipo: "consulta", fim: "tool-calls" }]);
    const r1 = await seam.runModelCall(poolDoModelo(), cfg, { ...entrada, maxSteps: 8 }, { registry: sozinho.registry });
    expect(r1.corte).toBeNull();
    const naUltima = modelo([{ tipo: "consulta", fim: "tool-calls" }, { tipo: "texto", fim: "stop" }]);
    const r2 = await seam.runModelCall(poolDoModelo(), cfg, { ...entrada, maxSteps: 2 }, { registry: naUltima.registry });
    expect(r2.corte).toBeNull();
  });

  it("o corte pelo teto de tokens tem a precedência sobre o limite de etapas", async () => {
    const m = modelo([
      { tipo: "consulta", fim: "tool-calls", saida: 5_000 },
      { tipo: "consulta", fim: "tool-calls" },
    ]);
    const r = await seam.runModelCall(
      poolDoModelo(),
      cfg,
      { ...entrada, maxSteps: 1, tetoDeTokensDoTurno: 1_000 },
      { registry: m.registry },
    );
    expect(r.corte?.motivo).toBe("corte_por_teto_de_tokens");
  });
});

describe("(C01) (i) a régua da falha que esgota as tentativas espelha a disposição do worker", () => {
  const ultima = { attempts: 5, max_attempts: 5, created_at: new Date("2026-10-04T12:00:00Z") };
  const agora = new Date("2026-10-04T12:05:00Z").getTime();

  it("na última tentativa, a falha comum (prazo da requisição, prazo da execução, provedor fora) mata o job", async () => {
    const f = await regua();
    const prazo = new Error("timeout: a requisição ao provedor de IA passou do prazo de 120000 ms e foi abortada");
    prazo.name = "TimeoutError";
    expect(f(ultima, prazo, agora)).toBe(true);
    expect(f(ultima, new PrazoDaExecucaoVencidoError("j", 540_000), agora)).toBe(true);
    expect(f(ultima, new Error("provedor fora do ar (503)"), agora)).toBe(true);
    expect(
      f(ultima, new AgendaDeferredError({ adiar: true, motivo: "leitura_indisponivel", appointment_id: null, reavaliar_em: null } as never), agora),
    ).toBe(true);
  });

  it("antes da última tentativa nada mata o job: a fila re-tenta", async () => {
    const f = await regua();
    expect(f({ ...ultima, attempts: 4 }, new Error("provedor fora do ar"), agora)).toBe(false);
    expect(f({ ...ultima, attempts: 1 }, new Error("x"), agora)).toBe(false);
  });

  it("o que o worker cancela, adia sem gastar tentativa ou já resolveu não é a falha final", async () => {
    const f = await regua();
    expect(f(ultima, new StaleServiceBoundaryError(), agora)).toBe(false);
    expect(f(ultima, new JobLeasePerdidoError("j"), agora)).toBe(false);
    expect(f(ultima, Object.assign(new Error("is_blocked"), { terminal: true }), agora)).toBe(false);
    expect(f(ultima, new turno.JobSettledError("cap de envio"), agora)).toBe(false);
    expect(
      f(ultima, new AgendaDeferredError({ adiar: true, motivo: "agendado", appointment_id: null, reavaliar_em: null } as never), agora),
    ).toBe(false);
    // O teto de orçamento tem passagem própria (`comHandoffSeOrcamentoAcabar`), com aviso ao lead.
    expect(f(ultima, new seam.LlmBudgetExceededError(), agora)).toBe(false);
    // Sem saldo, dentro da janela de espera: o job espera a recarga, sem gastar tentativa.
    expect(f(ultima, new Error("Your credit balance is too low to access the Anthropic API"), agora)).toBe(false);
  });
});

describe("(C01) os textos de cada fim: legíveis, sem código cru e sem prometer prazo", () => {
  const fins = [
    { motivo: "corte_por_teto_de_tokens", teto: 50_000, gastos: 60_600, etapas: 2 },
    { motivo: "limite_de_etapas", teto: 8, gastos: 8, etapas: 8 },
    { motivo: "teto_de_saida", teto: 8_000, gastos: 8_000, etapas: 2 },
    { motivo: "falha_na_ultima_tentativa", erro: "timeout: a requisição passou do prazo", tentativa: 5, tentativas: 5 },
  ] as const;

  it("cada fim tem título do caso, resumo, bloqueio, motivo e título da passagem próprios", () => {
    const textos = fins.map((f) => turno.textosDoFimSemResposta(f as never));
    for (const t of textos) {
      for (const valor of Object.values(t)) {
        expect(valor).not.toMatch(/\b(minutos?|horas?|em breve|logo)\b/i);
      }
      for (const valor of [t.tituloDoCaso, t.motivoDaPassagem, t.tituloDaPassagem]) {
        expect(valor).not.toMatch(/corte_por|limite_de|teto_de|falha_na|token_budget|_/);
      }
      expect(t.motivoDaPassagem).toMatch(/uma pessoa precisa responder/);
      expect(t.tituloDaPassagem).toBe(`${t.tituloDoCaso} — assumir a conversa`);
    }
    expect(new Set(textos.map((t) => t.motivoDaPassagem)).size).toBe(4);
    expect(textos[1]!.resumo).toMatch(/limite de etapas da versão \(8 de 8\)/);
    expect(textos[2]!.resumo).toMatch(/8000 tokens; teto 8000/);
    expect(textos[3]!.resumo).toMatch(/tentativa 5 de 5 também falhou \(timeout: a requisição passou do prazo\)/);
  });

  it("o corte pelo teto de tokens mantém os textos da rodada 8, palavra por palavra", () => {
    const t = turno.textosDoFimSemResposta(fins[0] as never);
    expect(t.tituloDoCaso).toBe(turno.TITULO_DO_CASO_POR_CORTE);
    expect(t.motivoDaPassagem).toBe(turno.MOTIVO_DA_PASSAGEM_POR_CORTE);
    expect(t.tituloDaPassagem).toBe(turno.TITULO_DA_PASSAGEM_POR_CORTE);
    expect(t.resumo).toBe(
      "A IA não chegou a responder: o laço foi cortado pelo teto de tokens da versão (60600 tokens em 2 etapa(s); teto 50000). Nenhuma mensagem saiu ao cliente neste turno.",
    );
    expect(t.bloqueio).toMatch(/cortada por tamanho/);
  });
});

describe("(C01) a ligação no turno, pelo código", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("(ii) o bloco do corte chama a sequência comum com `turn.corte` (que agora traz o limite de etapas e o teto de saída)", () => {
    expect(TURNO).toMatch(
      /turn\.corte !== null &&\s*!leadTemResposta &&[\s\S]{0,200}\) \{\s*await passarAoHumanoSemResposta\(turn\.corte\);\s*\}/,
    );
  });

  it("a sequência comum: caso → frase pelo `send` exclusivo → passagem gravada, com os textos do fim", () => {
    const ini = TURNO.indexOf("const passarAoHumanoSemResposta = async (fim: FimSemResposta): Promise<DesfechoDaFraseDeEspera> => {");
    expect(ini).toBeGreaterThan(-1);
    const corpo = TURNO.slice(ini, TURNO.indexOf("\n  };\n", ini));
    const caso = corpo.indexOf("const caso = await openCase(");
    const frase = corpo.indexOf("send: enviarFraseDeEspera,");
    const passagem = corpo.indexOf("await gravarPassagemComNovaTentativa(");
    expect(caso).toBeGreaterThan(-1);
    expect(frase).toBeGreaterThan(caso);
    expect(passagem).toBeGreaterThan(frase);
    expect(corpo).toMatch(/const textos = textosDoFimSemResposta\(fim\);/);
    expect(corpo).toMatch(/passadoAoHumano = true;/);
    // Nenhuma frase nova: a de espera de sempre.
    expect(corpo).toMatch(/body: deps\.knobs\.fraseDeEspera \?\? FRASE_DE_ESPERA_PADRAO,/);
  });

  it("(i) o `catch` do corpo do turno: última tentativa + zero mensagens + sem passagem → a sequência comum, e o erro ORIGINAL sobe", () => {
    const i = TURNO.indexOf("(C01, -c01.3, item 1c-i) A ÚLTIMA TENTATIVA FALHOU");
    expect(i).toBeGreaterThan(-1);
    const bloco = TURNO.slice(TURNO.lastIndexOf("} catch (err) {", i), TURNO.indexOf("} finally {", i));
    expect(bloco).toMatch(
      /if \(\s*!preview &&\s*!leadTemResposta &&\s*!passadoAoHumano &&\s*!turnoDescartado &&\s*turnoVaiFalarComOLead\(liveJob\(\)\) &&\s*falhaEsgotaAsTentativas\(liveJob\(\), err\)\s*\) \{/,
    );
    expect(bloco).toMatch(
      /await passarAoHumanoSemResposta\(\{\s*motivo: 'falha_na_ultima_tentativa',[\s\S]*?tentativa: liveJob\(\)\.attempts,\s*tentativas: liveJob\(\)\.max_attempts,\s*\}\);/,
    );
    // Falha do próprio fail-safe não troca o erro que explica o job morto.
    expect(bloco).toMatch(/\} catch \(erroDoFailSafe\) \{[\s\S]*?\}\s*\}\s*throw err;\s*$/);
  });

  it("(i) o `catch` cobre a chamada principal do modelo e o fim do turno (`runError`, envio 'failed')", () => {
    const corpoDoTurno = TURNO.indexOf("let mcpCleanup: (() => Promise<void>) | null = null;\n  try {");
    const chamada = TURNO.indexOf("    const turn = await runModelCall(");
    const runError = TURNO.indexOf("throw runError;");
    const failed = TURNO.indexOf("throw new Error('envio marcado como failed pelo CRM");
    const captura = TURNO.indexOf("(C01, -c01.3, item 1c-i) A ÚLTIMA TENTATIVA FALHOU");
    expect(corpoDoTurno).toBeGreaterThan(-1);
    for (const ponto of [chamada, runError, failed]) {
      expect(ponto).toBeGreaterThan(corpoDoTurno);
      expect(captura).toBeGreaterThan(ponto);
    }
    // Entre o início do corpo e a captura não há outro `catch` no nível do corpo.
    expect(TURNO.slice(corpoDoTurno, captura).match(/\n {2}\} catch \(/g)).toHaveLength(1);
  });

  it("(i, rodada 2) a falha da compactação na última tentativa fica guardada e sobe na primeira linha do corpo, onde o `catch` a trata", () => {
    // A única chamada da compactação passa pela captura; o comportamento, contra o banco,
    // está em `tests/invariants/c01-falha-na-preparacao-na-ultima-tentativa.test.ts`.
    expect(TURNO.match(/await maybeCompact\(/g)).toHaveLength(1);
    const chamada = TURNO.indexOf("const compacted = await maybeCompact(");
    expect(chamada).toBeGreaterThan(-1);
    expect(TURNO.indexOf("    ).catch(adiarFalhaDaUltimaTentativa);\n    if (compacted !== null) {", chamada)).toBeGreaterThan(chamada);
    // Só na última tentativa (a mesma régua do `catch`); antes dela o erro sobe na hora.
    expect(TURNO).toMatch(
      /const adiarFalhaDaUltimaTentativa = \(err: unknown\): null => \{\s*if \(preview \|\| !falhaEsgotaAsTentativas\(liveJob\(\), err\)\) throw err;\s*preparacao\.falha = \{ erro: err \};/,
    );
    // E sobe dentro do `try` do corpo, antes de qualquer outra coisa.
    expect(TURNO).toMatch(
      /let mcpCleanup: \(\(\) => Promise<void>\) \| null = null;\n {2}try \{\n(?: {4}\/\/.*\n)*\s*if \(preparacao\.falha !== null\) throw preparacao\.falha\.erro;/,
    );
  });
});
