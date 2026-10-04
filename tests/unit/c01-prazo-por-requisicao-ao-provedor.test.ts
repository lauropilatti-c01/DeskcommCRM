/**
 * (C01, -c01.3, item 1a) CADA REQUISIÇÃO AO PROVEDOR TEM PRAZO PRÓPRIO.
 *
 * O defeito (C41, volta 19-A2): o único prazo das chamadas de modelo era o da
 * execução (`prazoDasChamadas`, lease − 60 s = 540 s). Uma requisição que pendura
 * comia os nove minutos inteiros antes de cair — duas chamadas de ~536 s seguidas
 * gastaram as tentativas do job com o lead sem resposta.
 *
 * O que se prova aqui, com `fetch` falso e relógio falso (nenhuma rede, nenhum
 * modelo de verdade):
 *   - a requisição pendurada da OpenRouter (fábrica real, `fetch` interceptado) cai
 *     em 120 s, não antes e não em 540 s; o `fetch` recebe o abortamento; a falha
 *     sai de `runModelCall` com nome de abortamento (o SDK não a repete) e fica
 *     gravada em `llm_calls`;
 *   - um provedor que ignora o sinal cai no mesmo prazo (corrida com o relógio);
 *   - o prazo é por requisição: duas etapas de 100 s cada passam;
 *   - o prazo vem do ambiente (`LLM_REQUEST_TIMEOUT_MS`, padrão 120 s).
 */
import { tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { loadEnv } from "@/lib/agent-engine/env";
import { llmEdgeConfigFromEnv, runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function poolDoModelo(provider: string, modelo: string) {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: { provider, default_model: modelo, params: {}, enabled_models: [], monthly_budget_cents: null },
          },
        ],
      };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

const entrada = {
  tenantId: ORG,
  leadId: LEAD,
  jobId: JOB,
  purpose: "agent_turn",
  messages: [{ role: "user" as const, content: "oi" }],
};

/** `fetch` falso que nunca responde: só cai quando o sinal da requisição aborta, com a razão dele. */
function fetchQuePendura() {
  const abortados: unknown[] = [];
  let chamadas = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
      chamadas += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            abortados.push(init.signal!.reason);
            reject(init.signal!.reason);
          },
          { once: true },
        );
      });
    }),
  );
  return { abortados, chamadas: () => chamadas };
}

/** Acompanha a promessa sem deixar a rejeição solta. */
function acompanhar<T>(p: Promise<T>) {
  const estado: { fim: "pendente" | "ok" | "erro"; erro?: unknown } = { fim: "pendente" };
  p.then(
    () => (estado.fim = "ok"),
    (e: unknown) => {
      estado.fim = "erro";
      estado.erro = e;
    },
  );
  return estado;
}

describe("(C01) a requisição pendurada cai no prazo dela, não no da execução", () => {
  it("OpenRouter de verdade, fetch pendurado: nada até 120 s; em 120 s cai, o fetch é abortado e a falha fica gravada", async () => {
    vi.useFakeTimers();
    const rede = fetchQuePendura();
    const { pool, inserts } = poolDoModelo("openrouter", "openai/gpt-6.1-sol");
    const cfg = llmEdgeConfigFromEnv({ OPENROUTER_API_KEY: "sk-or-de-teste" });
    const chamada = acompanhar(runModelCall(pool, cfg, entrada));

    await vi.advanceTimersByTimeAsync(119_999);
    expect(rede.chamadas()).toBe(1);
    expect(chamada.fim).toBe("pendente");

    await vi.advanceTimersByTimeAsync(1);
    expect(chamada.fim).toBe("erro");
    const erro = chamada.erro as Error;
    // Nome de abortamento: o SDK relança na hora, sem repetir a requisição.
    expect(erro.name).toBe("TimeoutError");
    expect(erro.message).toMatch(/timeout/);
    expect(erro.message).toContain("120000 ms");
    expect(rede.abortados).toHaveLength(1);
    expect(rede.chamadas()).toBe(1);
    // A falha fica em llm_calls (status 'erro'), como toda falha do seam.
    const falha = inserts.find((i) => i.sql.includes("'erro'"));
    expect(falha).toBeDefined();
  });

  it("muito antes dos 540 s do prazo da execução: com 5 min de relógio, a chamada já tinha caído aos 2 min", async () => {
    vi.useFakeTimers();
    fetchQuePendura();
    const { pool } = poolDoModelo("openrouter", "openai/gpt-6.1-sol");
    const cfg = llmEdgeConfigFromEnv({ OPENROUTER_API_KEY: "sk-or-de-teste" });
    const inicio = Date.now();
    let caiuEm: number | null = null;
    const chamada = runModelCall(pool, cfg, entrada).catch(() => {
      caiuEm = Date.now() - inicio;
    });
    await vi.advanceTimersByTimeAsync(300_000);
    await chamada;
    expect(caiuEm).toBe(120_000);
  });

  it("um provedor que IGNORA o sinal cai no mesmo prazo (corrida com o relógio)", async () => {
    vi.useFakeTimers();
    const { pool } = poolDoModelo("anthropic", "claude-padrao");
    const surdo = () =>
      ({
        specificationVersion: "v3",
        provider: "anthropic",
        modelId: "claude-padrao",
        doGenerate: () => new Promise(() => {}),
      }) as never;
    const chamada = acompanhar(
      runModelCall(pool, { anthropicApiKey: "sk-ant-x", cacheTtl: "1h" }, entrada, { registry: { anthropic: surdo } }),
    );
    await vi.advanceTimersByTimeAsync(119_999);
    expect(chamada.fim).toBe("pendente");
    await vi.advanceTimersByTimeAsync(1);
    expect(chamada.fim).toBe("erro");
    expect((chamada.erro as Error).name).toBe("TimeoutError");
  });

  it("é por requisição: duas etapas de 100 s cada (200 s no total) passam", async () => {
    vi.useFakeTimers();
    const { pool } = poolDoModelo("anthropic", "claude-padrao");
    let etapa = 0;
    const lento = () =>
      ({
        specificationVersion: "v3",
        provider: "anthropic",
        modelId: "claude-padrao",
        doGenerate: async () => {
          etapa += 1;
          await new Promise((r) => setTimeout(r, 100_000));
          const usage = {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          };
          if (etapa === 1) {
            return {
              content: [{ type: "tool-call", toolCallId: "c1", toolName: "consulta", input: JSON.stringify({ q: "x" }) }],
              finishReason: { unified: "tool-calls", raw: undefined },
              usage,
              warnings: [],
            };
          }
          return { content: [{ type: "text", text: "fim" }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
        },
      }) as never;
    const consulta = tool({
      description: "consulta de teste",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => ({ ok: true }),
    });
    const chamada = acompanhar(
      runModelCall(
        pool,
        { anthropicApiKey: "sk-ant-x", cacheTtl: "1h" },
        { ...entrada, tools: { consulta }, maxSteps: 5 },
        { registry: { anthropic: lento } },
      ),
    );
    await vi.advanceTimersByTimeAsync(250_000);
    expect(chamada.fim).toBe("ok");
    expect(etapa).toBe(2);
  });
});

describe("(C01) o prazo vem do ambiente do worker", () => {
  const base = {
    SUPABASE_DB_URL: "postgres://u:p@localhost:5432/db",
    NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
    SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
  };

  it("LLM_REQUEST_TIMEOUT_MS: padrão 120 s; o valor do ambiente chega à config do seam", () => {
    expect(llmEdgeConfigFromEnv(loadEnv({ ...base } as unknown as NodeJS.ProcessEnv)).prazoPorRequisicaoMs).toBe(120_000);
    expect(
      llmEdgeConfigFromEnv(loadEnv({ ...base, LLM_REQUEST_TIMEOUT_MS: "30000" } as unknown as NodeJS.ProcessEnv))
        .prazoPorRequisicaoMs,
    ).toBe(30_000);
  });

  it("o valor configurado é o que vale na requisição (30 s)", async () => {
    vi.useFakeTimers();
    fetchQuePendura();
    const { pool } = poolDoModelo("openrouter", "openai/gpt-6.1-sol");
    const cfg = llmEdgeConfigFromEnv(
      loadEnv({ ...base, OPENROUTER_API_KEY: "sk-or-de-teste", LLM_REQUEST_TIMEOUT_MS: "30000" } as unknown as NodeJS.ProcessEnv),
    );
    const chamada = acompanhar(runModelCall(pool, cfg, entrada));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(chamada.fim).toBe("pendente");
    await vi.advanceTimersByTimeAsync(1);
    expect(chamada.fim).toBe("erro");
    expect((chamada.erro as Error).message).toContain("30000 ms");
  });
});
