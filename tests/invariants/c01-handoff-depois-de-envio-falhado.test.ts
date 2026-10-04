import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as HumanHandoff from "@/lib/agent-engine/agent/human-handoff";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01, -c01.3, rodada 3) A PASSAGEM PEDIDA PELO MODELO DEPOIS DE UM ENVIO QUE NÃO CHEGOU
 * — achado 1 (alto) da 2ª revisão adversarial do Codex da -c01.3 (04/10/2026), contra
 * Postgres real, com modelo e canal falsos (o harness de
 * `c01-envio-falhado-nao-e-resposta.test.ts`).
 *
 * O achado: o aviso ao lead de `request_human_handoff` só saía com `seq === 0`, e `seq`
 * é o contador do TETO — conta também o envio que o canal devolveu `failed` ou
 * `unavailable`. Depois de um envio que não chegou, a passagem pulava o aviso e gravava
 * `avisado: true`; `force_human` veta o resto, e o lead ficava mudo com a equipe lendo
 * que ele "JÁ foi avisado".
 *
 * O que se prova:
 *   - `failed` e `unavailable` seguidos de `request_human_handoff`, na última tentativa e
 *     antes dela: o aviso sai ao canal e a passagem grava o lead avisado (de verdade);
 *   - a resposta só na fila do CRM (`queued`) seguida da passagem: o aviso não sai em
 *     dobro (a resposta está a caminho), mas a passagem grava o desfecho real — o lead
 *     ainda não recebeu nada (`na_fila_canal_fora`), não "avisado";
 *   - a resposta obsoleta usa a mesma evidência: depois de um envio `failed`, a mensagem
 *     nova do cliente torna a resposta seguinte obsoleta (nada saiu ao lead ainda); com
 *     `seq` ela saía desatualizada.
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

const ORG = "a6a6a6a6-0000-4000-8000-000000000001";
const CONTACT = "a6a6a6a6-0000-4000-8000-000000000002";
const SESSION = "a6a6a6a6-0000-4000-8000-000000000003";
const CONV = "a6a6a6a6-0000-4000-8000-000000000004";
const MSG = "a6a6a6a6-0000-4000-8000-000000000005";
const AGENTE = "a6a6a6a6-0000-4000-8000-000000000006";
const VERSAO = "a6a6a6a6-0000-4000-8000-000000000007";
/** O instante do turno (dentro da janela horária do anti-ban) e o da mensagem do cliente, 5 min antes. */
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";
/** O `token_budget` publicado. */
const TETO = 100_000;
/** O prazo por requisição ao provedor neste teste: o mecanismo real, curto. */
const PRAZO_MS = 50;
/** A régua da resposta obsoleta (`respostaFicouObsoleta`) ligada: 10 minutos. */
const TETO_DA_OBSOLETA_MS = 10 * 60_000;

type Modules = {
  turno: typeof InboundTurn;
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

const USO_PEQUENO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const RESPOSTA = "Oi! Seu cadastro está ativo, sim. Quer que eu te explique os próximos passos?";
const RESPOSTA_DESATUALIZADA = "Posso te ajudar com mais alguma coisa sobre o cadastro?";
const NOVA_DO_CLIENTE = "na verdade quero mudar meu e-mail";

type Etapa = "responde" | "pede_humano" | "cliente_escreve_e_responde" | "encerra";

/**
 * Modelo falso que segue um roteiro de etapas (fora a chamada de checkpoint):
 * `responde` manda a RESPOSTA; `pede_humano` chama `request_human_handoff`;
 * `cliente_escreve_e_responde` grava uma mensagem nova do cliente (ele escreveu enquanto
 * o modelo pensava) e manda outra resposta; `encerra` termina com texto.
 */
function modelo(roteiro: Etapa[]) {
  const estado = { etapas: 0 };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    if (pedeCheckpoint(opts)) return texto(CHECKPOINT);
    const etapa = roteiro[estado.etapas] ?? "encerra";
    estado.etapas += 1;
    if (etapa === "encerra") return texto("pronto");
    if (etapa === "cliente_escreve_e_responde") {
      await pool.query(
        `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
           type, direction, status, body, sent_via, sent_at)
         values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',now())`,
        [randomUUID(), ORG, CONV, SESSION, CONTACT, NOVA_DO_CLIENTE],
      );
    }
    const chamada =
      etapa === "pede_humano"
        ? {
            toolName: "request_human_handoff",
            input: JSON.stringify({ por_que: "o cliente quer falar com o setor de cadastro" }),
          }
        : {
            toolName: "send_message",
            input: JSON.stringify({
              body: etapa === "responde" ? RESPOSTA : RESPOSTA_DESATUALIZADA,
            }),
          };
    return {
      content: [{ type: "tool-call" as const, toolCallId: `c${estado.etapas}`, ...chamada }],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO_PEQUENO,
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

function montaHandler(doGenerate: unknown, extras: { respostaObsoletaTetoMs?: number } = {}) {
  return m.turno.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake", prazoPorRequisicaoMs: PRAZO_MS } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 8,
      queuedRetryDelayMs: 1000,
      ...extras,
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
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "handoff", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "handoff" });
    await m.queue.completeJob(pool, claimed!.id, "handoff");
    return { erro: null, jobId: job.id };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "handoff", err);
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
     values ($1,'c01-handoff-envio-falhado','Handoff Envio Falhado','Handoff Envio Falhado')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Handoff','+5511900000781') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-handoff-sessao','WORKING','\\x00'::bytea)
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
     values ($1,$2,'Agente do handoff','Você é um atendente de teste.','mcp_agent')
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
  // Fica só a mensagem do cliente que acorda o turno.
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

/** As passagens gravadas, com o que cada uma diz do aviso ao lead. */
async function passagens() {
  const { rows } = await pool.query<{
    origem: string;
    cliente_avisado: boolean | null;
    aviso_motivo_codigo: string | null;
  }>(
    `select origem, cliente_avisado, aviso_motivo_codigo from passagens_de_atendimento
      where organization_id = $1 and conversation_id = $2 order by criado_em`,
    [ORG, CONV],
  );
  return rows;
}

async function casos(): Promise<string[]> {
  const { rows } = await pool.query<{ title: string }>(
    "select title from agent_cases where organization_id = $1 and conversation_id = $2",
    [ORG, CONV],
  );
  return rows.map((r) => r.title);
}

async function statusDoJob(jobId: string): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    "select status from job_queue where id = $1",
    [jobId],
  );
  return rows[0]!.status;
}

describe("(C01, -c01.3, rodada 3) a passagem pedida pelo modelo depois de um envio que não chegou avisa o lead", () => {
  it.each([
    { desfecho: "failed" as const, tentativas: 1, erro: /envio marcado como failed pelo CRM/, status: "dead" },
    { desfecho: "failed" as const, tentativas: 2, erro: /envio marcado como failed pelo CRM/, status: "pending" },
    { desfecho: "unavailable" as const, tentativas: 1, erro: /canal indisponível no envio/, status: "dead" },
    { desfecho: "unavailable" as const, tentativas: 2, erro: /canal indisponível no envio/, status: "pending" },
  ])(
    "resposta `$desfecho` e depois request_human_handoff (tentativas: $tentativas): o aviso sai e a passagem grava o lead avisado",
    async ({ desfecho, tentativas, erro, status }) => {
      desfechos = [desfecho];
      const mod = modelo(["responde", "pede_humano", "encerra"]);
      const res = await rodaTurno(montaHandler(mod.doGenerate), tentativas);

      expect(res.erro?.message).toMatch(erro);
      expect(await statusDoJob(res.jobId)).toBe(status);
      // A resposta que não chegou e, depois dela, o aviso da passagem. Sem a correção:
      // só a resposta (o aviso era pulado por `seq > 0`) — o lead mudo.
      const corpos = enviados.map((e) => e.body);
      expect(corpos).toHaveLength(2);
      expect(corpos[0]).toBe(RESPOSTA);
      expect(corpos[1]).not.toBe(RESPOSTA);
      expect(corpos[1]).not.toBe(m.turno.FRASE_DE_ESPERA_PADRAO);
      // A passagem pedida pelo modelo, com o aviso que de fato chegou ao canal; o
      // fail-safe da última tentativa não entra em dobro (o lead tem o aviso).
      expect(await passagens()).toEqual([
        { origem: "ferramenta_do_modelo", cliente_avisado: true, aviso_motivo_codigo: null },
      ]);
      expect(await casos()).toEqual([]);
      expect(await m.isLeadInHandoff(pool, ORG, CONTACT)).toBe(true);
    },
  );

  it("resposta só na fila do CRM (`queued`) e depois request_human_handoff: sem aviso em dobro, e a passagem diz que o lead ainda não recebeu nada", async () => {
    desfechos = ["queued"];
    const mod = modelo(["responde", "pede_humano", "encerra"]);
    const res = await rodaTurno(montaHandler(mod.doGenerate), 1);

    expect(res.erro).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual([RESPOSTA]);
    // Sem a correção: `cliente_avisado: true` — a equipe lia "o lead JÁ foi avisado"
    // com a resposta presa na fila do canal.
    expect(await passagens()).toEqual([
      {
        origem: "ferramenta_do_modelo",
        cliente_avisado: false,
        aviso_motivo_codigo: "na_fila_canal_fora",
      },
    ]);
  });

  it("resposta entregue (`sent`) e depois request_human_handoff: como antes, sem aviso em dobro e o lead avisado", async () => {
    const mod = modelo(["responde", "pede_humano", "encerra"]);
    const res = await rodaTurno(montaHandler(mod.doGenerate), 1);

    expect(res.erro).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual([RESPOSTA]);
    expect(await passagens()).toEqual([
      { origem: "ferramenta_do_modelo", cliente_avisado: true, aviso_motivo_codigo: null },
    ]);
  });
});

describe("(C01, -c01.3, rodada 3) a resposta obsoleta usa a mesma evidência", () => {
  it("envio `failed`, o cliente escreve de novo e o modelo responde: a resposta desatualizada não sai", async () => {
    desfechos = ["failed"];
    const mod = modelo(["responde", "cliente_escreve_e_responde", "encerra"]);
    const res = await rodaTurno(
      montaHandler(mod.doGenerate, { respostaObsoletaTetoMs: TETO_DA_OBSOLETA_MS }),
      2,
    );

    expect(res.erro?.message).toMatch(/envio marcado como failed pelo CRM/);
    expect(await statusDoJob(res.jobId)).toBe("pending");
    // Nada chegou ao lead e ele escreveu de novo: a resposta seguinte foi escrita sem a
    // mensagem nova. Sem a correção ela saía (`seq` já era 1 pelo envio que falhou).
    expect(enviados.map((e) => e.body)).toEqual([RESPOSTA]);
  });

  it("controle: envio `sent`, o cliente escreve de novo e o modelo responde — a resposta já começou, a segunda sai (regra do autor)", async () => {
    const mod = modelo(["responde", "cliente_escreve_e_responde", "encerra"]);
    const res = await rodaTurno(
      montaHandler(mod.doGenerate, { respostaObsoletaTetoMs: TETO_DA_OBSOLETA_MS }),
      2,
    );

    expect(res.erro).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual([RESPOSTA, RESPOSTA_DESATUALIZADA]);
  });
});
