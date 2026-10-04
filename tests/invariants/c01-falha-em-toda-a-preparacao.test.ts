import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as HumanHandoff from "@/lib/agent-engine/agent/human-handoff";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01, -c01.3, rodada 3) A FALHA EM QUALQUER PONTO DA PREPARAÇÃO DO TURNO, NA ÚLTIMA
 * TENTATIVA, PASSA À EQUIPE — achado 2 (alto) da 2ª revisão adversarial do Codex da
 * -c01.3 (04/10/2026), contra Postgres real, com modelo e canal falsos.
 *
 * O achado: a rodada 2 levou ao `catch` da última tentativa só a falha da compactação;
 * as outras leituras da preparação (o checkpoint, o playbook, o índice de notas, as
 * leituras depois dos desvios) continuavam fora — um `statement_timeout` numa delas, na
 * última tentativa, levava o job a 'dead' sem caso, sem frase e sem passagem.
 *
 * A falha é real: o pool do turno é o pool do teste com UMA consulta (escolhida pelo
 * texto do SQL) devolvendo o erro do Postgres para `statement_timeout`; o resto do banco
 * responde. O que se prova:
 *   - a leitura do checkpoint, a do playbook e uma leitura depois dos desvios falham na
 *     última tentativa → frase de espera, caso aberto, passagem gravada, job 'dead';
 *   - a mesma falha antes da última tentativa → nada sai, o job volta à fila;
 *   - a leitura do índice de notas DEGRADA: o turno segue, responde, e a abertura diz
 *     ao modelo que as notas não foram lidas (não "sem notas");
 *   - a escolta reconcilia com o ledger: resposta aceita deste job numa execução
 *     anterior → sem frase, sem caso;
 *   - antes dos desvios determinísticos, a suspeita de opt-out nas mensagens sem
 *     resposta segura a frase: a passagem sai, a mensagem automática não;
 *   - o limite: com o próprio ledger fora, a escolta não dispara (não dá para saber se o
 *     lead já tem resposta).
 *
 * (Rodada 3b, regressão achada na 3ª revisão do Codex) A escolta reconfere o modo do
 * agente no envio: o agente pausado ou passado para assistido DEPOIS de a escolta abrir o
 * caso (durante as consultas do aviso) não manda a frase de espera; o contexto de
 * operação do agente chega à cadeia (que reconfere sob o lock do número) e ao canal (que
 * reconfere na borda do envio).
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

const ORG = "a7a7a7a7-0000-4000-8000-000000000001";
const CONTACT = "a7a7a7a7-0000-4000-8000-000000000002";
const SESSION = "a7a7a7a7-0000-4000-8000-000000000003";
const CONV = "a7a7a7a7-0000-4000-8000-000000000004";
const MSG = "a7a7a7a7-0000-4000-8000-000000000005";
const AGENTE = "a7a7a7a7-0000-4000-8000-000000000006";
const VERSAO = "a7a7a7a7-0000-4000-8000-000000000007";
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";
const TETO = 100_000;
const PRAZO_MS = 50;
/** O erro que o Postgres devolve quando `statement_timeout` corta a consulta. */
const ERRO_DO_BANCO = "canceling statement due to statement timeout";
const PEDIDO_DE_PARADA = "me tira da lista, por favor";

type Modules = {
  turno: typeof InboundTurn;
  handoff: typeof HumanHandoff;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

/** Tudo o que chegou ao canal, na ordem. */
let enviados: string[] = [];
/** (Rodada 3b) A entrada inteira de cada envio ao canal. */
let entradas: Array<{ body: string; agentOperation?: unknown }> = [];
/** (Rodada 3b) O gancho que troca o modo do agente chegou a rodar. */
let modoTrocado = false;
/** O texto de cada chamada ao modelo (fora o checkpoint), para conferir a abertura. */
let prompts: string[] = [];

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
    prompts.push(JSON.stringify(opts.prompt ?? []));
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
 * O pool do turno: o do teste, com as consultas cujo SQL contém `falha` devolvendo o
 * erro do `statement_timeout`. `connect()` (as transações da cadeia de envio) segue o
 * pool real.
 */
function poolQueFalha(falha: string, antesDaConsulta?: (sql: string) => Promise<void>): pg.Pool {
  return new Proxy(pool, {
    get(alvo, prop) {
      if (prop === "query") {
        return (sql: unknown, ...resto: unknown[]) => {
          const textoDoSql = typeof sql === "string" ? sql : (sql as { text?: string })?.text ?? "";
          if (textoDoSql.includes(falha)) return Promise.reject(new Error(ERRO_DO_BANCO));
          if (antesDaConsulta !== undefined) {
            return antesDaConsulta(textoDoSql).then(() =>
              (alvo.query as (...a: unknown[]) => unknown)(sql, ...resto),
            );
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
        send: async (i: { body: string; agentOperation?: unknown }) => {
          enviados.push(i.body);
          entradas.push(i);
          const n = enviados.length;
          return { kind: "sent", idempotencyKey: `k${n}`, messageId: `m${n}` };
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
  falha: string,
  maxAttempts: number,
  antes?: (jobId: string) => Promise<void>,
  antesDaConsulta?: (sql: string) => Promise<void>,
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
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "preparo", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await montaHandler()(claimed!, poolQueFalha(falha, antesDaConsulta), { workerId: "preparo" });
    await m.queue.completeJob(pool, claimed!.id, "preparo");
    return { erro: null, jobId: job.id };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "preparo", err);
    return { erro: err as Error, jobId: job.id };
  }
}

beforeAll(async () => {
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    handoff: await import("@/lib/agent-engine/agent/human-handoff"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'c01-falha-na-preparacao','Falha na Preparação','Falha na Preparação')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Preparo','+5511900000782') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-preparo-sessao','WORKING','\\x00'::bytea)
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
     values ($1,$2,'Agente do preparo','Você é um atendente de teste.','mcp_agent')
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
  entradas = [];
  modoTrocado = false;
  prompts = [];
  await pool.query("update ai_agents set paused_at = null, operation_mode = 'automatic' where id = $1", [
    AGENTE,
  ]);
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
  await pool.query("delete from passagens_de_atendimento where organization_id = $1", [ORG]);
});

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
    emHandoff: await m.handoff.isLeadInHandoff(pool, ORG, CONTACT),
    central: central.map((c) => c.title),
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

/**
 * A passagem pela falha na última tentativa, como a do `catch` do corpo do turno: caso,
 * `force_human`, motivo e aviso na Central. (Ela não grava linha em
 * `passagens_de_atendimento`: o vocabulário fechado da tabela não tem a origem nem o
 * motivo da falha, e acrescentá-los é migration — fora da -c01.3.)
 */
async function esperaPassagemPelaFalha() {
  const passagem = await estadoDaPassagem();
  expect(passagem.casos).toHaveLength(1);
  expect(passagem.casos[0]!.title).toBe(m.turno.TITULO_DO_CASO_POR_FALHA_NA_ULTIMA_TENTATIVA);
  expect(passagem.casos[0]!.summary).toContain(`preparação do turno: ${ERRO_DO_BANCO}`);
  expect(passagem.forceHuman).toBe(true);
  expect(passagem.emHandoff).toBe(true);
  expect(passagem.motivo).toBe(m.turno.MOTIVO_DA_PASSAGEM_POR_FALHA_NA_ULTIMA_TENTATIVA);
  expect(passagem.central).toEqual([m.turno.TITULO_DA_PASSAGEM_POR_FALHA_NA_ULTIMA_TENTATIVA]);
}

async function esperaSemPassagem() {
  const passagem = await estadoDaPassagem();
  expect(passagem.casos).toEqual([]);
  expect(passagem.forceHuman).toBe(false);
  expect(passagem.emHandoff).toBe(false);
  expect(passagem.central).toEqual([]);
}

/** O que cada leitura da preparação é, pelo texto do SQL que a faz. */
const LEITURAS_QUE_DERRUBAM = [
  { leitura: "o checkpoint (antes dos desvios)", sql: "from lead_checkpoints" },
  { leitura: "o playbook (antes dos desvios)", sql: "from playbook_pointers" },
  { leitura: "a tabela de promessas (depois dos desvios)", sql: "from promise_table_pointers" },
];

describe("(C01, -c01.3, rodada 3) a falha em qualquer ponto da preparação, na última tentativa, passa à equipe", () => {
  it.each(LEITURAS_QUE_DERRUBAM)(
    "falha na leitura de $leitura, na última tentativa: frase de espera, caso aberto, passagem gravada",
    async ({ sql }) => {
      const { erro, jobId } = await rodaTurno(sql, 1);

      expect(erro?.message).toBe(ERRO_DO_BANCO);
      expect(await statusDoJob(jobId)).toBe("dead");
      // Sem a correção: nada sai e não há caso — o lead fica mudo.
      expect(enviados).toEqual([m.turno.FRASE_DE_ESPERA_PADRAO]);
      await esperaPassagemPelaFalha();
    },
  );

  it.each(LEITURAS_QUE_DERRUBAM)(
    "falha na leitura de $leitura ANTES da última tentativa: nada sai, o job volta à fila",
    async ({ sql }) => {
      const { erro, jobId } = await rodaTurno(sql, 2);

      expect(erro?.message).toBe(ERRO_DO_BANCO);
      expect(await statusDoJob(jobId)).toBe("pending");
      expect(enviados).toEqual([]);
      await esperaSemPassagem();
    },
  );

  it("o índice de notas DEGRADA: o turno segue e responde, e a abertura diz que as notas não foram lidas", async () => {
    const { erro, jobId } = await rodaTurno("from lead_notes", 1);

    // Sem a correção: o turno caía com o erro do banco e o job ia a 'dead'.
    expect(erro).toBeNull();
    expect(await statusDoJob(jobId)).toBe("done");
    expect(enviados).toEqual([RESPOSTA]);
    expect(prompts[0]).toContain(m.turno.INDICE_DE_NOTAS_NAO_LIDO.slice(0, 40));
    await esperaSemPassagem();
  });

  it("reconcilia com o ledger: a resposta deste job já aceita numa execução anterior — sem frase, sem caso", async () => {
    const { erro, jobId } = await rodaTurno("from lead_checkpoints", 1, async (id) => {
      await pool.query(
        `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status)
         values ($1,$2,$3,1,'hash-da-resposta-anterior','accepted')`,
        [ORG, CONTACT, id],
      );
    });

    expect(erro?.message).toBe(ERRO_DO_BANCO);
    expect(await statusDoJob(jobId)).toBe("dead");
    expect(enviados).toEqual([]);
    await esperaSemPassagem();
  });

  it("antes dos desvios, a suspeita de opt-out nas mensagens sem resposta segura a frase: a passagem sai, a mensagem automática não", async () => {
    expect(m.handoff.detectAmbiguousOptOut(PEDIDO_DE_PARADA)).toBe(true);
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at)
       values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',$7)`,
      [randomUUID(), ORG, CONV, SESSION, CONTACT, PEDIDO_DE_PARADA, MENSAGEM_DO_CLIENTE_EM],
    );
    const { erro, jobId } = await rodaTurno("from lead_checkpoints", 1);

    expect(erro?.message).toBe(ERRO_DO_BANCO);
    expect(await statusDoJob(jobId)).toBe("dead");
    expect(enviados).toEqual([]);
    await esperaPassagemPelaFalha();
  });

  it("o limite: com o próprio ledger fora, a escolta não dispara (não dá para saber se o lead já tem resposta)", async () => {
    const { erro, jobId } = await rodaTurno("from send_ledger where organization_id=$1 and job_id=$2", 1);

    expect(erro?.message).toBe(ERRO_DO_BANCO);
    expect(await statusDoJob(jobId)).toBe("dead");
    expect(enviados).toEqual([]);
    await esperaSemPassagem();
  });
});

/**
 * (Rodada 3b) O gancho: na primeira consulta do aviso (o idioma da organização), com o
 * caso da escolta já aberto, roda `troca` sobre o agente — o operador pausando ou
 * passando para assistido enquanto o aviso consulta o banco.
 */
function trocaOModoDepoisDoCaso(troca: string) {
  return async (sql: string) => {
    if (modoTrocado || !sql.includes("select locale from organizations where id = $1")) return;
    const { rows } = await pool.query(
      "select 1 from agent_cases where organization_id = $1 and conversation_id = $2",
      [ORG, CONV],
    );
    if (rows.length === 0) return;
    await pool.query(troca, [AGENTE]);
    modoTrocado = true;
  };
}

describe("(C01, -c01.3, rodada 3b) a escolta da preparação reconfere o modo do agente no envio", () => {
  it.each([
    { modo: "pausado", troca: "update ai_agents set paused_at = now() where id = $1" },
    { modo: "assistido", troca: "update ai_agents set operation_mode = 'assisted' where id = $1" },
  ])(
    "o agente $modo entre a abertura do caso e o envio do aviso: a frase de espera não sai",
    async ({ troca }) => {
      const { erro, jobId } = await rodaTurno("from lead_checkpoints", 1, undefined, trocaOModoDepoisDoCaso(troca));

      expect(modoTrocado).toBe(true);
      expect(erro?.message).toBe(ERRO_DO_BANCO);
      expect(await statusDoJob(jobId)).toBe("dead");
      // Sem a correção: a frase saía com o agente pausado ou assistido.
      expect(enviados).toEqual([]);
      // O caso foi aberto antes da troca: a equipe tem o registro.
      const { casos } = await estadoDaPassagem();
      expect(casos).toHaveLength(1);
    },
  );

  it("controle: o agente ativo, o mesmo ponto do aviso — a frase de espera sai", async () => {
    const { erro, jobId } = await rodaTurno(
      "from lead_checkpoints",
      1,
      undefined,
      trocaOModoDepoisDoCaso("select $1::uuid"),
    );

    expect(modoTrocado).toBe(true);
    expect(erro?.message).toBe(ERRO_DO_BANCO);
    expect(await statusDoJob(jobId)).toBe("dead");
    expect(enviados).toEqual([m.turno.FRASE_DE_ESPERA_PADRAO]);
    await esperaPassagemPelaFalha();
  });

  it("a frase leva ao canal o contexto de operação do agente lido na guarda do modo (o que a borda do envio reconfere)", async () => {
    const { rows } = await pool.query<{ revisao: string }>(
      "select operation_revision::text as revisao from ai_agents where id = $1",
      [AGENTE],
    );
    await rodaTurno("from lead_checkpoints", 1);

    expect(entradas.map((e) => e.body)).toEqual([m.turno.FRASE_DE_ESPERA_PADRAO]);
    expect(entradas[0]!.agentOperation).toEqual({
      organizationId: ORG,
      agentId: AGENTE,
      versionId: VERSAO,
      revision: rows[0]!.revisao,
    });
  });
});
