import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as HumanHandoff from "@/lib/agent-engine/agent/human-handoff";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01, -c01.3, rodada 3) O ACEITE DO CANAL É EVIDÊNCIA ANTES DE QUALQUER REGISTRO —
 * achado 3 (médio) da 2ª revisão adversarial do Codex da -c01.3 (04/10/2026), contra
 * Postgres real, com modelo e canal falsos.
 *
 * O achado: na retomada de uma posição falhada (a execução anterior deixou o recibo
 * 'failed'), o canal devolve `sent` e a consulta seguinte (`posicaoFalhadaFoiOcupada`)
 * falha ANTES de a evidência de resposta (`leadTemResposta`) ser marcada. Na última
 * tentativa, o `catch` do turno lia "nenhuma resposta" e mandava a frase de espera,
 * abria caso e passava a uma pessoa uma conversa já respondida.
 *
 * O que se prova: com a consulta falhando depois do aceite (`sent` e `queued`), na
 * última tentativa, só a resposta sai — sem frase, sem caso, sem passagem.
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
  max: 2,
});

const ORG = "a8a8a8a8-0000-4000-8000-000000000001";
const CONTACT = "a8a8a8a8-0000-4000-8000-000000000002";
const SESSION = "a8a8a8a8-0000-4000-8000-000000000003";
const CONV = "a8a8a8a8-0000-4000-8000-000000000004";
const MSG = "a8a8a8a8-0000-4000-8000-000000000005";
const AGENTE = "a8a8a8a8-0000-4000-8000-000000000006";
const VERSAO = "a8a8a8a8-0000-4000-8000-000000000007";
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";
const TETO = 100_000;
const PRAZO_MS = 50;
const ERRO_DO_BANCO = "canceling statement due to statement timeout";
/** A consulta de `posicaoFalhadaFoiOcupada` (e de todo `find` do ledger). */
const SQL_DA_CONSULTA = "select * from send_ledger where organization_id=$1 and job_id=$2 and seq=$3";

type Modules = {
  turno: typeof InboundTurn;
  isLeadInHandoff: typeof HumanHandoff.isLeadInHandoff;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

/** Tudo o que chegou ao canal, na ordem. */
let enviados: string[] = [];
/** O que o canal devolve. */
let desfecho: "sent" | "queued" = "sent";

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
const RESPOSTA = "Oi! Seu cadastro está ativo, sim. Quer que eu te explique os próximos passos?";

function texto(t: string) {
  return {
    content: [{ type: "text" as const, text: t }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: USO,
    warnings: [],
  };
}

/** Modelo falso: responde com a RESPOSTA na 1ª etapa e encerra na 2ª. */
function modelo() {
  let etapas = 0;
  return async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    const ultima = msgs[msgs.length - 1];
    const pedeCheckpoint =
      ultima?.role === "user" &&
      Array.isArray(ultima.content) &&
      (ultima.content as Array<Record<string, unknown>>).some(
        (p) => p.type === "text" && p.text === m.turno.CHECKPOINT_INSTRUCTION,
      );
    if (pedeCheckpoint) return texto(CHECKPOINT);
    etapas += 1;
    if (etapas > 1) return texto("pronto");
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "c1",
          toolName: "send_message",
          input: JSON.stringify({ body: RESPOSTA }),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
}

/**
 * O pool do turno: o do teste, com a consulta do recibo por posição devolvendo o erro
 * do `statement_timeout` DEPOIS de o canal aceitar o primeiro envio — antes disso
 * (a leitura do estado inicial do job) ela responde.
 */
function poolQueFalhaDepoisDoAceite(): pg.Pool {
  return new Proxy(pool, {
    get(alvo, prop) {
      if (prop === "query") {
        return (sql: unknown, ...resto: unknown[]) => {
          const textoDoSql = typeof sql === "string" ? sql : (sql as { text?: string })?.text ?? "";
          if (enviados.length > 0 && textoDoSql === SQL_DA_CONSULTA) {
            return Promise.reject(new Error(ERRO_DO_BANCO));
          }
          return (alvo.query as (...a: unknown[]) => unknown)(sql, ...resto);
        };
      }
      const valor = Reflect.get(alvo, prop) as unknown;
      return typeof valor === "function" ? (valor as (...a: unknown[]) => unknown).bind(alvo) : valor;
    },
  });
}

function montaHandler() {
  return m.turno.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake", prazoPorRequisicaoMs: PRAZO_MS } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 8,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(modelo() as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          enviados.push(i.body);
          const n = enviados.length;
          return { kind: desfecho, idempotencyKey: `k${n}`, messageId: desfecho === "sent" ? `m${n}` : null };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => AGORA,
    sleep: async () => {},
  });
}

/** Roda o turno na última tentativa, com o recibo 'failed' da posição 1 deixado pela execução anterior. */
async function rodaTurnoComPosicaoFalhada(): Promise<{ erro: Error | null; jobId: string }> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: MSG,
      crm_event_id: randomUUID(),
    },
    maxAttempts: 1,
  });
  await pool.query(
    `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status, last_error)
     values ($1,$2,$3,1,'hash-da-resposta-anterior','failed','o canal marcou a mensagem como falha')`,
    [ORG, CONTACT, job.id],
  );
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "aceite", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await montaHandler()(claimed!, poolQueFalhaDepoisDoAceite(), { workerId: "aceite" });
    await m.queue.completeJob(pool, claimed!.id, "aceite");
    return { erro: null, jobId: job.id };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "aceite", err);
    return { erro: err as Error, jobId: job.id };
  }
}

beforeAll(async () => {
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    isLeadInHandoff: (await import("@/lib/agent-engine/agent/human-handoff")).isLeadInHandoff,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'c01-aceite-antes-da-consulta','Aceite Antes da Consulta','Aceite Antes da Consulta')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Aceite','+5511900000783') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-aceite-sessao','WORKING','\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group, last_inbound_at)
     values ($1,$2,$3,$4,'open',false,$5) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION, MENSAGEM_DO_CLIENTE_EM],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi, meu cadastro está ativo?','external_device',$6)
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT, MENSAGEM_DO_CLIENTE_EM],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1,$2,'Agente do aceite','Você é um atendente de teste.','mcp_agent')
     on conflict (id) do nothing`,
    [AGENTE, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at, token_budget, max_steps)
     values ($1,$2,$3,1,'Você é um atendente de teste.','anthropic','claude-sonnet-4-6',$4,'published',now(),$5,8)
     on conflict (id) do nothing`,
    [VERSAO, ORG, AGENTE, SESSION, TETO],
  );
  await pool.query("update ai_agents set published_version_id = $1 where id = $2", [
    VERSAO,
    AGENTE,
  ]);
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
  enviados = [];
  desfecho = "sent";
  await pool.query("delete from agent_case_events where organization_id = $1", [ORG]);
  await pool.query("delete from agent_cases where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1 and id <> $2", [ORG, MSG]);
  await pool.query(
    "update contacts set force_human = false where organization_id = $1 and id = $2",
    [ORG, CONTACT],
  );
  await pool.query(
    `update conversations
        set bot_silenced_until = null, status = 'open', last_handoff_at = null, last_handoff_reason = null
      where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
});

async function statusDoJob(jobId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    "select status from job_queue where id = $1",
    [jobId],
  );
  return rows[0]!.status;
}

describe("(C01, -c01.3, rodada 3) o aceite do canal é evidência antes de qualquer registro", () => {
  it.each(["sent", "queued"] as const)(
    "o canal devolve `%s` na retomada da posição falhada e a consulta seguinte falha, na última tentativa: só a resposta, sem frase e sem caso",
    async (kind) => {
      desfecho = kind;
      const { erro, jobId } = await rodaTurnoComPosicaoFalhada();

      // O erro da consulta derruba o turno (o job morre com ele) ...
      expect(erro).not.toBeNull();
      expect(await statusDoJob(jobId)).toBe("dead");
      // ... mas a resposta já tinha sido aceita: sem a correção, a frase de espera saía
      // depois dela e o caso abria uma conversa já respondida.
      expect(enviados).toEqual([RESPOSTA]);
      const { rows: casos } = await pool.query(
        "select 1 from agent_cases where organization_id = $1 and conversation_id = $2",
        [ORG, CONV],
      );
      expect(casos).toEqual([]);
      expect(await m.isLeadInHandoff(pool, ORG, CONTACT)).toBe(false);
    },
  );
});
