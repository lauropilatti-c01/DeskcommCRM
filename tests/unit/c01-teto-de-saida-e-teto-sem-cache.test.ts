/**
 * (C01, -c01.3, item 1b) TETO DE SAÍDA POR ETAPA E `token_budget` CONTANDO SÓ O QUE É NOVO.
 *
 * Os dois defeitos (C01.md, "Limite desta versão — o `token_budget` da versão corta
 * turnos normais quando o prompt é grande"):
 *   1. o turno do agente não tinha teto de saída por requisição: uma etapa podia
 *      gerar sem fim (C54: 66 mil tokens de saída numa etapa só, 1.033 s), e o
 *      `token_budget` só é avaliado ENTRE etapas;
 *   2. o `token_budget` somava entrada + saída de cada etapa, e cada etapa reenvia o
 *      prompt inteiro: com o prompt da C01 (~21.700 tokens por etapa, quase todo lido
 *      do cache) o padrão do autor (50.000) cortava o laço na 3ª etapa, antes do
 *      `send_message` (volta 19-A, 7 de 7 conversas passadas à equipe no 1º turno).
 *
 * A correção: `AGENT_MAX_OUTPUT_TOKENS` (padrão 8.000) vai a cada requisição do turno
 * (o da organização, quando menor, vence); e o teto conta saída + entrada fora do cache.
 */
import { readFileSync } from "node:fs";
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";
import { loadEnv } from "@/lib/agent-engine/env";
import {
  pararPorTetoDeTokens,
  runModelCall,
  tokensDasEtapas,
} from "@/lib/agent-engine/edge/llm/run-model-call";

const ORG = "11111111-1111-4111-8111-111111111111";
const base = {
  SUPABASE_DB_URL: "postgres://u:p@localhost:5432/db",
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
};

function poolDoModelo(params: Record<string, unknown> = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: { provider: "anthropic", default_model: "claude-padrao", params, enabled_models: [], monthly_budget_cents: null },
          },
        ],
      };
    }
    if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-1" }] };
    return { rows: [] };
  });
  return { query } as never;
}

/** Uso de uma etapa no formato do provedor (V3), com a parte lida do cache. */
const uso = (entrada: number, doCache: number, saida: number) => ({
  inputTokens: { total: entrada, noCache: entrada - doCache, cacheRead: doCache, cacheWrite: 0 },
  outputTokens: { total: saida, text: saida, reasoning: 0 },
});

/** Modelo falso que consulta a ferramenta `consulta` em cada etapa até esgotar `usos`, e anota as opções recebidas. */
function modeloQueConsulta(usos: Array<ReturnType<typeof uso>>) {
  const estado = { etapas: 0, maxOutputTokens: [] as Array<number | undefined> };
  const fabrica = () =>
    ({
      specificationVersion: "v3",
      provider: "anthropic",
      modelId: "claude-padrao",
      doGenerate: async (opcoes: { maxOutputTokens?: number }) => {
        estado.maxOutputTokens.push(opcoes.maxOutputTokens);
        const u = usos[estado.etapas];
        estado.etapas += 1;
        if (u === undefined) {
          return { content: [{ type: "text", text: "fim" }], finishReason: { unified: "stop", raw: undefined }, usage: uso(1, 0, 1), warnings: [] };
        }
        return {
          content: [{ type: "tool-call", toolCallId: `c${estado.etapas}`, toolName: "consulta", input: JSON.stringify({ q: "x" }) }],
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
  execute: async () => ({ ok: true }),
});
const cfg = { anthropicApiKey: "sk-ant-x", cacheTtl: "1h" } as const;
const entrada = {
  tenantId: ORG,
  purpose: "agent_turn",
  messages: [{ role: "user" as const, content: "oi" }],
  tools: { consulta },
};

describe("(C01) teto de saída por requisição no turno do agente", () => {
  it("AGENT_MAX_OUTPUT_TOKENS: padrão 8.000, configurável, e chega ao knob do turno", () => {
    expect(turnKnobsFromEnv(loadEnv({ ...base } as unknown as NodeJS.ProcessEnv)).maxOutputTokens).toBe(8_000);
    expect(
      turnKnobsFromEnv(loadEnv({ ...base, AGENT_MAX_OUTPUT_TOKENS: "4000" } as unknown as NodeJS.ProcessEnv)).maxOutputTokens,
    ).toBe(4_000);
  });

  it("a fiação: a chamada principal do turno passa o knob ao seam", () => {
    const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    const chamada = turno.slice(turno.indexOf("const turn = await runModelCall("));
    expect(chamada.slice(0, 4_000)).toMatch(/maxOutputTokens:\s*deps\.knobs\.maxOutputTokens/);
  });

  it("o valor chega ao generateText de CADA etapa; o da organização, quando menor, vence", async () => {
    const semOrg = modeloQueConsulta([uso(10, 0, 1), uso(10, 0, 1)]);
    await runModelCall(poolDoModelo(), cfg, { ...entrada, maxSteps: 5, maxOutputTokens: 8_000 }, { registry: semOrg.registry });
    expect(semOrg.estado.maxOutputTokens).toEqual([8_000, 8_000, 8_000]);

    const orgMenor = modeloQueConsulta([uso(10, 0, 1)]);
    await runModelCall(poolDoModelo({ maxOutputTokens: 2_000 }), cfg, { ...entrada, maxSteps: 5, maxOutputTokens: 8_000 }, { registry: orgMenor.registry });
    expect(orgMenor.estado.maxOutputTokens).toEqual([2_000, 2_000]);
  });
});

describe("(C01) o token_budget conta só o que é novo (saída + entrada fora do cache)", () => {
  it("a entrada lida do cache sai da conta; sem detalhe de cache conta a entrada inteira, como antes", () => {
    expect(
      tokensDasEtapas([
        { usage: { inputTokens: 21_700, outputTokens: 300, inputTokenDetails: { cacheReadTokens: 21_000 } } },
        { usage: { inputTokens: 22_000, outputTokens: 200, inputTokenDetails: { cacheReadTokens: 21_700 } } },
      ]),
    ).toBe(700 + 300 + 300 + 200);
    expect(tokensDasEtapas([{ usage: { inputTokens: 1_000, outputTokens: 200 } }])).toBe(1_200);
    // Nunca negativo, mesmo com um provedor que relate mais cache que entrada.
    expect(tokensDasEtapas([{ usage: { inputTokens: 10, outputTokens: 0, inputTokenDetails: { cacheReadTokens: 50 } } }])).toBe(0);
  });

  it("o caso da volta 19-A: prompt de ~21.700 tokens quase todo do cache, teto 50.000 — 5 etapas não cortam", () => {
    const etapa = { usage: { inputTokens: 21_700, outputTokens: 300, inputTokenDetails: { cacheReadTokens: 21_000 } } };
    const parar = pararPorTetoDeTokens(50_000);
    expect(parar({ steps: [etapa, etapa, etapa] })).toBe(false);
    expect(parar({ steps: [etapa, etapa, etapa, etapa, etapa] })).toBe(false);
  });

  it("pelo seam: o laço de 4 consultas com cache chega ao fim, sem corte", async () => {
    const modelo = modeloQueConsulta([uso(21_700, 21_000, 300), uso(21_700, 21_000, 300), uso(21_700, 21_000, 300), uso(21_700, 21_000, 300)]);
    const r = await runModelCall(
      poolDoModelo(),
      cfg,
      { ...entrada, maxSteps: 14, tetoDeTokensDoTurno: 50_000 },
      { registry: modelo.registry },
    );
    expect(r.corte).toBeNull();
    expect(modelo.estado.etapas).toBe(5);
  });

  it("o que é novo continua contando: entrada sem cache passa do teto e corta", async () => {
    const modelo = modeloQueConsulta([uso(30_000, 0, 300), uso(30_000, 0, 300), uso(30_000, 0, 300)]);
    const r = await runModelCall(
      poolDoModelo(),
      cfg,
      { ...entrada, maxSteps: 14, tetoDeTokensDoTurno: 50_000 },
      { registry: modelo.registry },
    );
    expect(r.corte).toMatchObject({ motivo: "corte_por_teto_de_tokens", teto: 50_000, gastos: 60_600, etapas: 2 });
  });
});
