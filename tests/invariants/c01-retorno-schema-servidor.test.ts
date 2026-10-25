import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/** Turno/SDK/SQL reais; modelo, canal e situação financeira fictícios. Nenhum provedor. */
vi.mock('@/lib/leads/fonte-financeira', () => ({
  lerSituacaoFinanceira: async ({ now }: { now: Date }) => ({
    status: 'nao_comprou_confirmado', complete: true, checkedAt: now.toISOString(), reason: 'fixture',
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

const ORG = "b7b7b7b7-0000-4000-8000-000000000001";
const CONTACT = "b7b7b7b7-0000-4000-8000-000000000002";
const SESSION = "b7b7b7b7-0000-4000-8000-000000000003";
const CONV = "b7b7b7b7-0000-4000-8000-000000000004";
const MSG = "b7b7b7b7-0000-4000-8000-000000000005";

interface EnvioCapturado {
  body: string;
  media?: { type?: string; mime?: string };
}

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: EnvioCapturado[] = [];
/** Todo resultado de tool que o modelo VIU — inclui repetição entre steps, de propósito
 * (o que importa é que o bloqueio apareceu em algum lugar, não em qual exatamente). */
let resultadosVistos: unknown[] = [];

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

type Entrada = { nome?: string; args: Record<string, unknown>; antes?: () => Promise<void> };
const AGORA = new Date('2026-10-24T15:00:00Z');
const PEDIDO = { reason: 'Retorno solicitado', promised_at: '2026-10-25T13:00:00Z', promise: 'Amanhã às 10h' };
const USER = 'b7b7b7b7-0000-4000-8000-000000000010';
const AGENT = 'b7b7b7b7-0000-4000-8000-000000000011';
const VERSION = 'b7b7b7b7-0000-4000-8000-000000000012';
const PIPELINE = 'b7b7b7b7-0000-4000-8000-000000000013';
const STAGE = 'b7b7b7b7-0000-4000-8000-000000000014';
const LEAD = 'b7b7b7b7-0000-4000-8000-000000000015';
const OFFER = 'b7b7b7b7-0000-4000-8000-000000000016';
let schemasVistos: Array<Record<string, unknown>> = [];
async function politica(value: unknown) {
  await pool.query("update organizations set settings = $2 where id = $1", [ORG, { c01_native_videos: value, llm: { default_model: 'claude-sonnet-4-6' }, jev: { ligado: false } }]);
}
function modelo(entradas: Entrada[], antesDoEnvio?: () => Promise<void>) {
  let chamadas = 0;
  return async (opts: { prompt?: unknown; tools?: unknown }) => {
    for (const t of (opts.tools ?? []) as Array<{ name: string; inputSchema?: Record<string, unknown> }>) {
      if (t.name === 'schedule_followup' && t.inputSchema) schemasVistos.push(t.inputSchema);
    }
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === 'tool-result') resultadosVistos.push(parte.output ?? parte);
      }
    }
    const entrada = entradas[chamadas];
    if (entrada) {
      if (chamadas === 0) await antesDoEnvio?.();
      await entrada.antes?.();
      chamadas += 1;
      return {
        content: [{ type: 'tool-call' as const, toolCallId: `c${chamadas}`, toolName: entrada.nome ?? 'schedule_followup', input: JSON.stringify(entrada.args) }],
        finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USO, warnings: [],
      };
    }
    return { content: [{ type: 'text' as const, text: CHECKPOINT }], finishReason: { unified: 'stop' as const, raw: undefined }, usage: USO, warnings: [] };
  };
}

function montaHandler(doGenerate: unknown, maxSendsPerTurn?: number) {
  return m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      followup: { minAheadMs: 30 * 60000, maxAheadMs: 30 * 86400000, staggerWindowMs: 0 },
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      ...(maxSendsPerTurn !== undefined ? { maxSendsPerTurn } : {}),
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
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: EnvioCapturado) => {
          enviados.push(i);
          return { kind: "sent" as const, idempotencyKey: `k${enviados.length}`, messageId: `m${enviados.length}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    // Meio-dia BRT: dentro da faixa de atendimento.
    clock: () => AGORA,
    sleep: async () => {},
    copiarVideo: async () => true,
    copiarFoto: async () => true,
  });
}

async function rodaTurno(handler: ReturnType<typeof montaHandler>): Promise<Error | null> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: MSG,
      crm_event_id: "b7b7b7b7-0000-4000-8000-000000000006",
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "callback-schema", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "callback-schema" });
    await m.queue.completeJob(pool, claimed!.id, "callback-schema");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "callback-schema", err);
    return err as Error;
  }
}

beforeAll(async () => {
  m = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'callback-schema-turno','Vídeo Schema','Vídeo Schema') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Pessoa fictícia','+5511900000888') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'callback-schema-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','Oi','external_device', now())
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
  await pool.query('insert into auth.users(id,email) values($1,$2)', [USER, 'callback@example.test']);
  await pool.query("insert into user_organizations(user_id,organization_id,role) values($1,$2,'admin')", [USER, ORG]);
  await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Fictício','ficticio')", [PIPELINE, ORG]);
  await pool.query("insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Aberto','aberto',1000)", [STAGE, ORG, PIPELINE]);
  await pool.query("insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,custom_fields) values($1,$2,$3,$4,$5,'Fictício',$6)", [LEAD, ORG, PIPELINE, STAGE, CONTACT, { produto_chave: 'produto-ficticio' }]);
  await pool.query("insert into ai_agents(id,organization_id,name,system_prompt,kind,operation_mode,created_by) values($1,$2,'Fictício','Atenda ao pedido.','mcp_agent','automatic',$3)", [AGENT, ORG, USER]);
  await pool.query(`insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,max_steps,token_budget,tool_ids,pipeline_ids,created_by,followup)
    values($1,$2,$3,1,'Atenda ao pedido.','anthropic','claude-sonnet-4-6',$4,'draft',12,500000,'{}',$5,$6,$7)`, [VERSION, ORG, AGENT, SESSION, [PIPELINE], USER, { enabled: true, callback_enabled: true, c01_callback: true }]);
  await pool.query('update ai_agents set published_version_id=$1 where id=$2', [VERSION, AGENT]);
  await pool.query("update ai_agent_versions set status='published',published_at=now() where id=$1", [VERSION]);
  await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,external_id)
    values($1,$2,$3,$4,$5,'text','outbound','delivered','Posso te chamar amanhã às 10h?',$6,'oferta-ficticia-entregue')`, [OFFER, ORG, CONV, SESSION, CONTACT, new Date(+AGORA - 60000)]);
  vi.stubEnv('C01_ACOMPANHAMENTO_INTEGRATION', JSON.stringify({ enabled: true, organizationId: ORG, tokenSha256: 'a'.repeat(64), signingKey: 'b'.repeat(40), allowedKinds: ['oferta', 'cronograma'] }));

});

afterAll(async () => { vi.unstubAllEnvs(); await pool.end(); });
beforeEach(async () => {
  enviados = [];
  resultadosVistos = [];
  schemasVistos = [];
  await politica(undefined);
  await pool.query("delete from cron_jobs where organization_id=$1", [ORG]);
  await pool.query("delete from messages where organization_id=$1 and id not in ($2,$3)", [ORG, MSG, OFFER]);
  await pool.query("update messages set body='Posso te chamar amanhã às 10h?',sent_at=$2 where id=$1", [OFFER, new Date(+AGORA - 60000)]);
  await pool.query("update messages set body='sim',sent_at=$2 where id=$1", [MSG, AGORA]);
  await pool.query("update conversations set last_inbound_at=$2 where id=$1", [CONV, AGORA]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from lead_checkpoints where organization_id = $1", [ORG]);
  await pool.query("update conversations set status = 'ai_handling', assignee_kind = 'ai', assigned_to_user_id = null, bot_silenced_until = null where id = $1", [CONV]);
  await pool.query("update contacts set force_human = false where id = $1", [CONTACT]);
});


async function crons() { return (await pool.query('select id,payload,enabled from cron_jobs where organization_id=$1', [ORG])).rows; }
function chamar(args: Record<string, unknown>, antes?: () => Promise<void>): Entrada { return { args, antes }; }

describe('retorno C01 com identidade do servidor no turno real', () => {
  it('devolve card autoritativo: contrato sem IDs e cron com confirmação entregue', async () => {
    expect(await rodaTurno(montaHandler(modelo([
      chamar(PEDIDO), { nome: 'send_message', args: { body: 'Combinado, amanhã às 10h eu chamo por aqui.' } },
    ])))).toBeNull();
    const props = schemasVistos[0]?.properties;
    expect(props).not.toHaveProperty('consent_message_id');
    expect(props).not.toHaveProperty('offered_message_id');
    expect(props).not.toHaveProperty('replace_pending_id');
    expect(props).not.toHaveProperty('crm_lead_id');
    expect(props).toHaveProperty('substituir_pendente');
    expect(schemasVistos[0]?.additionalProperties).toBe(false);
    const rows = await crons();
    expect(rows, JSON.stringify(resultadosVistos)).toHaveLength(1);
    expect(rows[0]?.payload.c01_callback).toMatchObject({ message_id: MSG, offered_message_id: OFFER, lead_id: LEAD, organization_id: ORG, contact_id: CONTACT, promised_at: new Date(PEDIDO.promised_at).toISOString() });
    expect(enviados).toHaveLength(1);
    expect(JSON.stringify(resultadosVistos)).toContain('agendado');
    expect(JSON.stringify(resultadosVistos)).toContain(`"crm_lead_id":"${LEAD}"`);
    expect(JSON.stringify(resultadosVistos)).not.toContain(`"crm_lead_id":"${CONTACT}"`);
    expect(JSON.stringify(resultadosVistos)).not.toContain(MSG);
  });
  it.each(['consent_message_id', 'offered_message_id', 'replace_pending_id', 'crm_lead_id'])('recusa %s injetado antes do executor', async (key) => {
    expect(await rodaTurno(montaHandler(modelo([chamar({ ...PEDIDO, [key]: '00000000-0000-0000-0000-000000000000' })])))).toBeNull();
    expect(await crons()).toHaveLength(0);
    expect(enviados).toHaveLength(0);
    expect(JSON.stringify(resultadosVistos)).toContain('error');
  });
  it('não devolve card autoritativo na recusa de horário sem consentimento', async () => {
    expect(await rodaTurno(montaHandler(modelo([chamar({ ...PEDIDO, promised_at: '2026-10-25T14:00:00Z' })])))).toBeNull();
    expect(await crons()).toHaveLength(0);
    expect(JSON.stringify(resultadosVistos)).toContain('callback_not_confirmed');
    expect(JSON.stringify(resultadosVistos)).not.toContain('crm_lead_id');
  });
  it('recusa pedido inválido sem candidatura', async () => {
    expect(await rodaTurno(montaHandler(modelo([chamar({ ...PEDIDO, reason: '' })])))).toBeNull();
    expect(await crons()).toHaveLength(0);
  });
  it('não aceita consentimento de outro turno injetado no job', async () => {
    expect(await rodaTurno(montaHandler(modelo([chamar(PEDIDO, async () => {
      await pool.query("update job_queue set payload=jsonb_set(payload,'{inbound_message_id}',to_jsonb($2::text)) where organization_id=$1 and status='running'", [ORG, OFFER]);
    })])))).toBeNull();
    expect(await crons()).toHaveLength(0);
    expect(JSON.stringify(resultadosVistos)).toContain('callback_not_confirmed');
  });
  it('devolve card autoritativo na remarcação, uma linha só e sem UUID do cron no resultado', async () => {
    expect(await rodaTurno(montaHandler(modelo([chamar(PEDIDO)])))).toBeNull();
    const anterior = (await crons())[0]!.id;
    resultadosVistos = [];
    expect(await rodaTurno(montaHandler(modelo([chamar(PEDIDO), chamar({ ...PEDIDO, substituir_pendente: true })])))).toBeNull();
    const rows = await crons();
    expect(rows, JSON.stringify(resultadosVistos)).toHaveLength(1);
    expect(rows[0]?.id).toBe(anterior);
    expect(JSON.stringify(resultadosVistos)).toContain('already_pending');
    expect(JSON.stringify(resultadosVistos)).toContain('reagendado');
    expect(JSON.stringify(resultadosVistos)).toContain(`"crm_lead_id":"${LEAD}"`);
    expect(JSON.stringify(resultadosVistos)).not.toContain(anterior);
  });
  it('recusa pendente cancelado entre observação e substituição, sem criar outro', async () => {
    expect(await rodaTurno(montaHandler(modelo([chamar(PEDIDO)])))).toBeNull();
    resultadosVistos = [];
    expect(await rodaTurno(montaHandler(modelo([
      chamar(PEDIDO), chamar({ ...PEDIDO, substituir_pendente: true }, async () => {
        await pool.query('update cron_jobs set enabled=false where organization_id=$1', [ORG]);
      }),
    ])))).toBeNull();
    expect(await crons()).toHaveLength(1);
    expect((await crons())[0]?.enabled).toBe(false);
    expect(JSON.stringify(resultadosVistos)).toContain('pending_changed');
  });
});


describe('precisão SQL do consentimento do retorno C01', () => {
  async function entre(instante: string, body = 'Uma mensagem intermediária.') {
    await pool.query(`insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,
      type,direction,status,body,sent_at,external_id) values('b7b7b7b7-0000-4000-8000-000000000017',$1,$2,$3,$4,
      'text','outbound','delivered',$5,$6,'intermediaria-ficticia')`, [ORG, CONV, SESSION, CONTACT, body, instante]);
  }
  async function espera(n: number) {
    expect(await rodaTurno(montaHandler(modelo([chamar(PEDIDO)])))).toBeNull();
    expect(await crons(), JSON.stringify(resultadosVistos)).toHaveLength(n);
    if (!n) expect(JSON.stringify(resultadosVistos)).toContain('callback_not_confirmed');
  }
  it('oferta com microssegundos não se reencontra como interveniente', async () => {
    await pool.query("update messages set sent_at='2026-10-24T14:59:00.000123Z' where id=$1", [OFFER]);
    await espera(1);
  });
  it('oferta e aceite distintos dentro do mesmo milissegundo mantêm a ordem real', async () => {
    await pool.query("update messages set sent_at='2026-10-24T15:00:00.000100Z' where id=$1", [OFFER]);
    await pool.query("update messages set sent_at='2026-10-24T15:00:00.000800Z' where id=$1", [MSG]);
    await espera(1);
  });
  it('mensagem real na fração do milissegundo anterior ao aceite continua recusada', async () => {
    await pool.query("update messages set sent_at='2026-10-24T15:00:00.000800Z' where id=$1", [MSG]);
    await entre('2026-10-24T15:00:00.000500Z');
    await espera(0);
  });
  it.each([
    ['oferta', '2026-10-24T14:59:00.000000Z'],
    ['aceite', '2026-10-24T15:00:00.000000Z'],
  ])('terceira mensagem empatada com %s deixa o vínculo ambíguo', async (_name, instante) => {
    await entre(instante, 'Posso te chamar amanhã às 10h?');
    await espera(0);
  });
});
