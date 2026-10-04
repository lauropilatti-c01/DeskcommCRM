import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as HumanHandoff from "@/lib/agent-engine/agent/human-handoff";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as SendLedger from "@/lib/agent-engine/edge/crm/send-ledger";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01, -c01.3, rodada 2) ENVIO QUE NÃO CHEGOU NÃO É RESPOSTA — achado 2 (alto) da 1ª
 * revisão adversarial do Codex da -c01.3 (04/10/2026), contra Postgres real, com modelo
 * e canal falsos (o harness de `c01-corte-antes-do-primeiro-envio.test.ts`).
 *
 * O achado: o fail-safe da última tentativa exigia `seq === 0`, e `seq` é o contador do
 * TETO de mensagens do turno — conta também o envio que o canal devolveu `failed` ou
 * `unavailable`. Um envio que falhou bloqueava a passagem à equipe como se o lead
 * tivesse recebido resposta: o turno falhava (envio 'failed' ou `runError`), o job ia a
 * 'dead' na última tentativa, e o lead ficava mudo.
 *
 * O que se prova, do jeito que o cliente sentiria:
 *   - o canal devolve `failed` na resposta, sem nada entregue antes → na última
 *     tentativa sai a frase de espera, o caso é aberto e a passagem fica gravada;
 *   - o mesmo com `unavailable`;
 *   - o corte do laço depois de um envio `failed`: a última tentativa passa à equipe
 *     uma vez; antes dela o job volta à fila sem frase (a nova tentativa roda o modelo);
 *   - a evidência que vale continua valendo, sem fail-safe em dobro: o recibo pendente
 *     que a execução anterior deixou com o canal (o ledger o recupera) e o `queued`
 *     desta execução são resposta a caminho — a falha seguinte na última tentativa não
 *     manda frase nem abre caso.
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

const ORG = "a2a2a2a2-0000-4000-8000-000000000001";
const CONTACT = "a2a2a2a2-0000-4000-8000-000000000002";
const SESSION = "a2a2a2a2-0000-4000-8000-000000000003";
const CONV = "a2a2a2a2-0000-4000-8000-000000000004";
const MSG = "a2a2a2a2-0000-4000-8000-000000000005";
const AGENTE = "a2a2a2a2-0000-4000-8000-000000000006";
const VERSAO = "a2a2a2a2-0000-4000-8000-000000000007";
/** O instante do turno (dentro da janela horária do anti-ban) e o da mensagem do cliente, 5 min antes. */
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";
/** O `token_budget` publicado: o mínimo que a coluna aceita (CHECK 1000..500000). */
const TETO = 1000;
/** O prazo por requisição ao provedor neste teste: o mecanismo real, curto. */
const PRAZO_MS = 50;

type Modules = {
  turno: typeof InboundTurn;
  ledger: typeof SendLedger;
  isLeadInHandoff: typeof HumanHandoff.isLeadInHandoff;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

type Desfecho = "sent" | "failed" | "unavailable" | "queued";
/** Tudo o que chegou ao canal, na ordem — entregue ou não. */
let enviados: Array<{ body: string }> = [];
/** O que o canal devolve a cada envio, na ordem; esgotado, `sent`. */
let desfechos: Desfecho[] = [];

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});

const uso = (entrada: number, saida: number) => ({
  inputTokens: { total: entrada, noCache: entrada, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: saida, text: saida, reasoning: 0 },
});
const USO_PEQUENO = uso(1, 1);
/** Uma etapa que sozinha passa do teto. */
const USO_ESTOURADO = uso(5 * TETO, 10);

const RESPOSTA = "Oi! Seu cadastro está ativo, sim. Quer que eu te explique os próximos passos?";

type Etapa = "responde" | "consulta_e_estoura" | "encerra" | "pendura";

/**
 * Modelo falso que segue um roteiro de etapas (fora a chamada de checkpoint):
 * `responde` manda a RESPOSTA; `consulta_e_estoura` chama `get_lead_context` com um uso
 * que sozinho passa do teto; `encerra` termina com texto; `pendura` nunca responde (só
 * o prazo por requisição a encerra). Esgotado o roteiro, encerra.
 */
function modelo(roteiro: Etapa[]) {
  const estado = { etapas: 0, checkpoints: 0 };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    if (pedeCheckpoint(opts)) {
      estado.checkpoints += 1;
      return texto(CHECKPOINT);
    }
    const etapa = roteiro[estado.etapas] ?? "encerra";
    estado.etapas += 1;
    if (etapa === "pendura") return new Promise<never>(() => {});
    if (etapa === "encerra") return texto("pronto");
    return {
      content: [
        etapa === "responde"
          ? {
              type: "tool-call" as const,
              toolCallId: `c${estado.etapas}`,
              toolName: "send_message",
              input: JSON.stringify({ body: RESPOSTA }),
            }
          : {
              type: "tool-call" as const,
              toolCallId: `c${estado.etapas}`,
              toolName: "get_lead_context",
              input: "{}",
            },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: etapa === "responde" ? USO_PEQUENO : USO_ESTOURADO,
      warnings: [],
    };
  };
  return { doGenerate, estado };
}

function texto(t: string) {
  return {
    content: [{ type: "text" as const, text: t }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: USO_PEQUENO,
    warnings: [],
  };
}

function pedeCheckpoint(opts: { prompt?: unknown }): boolean {
  const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
  const ultima = msgs[msgs.length - 1];
  return (
    ultima?.role === "user" &&
    Array.isArray(ultima.content) &&
    (ultima.content as Array<Record<string, unknown>>).some(
      (p) => p.type === "text" && p.text === m.turno.CHECKPOINT_INSTRUCTION,
    )
  );
}

function montaHandler(doGenerate: unknown) {
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
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          enviados.push({ body: i.body });
          const n = enviados.length;
          const kind = desfechos.shift() ?? "sent";
          if (kind === "unavailable") return { kind, reason: "sessão fora do ar (teste)" };
          if (kind === "queued") return { kind, idempotencyKey: `k${n}`, messageId: null };
          return { kind, idempotencyKey: `k${n}`, messageId: `m${n}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => AGORA,
    sleep: async () => {},
  });
}

async function rodaTurno(
  handler: ReturnType<typeof montaHandler>,
  maxAttempts: number,
  antes?: (jobId: string) => Promise<void>,
): Promise<{ erro: Error | null; jobId: string }> {
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
    maxAttempts,
  });
  await antes?.(job.id);
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "envio", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "envio" });
    await m.queue.completeJob(pool, claimed!.id, "envio");
    return { erro: null, jobId: job.id };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "envio", err);
    return { erro: err as Error, jobId: job.id };
  }
}

/**
 * O que a execução anterior do job deixou: o recibo da RESPOSTA pendente ('requested')
 * e a mensagem que o CRM gravou para ele e ainda segura ('queued') — o canal a entrega
 * quando a sessão voltar.
 */
async function respostaPendenteDaExecucaoAnterior(jobId: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status)
     values ($1,$2,$3,1,$4,'requested') returning id`,
    [ORG, CONTACT, jobId, m.ledger.hashDoConteudo({ body: RESPOSTA })],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, metadata)
     values ($1,$2,$3,$4,$5,'text','outbound','queued',$6,'ai',$7::jsonb)`,
    [randomUUID(), ORG, CONV, SESSION, CONTACT, RESPOSTA, JSON.stringify({ idempotency_key: rows[0]!.id })],
  );
}

beforeAll(async () => {
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    ledger: await import("@/lib/agent-engine/edge/crm/send-ledger"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    isLeadInHandoff: (await import("@/lib/agent-engine/agent/human-handoff")).isLeadInHandoff,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'c01-envio-falhado','Envio Falhado','Envio Falhado')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Envio','+5511900000779') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-envio-sessao','WORKING','\\x00'::bytea)
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
  // O agente PUBLICADO no número, com o teto de tokens no mínimo que a tela aceita.
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1,$2,'Agente do envio','Você é um atendente de teste.','mcp_agent')
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
  desfechos = [];
  await pool.query("delete from agent_case_events where organization_id = $1", [ORG]);
  await pool.query("delete from agent_cases where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query(
    "delete from messages where organization_id = $1 and direction = 'outbound'",
    [ORG],
  );
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
  await pool.query("delete from passagens_de_atendimento where organization_id = $1", [ORG]);
});

/** O que a passagem gravou — o que `isLeadInHandoff` lê e o que a Central mostra. */
async function estadoDaPassagem() {
  const { rows: contato } = await pool.query<{ force_human: boolean }>(
    "select force_human from contacts where organization_id = $1 and id = $2",
    [ORG, CONTACT],
  );
  const { rows: conversa } = await pool.query<{ last_handoff_reason: string | null }>(
    "select last_handoff_reason from conversations where organization_id = $1 and id = $2",
    [ORG, CONV],
  );
  const { rows: central } = await pool.query<{ title: string }>(
    "select title from agent_inbox_items where organization_id = $1 and ref_id = $2 order by created_at",
    [ORG, CONV],
  );
  const { rows: casos } = await pool.query<{ title: string; summary: string }>(
    "select title, summary from agent_cases where organization_id = $1 and conversation_id = $2 order by created_at",
    [ORG, CONV],
  );
  return {
    forceHuman: contato[0]!.force_human,
    motivo: conversa[0]!.last_handoff_reason,
    emHandoff: await m.isLeadInHandoff(pool, ORG, CONTACT),
    central,
    casos,
  };
}

async function statusDoJob(jobId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    "select status from job_queue where id = $1",
    [jobId],
  );
  return rows[0]!.status;
}

/** A passagem à equipe pela falha na última tentativa, com o erro que derrubou o turno no resumo. */
async function esperaPassagemPelaFalha(erroNoResumo: RegExp) {
  const passagem = await estadoDaPassagem();
  expect(passagem.casos).toHaveLength(1);
  expect(passagem.casos[0]!.title).toBe(m.turno.TITULO_DO_CASO_POR_FALHA_NA_ULTIMA_TENTATIVA);
  expect(passagem.casos[0]!.summary).toMatch(erroNoResumo);
  expect(passagem.forceHuman).toBe(true);
  expect(passagem.emHandoff).toBe(true);
  expect(passagem.motivo).toBe(m.turno.MOTIVO_DA_PASSAGEM_POR_FALHA_NA_ULTIMA_TENTATIVA);
  expect(passagem.central.map((c) => c.title)).toEqual([
    m.turno.TITULO_DA_PASSAGEM_POR_FALHA_NA_ULTIMA_TENTATIVA,
  ]);
}

/** Nada de fail-safe: nenhum caso, nenhuma passagem. */
async function esperaSemPassagem() {
  const passagem = await estadoDaPassagem();
  expect(passagem.casos).toEqual([]);
  expect(passagem.forceHuman).toBe(false);
  expect(passagem.emHandoff).toBe(false);
  expect(passagem.central).toEqual([]);
}

describe("(C01, -c01.3, rodada 2) envio que não chegou não é resposta: a última tentativa passa à equipe", () => {
  it("o canal devolve `failed` na resposta, sem entrega anterior: a frase de espera sai, caso aberto, passagem gravada", async () => {
    desfechos = ["failed"];
    const mod = modelo(["responde", "encerra"]);
    const { erro, jobId } = await rodaTurno(montaHandler(mod.doGenerate), 1);

    expect(erro?.message).toMatch(/envio marcado como failed pelo CRM/);
    expect(await statusDoJob(jobId)).toBe("dead");
    // A resposta foi tentada e falhou; depois dela, a frase de espera. Sem a correção:
    // só a resposta que falhou (`[RESPOSTA]`), e o lead fica mudo.
    expect(enviados.map((e) => e.body)).toEqual([RESPOSTA, m.turno.FRASE_DE_ESPERA_PADRAO]);
    await esperaPassagemPelaFalha(/envio marcado como failed pelo CRM/);
  });

  it("o canal devolve `unavailable` na resposta: a mesma passagem", async () => {
    desfechos = ["unavailable"];
    const mod = modelo(["responde", "encerra"]);
    const { erro, jobId } = await rodaTurno(montaHandler(mod.doGenerate), 1);

    expect(erro?.message).toMatch(/canal indisponível no envio/);
    expect(await statusDoJob(jobId)).toBe("dead");
    expect(enviados.map((e) => e.body)).toEqual([RESPOSTA, m.turno.FRASE_DE_ESPERA_PADRAO]);
    await esperaPassagemPelaFalha(/canal indisponível no envio/);
  });

  it("o corte do laço depois de um envio `failed`, na última tentativa: a passagem sai UMA vez", async () => {
    desfechos = ["failed"];
    const mod = modelo(["responde", "consulta_e_estoura"]);
    const { erro, jobId } = await rodaTurno(montaHandler(mod.doGenerate), 1);

    expect(erro?.message).toMatch(/envio marcado como failed pelo CRM/);
    expect(await statusDoJob(jobId)).toBe("dead");
    expect(mod.estado.etapas).toBe(2);
    expect(enviados.map((e) => e.body)).toEqual([RESPOSTA, m.turno.FRASE_DE_ESPERA_PADRAO]);
    await esperaPassagemPelaFalha(/envio marcado como failed pelo CRM/);
  });

  it("o corte do laço depois de um envio `failed`, ANTES da última tentativa: nada de frase — o job volta à fila e a nova tentativa roda o modelo", async () => {
    desfechos = ["failed"];
    const mod = modelo(["responde", "consulta_e_estoura"]);
    const { erro, jobId } = await rodaTurno(montaHandler(mod.doGenerate), 2);

    expect(erro?.message).toMatch(/envio marcado como failed pelo CRM/);
    expect(await statusDoJob(jobId)).toBe("pending");
    expect(enviados.map((e) => e.body)).toEqual([RESPOSTA]);
    await esperaSemPassagem();
  });
});

describe("(C01, -c01.3, rodada 2) a resposta a caminho continua valendo: sem fail-safe em dobro", () => {
  it("o recibo pendente da execução anterior (o canal segura a resposta) e a última tentativa falha: nada sai, nenhum caso", async () => {
    const mod = modelo(["pendura"]);
    const { erro, jobId } = await rodaTurno(
      montaHandler(mod.doGenerate),
      1,
      respostaPendenteDaExecucaoAnterior,
    );

    expect(erro?.name).toBe("TimeoutError");
    expect(await statusDoJob(jobId)).toBe("dead");
    expect(mod.estado.etapas).toBe(1);
    expect(enviados).toEqual([]);
    await esperaSemPassagem();
  });

  it("o canal devolve `queued` nesta execução e a etapa seguinte falha na última tentativa: só a resposta, nenhum caso", async () => {
    desfechos = ["queued"];
    const mod = modelo(["responde", "pendura"]);
    const { erro, jobId } = await rodaTurno(montaHandler(mod.doGenerate), 1);

    expect(erro?.name).toBe("TimeoutError");
    expect(await statusDoJob(jobId)).toBe("dead");
    expect(enviados.map((e) => e.body)).toEqual([RESPOSTA]);
    await esperaSemPassagem();
  });
});
