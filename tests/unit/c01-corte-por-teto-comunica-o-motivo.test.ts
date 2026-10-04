/**
 * (C01) O CORTE POR TETO DE TOKENS DIZ O MOTIVO AO TURNO — achado 1 (alto) da sétima
 * revisão adversarial do Codex (03/10/2026), rodada 8.
 *
 * O achado: o `token_budget` da versão para o laço de ferramentas ao fim da etapa em
 * que o acumulado passa do teto (`pararPorTetoDeTokens`, correção 2 da C54) — e a
 * PRIMEIRA etapa pode passar dele só consultando uma ferramenta. O corte só aparecia no
 * log: `runModelCall` devolvia o resultado como o de um laço que acabou sozinho (a linha
 * de `llm_calls` 'ok'), e o turno, sem roteiro, gravava o checkpoint e o worker
 * concluía o job com zero envios. O lead ficava mudo, sem retry nem encaminhamento, e
 * o job "ok" — o sintoma da C54, cuja chamada de 66 mil tokens cairia neste corte.
 *
 * A correção, em duas partes:
 *   (a) o corte volta ao chamador: `pararPorTetoDeTokens` avisa `aoCortar` uma vez,
 *       com os números, e `runModelCall` devolve `corte` (`CorteDoLaco` | null);
 *   (b) no turno (`inbound-turn.ts`), corte nosso com ZERO mensagens físicas ao lead
 *       neste job → o caminho do fail-safe de vocabulário interno: caso aberto, frase
 *       de espera pelo `send` exclusivo dela, passagem ao humano gravada. Com pelo
 *       menos um envio feito, nada muda. A prova de turno completo (Postgres real)
 *       está em `tests/invariants/c01-corte-antes-do-primeiro-envio.test.ts`.
 *
 * O prazo das chamadas aborta com exceção (o job falha e re-tenta) e não vira corte.
 * (-c01.3, item 1c) O fim pelo teto de etapas ainda pedindo ferramenta passou a voltar
 * em `corte` (`limite_de_etapas`), como o fim pelo teto de saída (`teto_de_saida`), e a
 * sequência do fail-safe subiu para `passarAoHumanoSemResposta`, que o bloco chama —
 * ver `c01-fim-sem-resposta-passa-ao-humano.test.ts`.
 */
import { readFileSync } from "node:fs";
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  pararPorTetoDeTokens,
  runModelCall,
  type CorteDoLaco,
} from "@/lib/agent-engine/edge/llm/run-model-call";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";

const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

function poolDoModelo() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "anthropic",
              default_model: "claude-padrao",
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("from ai_provider_credentials")) return { rows: [] };
    if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-1" }] };
    return { rows: [] };
  });
  return { query } as never;
}

/** Uso de uma etapa no formato do provedor (V3): entrada + saída. */
const uso = (entrada: number, saida: number) => ({
  inputTokens: { total: entrada, noCache: entrada, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: saida, text: saida, reasoning: 0 },
});

/**
 * Modelo falso: em cada etapa consulta a ferramenta `consulta` com o uso pedido
 * (`usos[etapa]`); esgotados os usos, encerra com texto. Conta as etapas.
 */
function modeloQueConsulta(usos: Array<ReturnType<typeof uso>>) {
  const estado = { etapas: 0 };
  const fabrica = () =>
    ({
      specificationVersion: "v3",
      provider: "anthropic",
      modelId: "claude-padrao",
      doGenerate: async () => {
        const u = usos[estado.etapas];
        estado.etapas += 1;
        if (u === undefined) {
          return {
            content: [{ type: "text", text: "fim" }],
            finishReason: { unified: "stop", raw: undefined },
            usage: uso(1, 1),
            warnings: [],
          };
        }
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `c${estado.etapas}`,
              toolName: "consulta",
              input: JSON.stringify({ q: `etapa ${estado.etapas}` }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: u,
          warnings: [],
        };
      },
    }) as never;
  return { estado, registry: { anthropic: fabrica } };
}

const consulta = tool({
  description: "consulta de teste",
  inputSchema: z.object({ q: z.string() }),
  execute: async ({ q }) => ({ ok: true, resposta: `resultado de ${q}` }),
});

const cfg = { anthropicApiKey: "sk-ant-x", cacheTtl: "1h" } as const;
const entrada = {
  tenantId: ORG,
  leadId: LEAD,
  jobId: JOB,
  purpose: "agent_turn",
  messages: [{ role: "user" as const, content: "oi" }],
  tools: { consulta },
};

describe("(C01) `pararPorTetoDeTokens` avisa o corte uma vez, com os números", () => {
  it("abaixo do teto não avisa; passando dele avisa UMA vez (teto, gastos, etapas) e segue devolvendo true", () => {
    const cortes: CorteDoLaco[] = [];
    const parar = pararPorTetoDeTokens(1_000, log as never, (c) => cortes.push(c));
    const etapa = (entrada: number, saida: number) => ({
      usage: { inputTokens: entrada, outputTokens: saida },
    });
    expect(parar({ steps: [etapa(400, 100)] })).toBe(false);
    expect(cortes).toEqual([]);
    // No teto ainda segue.
    expect(parar({ steps: [etapa(400, 100), etapa(400, 100)] })).toBe(false);
    expect(cortes).toEqual([]);
    expect(parar({ steps: [etapa(400, 100), etapa(400, 100), etapa(300, 50)] })).toBe(true);
    expect(cortes).toEqual([
      { motivo: "corte_por_teto_de_tokens", teto: 1_000, gastos: 1_350, etapas: 3 },
    ]);
    // Avaliado de novo (não acontece no SDK, que para no primeiro true), não avisa duas vezes.
    expect(parar({ steps: [etapa(400, 100), etapa(400, 100), etapa(300, 50), etapa(1, 1)] })).toBe(
      true,
    );
    expect(cortes).toHaveLength(1);
  });

  it("sem `aoCortar` funciona como antes (os chamadores antigos não mudam)", () => {
    const parar = pararPorTetoDeTokens(10, log as never);
    expect(parar({ steps: [{ usage: { inputTokens: 20, outputTokens: 0 } }] })).toBe(true);
  });
});

describe("(C01) `runModelCall` devolve o corte ao chamador", () => {
  it("a 1ª etapa passa do teto só consultando uma ferramenta: o laço para e `corte` traz o motivo e os números", async () => {
    const modelo = modeloQueConsulta([uso(5_000, 10), uso(10, 10)]);
    const r = await runModelCall(
      poolDoModelo(),
      cfg as never,
      { ...entrada, maxSteps: 5, tetoDeTokensDoTurno: 1_000 } as never,
      { registry: modelo.registry as never, log: log as never },
    );
    expect(modelo.estado.etapas).toBe(1);
    expect(r.corte).toEqual({
      motivo: "corte_por_teto_de_tokens",
      teto: 1_000,
      gastos: 5_010,
      etapas: 1,
    });
    // A linha de `llm_calls` continua 'ok': a chamada ao provedor foi bem (o CHECK da
    // coluna só aceita 'ok' e 'erro'); o motivo vive no retorno e no log.
    expect(r.callId).toBe("call-1");
    expect(log.warn).toHaveBeenCalledWith(
      "llm: teto de tokens da versão atingido — laço de ferramentas encerrado",
      expect.objectContaining({ teto: 1_000, gastos: 5_010, etapas: 1 }),
    );
  });

  it("o laço que acaba sozinho (o modelo encerra com texto) não tem corte", async () => {
    const modelo = modeloQueConsulta([uso(100, 10)]);
    const r = await runModelCall(
      poolDoModelo(),
      cfg as never,
      { ...entrada, maxSteps: 5, tetoDeTokensDoTurno: 1_000 } as never,
      { registry: modelo.registry as never, log: log as never },
    );
    expect(modelo.estado.etapas).toBe(2);
    expect(r.corte).toBeNull();
  });

  it("(-c01.3) o fim pelo teto de ETAPAS ainda pedindo ferramenta volta em `corte` como `limite_de_etapas` (o teto de tokens não estourou)", async () => {
    const modelo = modeloQueConsulta([uso(100, 10), uso(100, 10), uso(100, 10)]);
    const r = await runModelCall(
      poolDoModelo(),
      cfg as never,
      { ...entrada, maxSteps: 2, tetoDeTokensDoTurno: 1_000 } as never,
      { registry: modelo.registry as never, log: log as never },
    );
    expect(modelo.estado.etapas).toBe(2);
    expect(r.corte).toEqual({ motivo: "limite_de_etapas", teto: 2, gastos: 2, etapas: 2 });
  });

  it("sem teto de tokens (chamada auxiliar) `corte` é null, como sempre", async () => {
    const modelo = modeloQueConsulta([uso(5_000, 10)]);
    const r = await runModelCall(
      poolDoModelo(),
      cfg as never,
      { ...entrada, maxSteps: 3 } as never,
      { registry: modelo.registry as never, log: log as never },
    );
    expect(r.corte).toBeNull();
  });
});

describe("(C01) a ligação pelo código", () => {
  const SEAM = readFileSync("lib/agent-engine/edge/llm/run-model-call.ts", "utf8");
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("o seam: a condição de parada recebe `aoCortar`, o holder é preenchido no `stopWhen` e o retorno leva `corte`", () => {
    expect(SEAM).toMatch(/const corte: \{ valor: CorteDoLaco \| null \} = \{ valor: null \};/);
    expect(SEAM).toMatch(
      /pararPorTetoDeTokens\(input\.tetoDeTokensDoTurno, deps\.log, \(c\) => \{\s*corte\.valor = c;\s*\}\)/,
    );
    expect(SEAM).toMatch(/avisos: decisao\.avisos,[\s\S]{0,600}corte: corte\.valor,\s*\};\s*\}/);
    // Os motivos (-c01.3: mais o teto de etapas e o de saída); o prazo das chamadas
    // aborta com exceção e não passa por aqui.
    expect(SEAM).toMatch(/motivo: 'corte_por_teto_de_tokens' \| 'limite_de_etapas' \| 'teto_de_saida';/);
    expect(SEAM).not.toMatch(/corte_por_timeout/);
    // O teto de etapas do autor fica como está.
    expect(SEAM).toMatch(/stepCountIs\(input\.maxSteps\),/);
  });

  it("o turno: corte nosso + zero mensagens ao lead + sem erro + sem passagem + turno que fala com o lead → caso, frase pelo `send` exclusivo, passagem gravada", () => {
    const i = TURNO.indexOf("turn.corte !== null &&");
    expect(i).toBeGreaterThan(-1);
    const condicao = TURNO.slice(i - 200, TURNO.indexOf("if (runError !== null) {", i));
    expect(condicao).toMatch(
      /if \(\s*!preview &&\s*turn\.corte !== null &&\s*seq === 0 &&\s*runError === null &&\s*!passadoAoHumano &&\s*!turnoDescartado &&\s*turnoVaiFalarComOLead\(liveJob\(\)\)\s*\) \{\s*await passarAoHumanoSemResposta\(turn\.corte\);\s*\}/,
    );
    // (-c01.3) A sequência mora em `passarAoHumanoSemResposta`; os textos vêm de
    // `textosDoFimSemResposta` (o corte pelo teto de tokens: os constantes de sempre).
    const ini = TURNO.indexOf("const passarAoHumanoSemResposta = async (fim: FimSemResposta): Promise<DesfechoDaFraseDeEspera> => {");
    expect(ini).toBeGreaterThan(-1);
    const bloco = TURNO.slice(ini, TURNO.indexOf("\n  };\n", ini));
    // Caso ANTES da frase, com a origem do fail-safe; sem caso (e não é "já havia") o job falha.
    expect(bloco).toMatch(/const caso = await openCase\(/);
    expect(bloco).toMatch(/title: textos\.tituloDoCaso,/);
    expect(bloco).toMatch(/source: 'guardrail_autofallback',/);
    expect(bloco).toMatch(
      /if \(!caso\.ok && caso\.error\.code !== 'case_already_open'\) \{\s*throw new Error\(`fail-safe do turno sem resposta \(\$\{fim\.motivo\}\) sem caso: \$\{caso\.error\.code\}`\);/,
    );
    // A mesma sequência do fail-safe de vocabulário interno.
    expect(bloco).toMatch(
      /openedCaseThisTurn = true;\s*moverParaHandoffBestEffort\(fim\.motivo\);\s*passadoAoHumano = true;/,
    );
    expect(bloco).toMatch(
      /const espera = await runBeforeSend\(\{[\s\S]*?body: deps\.knobs\.fraseDeEspera \?\? FRASE_DE_ESPERA_PADRAO,[\s\S]*?hasOpenCase: true,\s*openedCaseThisTurn: true,\s*enforceSpinning: false,[\s\S]*?send: enviarFraseDeEspera,\s*\}\);/,
    );
    expect(bloco).toMatch(
      /const desfecho = desfechoDaFraseDeEspera\(espera, \{ outcomes, noteRunError, log: runLog \}\);/,
    );
    expect(bloco).toMatch(
      /await gravarPassagemComNovaTentativa\(\s*\(\) =>\s*performHumanHandoff\(\s*pool,\s*\{ tenantId, leadId, conversationId: input\.conversationId \},\s*\{\s*reason: textos\.motivoDaPassagem,\s*conversationSummary: buildHandoffSummary\(previous\),\s*inboxTitle: textos\.tituloDaPassagem,\s*avisoAoLead: avisoAoLeadPelaFraseDeEspera\(espera\),/,
    );
    // Nada do envio do modelo: sem fotos, sem bolhas, sem plano da retomada.
    for (const proibido of [
      "fotosDoProduto",
      "enviarComFotos",
      "sendInBubbles",
      "planejarRetomada",
    ]) {
      expect(bloco, proibido).not.toContain(proibido);
    }
  });

  it("o bloco vem DEPOIS do laço do modelo e ANTES de o turno falhar por `runError`/`failed` e da pergunta do roteiro", () => {
    const modelo = TURNO.indexOf("    const turn = await runModelCall(");
    const corte = TURNO.indexOf("turn.corte !== null &&");
    const runError = TURNO.indexOf("if (runError !== null) {", corte);
    const roteiro = TURNO.indexOf("if (roteiro !== null) {", corte);
    expect(modelo).toBeGreaterThan(-1);
    expect(corte).toBeGreaterThan(modelo);
    expect(runError).toBeGreaterThan(corte);
    expect(roteiro).toBeGreaterThan(runError);
  });

  it("os textos: motivo e títulos legíveis, em português, sem código cru nem prazo prometido", () => {
    for (const nome of [
      "MOTIVO_DA_PASSAGEM_POR_CORTE",
      "TITULO_DO_CASO_POR_CORTE",
      "TITULO_DA_PASSAGEM_POR_CORTE",
    ]) {
      const m = TURNO.match(new RegExp(`export const ${nome} =\\s*'([^']+)';`));
      expect(m, nome).not.toBeNull();
      expect(m![1]).toMatch(/cortada/);
      expect(m![1]).not.toMatch(/\b(minutos?|horas?|em breve|logo)\b/i);
      expect(m![1]).not.toMatch(/corte_por|token_budget|_/);
    }
  });
});
