import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as FollowupTurn from "@/lib/agent-engine/agent/followup-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as SendLedger from "@/lib/agent-engine/edge/crm/send-ledger";
import type * as SendMessage from "@/lib/agent-engine/edge/crm/send-message";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";
import type * as Handler from "@/app/api/v1/messages/_handler";
import type * as Duble from "@/tests/helpers/duble-do-handler";
import { criarOrigemDeFollowup } from "./followup-service-origin";
import type { ChannelSendInput } from "@/lib/agent-engine/channel-adapter";

/**
 * (C01, -c01.5) O GANCHO ANTES DO TURNO NO TURNO INTEIRO, contra Postgres real, com
 * modelo falso e o envio pelo caminho de verdade: ledger real (`sendWithLedger`), o
 * corpo que o motor manda ao handler (`corpoDoEnvio`), o handler de mensagens
 * (`sendMessageHandler`, com o dublê do Supabase) e o adapter do canal oficial, até o
 * POST na Graph (o `fetch` dublado). A linha que o handler grava é espelhada no
 * Postgres, como o handler real a gravaria: é por ela que o ledger reconhece o envio.
 *
 * O serviço do gancho é o mesmo `fetch` dublado, noutro endereço.
 *
 * Provas (numeração do pedido da -c01.5):
 *   2. sem o gancho no ambiente, o turno é o de antes: o modelo responde e nenhuma
 *      chamada a mais sai;
 *   3. `seguir` com `gravar` e `resumo`: campos e etiquetas no card, o texto do
 *      formulário trocado pelo resumo e o modelo chamado lendo o resumo (e os campos);
 *   4. `segurar`: o formulário sai pela Graph com o corpo exato, sem modelo e sem
 *      fail-safe, o `gravar` aplicado, a mensagem registrada; a re-execução do mesmo
 *      job não pergunta de novo nem envia de novo;
 *   5. prazo estourado, 500, resposta inválida e envio do `segurar` que falha: o
 *      modelo responde e o `gravar` não é aplicado;
 *   6. a assinatura confere com o segredo, e o pedido não leva telefone, e-mail nem
 *      nome do contato.
 *
 * E os requisitos da verificação do porteiro:
 *   - `segurar` com `enviar: []`: grava e encerra o turno sem modelo e sem fail-safe;
 *   - envio parcial do `segurar` (o 1º saiu, o 2º não): grava, encerra, fica no log;
 *   - o turno de follow-up (`followup_turn`) não chama o gancho;
 *   - a re-execução depois do `segurar` não envia de novo (a anotação no job).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

// A credencial da sessão oficial (cifrada) e a auditoria do handler.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const alvo: Record<string, unknown> = {
        maybeSingle: async () => ({
          data: { meta_phone_number_id: "111", meta_token_encrypted: "\\xdeadbeef" },
          error: null,
        }),
      };
      alvo.select = () => alvo;
      alvo.eq = () => alvo;
      alvo.is = () => alvo;
      return alvo;
    },
    rpc: async (nome: string) =>
      nome === "fn_decrypt_oauth" ? { data: "tok-da-sessao", error: null } : { data: null, error: null },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "c5c5c5c5-0000-4000-8000-000000000001";
const CONTACT = "c5c5c5c5-0000-4000-8000-000000000002";
const SESSION = "c5c5c5c5-0000-4000-8000-000000000003";
const CONV = "c5c5c5c5-0000-4000-8000-000000000004";
const MSG = "c5c5c5c5-0000-4000-8000-000000000005";
const AGENTE = "c5c5c5c5-0000-4000-8000-000000000006";
const VERSAO = "c5c5c5c5-0000-4000-8000-000000000007";
const PIPELINE = "c5c5c5c5-0000-4000-8000-000000000008";
const ETAPA = "c5c5c5c5-0000-4000-8000-000000000009";
const CARD = "c5c5c5c5-0000-4000-8000-00000000000a";

const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";

/** O que o pedido nunca pode levar. */
const NOME = "Maria Gancho";
const TELEFONE = "+5511900000881";
const EMAIL = "maria.gancho@teste.example";

const GANCHO = { url: "http://gancho.teste/turno", segredo: "segredo-do-gancho", prazoMs: 200 };
const CAMPOS_INICIAIS = {
  interesse: "plano-b",
  telefone_extra: "+5511988887777",
  email_alternativo: "outro@teste.example",
  nome_completo: NOME,
  _interno: { origem: "importacao" },
};
const ETIQUETAS_INICIAIS = ["etiqueta-antiga", "aguardando"];

const RESPOSTA_DO_MODELO = "Oi! Que bom falar com você. Me conta: o que você está buscando agora?";

/** Um formulário no formato da Meta, sem dado de ninguém. */
const FORMULARIO = {
  type: "flow",
  body: { text: "Responda o formulário, por favor." },
  action: {
    name: "flow",
    parameters: {
      flow_message_version: "3",
      flow_token: "tok-teste",
      flow_id: "123",
      flow_cta: "Responder",
      flow_action: "navigate",
      flow_action_payload: { screen: "INICIO" },
    },
  },
};

type Modules = {
  turno: typeof InboundTurn;
  followup: typeof FollowupTurn;
  ledger: typeof SendLedger;
  envio: typeof SendMessage;
  handler: typeof Handler;
  duble: typeof Duble;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

// ─── o mundo de fora (fetch dublado) ─────────────────────────────────────────

interface PedidoCapturado {
  corpo: string;
  assinatura: string | null;
}
let pedidosAoGancho: PedidoCapturado[] = [];
let postsNaGraph: Array<Record<string, unknown>> = [];
/** Como o gancho responde a cada pedido. */
let respostaDoGancho: (init: RequestInit) => Promise<Response> = async () => json({ acao: "seguir" });
/** Status da Graph a cada POST, na ordem; esgotado, 200. */
let statusDaGraph: number[] = [];

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

const fetchDublado = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
  const alvo = String(url);
  if (alvo === GANCHO.url) {
    const headers = new Headers(init.headers);
    pedidosAoGancho.push({ corpo: String(init.body), assinatura: headers.get("x-hook-signature") });
    return respostaDoGancho(init);
  }
  if (alvo.includes("/messages")) {
    postsNaGraph.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const status = statusDaGraph.shift() ?? 200;
    return status === 200
      ? json({ messages: [{ id: `wamid.${postsNaGraph.length}` }] })
      : json({ error: { message: "falha de teste", code: 131000 } }, status);
  }
  throw new Error(`fetch inesperado no teste: ${alvo}`);
};

// ─── o modelo falso ──────────────────────────────────────────────────────────

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

/** Responde com `send_message` na 1ª etapa e encerra; guarda o prompt de cada etapa. */
function modelo() {
  const estado = { etapas: 0, prompts: [] as string[] };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    const ultima = msgs[msgs.length - 1];
    const pedeCheckpoint =
      ultima?.role === "user" &&
      Array.isArray(ultima.content) &&
      (ultima.content as Array<Record<string, unknown>>).some(
        (p) => p.type === "text" && p.text === m.turno.CHECKPOINT_INSTRUCTION,
      );
    if (pedeCheckpoint) return texto(CHECKPOINT);
    estado.etapas += 1;
    estado.prompts.push(JSON.stringify(opts.prompt));
    if (estado.etapas > 1) return texto("pronto");
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${estado.etapas}`,
          toolName: "send_message",
          input: JSON.stringify({ body: RESPOSTA_DO_MODELO }),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
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

// ─── o canal: ledger real → corpo do motor → handler → adapter oficial → Graph ──

let enviosAoCanal: ChannelSendInput[] = [];
/** O log do turno, linha a linha (JSON), para conferir o que fica registrado. */
let linhasDoLog: string[] = [];

const CONVERSA_DO_HANDLER = {
  id: CONV,
  organization_id: ORG,
  contact_id: CONTACT,
  channel_session_id: SESSION,
  is_group: false,
  group_chat_id: null,
  provider_conversation_id: null,
  contacts: { phone_number: TELEFONE, wa_identity: `phone:${TELEFONE}`, wa_lid: null, is_blocked: false },
  channel_sessions: {
    provider: "meta_cloud",
    waha_session_name: null,
    meta_phone_number_id: "111",
    zernio_account_id: null,
    status: "WORKING",
    archived_at: null,
  },
};

function canal() {
  return {
    channel: "oficial-de-teste",
    send: async (i: ChannelSendInput) => {
      enviosAoCanal.push(i);
      const desfecho = await m.ledger.sendWithLedger(m.ledger.pgSendLedger(pool), i, async (key, messageId) => {
        const { supabase, capturas } = m.duble.criarDubleDoHandler({ conversation: CONVERSA_DO_HANDLER });
        const msg = await m.handler.sendMessageHandler(
          supabase,
          {
            organization_id: i.tenantId,
            actor: { type: "user", id: "c5c5c5c5-0000-4000-8000-0000000000ff" },
            requestId: key,
            internalMessageId: messageId,
          },
          m.envio.corpoDoEnvio(i, key),
        );
        // A linha como o handler real a grava, para o ledger e a conversa a lerem.
        const linha = capturas.inserts.messages!.at(-1)!;
        await pool.query(
          `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
             type, direction, status, body, sent_via, metadata, sent_at)
           values ($1,$2,$3,$4,$5,$6,'outbound',$7,$8,'ai',$9::jsonb, now())`,
          [msg.id, ORG, CONV, SESSION, CONTACT, linha.type, msg.status, linha.body, JSON.stringify(linha.metadata ?? {})],
        );
        return { id: msg.id, status: msg.status };
      });
      if (desfecho.kind === "sent" || desfecho.kind === "already_sent" || desfecho.kind === "queued")
        return { kind: desfecho.kind, idempotencyKey: desfecho.idempotencyKey, messageId: desfecho.crmMessageId };
      if (desfecho.kind === "failed")
        return { kind: "failed", idempotencyKey: desfecho.idempotencyKey, messageId: desfecho.crmMessageId };
      return { kind: "blocked", idempotencyKey: desfecho.idempotencyKey };
    },
    sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
    capabilities: () => ({ freeform: false, media: true, audio: true }),
    costPerMessage: () => ({ currency: "BRL", cents: 0 }),
  };
}

function depsDoTurno(doGenerate: unknown, comGancho: boolean) {
  return {
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 4000,
      notesIndexMaxTokens: 500,
      maxSteps: 4,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
      ...(comGancho ? { ganchoAntesDoTurno: GANCHO } : {}),
    },
    log: m.createLogger({
      write: (linha: string) => {
        linhasDoLog.push(linha);
        if (process.env.DEBUG_GANCHO) process.stderr.write(linha);
        return true;
      },
    } as never),
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () => canal() as never,
    clock: () => AGORA,
    sleep: async () => {},
  };
}

function montaHandler(doGenerate: unknown, comGancho: boolean) {
  return m.turno.createInboundTurnHandler(depsDoTurno(doGenerate, comGancho));
}

async function enfileira(inboundMessageId: string): Promise<string> {
  await pool.query("update job_queue set status = 'done' where organization_id = $1 and status = 'pending'", [ORG]);
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: inboundMessageId,
      crm_event_id: randomUUID(),
    },
    maxAttempts: 3,
  });
  return job.id;
}

async function executa(handler: ReturnType<typeof montaHandler>, jobId: string): Promise<Error | null> {
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "gancho", maxConcurrency: 1 });
  expect(claimed?.id).toBe(jobId);
  try {
    await handler(claimed!, pool, { workerId: "gancho" });
    await m.queue.completeJob(pool, claimed!.id, "gancho");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "gancho", err);
    return err as Error;
  }
}

/** A re-execução do mesmo job (o reaper o devolveu à fila depois de uma queda). */
async function reexecuta(handler: ReturnType<typeof montaHandler>, jobId: string): Promise<Error | null> {
  await pool.query(
    `update job_queue set status = 'pending', locked_by = null, locked_at = null, run_after = now() - interval '1 second'
      where id = $1`,
    [jobId],
  );
  return executa(handler, jobId);
}

async function card() {
  const { rows } = await pool.query<{ custom_fields: Record<string, unknown>; tags: string[] }>(
    "select custom_fields, tags from crm_leads where organization_id = $1 and id = $2",
    [ORG, CARD],
  );
  return rows[0]!;
}

async function mensagensDeSaida() {
  const { rows } = await pool.query<{ type: string; body: string; metadata: Record<string, unknown> }>(
    `select type, body, metadata from messages
      where organization_id = $1 and conversation_id = $2 and direction = 'outbound' order by created_at`,
    [ORG, CONV],
  );
  return rows;
}

async function casosAbertos(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*) as n from agent_cases where organization_id = $1",
    [ORG],
  );
  return Number(rows[0]!.n);
}

async function anotacaoDoJob(jobId: string): Promise<unknown> {
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    "select payload from job_queue where id = $1",
    [jobId],
  );
  return rows[0]!.payload.gancho_antes_do_turno;
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchDublado);
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    followup: await import("@/lib/agent-engine/agent/followup-turn"),
    ledger: await import("@/lib/agent-engine/edge/crm/send-ledger"),
    envio: await import("@/lib/agent-engine/edge/crm/send-message"),
    handler: await import("@/app/api/v1/messages/_handler"),
    duble: await import("@/tests/helpers/duble-do-handler"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'c01-gancho','Gancho','Gancho') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number, email)
     values ($1,$2,$3,$4,$5) on conflict (id) do nothing`,
    [CONTACT, ORG, NOME, TELEFONE, EMAIL],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id,
                                   meta_waba_id, status, webhook_secret_encrypted)
     values ($1,$2,'meta_cloud','111','333','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group, last_inbound_at)
     values ($1,$2,$3,$4,'open',false,$5) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION, MENSAGEM_DO_CLIENTE_EM],
  );
  // A organização nasce com o funil padrão (gatilho do produto); sem ele, um nosso.
  await pool.query(
    `insert into crm_pipelines (id, organization_id, name, slug, is_default)
     select $1,$2,'Vendas','vendas',true
      where not exists (select 1 from crm_pipelines where organization_id = $2 and is_default)`,
    [PIPELINE, ORG],
  );
  const { rows: funil } = await pool.query<{ id: string }>(
    "select id from crm_pipelines where organization_id = $1 and is_default limit 1",
    [ORG],
  );
  await pool.query(
    `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
     values ($1,$2,$3,'Gancho novo','gancho-novo',999) on conflict (id) do nothing`,
    [ETAPA, ORG, funil[0]!.id],
  );
  await pool.query(
    `insert into crm_leads (id, organization_id, pipeline_id, stage_id, contact_id, title)
     values ($1,$2,$3,$4,$5,'Card do teste') on conflict (id) do nothing`,
    [CARD, ORG, funil[0]!.id, ETAPA, CONTACT],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1,$2,'Agente do gancho','Você é um atendente de teste.','mcp_agent') on conflict (id) do nothing`,
    [AGENTE, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at, token_budget, max_steps)
     values ($1,$2,$3,1,'Você é um atendente de teste.','anthropic','claude-sonnet-4-6',$4,'published',now(),100000,4)
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

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  pedidosAoGancho = [];
  postsNaGraph = [];
  statusDaGraph = [];
  enviosAoCanal = [];
  linhasDoLog = [];
  respostaDoGancho = async () => json({ acao: "seguir" });
  await pool.query("delete from agent_case_events where organization_id = $1", [ORG]);
  await pool.query("delete from agent_cases where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("update job_queue set status = 'done' where organization_id = $1 and status in ('pending', 'running')", [ORG]);
  // A janela do anti-spinning cruza leads e testes: a mesma resposta do modelo seria
  // vetada a partir da terceira vez.
  await pool.query("delete from outbound_copies where organization_id = $1", [ORG]);
  await pool.query(
    "update crm_leads set custom_fields = $3::jsonb, tags = $4::text[], contact_id = $5 where organization_id = $1 and id = $2",
    [ORG, CARD, JSON.stringify(CAMPOS_INICIAIS), ETIQUETAS_INICIAIS, CONTACT],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Oi, quero saber mais','external_device',$6)`,
    [MSG, ORG, CONV, SESSION, CONTACT, MENSAGEM_DO_CLIENTE_EM],
  );
});

/** A resposta de um formulário como a entrada a grava (item A): texto neutro, original no metadata. */
async function respostaDeFormulario(): Promise<string> {
  const id = randomUUID();
  const bruto = '{"flow_token":"tok-teste","pergunta_1":"opcao_a","pergunta_2":"opcao_b"}';
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, metadata)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Formulário respondido','external_device',$6,$7::jsonb)`,
    [
      id,
      ORG,
      CONV,
      SESSION,
      CONTACT,
      "2026-07-30T14:58:00Z",
      JSON.stringify({
        interactive: {
          type: "nfm_reply",
          name: "flow",
          body: "Sent",
          flow_token: "tok-teste",
          response: JSON.parse(bruto),
          raw: bruto,
        },
        raw_type: "interactive",
      }),
    ],
  );
  return id;
}

describe("2. sem o gancho no ambiente, o turno é o de antes", () => {
  it("o modelo responde e nenhuma chamada a mais sai (nem ao gancho, nem anotação no job)", async () => {
    const mod = modelo();
    const jobId = await enfileira(MSG);
    expect(await executa(montaHandler(mod.doGenerate, false), jobId)).toBeNull();

    expect(pedidosAoGancho).toEqual([]);
    expect(mod.estado.etapas).toBeGreaterThanOrEqual(1);
    expect(postsNaGraph).toHaveLength(1);
    expect((postsNaGraph[0]!.text as { body: string }).body).toBe(RESPOSTA_DO_MODELO);
    expect(await anotacaoDoJob(jobId)).toBeUndefined();
    expect(await card()).toEqual({ custom_fields: CAMPOS_INICIAIS, tags: ETIQUETAS_INICIAIS });
  });
});

describe("3. `seguir` com `gravar` e `resumo`", () => {
  it("campos e etiquetas no card, o texto do formulário vira o resumo e o modelo o lê", async () => {
    const formularioId = await respostaDeFormulario();
    const RESUMO = "Respostas do formulário: pergunta 1, opção A; pergunta 2, opção B.";
    respostaDoGancho = async () =>
      json({
        acao: "seguir",
        motivo: "formulario",
        gravar: {
          campos: { pergunta_1: "opcao_a", respondido_em: "2026-07-30T14:58:00Z" },
          etiquetas_mais: ["Respondeu"],
          etiquetas_menos: ["aguardando"],
        },
        resumo: RESUMO,
      });
    const mod = modelo();
    const jobId = await enfileira(formularioId);
    expect(await executa(montaHandler(mod.doGenerate, true), jobId)).toBeNull();

    // O pedido levou o formulário que este turno atende.
    expect(pedidosAoGancho).toHaveLength(1);
    const pedido = JSON.parse(pedidosAoGancho[0]!.corpo) as Record<string, unknown>;
    expect(pedido.formulario).toEqual({
      mensagem_id: formularioId,
      resposta: { flow_token: "tok-teste", pergunta_1: "opcao_a", pergunta_2: "opcao_b" },
      flow_token: "tok-teste",
      bruto: '{"flow_token":"tok-teste","pergunta_1":"opcao_a","pergunta_2":"opcao_b"}',
    });

    // gravar: merge raso nos campos (os de antes ficam), etiqueta somada e tirada.
    const depois = await card();
    expect(depois.custom_fields).toEqual({
      ...CAMPOS_INICIAIS,
      pergunta_1: "opcao_a",
      respondido_em: "2026-07-30T14:58:00Z",
    });
    expect(depois.tags).toEqual(["etiqueta-antiga", "respondeu"]);

    // O texto da resposta do formulário virou o resumo; o original ficou no metadata.
    const { rows } = await pool.query<{ body: string; metadata: { interactive: { type: string } } }>(
      "select body, metadata from messages where id = $1",
      [formularioId],
    );
    expect(rows[0]!.body).toBe(RESUMO);
    expect(rows[0]!.metadata.interactive.type).toBe("nfm_reply");

    // O modelo foi chamado e leu o resumo (e não o texto neutro) e os campos do card.
    expect(mod.estado.etapas).toBeGreaterThanOrEqual(1);
    const prompt = mod.estado.prompts[0]!;
    expect(prompt).toContain(RESUMO);
    expect(prompt).not.toContain("Formulário respondido");
    // Os campos do card, relidos depois do `gravar`: o que o formulário gravou já aparece.
    expect(prompt).toContain("campos_do_card");
    expect(prompt).toContain("respondido_em");
    expect(postsNaGraph).toHaveLength(1);
    expect((postsNaGraph[0]!.text as { body: string }).body).toBe(RESPOSTA_DO_MODELO);
  });
});

describe("4. `segurar`: o gancho responde e o turno termina", () => {
  const SEGURAR = {
    acao: "segurar",
    motivo: "completo",
    enviar: [{ tipo: "interativo", interactive: FORMULARIO }],
    gravar: {
      campos: { enviado_em: "2026-07-30T15:00:00Z", lembretes: 0 },
      etiquetas_mais: ["aguardando"],
    },
  };

  it("o formulário sai pela Graph com o corpo exato; sem modelo, sem fail-safe; gravar aplicado; mensagem registrada", async () => {
    respostaDoGancho = async () => json(SEGURAR);
    const mod = modelo();
    const jobId = await enfileira(MSG);
    expect(await executa(montaHandler(mod.doGenerate, true), jobId)).toBeNull();

    expect(postsNaGraph).toEqual([
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: "5511900000881",
        type: "interactive",
        interactive: FORMULARIO,
      },
    ]);
    expect(mod.estado.etapas).toBe(0);
    expect(await casosAbertos()).toBe(0);
    expect(enviosAoCanal.map((e) => e.seq)).toEqual([-1]);

    const saida = await mensagensDeSaida();
    expect(saida).toHaveLength(1);
    expect(saida[0]!.type).toBe("text");
    expect(saida[0]!.body).toBe(FORMULARIO.body.text);
    expect(saida[0]!.metadata.interactive).toEqual(FORMULARIO);
    expect(saida[0]!.metadata.origem).toBe("pre_turn_hook");

    const depois = await card();
    expect(depois.custom_fields).toEqual({
      ...CAMPOS_INICIAIS,
      enviado_em: "2026-07-30T15:00:00Z",
      lembretes: 0,
    });
    expect(depois.tags).toEqual(ETIQUETAS_INICIAIS);
    expect(await anotacaoDoJob(jobId)).toMatchObject({ situacao: "decidido", resposta: { acao: "segurar" } });
  });

  it("o turno seguinte vê o formulário enviado: `interativo` da saída é o objeto que saiu (`metadata.interactive`)", async () => {
    respostaDoGancho = async () => json(SEGURAR);
    const mod = modelo();
    const handler = montaHandler(mod.doGenerate, true);
    expect(await executa(handler, await enfileira(MSG))).toBeNull();

    const nova = randomUUID();
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at)
       values ($1,$2,$3,$4,$5,'text','inbound','delivered','Recebi, já vou responder','external_device', now())`,
      [nova, ORG, CONV, SESSION, CONTACT],
    );
    respostaDoGancho = async () => json({ acao: "segurar", motivo: "aguardando", enviar: [] });
    expect(await executa(handler, await enfileira(nova))).toBeNull();

    expect(pedidosAoGancho).toHaveLength(2);
    const segundo = JSON.parse(pedidosAoGancho[1]!.corpo) as { mensagens: Array<Record<string, unknown>> };
    expect(segundo.mensagens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direcao: "saida", texto: FORMULARIO.body.text, interativo: FORMULARIO }),
        expect.objectContaining({ direcao: "entrada", texto: "Recebi, já vou responder", interativo: null }),
      ]),
    );
    expect(postsNaGraph).toHaveLength(1);
  });

  it("a re-execução do mesmo job não pergunta de novo ao gancho nem envia de novo", async () => {
    let chamadas = 0;
    respostaDoGancho = async () => {
      chamadas += 1;
      // Perguntado de novo, o serviço veria o formulário já enviado e mandaria o lembrete.
      return json(chamadas === 1 ? SEGURAR : { ...SEGURAR, motivo: "lembrete", enviar: [{ tipo: "texto", texto: "Lembrete!" }] });
    };
    const mod = modelo();
    const handler = montaHandler(mod.doGenerate, true);
    const jobId = await enfileira(MSG);
    expect(await executa(handler, jobId)).toBeNull();
    expect(await reexecuta(handler, jobId)).toBeNull();

    expect(chamadas).toBe(1);
    expect(postsNaGraph).toHaveLength(1);
    expect(await mensagensDeSaida()).toHaveLength(1);
    expect(mod.estado.etapas).toBe(0);
    const { rows } = await pool.query<{ seq: number; status: string }>(
      "select seq, status from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows).toEqual([{ seq: -1, status: "accepted" }]);
  });

  it("`enviar: []` (aguardando): grava, encerra o turno sem modelo e sem fail-safe, nada sai; a re-execução também não", async () => {
    let chamadas = 0;
    respostaDoGancho = async () => {
      chamadas += 1;
      return json({ acao: "segurar", motivo: "aguardando", enviar: [], gravar: { campos: { aguardando_desde: "2026-07-30T15:00:00Z" } } });
    };
    const mod = modelo();
    const handler = montaHandler(mod.doGenerate, true);
    const jobId = await enfileira(MSG);
    expect(await executa(handler, jobId)).toBeNull();
    expect(await reexecuta(handler, jobId)).toBeNull();

    expect(chamadas).toBe(1);
    expect(postsNaGraph).toEqual([]);
    expect(enviosAoCanal).toEqual([]);
    expect(await mensagensDeSaida()).toEqual([]);
    expect(mod.estado.etapas).toBe(0);
    expect(await casosAbertos()).toBe(0);
    expect((await card()).custom_fields).toEqual({ ...CAMPOS_INICIAIS, aguardando_desde: "2026-07-30T15:00:00Z" });
    expect(await anotacaoDoJob(jobId)).toMatchObject({ situacao: "decidido", resposta: { acao: "segurar", enviar: [] } });
  });

  it("envio parcial (o 1º saiu, o 2º a Graph recusou): grava, encerra sem o modelo e registra no log", async () => {
    respostaDoGancho = async () =>
      json({
        acao: "segurar",
        enviar: [
          { tipo: "texto", texto: "Já te mando as perguntas." },
          { tipo: "interativo", interactive: FORMULARIO },
        ],
        gravar: { campos: { enviado_em: "2026-07-30T15:00:00Z" }, etiquetas_mais: ["respondeu"] },
      });
    statusDaGraph = [200, 500];
    const mod = modelo();
    const jobId = await enfileira(MSG);
    expect(await executa(montaHandler(mod.doGenerate, true), jobId)).toBeNull();

    expect(postsNaGraph.map((p) => p.type)).toEqual(["text", "interactive"]);
    expect(mod.estado.etapas).toBe(0);
    expect(await casosAbertos()).toBe(0);
    const depois = await card();
    expect(depois.custom_fields).toEqual({ ...CAMPOS_INICIAIS, enviado_em: "2026-07-30T15:00:00Z" });
    expect(depois.tags).toEqual([...ETIQUETAS_INICIAIS, "respondeu"]);
    const { rows } = await pool.query<{ seq: number; status: string }>(
      "select seq, status from send_ledger where organization_id = $1 and job_id = $2 order by seq desc",
      [ORG, jobId],
    );
    expect(rows.map((r) => r.seq)).toEqual([-1, -2]);
    expect(rows[0]!.status).toBe("accepted");
    expect(rows[1]!.status).not.toBe("accepted");
    const parcial = linhasDoLog.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => String(l.msg).includes("envio parcial"));
    expect(parcial).toMatchObject({ level: "warn", item: 2, enviadas: 1 });
  });
});

describe("4b. conversa sem card do funil (contato sem `crm_lead`)", () => {
  it("o pedido vai com `lead.id` nulo; o `segurar` envia e encerra; o `gravar` não tem onde gravar e fica no log", async () => {
    await pool.query("update crm_leads set contact_id = null where organization_id = $1 and id = $2", [ORG, CARD]);
    respostaDoGancho = async () =>
      json({
        acao: "segurar",
        enviar: [{ tipo: "interativo", interactive: FORMULARIO }],
        gravar: { campos: { enviado_em: "2026-07-30T15:00:00Z" }, etiquetas_mais: ["aguardando"] },
      });
    const mod = modelo();
    const jobId = await enfileira(MSG);
    expect(await executa(montaHandler(mod.doGenerate, true), jobId)).toBeNull();

    const pedido = JSON.parse(pedidosAoGancho[0]!.corpo) as { lead: unknown };
    expect(pedido.lead).toEqual({ id: null, etapa: null, campos: {}, etiquetas: [] });
    expect(postsNaGraph.map((p) => p.type)).toEqual(["interactive"]);
    expect(mod.estado.etapas).toBe(0);
    // O card que existia (agora sem contato) não é tocado: o gancho não cria card.
    expect(await card()).toEqual({ custom_fields: CAMPOS_INICIAIS, tags: ETIQUETAS_INICIAIS });
    const { rows } = await pool.query<{ n: string }>(
      "select count(*) as n from crm_leads where organization_id = $1 and contact_id = $2",
      [ORG, CONTACT],
    );
    expect(Number(rows[0]!.n)).toBe(0);
    expect(linhasDoLog.some((l) => l.includes("sem card do funil para gravar"))).toBe(true);
  });
});

describe("3b. o gancho só vale no turno aberto por mensagem do cliente", () => {
  it("o turno de follow-up (`followup_turn`, retorno prometido) roda o modelo sem chamar o gancho", async () => {
    const boundary = await criarOrigemDeFollowup(pool, ORG, CONTACT);
    expect(boundary.conversation_id).toBe(CONV);
    const { rows } = await pool.query<{ id: string }>(
      `insert into job_queue (organization_id, contact_id, kind, payload, max_attempts)
       values ($1, $2, 'followup_turn', $3::jsonb, 3) returning id`,
      [ORG, CONTACT, JSON.stringify({ reason: "retorno combinado", promise: "voltar a falar", service_boundary: boundary })],
    );
    const jobId = rows[0]!.id;
    respostaDoGancho = async () =>
      json({ acao: "segurar", enviar: [{ tipo: "texto", texto: "não devia sair" }] });
    const mod = modelo();
    const handler = m.followup.createFollowupTurnHandler(depsDoTurno(mod.doGenerate, true));
    expect(await executa(handler as never, jobId)).toBeNull();

    expect(pedidosAoGancho).toEqual([]);
    expect(mod.estado.etapas).toBeGreaterThanOrEqual(1);
    expect(postsNaGraph.map((p) => (p.text as { body: string } | undefined)?.body)).toEqual([RESPOSTA_DO_MODELO]);
    expect(await anotacaoDoJob(jobId)).toBeUndefined();
  });
});

describe("5. falha do gancho: o modelo responde e nada é gravado", () => {
  const SEGURAR_COM_GRAVAR = {
    acao: "segurar",
    enviar: [{ tipo: "interativo", interactive: FORMULARIO }],
    gravar: { campos: { nao_deve_gravar: true }, etiquetas_mais: ["nao-deve-gravar"] },
  };

  async function esperaModeloSemGravar(jobId: string, mod: ReturnType<typeof modelo>) {
    expect(mod.estado.etapas).toBeGreaterThanOrEqual(1);
    expect(postsNaGraph.at(-1)!.type).toBe("text");
    expect((postsNaGraph.at(-1)!.text as { body: string }).body).toBe(RESPOSTA_DO_MODELO);
    expect(await card()).toEqual({ custom_fields: CAMPOS_INICIAIS, tags: ETIQUETAS_INICIAIS });
    expect(await anotacaoDoJob(jobId)).toMatchObject({ situacao: "modelo" });
    expect(await casosAbertos()).toBe(0);
  }

  it("prazo estourado", async () => {
    respostaDoGancho = (init) =>
      new Promise<Response>((_, rejeita) => {
        init.signal?.addEventListener("abort", () => rejeita(init.signal!.reason));
      });
    const mod = modelo();
    const jobId = await enfileira(MSG);
    expect(await executa(montaHandler(mod.doGenerate, true), jobId)).toBeNull();
    expect(pedidosAoGancho).toHaveLength(1);
    expect(await anotacaoDoJob(jobId)).toEqual({ situacao: "modelo", motivo: "prazo" });
    await esperaModeloSemGravar(jobId, mod);
  });

  it("500", async () => {
    respostaDoGancho = async () => json(SEGURAR_COM_GRAVAR, 500);
    const mod = modelo();
    const jobId = await enfileira(MSG);
    expect(await executa(montaHandler(mod.doGenerate, true), jobId)).toBeNull();
    expect(await anotacaoDoJob(jobId)).toEqual({ situacao: "modelo", motivo: "status" });
    await esperaModeloSemGravar(jobId, mod);
  });

  it("resposta fora do contrato (`segurar` sem a lista `enviar`, e JSON quebrado)", async () => {
    for (const corpo of [
      JSON.stringify({ acao: "segurar", gravar: SEGURAR_COM_GRAVAR.gravar }),
      '{"acao": "segurar",',
    ]) {
      postsNaGraph = [];
      await pool.query("delete from messages where organization_id = $1 and direction = 'outbound'", [ORG]);
      await pool.query("delete from outbound_copies where organization_id = $1", [ORG]);
      respostaDoGancho = async () => new Response(corpo, { status: 200 });
      const mod = modelo();
      const jobId = await enfileira(MSG);
      expect(await executa(montaHandler(mod.doGenerate, true), jobId)).toBeNull();
      expect(await anotacaoDoJob(jobId)).toEqual({ situacao: "modelo", motivo: "resposta_invalida" });
      await esperaModeloSemGravar(jobId, mod);
    }
  });

  it("o envio do `segurar` falha na Graph: o modelo responde, e o gravar daquela resposta não vale", async () => {
    respostaDoGancho = async () => json(SEGURAR_COM_GRAVAR);
    statusDaGraph = [500];
    const mod = modelo();
    const jobId = await enfileira(MSG);
    expect(await executa(montaHandler(mod.doGenerate, true), jobId)).toBeNull();

    expect(postsNaGraph[0]!.type).toBe("interactive");
    expect(postsNaGraph).toHaveLength(2);
    expect(await anotacaoDoJob(jobId)).toMatchObject({ situacao: "modelo" });
    await esperaModeloSemGravar(jobId, mod);
    // A posição negativa que falhou é do gancho: a resposta do modelo não a herda.
    const { rows } = await pool.query<{ seq: number; status: string }>(
      "select seq, status from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows.find((r) => r.seq === -1)?.status).not.toBe("accepted");
    expect(rows.filter((r) => r.seq > 0).map((r) => r.status)).toEqual(["accepted"]);
  });
});

describe("6. assinatura e dado pessoal", () => {
  it("a assinatura confere com o segredo; o pedido não leva telefone, e-mail nem nome", async () => {
    const mod = modelo();
    const jobId = await enfileira(MSG);
    expect(await executa(montaHandler(mod.doGenerate, true), jobId)).toBeNull();

    expect(pedidosAoGancho).toHaveLength(1);
    const { corpo, assinatura } = pedidosAoGancho[0]!;
    const partes = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(assinatura ?? "");
    expect(partes).not.toBeNull();
    const esperado = createHmac("sha256", GANCHO.segredo).update(`${partes![1]}.${corpo}`, "utf8").digest("hex");
    expect(partes![2]).toBe(esperado);
    expect(Math.abs(Number(partes![1]) - Date.now() / 1000)).toBeLessThan(300);

    for (const pessoal of [NOME, TELEFONE, TELEFONE.slice(1), EMAIL, "5511988887777", "outro@teste.example"])
      expect(corpo).not.toContain(pessoal);

    const pedido = JSON.parse(corpo) as {
      versao: number;
      evento: string;
      organizacao_id: string;
      agente_id: string;
      conversa: Record<string, unknown>;
      lead: { id: string; etapa: string; campos: Record<string, unknown>; etiquetas: string[] };
      mensagens: Array<Record<string, unknown>>;
      formulario?: unknown;
    };
    expect(pedido).toMatchObject({
      versao: 1,
      evento: "turno",
      organizacao_id: ORG,
      agente_id: AGENTE,
      conversa: { id: CONV, canal: "meta", pessoa_atendendo: false },
      lead: { id: CARD, etapa: "gancho-novo", etiquetas: ETIQUETAS_INICIAIS },
    });
    expect(pedido.lead.campos).toEqual({ interesse: "plano-b", _interno: { origem: "importacao" } });
    expect(pedido.mensagens).toEqual([
      { direcao: "entrada", texto: "Oi, quero saber mais", em: "2026-07-30T14:55:00.000Z", interativo: null },
    ]);
    expect(pedido.formulario).toBeUndefined();
  });
});
