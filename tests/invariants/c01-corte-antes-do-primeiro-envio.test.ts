import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as HumanHandoff from "@/lib/agent-engine/agent/human-handoff";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01) O CORTE POR TETO DE TOKENS ANTES DO PRIMEIRO ENVIO NO TURNO COMPLETO — achado 1
 * (alto) da sétima revisão adversarial do Codex (03/10/2026), rodada 8, contra Postgres
 * real, com modelo e canal falsos (o harness de `c01-fail-safe-turno-completo.test.ts`)
 * e um agente PUBLICADO no número com `token_budget = 1000` (o mínimo que a tela aceita).
 *
 * O achado: a primeira etapa pode passar do teto só consultando uma ferramenta. O laço
 * parava (`pararPorTetoDeTokens`), `runModelCall` devolvia o resultado como o de um
 * laço que acabou sozinho, e o turno, sem roteiro, gravava o checkpoint e o worker
 * concluía o job com ZERO envios: o lead ficava mudo, sem retry nem encaminhamento, e
 * o job "ok" — o sintoma da C54 (a chamada de 66 mil tokens cairia neste corte).
 *
 * O que se prova, do jeito que o cliente sentiria:
 *   - o modelo estoura o teto na 1ª etapa consultando `get_lead_context`, antes de
 *     qualquer envio → sai SÓ a frase de espera; um caso é aberto para a equipe; a
 *     passagem ao humano fica gravada (`force_human`, silêncio, aviso na Central com
 *     "cliente avisado"); o job conclui; o próximo turno do lead é pulado;
 *   - o modelo manda UMA mensagem e só então estoura o teto → nada disso: a mensagem
 *     fica, não há caso nem passagem, o corte só encerra o laço (como sempre) e o job
 *     conclui.
 *
 * O unitário `c01-corte-por-teto-comunica-o-motivo` prova as peças (o motivo no retorno
 * de `runModelCall`) e prende a ligação pelo código.
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

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const CONTACT = "eeeeeeee-0000-4000-8000-000000000002";
const SESSION = "eeeeeeee-0000-4000-8000-000000000003";
const CONV = "eeeeeeee-0000-4000-8000-000000000004";
const MSG = "eeeeeeee-0000-4000-8000-000000000005";
const AGENTE = "eeeeeeee-0000-4000-8000-000000000006";
const VERSAO = "eeeeeeee-0000-4000-8000-000000000007";
/** A mensagem SEGUINTE do cliente: chega depois do fail-safe e acorda outro turno. */
const MSG_SEGUINTE = "eeeeeeee-0000-4000-8000-000000000015";
/** O instante do turno (dentro da janela horária do anti-ban) e o da mensagem do cliente, 5 min antes. */
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";
/** O `token_budget` publicado: o mínimo que a coluna aceita (CHECK 1000..500000). */
const TETO = 1000;

type Modules = {
  turno: typeof InboundTurn;
  isLeadInHandoff: typeof HumanHandoff.isLeadInHandoff;
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

/** Uso de uma etapa (V3). */
const uso = (entrada: number, saida: number) => ({
  inputTokens: { total: entrada, noCache: entrada, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: saida, text: saida, reasoning: 0 },
});
/** Uma etapa que sozinha passa do teto. */
const USO_ESTOURADO = uso(5 * TETO, 10);
const USO_PEQUENO = uso(1, 1);

const RESPOSTA = "Oi! Seu cadastro está ativo, sim. Quer que eu te explique os próximos passos?";

/**
 * Modelo falso que CONSULTA antes de responder: a 1ª etapa chama `get_lead_context` com
 * um uso que sozinho passa do teto; se ganhasse uma 2ª etapa, mandaria a resposta. Conta
 * as etapas do laço (fora a chamada de checkpoint).
 */
function modeloQueEstouraConsultando() {
  const estado = { etapas: 0, checkpoints: 0 };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    if (pedeCheckpoint(opts)) {
      estado.checkpoints += 1;
      return respostaDeCheckpoint();
    }
    estado.etapas += 1;
    if (estado.etapas === 1) {
      return {
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "c1",
            toolName: "get_lead_context",
            input: "{}",
          },
        ],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USO_ESTOURADO,
        warnings: [],
      };
    }
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
      usage: USO_PEQUENO,
      warnings: [],
    };
  };
  return { doGenerate, estado };
}

/**
 * Modelo falso que RESPONDE e só então estoura: a 1ª etapa manda a resposta com um uso
 * que passa do teto; não ganha 2ª etapa.
 */
function modeloQueRespondeEEstoura() {
  const estado = { etapas: 0, checkpoints: 0 };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    if (pedeCheckpoint(opts)) {
      estado.checkpoints += 1;
      return respostaDeCheckpoint();
    }
    estado.etapas += 1;
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${estado.etapas}`,
          toolName: "send_message",
          input: JSON.stringify({ body: estado.etapas === 1 ? RESPOSTA : "não devia sair" }),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO_ESTOURADO,
      warnings: [],
    };
  };
  return { doGenerate, estado };
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

function respostaDeCheckpoint() {
  return {
    content: [{ type: "text" as const, text: CHECKPOINT }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: USO_PEQUENO,
    warnings: [],
  };
}

function montaHandler(doGenerate: unknown) {
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
  evento: string,
  inboundMessageId: string = MSG,
): Promise<{ erro: Error | null; jobId: string }> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: inboundMessageId,
      crm_event_id: evento,
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "corte", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "corte" });
    await m.queue.completeJob(pool, claimed!.id, "corte");
    return { erro: null, jobId: job.id };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "corte", err);
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
     values ($1,'c01-corte-antes-do-envio','Corte Turno','Corte Turno')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Corte','+5511900000777') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-corte-sessao','WORKING','\\x00'::bytea)
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
  // O agente PUBLICADO no número, com o teto de tokens no mínimo que a tela aceita: é a
  // versão publicada que carrega `token_budget` até o turno (`agentConfig.tokenBudget`).
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1,$2,'Agente do corte','Você é um atendente de teste.','mcp_agent')
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
  await pool.query("delete from agent_case_events where organization_id = $1", [ORG]);
  await pool.query("delete from agent_cases where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
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
  await pool.query("delete from messages where organization_id = $1 and id = $2", [
    ORG,
    MSG_SEGUINTE,
  ]);
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
  const { rows: central } = await pool.query<{ kind: string; title: string; body: string | null }>(
    "select kind, title, body from agent_inbox_items where organization_id = $1 and ref_id = $2 order by created_at",
    [ORG, CONV],
  );
  const { rows: casos } = await pool.query<{
    title: string;
    summary: string;
    blocker: string;
    source: string;
    status: string;
  }>(
    "select title, summary, blocker, source, status from agent_cases where organization_id = $1 and conversation_id = $2 order by created_at",
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

describe("(C01, rodada 8) o corte por teto de tokens antes do primeiro envio", () => {
  it("o modelo estoura o teto na 1ª etapa consultando `get_lead_context`: sai SÓ a frase de espera, caso aberto, passagem gravada, job concluído", async () => {
    const modelo = modeloQueEstouraConsultando();
    const { erro, jobId } = await rodaTurno(montaHandler(modelo.doGenerate), crypto.randomUUID());

    expect(erro).toBeNull();
    expect(await statusDoJob(jobId)).toBe("done");
    // O laço parou na 1ª etapa (o corte): a resposta da 2ª etapa nunca foi pedida.
    expect(modelo.estado.etapas).toBe(1);
    // O cliente recebeu a frase de espera — e só ela. Sem a correção: nada (`[]`).
    expect(enviados.map((e) => e.body)).toEqual([m.turno.FRASE_DE_ESPERA_PADRAO]);

    const passagem = await estadoDaPassagem();
    expect(passagem.casos).toHaveLength(1);
    expect(passagem.casos[0]).toMatchObject({
      title: m.turno.TITULO_DO_CASO_POR_CORTE,
      source: "guardrail_autofallback",
    });
    // O caso diz o que aconteceu, com os números: 5010 tokens numa etapa, teto 1000.
    expect(passagem.casos[0]!.summary).toMatch(/cortado pelo teto de tokens/);
    expect(passagem.casos[0]!.summary).toMatch(/5010 tokens em 1 etapa\(s\); teto 1000/);
    expect(passagem.casos[0]!.blocker).toMatch(/cortada por tamanho/);
    expect(passagem.casos[0]!.blocker).not.toMatch(/recebeu/);
    // A passagem ao humano está GRAVADA, com o aviso de que o cliente foi avisado.
    expect(passagem.forceHuman).toBe(true);
    expect(passagem.silenciada).toBe(true);
    expect(passagem.emHandoff).toBe(true);
    expect(passagem.motivo).toBe(m.turno.MOTIVO_DA_PASSAGEM_POR_CORTE);
    expect(passagem.central).toHaveLength(1);
    expect(passagem.central[0]!.title).toBe(m.turno.TITULO_DA_PASSAGEM_POR_CORTE);
    expect(passagem.central[0]!.body).toMatch(/JÁ FOI avisado/);
    // O checkpoint do turno continua sendo gravado (a 2ª chamada, só o fechamento).
    expect(modelo.estado.checkpoints).toBe(1);
  });

  it("a mensagem seguinte do cliente não volta ao modelo: o lead está em handoff e o turno é pulado", async () => {
    const primeiro = modeloQueEstouraConsultando();
    await rodaTurno(montaHandler(primeiro.doGenerate), crypto.randomUUID());
    expect(enviados.map((e) => e.body)).toEqual([m.turno.FRASE_DE_ESPERA_PADRAO]);

    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at)
       values ($1,$2,$3,$4,$5,'text','inbound','delivered','e então?','external_device',$6)`,
      [MSG_SEGUINTE, ORG, CONV, SESSION, CONTACT, AGORA.toISOString()],
    );
    const segundo = modeloQueRespondeEEstoura();
    const { erro } = await rodaTurno(
      montaHandler(segundo.doGenerate),
      crypto.randomUUID(),
      MSG_SEGUINTE,
    );
    expect(erro).toBeNull();
    expect(segundo.estado.etapas).toBe(0);
    expect(enviados.map((e) => e.body)).toEqual([m.turno.FRASE_DE_ESPERA_PADRAO]);
  });

  it("com UMA mensagem enviada antes do corte nada muda: a mensagem fica, sem caso, sem passagem, e o job conclui", async () => {
    const modelo = modeloQueRespondeEEstoura();
    const { erro, jobId } = await rodaTurno(montaHandler(modelo.doGenerate), crypto.randomUUID());

    expect(erro).toBeNull();
    expect(await statusDoJob(jobId)).toBe("done");
    // O corte continua encerrando o laço ao fim da etapa estourada (sem 2ª etapa)…
    expect(modelo.estado.etapas).toBe(1);
    // …e o cliente recebeu a resposta, só ela — sem frase de espera.
    expect(enviados.map((e) => e.body)).toEqual([RESPOSTA]);

    const passagem = await estadoDaPassagem();
    expect(passagem.casos).toEqual([]);
    expect(passagem.forceHuman).toBe(false);
    expect(passagem.silenciada).toBe(false);
    expect(passagem.emHandoff).toBe(false);
    expect(passagem.motivo).toBeNull();
    expect(passagem.central).toEqual([]);
    expect(modelo.estado.checkpoints).toBe(1);
  });
});
