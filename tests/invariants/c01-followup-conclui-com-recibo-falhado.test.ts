import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type * as FollowupTurn from "@/lib/agent-engine/agent/followup-turn";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as SendLedger from "@/lib/agent-engine/edge/crm/send-ledger";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as Claim from "@/lib/agent-engine/queue/claim";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as Engine from "@/lib/followup/engine";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import type * as TurnBridge from "@/lib/followup/turn-bridge";

import { criarOrigemDeFollowup } from "./followup-service-origin";
import { isolarFixtureDeFollowup } from "./followup-isolamento";
import { relogioAncoradoNoBanco } from "./followup-relogio";

/**
 * (C01) O FOLLOW-UP POR IA CONCLUI O PASSO DEPOIS DE UM RECIBO FALHADO — a regressão de
 * fluxo completo que a sexta revisão adversarial do Codex (03/10/2026) pediu para o
 * achado 2 (alto), rodada 7, correção 2.
 *
 * O caminho é o de produção: o tick do motor enfileira o turno de `send_message` do nó
 * `ai_message`; o worker reivindica o job; o handler real (`createFollowupTurnHandler`)
 * roda o turno da IA com um modelo falso e um canal falso que passa pelo `send_ledger`
 * REAL (como o adapter WAHA); ao fim, `resultadoDoEnvioDoFollowup` lê o ledger e
 * `completeFollowupTurn` — a ponte de verdade, `completeTurnForEnrollment` — avança o
 * enrollment. Postgres real.
 *
 * O cenário: a 1ª execução manda A, B e C; o canal FALHA A (o CRM marca a mensagem
 * `failed`) e aceita B e C. O turno do autor falha o job na hora ("envio marcado como
 * failed pelo CRM — run re-tentado pela fila", F2-06): o job volta à fila — "failed:
 * retry = tentativa lógica nova". A re-execução regenera A, B e C. Até a rodada 6, a
 * posição continuava da maior aceita: A nascia na posição 4, o 'failed' ficava na 1
 * para sempre, e o agregador do follow-up — que exige todos os recibos aceitos —
 * lançava `followup_message_not_sent` em TODA re-execução: `completeFollowupTurn` nunca
 * rodava, os retries esgotavam e o fluxo não avançava — com o cliente tendo recebido
 * tudo. Agora A toma a posição 1 (o recibo falhado cede a posição, pelo `rotate` de
 * sempre), B e C não saem de novo, o ledger fica todo aceito, e o passo conclui: o
 * enrollment avança para o fim do fluxo.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

const WORKER = "c01-followup-falhado";
/** O instante do turno: dentro da janela de DISPARO do anti-ban (quinta-feira, 12h em Brasília). */
const AGORA = new Date("2026-07-30T15:00:00Z");
const TETO = 3;

const A = "Oi! Vi que você perguntou sobre o plano.";
const B = "Ele inclui o material e o acesso à plataforma.";
const C = "Quer que eu te mande o link para começar?";
/** A reescrita de A na re-execução: o modelo raramente regenera o texto idêntico. */
const A2 = "Olá! Passando para retomar a sua pergunta sobre o plano.";

type Modules = {
  followup: typeof FollowupTurn;
  turno: typeof InboundTurn;
  ledger: typeof SendLedger;
  queue: typeof Queue;
  claim: typeof Claim;
  engine: typeof Engine;
  bridge: typeof TurnBridge;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

/** O que o CRM falso recebeu (na ordem): a chave do recibo e o corpo. */
let entregues: Array<{ key: string; body: string }> = [];
/** Corpos que o CRM falso marca `failed` — uma vez cada (a 1ª execução falha A). */
let falham = new Set<string>();

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});
const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** Modelo falso que manda os textos dados (um por etapa) e depois encerra. */
function modeloQueManda(textos: readonly string[]) {
  const estado = { etapas: 0, checkpoints: 0, resultados: new Map<string, string>() };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result")
          estado.resultados.set(String(parte.toolCallId), JSON.stringify(parte.output ?? parte));
      }
    }
    const ultima = msgs[msgs.length - 1];
    const pedeCheckpoint =
      ultima?.role === "user" &&
      Array.isArray(ultima.content) &&
      (ultima.content as Array<Record<string, unknown>>).some(
        (p) => p.type === "text" && p.text === m.turno.CHECKPOINT_INSTRUCTION,
      );
    if (pedeCheckpoint) {
      estado.checkpoints += 1;
      return {
        content: [{ type: "text" as const, text: CHECKPOINT }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    estado.etapas += 1;
    const body = textos[estado.etapas - 1];
    if (body === undefined) {
      return {
        content: [{ type: "text" as const, text: "ok" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${estado.etapas}`,
          toolName: "send_message",
          input: JSON.stringify({ body }),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
  return { doGenerate, estado };
}

/**
 * O handler do `followup_turn` como `workers/agent-worker/main.ts` o monta: a ponte de
 * verdade em `completeFollowupTurn` (espionada), o canal falso pelo ledger real.
 */
function montaHandler(doGenerate: unknown) {
  const store = m.ledger.pgSendLedger(pool);
  const complete = vi.fn(
    async (
      p: pg.Pool,
      i: {
        organizationId: string;
        enrollmentId: string;
        nodeId: string;
        jobId?: string;
        jobClaim?: Claim.JobClaim;
        result: FollowupTurn.FollowupFlowTurnResult;
      },
    ) => {
      await m.bridge.completeTurnForEnrollment(
        m.bridge.createPgAdminClient(p),
        i.organizationId,
        i.enrollmentId,
        i.nodeId,
        i.result,
        undefined,
        i.jobId,
        i.jobClaim,
      );
    },
  );
  const handler = m.followup.createFollowupTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 20,
      maxContextTokens: 4000,
      notesIndexMaxTokens: 500,
      maxSteps: 8,
      maxSendsPerTurn: TETO,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
      followupAi: { model: "claude-sonnet-4-6" },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "ledger-real",
        send: async (i: {
          tenantId: string;
          leadId: string | null;
          jobId: string;
          seq: number;
          body: string;
          identidade?: string;
        }) => {
          const outcome = await m.ledger.sendWithLedger(
            store,
            {
              tenantId: i.tenantId,
              leadId: i.leadId,
              jobId: i.jobId,
              seq: i.seq,
              body: i.body,
              // A identidade do envio, quando o turno a declara (o adapter real a repassa).
              ...(i.identidade !== undefined ? { identidade: i.identidade } : {}),
            },
            async (key, messageId) => {
              entregues.push({ key, body: i.body });
              // O CRM falso: marca `failed` o corpo que o caso pediu (uma vez), `sent` o resto.
              if (falham.delete(i.body)) return { id: messageId, status: "failed" };
              return { id: messageId, status: "sent" };
            },
          );
          if (outcome.kind === "blocked") return outcome;
          return {
            kind: outcome.kind,
            idempotencyKey: outcome.idempotencyKey,
            messageId: outcome.crmMessageId,
          };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => AGORA,
    sleep: async () => {},
    completeFollowupTurn: complete,
  });
  return { handler, complete };
}

// ---- o fluxo: um nó de mensagem pela IA e o fim ----
const P = { x: 0, y: 0 };
const GRAFO: FlowGraph = {
  nodes: [
    {
      id: "a1",
      type: "action",
      label: "Retomar",
      position: P,
      config: { mode: "ai_message", prompt_hint: "retome a conversa sobre o plano" },
    },
    { id: "e1", type: "end", label: "Fim", position: P, config: { outcome: "converted" } },
  ],
  edges: [{ id: "a1-e1", source: "a1", target: "e1", priority: 0, condition: { type: "always" } }],
};

interface Cenario {
  org: string;
  contato: string;
  enrollmentId: string;
}

/** Organização, contato que já conversou, o fluxo publicado e o enrollment no nó da IA. */
async function cenario(): Promise<Cenario> {
  const org = randomUUID();
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, 'Follow-up Falhado', 'Follow-up Falhado')`,
    [org, `c01-followup-falhado-${org}`],
  );
  const { rows: ct } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, name, phone_number) values ($1, 'Lead', '+5511900000999') returning id`,
    [org],
  );
  const contato = ct[0]!.id;
  const origem = await criarOrigemDeFollowup(pool, org, contato);
  const { rows: cv } = await pool.query<{ channel_session_id: string }>(
    `select channel_session_id from conversations where id = $1`,
    [origem.conversation_id],
  );
  await pool.query(
    `update conversations set service_started_at = now() - interval '1 hour', last_inbound_at = $2 where id = $1`,
    [origem.conversation_id, new Date(AGORA.getTime() - 50 * 60_000).toISOString()],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'inbound', 'delivered', 'oi, queria saber do plano', 'external_device', $6)`,
    [
      randomUUID(),
      org,
      origem.conversation_id,
      cv[0]!.channel_session_id,
      contato,
      new Date(AGORA.getTime() - 50 * 60_000).toISOString(),
    ],
  );
  const boundary = await criarOrigemDeFollowup(pool, org, contato);
  const { rows: ver } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, $2) returning id`,
    [org, JSON.stringify(GRAFO)],
  );
  const { rows: ptr } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, 'Retomada pela IA', 'active', $2) returning id`,
    [org, ver[0]!.id],
  );
  const { rows: en } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at,
        steps_taken, conversation_id, service_boundary)
     values ($1, $2, $3, $4, 'a1', 'active', now() - interval '1 second', 0, $5, $6::jsonb)
     returning id`,
    [org, ptr[0]!.id, ver[0]!.id, contato, boundary.conversation_id, JSON.stringify(boundary)],
  );
  return { org, contato, enrollmentId: en[0]!.id };
}

/** O tick do motor como produção: enfileira o turno de `send_message` do nó `a1`. */
async function tickEnfileira(c: Cenario): Promise<string> {
  const r = await m.engine.runFollowupTick(
    {
      db: m.bridge.createPgAdminClient(pool),
      clock: relogioAncoradoNoBanco(),
      enqueueJob: async (job) => {
        await pool.query(
          `insert into job_queue (organization_id, contact_id, kind, payload) values ($1, $2, 'followup_turn', $3)`,
          [job.organization_id, job.contact_id, job.payload],
        );
      },
    },
    { limit: 5 },
  );
  expect(r.failed, "o tick falhou num enrollment — ver last_error").toBe(0);
  const { rows } = await pool.query<{ id: string; payload: Record<string, unknown> }>(
    `select id, payload from job_queue
      where kind = 'followup_turn' and status = 'pending' and payload->>'followup_enrollment_id' = $1`,
    [c.enrollmentId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.payload).toMatchObject({ node_id: "a1", purpose: "send_message" });
  return rows[0]!.id;
}

/** Reivindica o job como o worker e roda o handler; falha ou conclui o job como o worker faria. */
async function executa(
  jobId: string,
  handler: ReturnType<typeof montaHandler>["handler"],
): Promise<Error | null> {
  // O claim é global: o que outros arquivos deixaram pendente nesta base não entra aqui.
  await pool.query("update job_queue set status = 'done' where status = 'pending' and id <> $1", [
    jobId,
  ]);
  // `failJob` devolve o job com espera (backoff): a fila o repegaria segundos depois.
  await pool.query("update job_queue set run_after = now() where id = $1", [jobId]);
  const [claimed] = await m.queue.claimJobs(pool, {
    workerId: WORKER,
    maxConcurrency: 5,
    batchSize: 1,
  });
  expect(claimed?.id, "o claim do worker pegou outro job").toBe(jobId);
  try {
    await handler(claimed!, pool, { workerId: WORKER });
    await m.queue.completeJob(pool, claimed!.id, WORKER);
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, WORKER, err);
    return err as Error;
  }
}

async function ledgerDoJob(org: string, jobId: string) {
  const { rows } = await pool.query<{ seq: number; status: string; body_hash: string }>(
    "select seq, status, body_hash from send_ledger where organization_id = $1 and job_id = $2 order by seq",
    [org, jobId],
  );
  return rows.map((r) => ({ seq: Number(r.seq), status: r.status, hash: r.body_hash }));
}

async function enrollment(id: string) {
  const { rows } = await pool.query<{ current_node_id: string; status: string }>(
    "select current_node_id, status from followup_enrollments where id = $1",
    [id],
  );
  const { rows: eventos } = await pool.query<{ event_type: string }>(
    "select event_type from followup_enrollment_events where enrollment_id = $1 order by created_at",
    [id],
  );
  return { ...rows[0]!, eventos: eventos.map((e) => e.event_type) };
}

async function job(id: string) {
  const { rows } = await pool.query<{
    status: string;
    attempts: number;
    last_error: string | null;
  }>("select status, attempts, last_error from job_queue where id = $1", [id]);
  return rows[0]!;
}

beforeAll(async () => {
  m = {
    followup: await import("@/lib/agent-engine/agent/followup-turn"),
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    ledger: await import("@/lib/agent-engine/edge/crm/send-ledger"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    claim: await import("@/lib/agent-engine/queue/claim"),
    engine: await import("@/lib/followup/engine"),
    bridge: await import("@/lib/followup/turn-bridge"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

beforeEach(async () => {
  entregues = [];
  falham = new Set();
  await isolarFixtureDeFollowup(pool);
  await pool.query(`delete from job_queue where kind = 'followup_turn'`);
});

describe("(rodada 7) o follow-up por IA conclui o passo depois de um recibo falhado (achado 2 da sexta revisão)", () => {
  it("1ª execução: A falha no canal, B e C saem, o turno falha o job (F2-06). Re-execução com o mesmo texto: A toma a posição 1, nada sai de novo, `completeFollowupTurn` roda e o enrollment avança", async () => {
    const c = await cenario();
    const jobId = await tickEnfileira(c);

    // ---- 1ª execução: o canal falha A ----
    falham.add(A);
    const primeira = montaHandler(modeloQueManda([A, B, C]).doGenerate);
    const erro1 = await executa(jobId, primeira.handler);
    // O turno do autor: um envio `failed` falha o run inteiro, e a fila o re-tenta.
    expect(erro1?.message).toMatch(/envio marcado como failed pelo CRM/);
    expect(primeira.complete).not.toHaveBeenCalled();
    expect(entregues.map((e) => e.body)).toEqual([A, B, C]);
    expect((await ledgerDoJob(c.org, jobId)).map((r) => [r.seq, r.status])).toEqual([
      [1, "failed"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(await job(jobId)).toMatchObject({ status: "pending", attempts: 1 });
    expect((await enrollment(c.enrollmentId)).current_node_id).toBe("a1");

    // ---- re-execução pela fila: o modelo regenera A, B e C ----
    // Sem a correção: `followup_message_not_sent` (o 'failed' da posição 1 ficava lá, A
    // nascia na 4), em toda re-execução, até o job morrer.
    const segunda = montaHandler(modeloQueManda([A, B, C]).doGenerate);
    const erro2 = await executa(jobId, segunda.handler);
    expect(erro2?.message).toBeUndefined();

    // Só A foi ao CRM de novo; B e C, aceitas, não saíram.
    expect(entregues.map((e) => e.body)).toEqual([A, B, C, A]);
    expect(entregues[3]!.key).not.toBe(entregues[0]!.key);
    // A tomou a posição 1 (rotacionada): o ledger não tem 'failed'.
    const ledger = await ledgerDoJob(c.org, jobId);
    expect(ledger.map((r) => [r.seq, r.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(ledger[0]!.hash).toBe(m.ledger.hashDoConteudo({ body: A }));
    // O passo concluiu: a ponte foi chamada com `sent`, o enrollment está no fim do fluxo.
    expect(segunda.complete).toHaveBeenCalledTimes(1);
    expect(segunda.complete.mock.calls[0]![1]).toMatchObject({
      organizationId: c.org,
      enrollmentId: c.enrollmentId,
      nodeId: "a1",
      jobId,
      result: { kind: "sent" },
    });
    const fim = await enrollment(c.enrollmentId);
    expect(fim.current_node_id).toBe("e1");
    expect(fim.eventos).toEqual(["turn_enqueued", "action_sent"]);
    expect(await job(jobId)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("re-execução em que o modelo REESCREVE a mensagem que falhou (A2 no lugar de A): A2 toma a posição 1, B e C não saem de novo, e o passo conclui do mesmo jeito", async () => {
    const c = await cenario();
    const jobId = await tickEnfileira(c);

    falham.add(A);
    const primeira = montaHandler(modeloQueManda([A, B, C]).doGenerate);
    expect((await executa(jobId, primeira.handler))?.message).toMatch(
      /envio marcado como failed pelo CRM/,
    );

    const segunda = montaHandler(modeloQueManda([A2, B, C]).doGenerate);
    expect((await executa(jobId, segunda.handler))?.message).toBeUndefined();

    expect(entregues.map((e) => e.body)).toEqual([A, B, C, A2]);
    const ledger = await ledgerDoJob(c.org, jobId);
    expect(ledger.map((r) => [r.seq, r.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(ledger[0]!.hash).toBe(m.ledger.hashDoConteudo({ body: A2 }));
    expect(segunda.complete).toHaveBeenCalledTimes(1);
    expect((await enrollment(c.enrollmentId)).current_node_id).toBe("e1");
    expect(await job(jobId)).toMatchObject({ status: "done" });
  });

  it("sem recibo falhado nada muda: A, B e C saem na 1ª execução, o passo conclui na hora", async () => {
    const c = await cenario();
    const jobId = await tickEnfileira(c);
    const unica = montaHandler(modeloQueManda([A, B, C]).doGenerate);
    expect(await executa(jobId, unica.handler)).toBeNull();
    expect(entregues.map((e) => e.body)).toEqual([A, B, C]);
    expect((await ledgerDoJob(c.org, jobId)).map((r) => [r.seq, r.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(unica.complete).toHaveBeenCalledTimes(1);
    expect((await enrollment(c.enrollmentId)).current_node_id).toBe("e1");
  });
});
