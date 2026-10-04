/**
 * (C01) AS CHAMADAS DE MODELO ACABAM ANTES DO LEASE — a correção 2 do caso C54.
 *
 * O lease do job dura `QUEUE_VISIBILITY_TIMEOUT_MS` (600 s) e o reaper passa a
 * cada 60 s. Nada impedia uma execução de ficar mais tempo que isso numa chamada
 * de modelo (ou num laço de ferramentas sem fim): o reaper devolvia o job, outra
 * execução começava, e a primeira seguia falando. Dois freios entram aqui:
 *
 *   1. PRAZO: `withServiceJob(..., { leaseMs })` arma um relógio menor que o
 *      lease (`prazoDasChamadas`) e aborta o sinal da execução quando ele vence.
 *      `runModelCall` lê esse sinal em TODA chamada do job (principal e
 *      auxiliares) — a que está em voo cai, e nenhuma nova começa. O erro é
 *      `PrazoDaExecucaoVencidoError`, que NÃO é fronteira obsoleta: a execução
 *      ainda é dona do lease, e o worker devolve o job à fila para re-tentar.
 *   2. TETO DE TOKENS: o `token_budget` da versão publicada (campo que já
 *      existia na tela e no runtime antigo, mas o motor nunca lia) vira condição
 *      de parada do laço de ferramentas, como já era `maxSteps`.
 *
 * O teto por chamada (`maxOutputTokens`) era só o da organização. Desde a -c01.3 o
 * turno do agente também passa o seu (`AGENT_MAX_OUTPUT_TOKENS`, padrão 8.000; o da
 * organização, quando menor, vence) — ver `c01-teto-de-saida-e-teto-sem-cache.test.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  combinarSinais,
  pararPorTetoDeTokens,
  runModelCall,
  tokensDasEtapas,
} from "@/lib/agent-engine/edge/llm/run-model-call";
import type { JobRow, Queryable } from "@/lib/agent-engine/queue/queue";
import {
  PrazoDaExecucaoVencidoError,
  type CurrentServiceBoundary,
} from "@/lib/atendimento/fronteira";
import {
  guardServiceTools,
  MARGEM_DO_LEASE_MS,
  prazoDasChamadas,
  sinalDaExecucao,
  withServiceJob,
} from "@/lib/atendimento/fronteira-server";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const CLAIM = "2026-09-28 12:00:00.123456+00";

const fronteira: CurrentServiceBoundary = {
  organization_id: ORG,
  contact_id: LEAD,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
  status: "ai_handling",
  demanda_fechada_em: null,
};

const job = {
  id: JOB,
  organization_id: ORG,
  contact_id: LEAD,
  kind: "inbound_turn",
  payload: { service_boundary: fronteira },
  locked_by: "w1",
  claim_acquired_at: CLAIM,
} as unknown as JobRow;

/** Banco da execução: a fronteira está em pé e o lease é SEMPRE desta execução. */
const dbDaExecucao = {
  query: async (sql: string) => {
    if (sql.includes("from job_queue")) return { rows: [{ lease: 1 }], rowCount: 1 };
    if (sql.includes("from conversations c")) return { rows: [fronteira], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  },
} as unknown as Queryable;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function poolDoModelo() {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
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
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "call-1" }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, inserts };
}

/** Modelo falso que fica em voo até o sinal abortar — e cai com a razão dele. */
function modeloQueEsperaOAborto() {
  const chamadas: number[] = [];
  const fabrica = () =>
    ({
      specificationVersion: "v3",
      provider: "anthropic",
      modelId: "claude-padrao",
      doGenerate: async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
        chamadas.push(Date.now());
        if (!abortSignal) throw new Error("o seam não repassou o sinal ao provedor");
        if (abortSignal.aborted) throw abortSignal.reason;
        return new Promise((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
        });
      },
    }) as never;
  return { chamadas, registry: { anthropic: fabrica } };
}

const cfg = { anthropicApiKey: "sk-ant-x", cacheTtl: "1h" } as const;
const entrada = {
  tenantId: ORG,
  leadId: LEAD,
  jobId: JOB,
  purpose: "agent_turn",
  messages: [{ role: "user" as const, content: "oi" }],
};

describe("(C01) prazo das chamadas de modelo menor que o lease", () => {
  it("o prazo fica abaixo do lease por uma margem, e nunca abaixo da metade dele", () => {
    expect(MARGEM_DO_LEASE_MS).toBe(60_000);
    // Os valores de produção: lease de 600 s, reaper a cada 60 s.
    expect(prazoDasChamadas(600_000)).toBe(540_000);
    // Lease curto: a margem inteira deixaria menos da metade — fica a metade.
    expect(prazoDasChamadas(90_000)).toBe(45_000);
    expect(prazoDasChamadas(120_000)).toBe(60_000);
    for (const lease of [10_000, 60_000, 120_000, 300_000, 600_000, 3_600_000]) {
      expect(prazoDasChamadas(lease)).toBeLessThan(lease);
      expect(prazoDasChamadas(lease)).toBeGreaterThan(0);
    }
  });

  it("vencido o prazo, o sinal da execução dispara, o lease continua da execução e nenhuma chamada nova começa", async () => {
    const { pool, inserts } = poolDoModelo();
    const modelo = modeloQueEsperaOAborto();
    await withServiceJob(
      dbDaExecucao,
      job,
      async () => {
        expect(sinalDaExecucao()?.aborted).toBe(false);
        await sleep(260);
        const sinal = sinalDaExecucao()!;
        expect(sinal.aborted).toBe(true);
        expect(sinal.reason).toBeInstanceOf(PrazoDaExecucaoVencidoError);
        // leaseMs 200 → a margem de 60 s não cabe: fica a metade, 100 ms.
        expect((sinal.reason as Error).message).toBe(`prazo_da_execucao_vencido:${JOB}:100ms`);

        // Não é lease perdido: um efeito cercado ainda passa (a execução é dona).
        const tools = guardServiceTools({
          send_message: { inputSchema: {} as never, execute: async () => ({ ok: true }) },
        } as never)!;
        await expect(tools.send_message!.execute!({}, {} as never)).resolves.toEqual({ ok: true });

        // Mas nenhuma chamada de modelo começa — nem a principal, nem auxiliar.
        await expect(
          runModelCall(pool, cfg, entrada, { registry: modelo.registry }),
        ).rejects.toBeInstanceOf(PrazoDaExecucaoVencidoError);
        await expect(
          runModelCall(pool, cfg, { ...entrada, purpose: "checkpoint" }, { registry: modelo.registry }),
        ).rejects.toBeInstanceOf(PrazoDaExecucaoVencidoError);
        expect(modelo.chamadas).toEqual([]);
        // A falha deixa rastro em llm_calls, como qualquer outra.
        expect(inserts).toHaveLength(2);
      },
      { leaseMs: 200 },
    );
  });

  it("a chamada em voo cai no instante do prazo, com a razão do prazo", async () => {
    const { pool } = poolDoModelo();
    const modelo = modeloQueEsperaOAborto();
    const inicio = Date.now();
    await withServiceJob(
      dbDaExecucao,
      job,
      async () => {
        await expect(
          runModelCall(pool, cfg, entrada, { registry: modelo.registry }),
        ).rejects.toBeInstanceOf(PrazoDaExecucaoVencidoError);
        expect(modelo.chamadas).toHaveLength(1);
        expect(sinalDaExecucao()!.reason).toBeInstanceOf(PrazoDaExecucaoVencidoError);
      },
      { leaseMs: 400 },
    );
    // leaseMs 400 → prazo 200 ms (metade): a chamada não voltou antes disso.
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(190);
  });

  it("sem leaseMs não há prazo (entrega transacional, resposta aprovada, testes antigos)", async () => {
    await withServiceJob(dbDaExecucao, job, async () => {
      await sleep(120);
      expect(sinalDaExecucao()?.aborted).toBe(false);
    });
  });

  it("combinarSinais: ausentes somem, um só volta ele mesmo, dois disparam juntos com a razão do primeiro", () => {
    expect(combinarSinais(undefined, undefined)).toBeUndefined();
    const a = new AbortController();
    expect(combinarSinais(a.signal, undefined)).toBe(a.signal);
    const b = new AbortController();
    const ambos = combinarSinais(a.signal, b.signal)!;
    expect(ambos.aborted).toBe(false);
    const razao = new PrazoDaExecucaoVencidoError(JOB, 1);
    b.abort(razao);
    expect(ambos.aborted).toBe(true);
    expect(ambos.reason).toBe(razao);
  });

  it("a fiação: o worker passa o visibility timeout e o seam combina o sinal da execução", () => {
    const worker = readFileSync("workers/agent-worker/main.ts", "utf8");
    expect(worker).toMatch(/withServiceJob\(pool, job, [^;]*\{\s*leaseMs:\s*env\.QUEUE_VISIBILITY_TIMEOUT_MS,?\s*\}/s);
    const seam = readFileSync("lib/agent-engine/edge/llm/run-model-call.ts", "utf8");
    expect(seam).toMatch(/combinarSinais\(input\.abortSignal,\s*sinalDaExecucao\(\)\)/);
    expect(seam).toMatch(/abortSignal\?\.throwIfAborted\(\);\s*(?:\/\/[^\n]*\n\s*)*result = await generateText\(/);
  });
});

describe("(C01) teto de tokens da versão como condição de parada do laço", () => {
  it("soma entrada e saída de todas as etapas; etapa sem uso conta zero", () => {
    expect(tokensDasEtapas([])).toBe(0);
    expect(
      tokensDasEtapas([
        { usage: { inputTokens: 1_000, outputTokens: 200 } },
        {},
        { usage: { inputTokens: 3_000 } },
        { usage: { outputTokens: 50 } },
      ]),
    ).toBe(4_250);
  });

  it("para quando o acumulado PASSA do teto (no teto ainda segue) e avisa uma vez só", () => {
    const avisos: Array<Record<string, unknown>> = [];
    const log = { warn: (_m: string, campos: Record<string, unknown>) => void avisos.push(campos) } as never;
    const parar = pararPorTetoDeTokens(5_000, log);
    const etapa = (tokens: number) => ({ usage: { inputTokens: tokens, outputTokens: 0 } });
    expect(parar({ steps: [etapa(2_000)] })).toBe(false);
    expect(parar({ steps: [etapa(2_000), etapa(3_000)] })).toBe(false);
    expect(avisos).toEqual([]);
    expect(parar({ steps: [etapa(2_000), etapa(3_000), etapa(1)] })).toBe(true);
    expect(parar({ steps: [etapa(2_000), etapa(3_000), etapa(1), etapa(1)] })).toBe(true);
    expect(avisos).toEqual([{ teto: 5_000, gastos: 5_001, etapas: 3 }]);
  });

  it("a fiação: a versão publicada carrega token_budget e o turno o passa ao seam, que o põe no stopWhen", () => {
    const config = readFileSync("lib/agent-engine/agent/agent-config.ts", "utf8");
    expect(config).toMatch(/v\.token_budget/);
    expect(config).toMatch(/tokenBudget:\s*r\.token_budget\s*\?\?\s*50_000/);
    const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    expect(turno).toMatch(/tetoDeTokensDoTurno:\s*agentConfig\.tokenBudget/);
    const seam = readFileSync("lib/agent-engine/edge/llm/run-model-call.ts", "utf8");
    expect(seam).toMatch(/stopWhen:[\s\S]*?pararPorTetoDeTokens\(input\.tetoDeTokensDoTurno/);
  });
});
