import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01, T8) A RECUSA DO RETORNO NÃO REFAZ O TURNO, E O SUCESSO DEIXA CONFIRMAR — o
 * turno inteiro contra Postgres real, com modelo e canal falsos (o harness de
 * `c01-fechamento-sem-json-nao-refaz-o-turno.test.ts`) e a fila de verdade.
 *
 * O achado (24/10/2026, `docs/comercial/continuidade-marina-t5-t8-2026-10-24.md`, §4,
 * no repositório do CRM agêntico): com o retorno C01 ligado, toda recusa de política de
 * `prepararRetornoComercialC01` (horário que a pessoa não confirmou, consentimento de
 * outra mensagem...) era uma exceção. O `schedule_followup` a tratava como erro interno:
 * "encerre o turno agora", e o job voltava à fila para refazer o turno inteiro com o
 * modelo, a cada tentativa, sem resposta ao lead. E o sucesso dizia "Encerre o turno
 * agora" antes de a Marina confirmar o horário que acabou de agendar.
 *
 * O modelo falso faz o que a ferramenta manda: com `internal_error` ele para; com
 * outra recusa ele responde sem prometer; com `ok=true` ele confirma o horário.
 */

const fake = vi.hoisted(() => ({ financeiro: vi.fn() }));
vi.mock("@/lib/leads/fonte-financeira", () => ({ lerSituacaoFinanceira: fake.financeiro }));

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
const FUNIL = "a8a8a8a8-0000-4000-8000-000000000008";
const ETAPA = "a8a8a8a8-0000-4000-8000-000000000009";
const NEGOCIO = "a8a8a8a8-0000-4000-8000-00000000000a";
/** O turno às 12h de Brasília; a pessoa escreveu 5 min antes e pediu amanhã às 10h. */
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";
const PEDIDO = "Pode me chamar amanhã às 10h";
const HORARIO_PEDIDO = "2026-07-31T13:00:00.000Z";
/** Um horário que ela não disse: o servidor recusa (`c01_callback_time_not_confirmed`). */
const HORARIO_ERRADO = "2026-07-31T14:00:00.000Z";

type Modules = {
  turno: typeof InboundTurn;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: string[] = [];
/** O número do caso entra no texto: o anti-blast veta o mesmo corpo entre os casos. */
let caso = 0;

const CHECKPOINT_DO_MODELO = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "resumo escrito pelo modelo",
  declaracao: { intencoes: [], promessas: [], nada_a_declarar: true },
});

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function texto(t: string) {
  return {
    content: [{ type: "text" as const, text: t }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: USO,
    warnings: [],
  };
}

function chamada(id: string, toolName: string, input: unknown) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: USO,
    warnings: [],
  };
}

type Msg = { role: string; content?: unknown };

function pedeCheckpoint(prompt: Msg[]): boolean {
  return prompt.some(
    (msg) =>
      msg.role === "user" &&
      Array.isArray(msg.content) &&
      (msg.content as Array<Record<string, unknown>>).some(
        (p) => p.type === "text" && p.text === m.turno.CHECKPOINT_INSTRUCTION,
      ),
  );
}

/** O último resultado da ferramenta que o modelo leu nesta execução (ou undefined). */
function resultadoDe(prompt: Msg[], toolName: string): Record<string, unknown> | undefined {
  let achado: Record<string, unknown> | undefined;
  for (const msg of prompt) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const p of msg.content as Array<Record<string, unknown>>) {
      if (p.type !== "tool-result" || p.toolName !== toolName) continue;
      const out = p.output as { value?: unknown } | undefined;
      achado = (out?.value ?? out) as Record<string, unknown>;
    }
  }
  return achado;
}

/**
 * Modelo falso: 1ª etapa chama `schedule_followup` com `promised_at`; lido o resultado,
 * confirma (ok), responde sem prometer (recusa) ou para (`internal_error`).
 */
function modelo(promisedAt: string) {
  const estado = { execucoes: 0, resultados: [] as Record<string, unknown>[] };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    const prompt = (opts.prompt ?? []) as Msg[];
    if (pedeCheckpoint(prompt)) return texto(CHECKPOINT_DO_MODELO);
    if (resultadoDe(prompt, "send_message")) return texto("pronto");
    const agendou = resultadoDe(prompt, "schedule_followup");
    if (!agendou) {
      estado.execucoes += 1;
      return chamada(`s${estado.execucoes}`, "schedule_followup", {
        reason: "A pessoa pediu para conversar amanhã",
        promised_at: promisedAt,
        promise: "Retomar a conversa no horário que ela pediu",
      });
    }
    estado.resultados.push(agendou);
    const erro = (agendou.error as { code?: string } | undefined)?.code;
    if (erro === "internal_error") return texto("pronto");
    const body =
      agendou.ok === true
        ? `Combinado, te chamo amanhã às 10h. Atendimento ${caso}.`
        : `Quando puder, é só me chamar aqui que a gente segue de onde parou. Atendimento ${caso}-${estado.execucoes}.`;
    return chamada(`m${estado.execucoes}`, "send_message", { body });
  };
  return { doGenerate, estado };
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
      followup: { minAheadMs: 1000, maxAheadMs: 7 * 86400000, staggerWindowMs: 0 },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(doGenerate as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          enviados.push(i.body);
          const n = enviados.length;
          return { kind: "sent", idempotencyKey: `k${caso}-${n}`, messageId: `m${caso}-${n}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => AGORA,
    sleep: async () => {},
  });
}

/** O job do turno pela fila, como o worker: claim, handler, `completeJob` ou `failJob`. */
async function rodaPelaFila(handler: ReturnType<typeof montaHandler>, maxAttempts: number, tentativasNoMaximo: number) {
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
  const erros: string[] = [];
  for (let execucao = 0; execucao < tentativasNoMaximo; execucao += 1) {
    await pool.query("update job_queue set status = 'done' where status = 'pending' and id <> $1", [job.id]);
    await pool.query("update job_queue set run_after = now() where id = $1", [job.id]);
    const [claimed] = await m.queue.claimJobs(pool, { workerId: "retorno", maxConcurrency: 1 });
    if (claimed?.id !== job.id) break;
    try {
      await handler(claimed, pool, { workerId: "retorno" });
      await m.queue.completeJob(pool, claimed.id, "retorno");
    } catch (err) {
      erros.push(err instanceof Error ? err.message : String(err));
      await m.queue.failJob(pool, claimed.id, "retorno", err);
    }
    const { rows } = await pool.query<{ status: string }>("select status from job_queue where id = $1", [job.id]);
    if (rows[0]!.status !== "pending") break;
  }
  const { rows } = await pool.query<{ status: string; attempts: number }>(
    "select status, attempts from job_queue where id = $1",
    [job.id],
  );
  return { erros, status: rows[0]!.status, attempts: rows[0]!.attempts };
}

async function retornos() {
  const { rows } = await pool.query<{ next_run_at: Date; payload: Record<string, unknown> }>(
    "select next_run_at, payload from cron_jobs where organization_id = $1",
    [ORG],
  );
  return rows;
}

beforeAll(async () => {
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  process.env.C01_ACOMPANHAMENTO_INTEGRATION = JSON.stringify({
    enabled: true,
    organizationId: ORG,
    tokenSha256: "a".repeat(64),
    signingKey: "retorno-ficticio-sem-segredo-".repeat(2),
    allowedKinds: ["oferta"],
  });

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, timezone)
     values ($1,'c01-retorno-recusa','Retorno','Retorno','America/Sao_Paulo') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Retorno','+5511900000782') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query("insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Funil fictício','ficticio')", [FUNIL, ORG]);
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Aberto','aberto',1000)",
    [ETAPA, ORG, FUNIL],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,custom_fields) values($1,$2,$3,$4,$5,'Oportunidade fictícia',$6)",
    [NEGOCIO, ORG, FUNIL, ETAPA, CONTACT, { produto_chave: "produto-ficticio" }],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-retorno-sessao','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
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
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',$7) on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT, PEDIDO, MENSAGEM_DO_CLIENTE_EM],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1,$2,'Agente do retorno','Você é um atendente de teste.','mcp_agent') on conflict (id) do nothing`,
    [AGENTE, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at, max_steps, followup)
     values ($1,$2,$3,1,'Você é um atendente de teste.','anthropic','claude-sonnet-4-6',$4,'published',now(),8,$5)
     on conflict (id) do nothing`,
    [VERSAO, ORG, AGENTE, SESSION, { callback_enabled: true, c01_callback: true }],
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
  caso += 1;
  enviados = [];
  fake.financeiro.mockReset();
  fake.financeiro.mockImplementation(async ({ now }: { now: Date }) => ({
    status: "nao_comprou_confirmado",
    complete: true,
    checkedAt: now.toISOString(),
  }));
  await pool.query("delete from cron_jobs where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1 and direction = 'outbound'", [ORG]);
  await pool.query("delete from lead_checkpoints where organization_id = $1", [ORG]);
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  // Uma tentativa final pode passar a conversa à equipe; cada caso começa com ela no automático.
  await pool.query(
    "update conversations set status = 'open', assignee_kind = 'ai', assigned_to_user_id = null, bot_silenced_until = null where id = $1",
    [CONV],
  );
  await pool.query("update contacts set force_human = false where id = $1", [CONTACT]);
});

describe("(C01, T8) schedule_followup no turno real", () => {
  it("recusa de política: uma resposta sem promessa, nenhum retorno, job concluído na 1ª tentativa", async () => {
    const mod = modelo(HORARIO_ERRADO);
    const r = await rodaPelaFila(montaHandler(mod.doGenerate), 3, 3);

    // Sem a correção: a recusa vira `internal_error`, o modelo para sem responder e o
    // job refaz o turno a cada tentativa (três execuções do modelo, nenhuma resposta).
    expect(r.erros).toEqual([]);
    expect(r.status).toBe("done");
    expect(r.attempts).toBe(1);
    expect(mod.estado.execucoes).toBe(1);
    expect(mod.estado.resultados).toHaveLength(1);
    expect(mod.estado.resultados[0]).toMatchObject({ ok: false, error: { code: "callback_not_confirmed" } });
    expect(String((mod.estado.resultados[0]!.error as { message: string }).message)).toContain("nenhum retorno foi criado");
    expect(enviados).toEqual([`Quando puder, é só me chamar aqui que a gente segue de onde parou. Atendimento ${caso}-1.`]);
    expect(await retornos()).toEqual([]);
  });

  it("sucesso: um retorno no horário pedido e a confirmação ao lead no mesmo turno", async () => {
    const mod = modelo(HORARIO_PEDIDO);
    const r = await rodaPelaFila(montaHandler(mod.doGenerate), 3, 3);

    expect(r.erros).toEqual([]);
    expect(r.status).toBe("done");
    expect(r.attempts).toBe(1);
    expect(mod.estado.execucoes).toBe(1);
    expect(mod.estado.resultados[0]).toMatchObject({ ok: true, status: "agendado" });
    const instrucao = String(mod.estado.resultados[0]!.message);
    // A ferramenta manda confirmar ao lead primeiro; encerrar vem depois da confirmação.
    expect(instrucao).not.toContain("Encerre o turno agora");
    expect(instrucao).toContain("confirme ao lead");
    expect(enviados).toEqual([`Combinado, te chamo amanhã às 10h. Atendimento ${caso}.`]);
    const criados = await retornos();
    expect(criados).toHaveLength(1);
    expect(criados[0]!.payload).toMatchObject({ scope: "commercial", c01_callback: { promised_at: HORARIO_PEDIDO } });
  });

  it("erro de infraestrutura continua falha real: o job volta à fila, nada é agendado", async () => {
    fake.financeiro.mockImplementation(async () => {
      throw new Error("fonte financeira fora do ar");
    });
    const mod = modelo(HORARIO_PEDIDO);
    const r = await rodaPelaFila(montaHandler(mod.doGenerate), 3, 1);

    expect(r.erros).toEqual(["fonte financeira fora do ar"]);
    expect(r.status).toBe("pending");
    expect(mod.estado.resultados[0]).toMatchObject({ ok: false, error: { code: "internal_error" } });
    expect(enviados).toEqual([]);
    expect(await retornos()).toEqual([]);
  });
});
