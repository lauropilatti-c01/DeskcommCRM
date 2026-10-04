import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as Compaction from "@/lib/agent-engine/agent/compaction";
import type * as HumanHandoff from "@/lib/agent-engine/agent/human-handoff";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01, -c01.3, rodada 2) A FALHA NA PREPARAÇÃO DO TURNO, NA ÚLTIMA TENTATIVA, PASSA À
 * EQUIPE — achado 1 (alto) da 1ª revisão adversarial do Codex da -c01.3 (04/10/2026),
 * contra Postgres real, com modelo e canal falsos (o harness de
 * `c01-corte-antes-do-primeiro-envio.test.ts`).
 *
 * O achado: o `catch` da última tentativa (item 1c-i) só cobria o corpo do turno. Antes
 * dele, a compactação do histórico (`maybeCompact`) chama o provedor duas vezes — o
 * flush das notas duráveis e o resumo —, sem capturar falha de rede. O prazo vencido de
 * uma delas na última tentativa ia direto ao `failJob` do worker: o job morria sem caso,
 * sem frase de espera e sem passagem ao humano, e o lead ficava mudo.
 *
 * O que se prova, do jeito que o cliente sentiria (o prazo por requisição é o real, de
 * 50 ms, e o modelo falso pendura a chamada):
 *   - o flush pendura na última tentativa → sai SÓ a frase de espera; um caso é aberto
 *     para a equipe com o erro; a passagem ao humano fica gravada; o job morre com o
 *     erro ORIGINAL (o prazo da requisição); o modelo do turno nem é chamado;
 *   - o mesmo quando quem pendura é o resumo (o flush respondeu);
 *   - antes da última tentativa nada muda: nada sai, nenhum caso, nenhuma passagem, e o
 *     job volta à fila para a nova tentativa.
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

const ORG = "a1a1a1a1-0000-4000-8000-000000000001";
const CONTACT = "a1a1a1a1-0000-4000-8000-000000000002";
const SESSION = "a1a1a1a1-0000-4000-8000-000000000003";
const CONV = "a1a1a1a1-0000-4000-8000-000000000004";
const MSG = "a1a1a1a1-0000-4000-8000-000000000005";
const AGENTE = "a1a1a1a1-0000-4000-8000-000000000006";
const VERSAO = "a1a1a1a1-0000-4000-8000-000000000007";
/** O instante do turno (dentro da janela horária do anti-ban) e o da mensagem do cliente, 5 min antes. */
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";
/** O prazo por requisição ao provedor neste teste: o mecanismo real, curto. */
const PRAZO_MS = 50;

type Modules = {
  turno: typeof InboundTurn;
  compactacao: typeof Compaction;
  isLeadInHandoff: typeof HumanHandoff.isLeadInHandoff;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: Array<{ body: string }> = [];

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const RESPOSTA = "Oi! Seu cadastro está ativo, sim. Quer que eu te explique os próximos passos?";

/** O texto inteiro do prompt de uma chamada, para saber de quem ela é. */
function textoDoPrompt(opts: { prompt?: unknown }): string {
  const msgs = (opts.prompt ?? []) as Array<{ content?: unknown }>;
  return msgs
    .flatMap((msg) =>
      typeof msg.content === "string"
        ? [msg.content]
        : Array.isArray(msg.content)
          ? (msg.content as Array<Record<string, unknown>>).map((p) =>
              typeof p.text === "string" ? p.text : "",
            )
          : [],
    )
    .join("\n");
}

/** Uma chamada que nunca responde: só o prazo por requisição a encerra. */
function pendura(): Promise<never> {
  return new Promise<never>(() => {});
}

/**
 * Modelo falso: o flush e o resumo da compactação são reconhecidos pela instrução fixa
 * de cada um; `pendurar` diz qual deles nunca responde. O turno manda a resposta numa
 * etapa. Conta as chamadas de cada tipo.
 */
function modelo(pendurar: "flush" | "resumo") {
  const estado = { flush: 0, resumo: 0, etapas: 0 };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    const texto = textoDoPrompt(opts);
    if (texto.includes(m.compactacao.FLUSH_INSTRUCTION)) {
      estado.flush += 1;
      if (pendurar === "flush") return pendura();
      return {
        content: [{ type: "text" as const, text: '{"notes": []}' }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    if (texto.includes(m.compactacao.COMPACTION_INSTRUCTION)) {
      estado.resumo += 1;
      return pendura();
    }
    estado.etapas += 1;
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${estado.etapas}`,
          toolName: "send_message",
          input: JSON.stringify({ body: RESPOSTA }),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
  return { doGenerate, estado };
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
      // A compactação dispara já com a mensagem do cliente no histórico.
      compaction: { triggerMessages: 1, transcriptMaxTokens: 500 },
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
          return {
            kind: "sent",
            idempotencyKey: `k${enviados.length}`,
            messageId: `m${enviados.length}`,
          };
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
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "prep", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "prep" });
    await m.queue.completeJob(pool, claimed!.id, "prep");
    return { erro: null, jobId: job.id };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "prep", err);
    return { erro: err as Error, jobId: job.id };
  }
}

beforeAll(async () => {
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    compactacao: await import("@/lib/agent-engine/agent/compaction"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    isLeadInHandoff: (await import("@/lib/agent-engine/agent/human-handoff")).isLeadInHandoff,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'c01-falha-na-preparacao','Preparação Turno','Preparação Turno')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Preparação','+5511900000778') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-prep-sessao','WORKING','\\x00'::bytea)
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
  // O agente PUBLICADO no número (o modelo do flush e do resumo é herdado dele).
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1,$2,'Agente da preparação','Você é um atendente de teste.','mcp_agent')
     on conflict (id) do nothing`,
    [AGENTE, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at, max_steps)
     values ($1,$2,$3,1,'Você é um atendente de teste.','anthropic','claude-sonnet-4-6',$4,'published',now(),8)
     on conflict (id) do nothing`,
    [VERSAO, ORG, AGENTE, SESSION],
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
  await pool.query("delete from agent_case_events where organization_id = $1", [ORG]);
  await pool.query("delete from agent_cases where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from lead_notes where organization_id = $1", [ORG]);
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
  const { rows: conversa } = await pool.query<{
    silenciada: boolean;
    last_handoff_reason: string | null;
  }>(
    `select (bot_silenced_until is not null and bot_silenced_until > now()) as silenciada, last_handoff_reason
       from conversations where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  const { rows: central } = await pool.query<{ title: string; body: string | null }>(
    "select title, body from agent_inbox_items where organization_id = $1 and ref_id = $2 order by created_at",
    [ORG, CONV],
  );
  const { rows: casos } = await pool.query<{ title: string; summary: string; source: string }>(
    "select title, summary, source from agent_cases where organization_id = $1 and conversation_id = $2 order by created_at",
    [ORG, CONV],
  );
  return {
    forceHuman: contato[0]!.force_human,
    silenciada: conversa[0]!.silenciada,
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

/** A passagem à equipe pela falha na última tentativa, completa. */
async function esperaPassagemPelaFalha() {
  const passagem = await estadoDaPassagem();
  expect(passagem.casos).toHaveLength(1);
  expect(passagem.casos[0]).toMatchObject({
    title: m.turno.TITULO_DO_CASO_POR_FALHA_NA_ULTIMA_TENTATIVA,
    source: "guardrail_autofallback",
  });
  // O caso diz qual tentativa e por quê: o prazo da requisição ao provedor.
  expect(passagem.casos[0]!.summary).toMatch(/a tentativa 1 de 1 também falhou/);
  expect(passagem.casos[0]!.summary).toMatch(/timeout: a requisição ao provedor de IA passou do prazo/);
  expect(passagem.forceHuman).toBe(true);
  expect(passagem.silenciada).toBe(true);
  expect(passagem.emHandoff).toBe(true);
  expect(passagem.motivo).toBe(m.turno.MOTIVO_DA_PASSAGEM_POR_FALHA_NA_ULTIMA_TENTATIVA);
  expect(passagem.central).toHaveLength(1);
  expect(passagem.central[0]!.title).toBe(m.turno.TITULO_DA_PASSAGEM_POR_FALHA_NA_ULTIMA_TENTATIVA);
  expect(passagem.central[0]!.body).toMatch(/JÁ FOI avisado/);
}

describe("(C01, -c01.3, rodada 2) a falha na preparação do turno, na última tentativa, passa à equipe", () => {
  it("o flush pendura na última tentativa: sai SÓ a frase de espera, caso aberto, passagem gravada, o job morre com o erro original", async () => {
    const mod = modelo("flush");
    const { erro, jobId } = await rodaTurno(montaHandler(mod.doGenerate), 1);

    // O erro que sobe é o ORIGINAL: o prazo vencido da requisição do flush.
    expect(erro?.name).toBe("TimeoutError");
    expect(await statusDoJob(jobId)).toBe("dead");
    expect(mod.estado.flush).toBe(1);
    // O resumo nem foi pedido, e o modelo do turno também não.
    expect(mod.estado.resumo).toBe(0);
    expect(mod.estado.etapas).toBe(0);
    // O cliente recebeu a frase de espera — e só ela. Sem a correção: nada (`[]`).
    expect(enviados.map((e) => e.body)).toEqual([m.turno.FRASE_DE_ESPERA_PADRAO]);
    await esperaPassagemPelaFalha();
  });

  it("o resumo da compactação pendura na última tentativa (o flush respondeu): a mesma passagem", async () => {
    const mod = modelo("resumo");
    const { erro, jobId } = await rodaTurno(montaHandler(mod.doGenerate), 1);

    expect(erro?.name).toBe("TimeoutError");
    expect(await statusDoJob(jobId)).toBe("dead");
    expect(mod.estado.flush).toBe(1);
    expect(mod.estado.resumo).toBe(1);
    expect(mod.estado.etapas).toBe(0);
    expect(enviados.map((e) => e.body)).toEqual([m.turno.FRASE_DE_ESPERA_PADRAO]);
    await esperaPassagemPelaFalha();
  });

  it("antes da última tentativa nada muda: nada sai, nenhum caso, nenhuma passagem, e o job volta à fila", async () => {
    const mod = modelo("flush");
    const { erro, jobId } = await rodaTurno(montaHandler(mod.doGenerate), 2);

    expect(erro?.name).toBe("TimeoutError");
    expect(await statusDoJob(jobId)).toBe("pending");
    expect(mod.estado.etapas).toBe(0);
    expect(enviados).toEqual([]);
    const passagem = await estadoDaPassagem();
    expect(passagem.casos).toEqual([]);
    expect(passagem.forceHuman).toBe(false);
    expect(passagem.emHandoff).toBe(false);
    expect(passagem.central).toEqual([]);
  });
});
