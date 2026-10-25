import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/** Turno real + SDK real + PostgreSQL descartável; modelo/canal/cópia fictícios.
 * OFF não oferece argumento de vídeo e nunca o descarta para enviar só legenda.
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

const ORG = "b6b6b6b6-0000-4000-8000-000000000001";
const CONTACT = "b6b6b6b6-0000-4000-8000-000000000002";
const SESSION = "b6b6b6b6-0000-4000-8000-000000000003";
const CONV = "b6b6b6b6-0000-4000-8000-000000000004";
const MSG = "b6b6b6b6-0000-4000-8000-000000000005";

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

type Entrada = { body: string; produto_codigo?: string; video_chave?: string };
let schemasVistos: Array<Record<string, unknown>> = [];
const POLITICA = { enabled: true, catalog: [{ key: 'fixture', sha256: 'a'.repeat(64) }] };
async function politica(value: unknown) {
  await pool.query("update organizations set settings = $2 where id = $1", [ORG, { c01_native_videos: value, llm: { default_model: 'claude-sonnet-4-6' }, jev: { ligado: false } }]);
}
function modelo(entradas: Entrada[], antesDoEnvio?: () => Promise<void>) {
  let chamadas = 0;
  return async (opts: { prompt?: unknown; tools?: unknown }) => {
    for (const t of (opts.tools ?? []) as Array<{ name: string; inputSchema?: Record<string, unknown> }>) {
      if (t.name === 'send_message' && t.inputSchema) schemasVistos.push(t.inputSchema);
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
      chamadas += 1;
      return {
        content: [{ type: 'tool-call' as const, toolCallId: `c${chamadas}`, toolName: 'send_message', input: JSON.stringify(entrada) }],
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
    // Terça, 15h BRT: dentro da janela anti-ban (7h-22h) — sem isso o gate `pacing`
    // vetaria por horário, e o teste mediria o motivo errado.
    clock: () => new Date("2026-07-28T18:00:00Z"),
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
      crm_event_id: "b6b6b6b6-0000-4000-8000-000000000006",
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "video-schema", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "video-schema" });
    await m.queue.completeJob(pool, claimed!.id, "video-schema");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "video-schema", err);
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
     values ($1,'video-schema-turno','Vídeo Schema','Vídeo Schema') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Pessoa fictícia','+5511900000888') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'video-schema-session','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
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
});

afterAll(async () => { await pool.end(); });
beforeEach(async () => {
  enviados = [];
  resultadosVistos = [];
  schemasVistos = [];
  await politica(undefined);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from lead_checkpoints where organization_id = $1", [ORG]);
  await pool.query("update conversations set status = 'ai_handling', assignee_kind = 'ai', assigned_to_user_id = null, bot_silenced_until = null where id = $1", [CONV]);
  await pool.query("update contacts set force_human = false where id = $1", [CONTACT]);
});

describe('send_message — capacidade de vídeo no schema efetivo', () => {
  it('OFF mantém a foto real do catálogo pelo executor', async () => {
    const produto = 'b6b6b6b6-0000-4000-8000-000000000011';
    const arquivo = 'b6b6b6b6-0000-4000-8000-000000000012.jpg';
    await pool.query(`insert into catalog_products (id, organization_id, codigo, nome, preco_cents, fotos)
      values ($1,$2,'FOTO-FICTICIA','Produto fictício',100,ARRAY[$3])`, [produto, ORG, `${ORG}/${produto}/${arquivo}`]);
    expect(await rodaTurno(montaHandler(modelo([{ body: 'Veja a foto.', produto_codigo: 'FOTO-FICTICIA' }])))).toBeNull();
    expect(enviados).toEqual([expect.objectContaining({ body: 'Veja a foto.', media: expect.objectContaining({ mime: 'image/jpeg', storagePath: `${ORG}/${CONV}/catalogo-${arquivo}` }) })]);
    expect(schemasVistos[0]?.properties).not.toHaveProperty('video_chave');
  });
  it('veto de estilo seguido de vídeo OFF inválido não revive o texto anterior', async () => {
    await pool.query(`update organizations set settings=jsonb_set(settings,'{travas_de_envio}','{"linguagem_formal":{"ligada":true}}'::jsonb) where id=$1`, [ORG]);
    expect(await rodaTurno(montaHandler(modelo([
      { body: 'Gostaria de continuar.' },
      { body: 'Legenda nova que não deve sair.', video_chave: 'none' },
    ])))).toBeNull();
    expect(JSON.stringify(resultadosVistos)).toContain('linguagem_formal');
    expect(JSON.stringify(resultadosVistos)).toContain('somente body');
    expect(enviados).toEqual([]);
  });
  it('nova tentativa válida após erro de schema preserva a saída útil de estilo', async () => {
    await pool.query(`update organizations set settings=jsonb_set(settings,'{travas_de_envio}','{"linguagem_formal":{"ligada":true}}'::jsonb) where id=$1`, [ORG]);
    expect(await rodaTurno(montaHandler(modelo([
      { body: 'Gostaria de retomar o assunto.' },
      { body: 'Legenda inválida descartada.', video_chave: 'none' },
      { body: 'Gostaria de explicar o próximo passo.' },
    ])))).toBeNull();
    expect(JSON.stringify(resultadosVistos)).toContain('linguagem_formal');
    expect(enviados.map(e => e.body)).toEqual(['Gostaria de explicar o próximo passo.']);
  });

  it.each([undefined, { enabled: false, catalog: [] }, { enabled: true, catalog: [{ key: 'invalida', sha256: 'x' }] }])(
    'OFF ou configuração inválida não expõe vídeo, preserva texto e fotos: %j', async (config) => {
      await politica(config);
      const body = `Texto normal com configuração ${JSON.stringify(config) ?? 'ausente'}.`;
      expect(await rodaTurno(montaHandler(modelo([{ body }])))).toBeNull();
      expect(schemasVistos.length).toBeGreaterThan(0);
      for (const schema of schemasVistos) {
        expect(schema.properties).toHaveProperty('body');
        expect(schema.properties).toHaveProperty('produto_codigo');
        expect(schema.properties).not.toHaveProperty('video_chave');
      }
      expect(enviados).toEqual([expect.objectContaining({ body })]);
    },
  );
  it('OFF recusa campo de vídeo injetado e ensina uma nova chamada só de texto', async () => {
    expect(await rodaTurno(montaHandler(modelo([
      { body: 'Legenda que não pode sair.', produto_codigo: '', video_chave: 'none' },
      { body: 'Resposta de texto feita depois da recusa.' },
    ])))).toBeNull();
    expect(enviados.map(e => e.body)).toEqual(['Resposta de texto feita depois da recusa.']);
    expect(JSON.stringify(resultadosVistos)).toMatch(/somente body|apenas body/);
  });
  it('ON expõe vídeo e envia mídia aprovada sem perder a legenda', async () => {
    await politica(POLITICA);
    expect(await rodaTurno(montaHandler(modelo([{ body: 'Legenda válida de catálogo.', video_chave: 'fixture' }])))).toBeNull();
    expect(schemasVistos[0]?.properties).toHaveProperty('video_chave');
    expect(enviados).toEqual([expect.objectContaining({ body: 'Legenda válida de catálogo.', media: expect.objectContaining({ type: 'video', mime: 'video/mp4' }) })]);
  });
  it('ON recusa combinação de mídia inválida sem degradar para texto e ensina correção', async () => {
    await politica(POLITICA);
    expect(await rodaTurno(montaHandler(modelo([
      { body: 'Legenda misturada que não pode sair.', produto_codigo: '', video_chave: 'fixture' },
      { body: 'Texto separado depois da combinação inválida.' },
    ])))).toBeNull();
    expect(enviados.map(e => e.body)).toEqual(['Texto separado depois da combinação inválida.']);
    expect(JSON.stringify(resultadosVistos)).toMatch(/video_configuracao_invalida/);
    expect(JSON.stringify(resultadosVistos)).toMatch(/somente body|apenas body/);
  });
  it('ON na montagem e OFF antes do envio continua recusando toda a mídia', async () => {
    await politica(POLITICA);
    expect(await rodaTurno(montaHandler(modelo([
      { body: 'Vídeo desligado depois de montar ferramenta.', video_chave: 'fixture' },
      { body: 'Texto novo depois de reler a capacidade.' },
    ], () => politica({ enabled: false, catalog: [] }))))).toBeNull();
    expect(schemasVistos[0]?.properties).toHaveProperty('video_chave');
    expect(enviados.map(e => e.body)).toEqual(['Texto novo depois de reler a capacidade.']);
    expect(JSON.stringify(resultadosVistos)).toMatch(/video_desligado/);
  });
});
