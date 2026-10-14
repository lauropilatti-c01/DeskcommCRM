import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { tool } from "ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { z } from "zod";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as McpTools from "@/lib/agent-engine/edge/crm/mcp-tools";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01, -c01.14) AS TRAVAS "CONSULTE ANTES DE ENVIAR" E "MARCADOR ENTRE COLCHETES" NO
 * TURNO INTEIRO, contra Postgres real, com modelo e canal falsos e o AI SDK de verdade (é
 * ele que entrega ao `send_message` as mensagens que o modelo leu).
 *
 * Com a consulta ligada para o agente do turno, numa tabela:
 *   - mandar sem consultar volta ao modelo; consultando e mandando de novo, sai;
 *   - consultar e mandar no MESMO passo volta (o modelo escreveu sem ler); no passo
 *     seguinte, com o resultado lido, sai;
 *   - a consulta que volta com erro não conta;
 *   - a segunda tentativa sem consulta passa (estilo: sem caso, sem passagem);
 *   - a consulta feita num turno anterior do contato libera o turno;
 *   - interruptor desligado (sem a chave, ou outro agente na lista): nada muda.
 * E o marcador "[link do vídeo]" nunca sai.
 *
 * Tabelas, links e textos são fictícios (regra do C01.md).
 */

const RESULTADO_DA_BASE = {
  content: [
    {
      type: "text",
      text: JSON.stringify({ rows: [{ duvida: "qual curso fazer", url: "https://videos.exemplo.com.br/v/abc123" }] }),
    },
  ],
};
const ERRO_DA_BASE = { erro: "pedido_invalido", detalhe: "coluna_inexistente:duvida_x" };

let respostaDaBase: unknown = RESULTADO_DA_BASE;

vi.mock("@/lib/agent-engine/edge/crm/mcp-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof McpTools>()),
  buildMcpTurnTools: async () => ({
    tools: {
      crm_query_external_data: tool({
        description: "Consulta a base externa da organização.",
        inputSchema: z.object({ tabela: z.string() }),
        execute: async () => respostaDaBase,
      }),
    },
    toolIds: ["crm_query_external_data"],
    cleanup: async () => {},
  }),
}));

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
const OUTRO_AGENTE = "a8a8a8a8-0000-4000-8000-000000000099";
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";

const TABELA = "tabela_de_videos";
const VIDEO = "https://videos.exemplo.com.br/v/abc123";

type Modules = {
  turno: typeof InboundTurn;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: Array<{ body: string }> = [];

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

/** Uma etapa do modelo falso: consultar, mandar, ou consultar e mandar no MESMO passo. */
type Etapa = { base: string } | { envia: string } | { baseEEnvia: [string, string] };

function chamada(id: string, toolName: string, input: unknown) {
  return { type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) };
}

/** Modelo falso: segue o roteiro e depois encerra; guarda o prompt de cada etapa. */
function modelo(roteiro: Etapa[]) {
  const estado = { etapas: 0, prompts: [] as string[] };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    const ultima = msgs[msgs.length - 1];
    const ehCheckpoint =
      ultima?.role === "user" &&
      Array.isArray(ultima.content) &&
      (ultima.content as Array<Record<string, unknown>>).some(
        (p) => p.type === "text" && p.text === m.turno.CHECKPOINT_INSTRUCTION,
      );
    if (ehCheckpoint) return texto(CHECKPOINT);
    estado.prompts.push(JSON.stringify(opts.prompt));
    const etapa = roteiro[estado.etapas];
    estado.etapas += 1;
    if (etapa === undefined) return texto("pronto");
    const n = estado.etapas;
    const content =
      "baseEEnvia" in etapa
        ? [
            chamada(`c${n}-0`, "crm_query_external_data", { tabela: etapa.baseEEnvia[0] }),
            chamada(`c${n}-1`, "send_message", { body: etapa.baseEEnvia[1] }),
          ]
        : "base" in etapa
          ? [chamada(`c${n}`, "crm_query_external_data", { tabela: etapa.base })]
          : [chamada(`c${n}`, "send_message", { body: etapa.envia })];
    return { content, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: USO, warnings: [] };
  };
  return { doGenerate, estado };
}

function texto(t: string) {
  return {
    content: [{ type: "text" as const, text: t }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: USO,
    warnings: [],
  };
}

function montaHandler(doGenerate: unknown) {
  const saidaDoLog = new Writable({
    write(_pedaco, _codificacao, pronto) {
      pronto();
    },
  });
  return m.turno.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
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
    log: m.createLogger(saidaDoLog),
    registry: m.createFakeRegistry(doGenerate as never),
    embed: (async () => ({ embedding: Array(1536).fill(0.1), promptTokens: 0, model: "text-embedding-3-small" })) as never,
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          enviados.push({ body: i.body });
          return { kind: "sent", idempotencyKey: `k${enviados.length}`, messageId: `m${enviados.length}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => AGORA,
    sleep: async () => {},
  });
}

async function rodaTurno(roteiro: Etapa[]): Promise<{ estado: { prompts: string[] }; erro: Error | null }> {
  const { doGenerate, estado } = modelo(roteiro);
  const handler = montaHandler(doGenerate);
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
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "ca", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "ca" });
    await m.queue.completeJob(pool, claimed!.id, "ca");
    return { estado, erro: null };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "ca", err);
    return { estado, erro: err as Error };
  }
}

/** As travas de envio da organização (JSON de `settings.travas_de_envio`). */
async function travas(valor: Record<string, unknown>) {
  await pool.query(
    "update organizations set settings = jsonb_build_object('travas_de_envio', $2::jsonb) where id = $1",
    [ORG, JSON.stringify(valor)],
  );
}
const LIGADA = {
  consulta_antes_de_enviar: { agentes: [AGENTE], tabela: TABELA },
  marcador_entre_colchetes: { ligada: true },
};

/** Os códigos que vetaram neste teste, na ordem. */
async function vetos(): Promise<string[]> {
  const { rows } = await pool.query<{ vetoed_code: string }>(
    "select vetoed_code from before_send_traces where organization_id = $1 and vetoed_code is not null order by created_at",
    [ORG],
  );
  return rows.map((r) => r.vetoed_code);
}

async function semCasoNemPassagem() {
  const casos = await pool.query("select 1 from agent_cases where organization_id = $1", [ORG]);
  const passagens = await pool.query("select 1 from passagens_de_atendimento where organization_id = $1", [ORG]);
  expect(casos.rowCount).toBe(0);
  expect(passagens.rowCount).toBe(0);
}

beforeAll(async () => {
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1,'c01-consulta-antes','Consulta antes','Consulta antes','{}'::jsonb)
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead consulta antes','+5511900000791') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-ca-sessao','WORKING','\\x00'::bytea)
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
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','não sei qual curso fazer','external_device',$6)
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT, MENSAGEM_DO_CLIENTE_EM],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1,$2,'Agente consulta antes','Você é um atendente de teste.','mcp_agent')
     on conflict (id) do nothing`,
    [AGENTE, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at, max_steps, tool_ids)
     values ($1,$2,$3,1,'Você é um atendente de teste.','anthropic','claude-sonnet-4-6',$4,'published',now(),8,
             array['crm_query_external_data'])
     on conflict (id) do nothing`,
    [VERSAO, ORG, AGENTE, SESSION],
  );
  await pool.query("update ai_agents set published_version_id = $1 where id = $2", [VERSAO, AGENTE]);
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
  respostaDaBase = RESULTADO_DA_BASE;
  await travas(LIGADA);
  await pool.query("delete from before_send_traces where organization_id = $1", [ORG]);
  await pool.query("delete from agent_case_events where organization_id = $1", [ORG]);
  await pool.query("delete from agent_cases where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("update contacts set force_human = false where organization_id = $1 and id = $2", [ORG, CONTACT]);
  await pool.query(
    `update conversations
        set bot_silenced_until = null, status = 'open', last_handoff_at = null, last_handoff_reason = null
      where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  await pool.query("delete from passagens_de_atendimento where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1 and direction = 'outbound'", [ORG]);
});

describe("(C01, -c01.14) 'consulte antes de enviar', no turno inteiro", () => {
  it("mandar sem consultar volta ao modelo; consultando e mandando de novo, sai", async () => {
    const { estado, erro } = await rodaTurno([
      { envia: "Cada curso combina com um perfil." },
      { base: TABELA },
      { envia: `Tem um vídeo sobre isso:\n\n${VIDEO}` },
    ]);
    expect(erro).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual([`Tem um vídeo sobre isso:\n\n${VIDEO}`]);
    expect(await vetos()).toEqual(["consulta_antes_de_enviar"]);
    expect(estado.prompts[1]).toMatch(/você ainda não leu a consulta à tabela tabela_de_videos/);
    await semCasoNemPassagem();
  });

  it("consultar e mandar no MESMO passo volta (escreveu sem ler); no passo seguinte, com o resultado lido, sai", async () => {
    const { erro } = await rodaTurno([
      { baseEEnvia: [TABELA, "Cada curso combina com um perfil."] },
      { envia: `O vídeo explica a escolha:\n\n${VIDEO}` },
    ]);
    expect(erro).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual([`O vídeo explica a escolha:\n\n${VIDEO}`]);
    expect(await vetos()).toEqual(["consulta_antes_de_enviar"]);
  });

  it("a consulta que voltou com erro não conta como lida", async () => {
    respostaDaBase = ERRO_DA_BASE;
    const { erro } = await rodaTurno([{ base: TABELA }, { envia: "Primeira com erro." }, { envia: "Segunda com erro." }]);
    expect(erro).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual(["Segunda com erro."]);
    // O 2º veto fica no rastro: é ele que desarma a trava antes de a mensagem sair.
    expect(await vetos()).toEqual(["consulta_antes_de_enviar", "consulta_antes_de_enviar"]);
  });

  it("a segunda tentativa sem consulta passa, sem caso nem passagem (estilo)", async () => {
    const { estado, erro } = await rodaTurno([{ envia: "Primeira sem consulta." }, { envia: "Segunda sem consulta." }]);
    expect(erro).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual(["Segunda sem consulta."]);
    // Volta ao modelo uma vez só; o 2º veto fica no rastro e desarma a trava no turno.
    expect(await vetos()).toEqual(["consulta_antes_de_enviar", "consulta_antes_de_enviar"]);
    expect(estado.prompts[1]).toMatch(/você ainda não leu a consulta/);
    expect(estado.prompts[2] ?? "").not.toMatch(/Segunda sem consulta[^]*você ainda não leu a consulta/);
    await semCasoNemPassagem();
  });

  it("a consulta à tabela num turno anterior do contato libera o turno; a de outra tabela, não", async () => {
    const TABELA_DO_TURNO_ANTERIOR = "tabela_do_turno_anterior";
    const { job } = await m.queue.enqueueJob(pool, ORG, {
      kind: "inbound_turn",
      leadId: CONTACT,
      payload: { conversation_id: CONV, contact_id: CONTACT, channel_session_id: SESSION, inbound_message_id: MSG, crm_event_id: randomUUID() },
      maxAttempts: 1,
    });
    await pool.query("update job_queue set status = 'done' where id = $1", [job.id]);
    await pool.query(
      `insert into api_audit_log (organization_id, action, resource_type, request_id, metadata)
       values ($1, 'mcp.tool_called', 'mcp_tool', $2,
               jsonb_build_object('tool_name','crm_query_external_data','success',true,
                                  'args', jsonb_build_object('tabela', $3::text)))`,
      [ORG, job.id, `c01.${TABELA_DO_TURNO_ANTERIOR}`],
    );
    await travas({ consulta_antes_de_enviar: { agentes: [AGENTE], tabela: TABELA_DO_TURNO_ANTERIOR } });
    await rodaTurno([{ envia: "Obrigado você!" }]);
    expect(enviados.map((e) => e.body)).toEqual(["Obrigado você!"]);
    expect(await vetos()).toEqual([]);

    enviados = [];
    await travas({ consulta_antes_de_enviar: { agentes: [AGENTE], tabela: "outra_tabela" } });
    await rodaTurno([{ envia: "Primeira, outra tabela." }, { envia: "Segunda, outra tabela." }]);
    expect(enviados.map((e) => e.body)).toEqual(["Segunda, outra tabela."]);
  });

  it("interruptor desligado: sem a chave, ou com outro agente na lista, sai de primeira", async () => {
    await travas({});
    await rodaTurno([{ envia: "Sem a chave." }]);
    await travas({ consulta_antes_de_enviar: { agentes: [OUTRO_AGENTE], tabela: TABELA } });
    await rodaTurno([{ envia: "Outro agente." }]);
    expect(enviados.map((e) => e.body)).toEqual(["Sem a chave.", "Outro agente."]);
    expect(await vetos()).toEqual([]);
  });
});

describe("(C01, -c01.14) 'marcador entre colchetes', no turno inteiro", () => {
  it("'[link do vídeo]' é barrado; com o link de verdade, sai", async () => {
    const { estado, erro } = await rodaTurno([
      { base: TABELA },
      { envia: "Separei um vídeo:\n\n[link do vídeo]" },
      { envia: `Separei um vídeo:\n\n${VIDEO}` },
    ]);
    expect(erro).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual([`Separei um vídeo:\n\n${VIDEO}`]);
    expect(await vetos()).toEqual(["marcador_entre_colchetes"]);
    expect(estado.prompts[2]).toMatch(/marcador entre colchetes \(\[link do vídeo\]\)/);
  });

  it("o marcador nunca sai, nem na segunda tentativa", async () => {
    await rodaTurno([
      { base: TABELA },
      { envia: "Olha: [link do vídeo]" },
      { envia: "Olha de novo: [link do teste]" },
    ]);
    expect(enviados.some((e) => e.body.includes("["))).toBe(false);
    expect(await vetos()).toEqual(["marcador_entre_colchetes", "marcador_entre_colchetes"]);
  });

  it("desligado, nada muda", async () => {
    await travas({});
    await rodaTurno([{ envia: "Olha: [link do vídeo]" }]);
    expect(enviados.map((e) => e.body)).toEqual(["Olha: [link do vídeo]"]);
  });
});
