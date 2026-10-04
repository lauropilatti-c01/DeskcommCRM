/**
 * (C01, -c01.3, item 5) RACIOCÍNIO, SEMENTE E VERBOSIDADE FIXOS NO OPENROUTER; PREÇO DOS
 * MODELOS EM USO.
 *
 * O defeito: o modelo do laboratório (`openai/gpt-6.1-sol`) não aceita temperatura, e o
 * que fixaria o comportamento entre rodadas (esforço de raciocínio, semente,
 * verbosidade) não chegava à requisição: `organizations.settings.llm.params` só levava
 * temperatura, topP, topK e teto de saída. E os três modelos em uso pelo OpenRouter não
 * tinham preço em `pricing.ts`: o custo de cada chamada ficava nulo.
 *
 * A correção: a fábrica do OpenRouter põe `reasoning_effort`, `seed` e `verbosity` no
 * corpo quando estão nos params da org; os três modelos ganham preço (US$ por milhão,
 * lista pública da OpenRouter, 04/10/2026). O corpo se prova interceptando o `fetch`
 * (nada sai da máquina); o custo, por `costCents`; a ligação no `runModelCall`, pelo
 * código.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateText, type LanguageModel } from "ai";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function interceptarSaida(): { urls: string[]; corpos: Array<Record<string, unknown>> } {
  const urls: string[] = [];
  const corpos: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as { url: string }).url);
      corpos.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      throw new Error("PARADA_DE_TESTE");
    }),
  );
  return { urls, corpos };
}

async function disparar(model: LanguageModel): Promise<void> {
  await generateText({ model, prompt: "oi", maxRetries: 0 }).catch(() => {});
}

type Registro = Parameters<typeof createDefaultRegistry>[0];

describe("(C01) o corpo da chamada ao OpenRouter", () => {
  it("leva reasoning_effort, seed e verbosity dos params da org — e nenhuma temperatura", async () => {
    const { urls, corpos } = interceptarSaida();
    const opcoes = { openrouterParams: { reasoning_effort: "low", seed: 7, verbosity: "low" } } as Registro;
    await disparar(createDefaultRegistry(opcoes)["openrouter"]!("sk-or-teste", "openai/gpt-6.1-sol"));
    expect(urls[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(corpos[0]).toMatchObject({
      model: "openai/gpt-6.1-sol",
      reasoning_effort: "low",
      seed: 7,
      verbosity: "low",
    });
    expect(corpos[0]?.temperature).toBeUndefined();
    // O resto da chamada continua intacto.
    expect(corpos[0]?.messages).toBeDefined();
  });

  it("só o que está nos params vai: semente sozinha", async () => {
    const { corpos } = interceptarSaida();
    const opcoes = { openrouterParams: { seed: 42 } } as Registro;
    await disparar(createDefaultRegistry(opcoes)["openrouter"]!("sk-or-teste", "openai/gpt-6-luna"));
    expect(corpos[0]?.seed).toBe(42);
    expect(corpos[0]?.reasoning_effort).toBeUndefined();
    expect(corpos[0]?.verbosity).toBeUndefined();
  });

  it("controle: sem params, o corpo não ganha nenhum dos três", async () => {
    const { corpos } = interceptarSaida();
    await disparar(createDefaultRegistry()["openrouter"]!("sk-or-teste", "openai/gpt-6.1-sol"));
    expect(corpos[0]).not.toHaveProperty("reasoning_effort");
    expect(corpos[0]).not.toHaveProperty("seed");
    expect(corpos[0]).not.toHaveProperty("verbosity");
  });

  it("controle: a OpenAI direta não herda os params do OpenRouter", async () => {
    vi.stubEnv("OPENAI_REASONING_EFFORT", "");
    const { corpos } = interceptarSaida();
    const opcoes = { openrouterParams: { reasoning_effort: "low", seed: 7, verbosity: "low" } } as Registro;
    await disparar(createDefaultRegistry(opcoes)["openai"]!("sk-de-teste", "gpt-6-luna"));
    expect(corpos[0]).not.toHaveProperty("reasoning_effort");
    expect(corpos[0]).not.toHaveProperty("verbosity");
  });
});

describe("(C01) o preço dos modelos em uso pelo OpenRouter (US$ por milhão)", () => {
  const MILHAO = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it("Sol 2 / 10 / 0,10; Luna 0,10 / 0,50 / 0,01; Haiku 4.5 1 / 5 / 0,10 (em centavos)", () => {
    expect(costCents("openai/gpt-6.1-sol", MILHAO)).toBeCloseTo(1200, 6);
    expect(costCents("openai/gpt-6-luna", MILHAO)).toBeCloseTo(60, 6);
    expect(costCents("anthropic/claude-haiku-4.5", MILHAO)).toBeCloseTo(600, 6);
  });

  it("o cache lido sai pelo preço dele", () => {
    const meioCache = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 500_000, cacheWriteTokens: 0 };
    // Sol: 500 mil a US$ 2 + 500 mil a US$ 0,10 = US$ 1,05.
    expect(costCents("openai/gpt-6.1-sol", meioCache)).toBeCloseTo(105, 6);
    // Luna: 500 mil a US$ 0,10 + 500 mil a US$ 0,01 = US$ 0,055.
    expect(costCents("openai/gpt-6-luna", meioCache)).toBeCloseTo(5.5, 6);
    // Haiku: 500 mil a US$ 1 + 500 mil a US$ 0,10 = US$ 0,55.
    expect(costCents("anthropic/claude-haiku-4.5", meioCache)).toBeCloseTo(55, 6);
  });
});

describe("(C01) a ligação no runModelCall, pelo código", () => {
  const FONTE = readFileSync("lib/agent-engine/edge/llm/run-model-call.ts", "utf8");

  it("os params da org aceitam os três, com os valores que a API conhece", () => {
    expect(FONTE).toMatch(/reasoning_effort: z\.enum\(\['none', 'minimal', 'low', 'medium', 'high', 'xhigh'\]\)\.optional\(\),/);
    expect(FONTE).toMatch(/seed: z\.number\(\)\.int\(\)\.optional\(\),/);
    expect(FONTE).toMatch(/verbosity: z\.enum\(\['low', 'medium', 'high'\]\)\.optional\(\),/);
  });

  it("o registry nasce depois da leitura dos params e os passa ao OpenRouter", () => {
    const parse = FONTE.indexOf("const parsedParams = paramsSchema.safeParse(config.params);");
    const registro = FONTE.indexOf("createDefaultRegistry({");
    expect(parse).toBeGreaterThan(-1);
    expect(registro).toBeGreaterThan(parse);
    expect(FONTE.match(/createDefaultRegistry\(/g)).toHaveLength(1);
    expect(FONTE).toMatch(
      /openrouterParams: \{\s*\.\.\.\(reasoning_effort !== undefined \? \{ reasoning_effort \} : \{\}\),\s*\.\.\.\(seed !== undefined \? \{ seed \} : \{\}\),\s*\.\.\.\(verbosity !== undefined \? \{ verbosity \} : \{\}\),\s*\},/,
    );
  });
});
