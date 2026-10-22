import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as HumanHandoff from "@/lib/agent-engine/agent/human-handoff";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01, junção da 1.86.0) A TRAVA DE PROMESSA SEM CASO (`casePromiseGate`) COM A
 * PASSAGEM DESLIGADA, pelo turno real (handler de `inbound_turn`) contra o Postgres.
 *
 * Até a -c01.16 a trava lia só o léxico de humano (`detectHumanPromise`). A 1.86 soma
 * dois sinais em OU: o retorno humano do classificador semântico
 * (`prometeuRetornoHumano`, cuja instrução cita "te retorno") e o léxico de retorno do
 * próprio assistente (`detectarPromessaDeRetornoDoAssistente`: "a gente se fala",
 * "te chamo", "retomamos amanhã"…). A produção (v27) tem `cases_enabled = true` e
 * `handoff_tool_enabled = false`, e o texto da Marina diz "vou verificar e já te
 * retorno". O que se prova aqui, do jeito que o lead sentiria:
 *
 *   (a) o turno que ABRE o caso e diz "já te retorno": a mensagem sai, sem voltar ao
 *       modelo e sem caso a mais — o caso aberto no turno libera a trava;
 *   (b) o turno sem caso que escapa um "te retorno" ou um "a gente se fala": a 1ª
 *       tentativa volta ao modelo; na 2ª o sistema abre o caso e a mensagem SAI. A
 *       conversa não é silenciada (C04): sem `force_human`, sem `bot_silenced_until`,
 *       e a mensagem seguinte do lead chega ao modelo e é respondida.
 *
 * O classificador semântico é o dublê do modelo (mesmo registro falso), respondendo
 * como a instrução manda: `prometeuRetornoHumano` verdadeiro para "te retorno".
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

const ORG = "c01ca5e0-0000-4000-8000-000000000001";
const CONTACT = "c01ca5e0-0000-4000-8000-000000000002";
const SESSION = "c01ca5e0-0000-4000-8000-000000000003";
const CONV = "c01ca5e0-0000-4000-8000-000000000004";
const AGENT = "c01ca5e0-0000-4000-8000-000000000005";
const VERSION = "c01ca5e0-0000-4000-8000-000000000006";
const AGORA = new Date("2026-07-28T18:00:00Z");

/** As duas frases do texto da Marina (v27, linhas 80 e 88). */
const MARINA_1 = "Vou verificar pra ti e já te retorno";
const MARINA_2 = "Entendi! vou verificar e já te retorno";
const A_GENTE_SE_FALA = "Perfeito, qualquer coisa a gente se fala!";
const REFORMULADA = "Perfeito! Se surgir qualquer dúvida, é só me chamar aqui.";
const RESPOSTA_SEGUINTE = "Claro! O curso de Operação tem aulas gravadas e simulados.";

type Modules = {
  createInboundTurnHandler: typeof InboundTurn.createInboundTurnHandler;
  CHECKPOINT_INSTRUCTION: string;
  isLeadInHandoff: typeof HumanHandoff.isLeadInHandoff;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: string[] = [];

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const texto = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
type Chamada = { toolName: string; input: Record<string, unknown> };
const ferramentas = (...chamadas: Chamada[]) => ({
  content: chamadas.map((c) => ({
    type: "tool-call" as const,
    toolCallId: `c-${crypto.randomUUID()}`,
    toolName: c.toolName,
    input: JSON.stringify(c.input),
  })),
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const enviar = (body: string): Chamada => ({ toolName: "send_message", input: { body } });
const abrirCaso: Chamada = {
  toolName: "open_human_case",
  input: {
    title: "Dúvida sobre a matrícula",
    summary: "O lead quer saber se a matrícula vale para o edital novo.",
    blocker: "Só a equipe confirma o edital.",
    kind: "duvida",
  },
};
const FECHAMENTO = JSON.stringify({ commitments: [], objections: [], next_action: null, rolling_summary: "t" });

type Resposta = ReturnType<typeof texto> | ReturnType<typeof ferramentas>;

/**
 * Dublê do modelo. O classificador semântico de promessa e o fechamento são
 * reconhecidos pelo prompt e respondidos fora do roteiro; as demais chamadas seguem o
 * roteiro. Guarda os prompts do agente e quantas vezes o classificador foi chamado.
 */
function modelo(roteiro: Resposta[]) {
  const estado = { prompts: [] as string[], classificacoes: 0, vereditos: [] as boolean[], resultados: [] as string[] };
  const fake = async (options: { prompt: unknown }) => {
    const prompt = JSON.stringify(options.prompt);
    if (prompt.includes("prometeuRetornoHumano")) {
      estado.classificacoes += 1;
      const msgs = options.prompt as Array<{ role: string; content?: unknown }>;
      const candidata = JSON.stringify(msgs[msgs.length - 1]?.content ?? "").toLowerCase();
      const retorno = candidata.includes("te retorno");
      estado.vereditos.push(retorno);
      return texto(
        JSON.stringify({
          isPromise: false,
          suspectPhrase: null,
          prometeuRetornoHumano: retorno,
          retornoSoDoAssistente: false,
        }),
      );
    }
    const msgs = options.prompt as Array<{ role: string; content?: unknown }>;
    const ultima = msgs[msgs.length - 1];
    if (
      ultima?.role === "user" &&
      Array.isArray(ultima.content) &&
      (ultima.content as Array<Record<string, unknown>>).some(
        (p) => p.type === "text" && p.text === m.CHECKPOINT_INSTRUCTION,
      )
    ) {
      return texto(FECHAMENTO);
    }
    estado.prompts.push(prompt);
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result") estado.resultados.push(JSON.stringify(parte.output ?? parte));
      }
    }
    return roteiro[estado.prompts.length - 1] ?? texto("");
  };
  return { fake, estado };
}

async function turno(
  fake: ReturnType<typeof modelo>["fake"],
  opts: { promessaSemantica?: boolean; mensagem?: string } = {},
): Promise<void> {
  const msg = crypto.randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, created_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',now(),now())`,
    [msg, ORG, CONV, SESSION, CONTACT, opts.mensagem ?? "a matrícula vale para o edital novo?"],
  );
  await pool.query("update job_queue set status = 'done' where organization_id = $1 and status = 'pending'", [ORG]);
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: msg,
      crm_event_id: crypto.randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "promessa", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  const handler = m.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 12,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
      ...(opts.promessaSemantica === false ? {} : { promiseSemantic: { enabled: true } }),
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(fake as never),
    channel: () =>
      ({
        channel: "captura",
        send: async (input: { body: string }) => {
          enviados.push(input.body);
          return { kind: "sent" as const, idempotencyKey: `k${enviados.length}`, messageId: `m${enviados.length}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => AGORA,
    sleep: async () => {},
  });
  await handler(claimed!, pool, { workerId: "promessa" });
  await m.queue.completeJob(pool, claimed!.id, "promessa");
}

async function casos(): Promise<Array<{ source: string; status: string }>> {
  const { rows } = await pool.query<{ source: string; status: string }>(
    `select source, status from agent_cases where organization_id = $1 and conversation_id = $2 order by created_at`,
    [ORG, CONV],
  );
  return rows;
}

/** O que silenciaria a conversa: o que `isLeadInHandoff` lê e o silêncio durável. */
async function silencio() {
  const { rows: contato } = await pool.query<{ force_human: boolean }>(
    "select force_human from contacts where organization_id = $1 and id = $2",
    [ORG, CONTACT],
  );
  const { rows: conversa } = await pool.query<{ silenciada: boolean }>(
    `select (bot_silenced_until is not null and bot_silenced_until > now()) as silenciada
       from conversations where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  return {
    forceHuman: contato[0]!.force_human,
    silenciada: conversa[0]!.silenciada,
    emHandoff: await m.isLeadInHandoff(pool, ORG, CONTACT),
  };
}

const VETO = "case_promise_without_case";

beforeAll(async () => {
  const turnoMod = await import("@/lib/agent-engine/agent/inbound-turn");
  m = {
    createInboundTurnHandler: turnoMod.createInboundTurnHandler,
    CHECKPOINT_INSTRUCTION: turnoMod.CHECKPOINT_INSTRUCTION,
    isLeadInHandoff: (await import("@/lib/agent-engine/agent/human-handoff")).isLeadInHandoff,
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'c01-promessa-de-caso','Promessa de caso','Promessa de caso') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-promessa-de-caso','WORKING','\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  // Como a produção (v27): casos ligados e a passagem desligada.
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt)
     values ($1, $2, 'Marina de teste', 'system') on conflict (id) do nothing`,
    [AGENT, ORG],
  );
  await pool.query(
    `insert into ai_agent_versions
       (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id,
        status, cases_enabled, handoff_tool_enabled)
     values ($1, $2, $3, 1, 'system', 'anthropic', 'claude-sonnet-4-6', $4, 'published', true, false)
     on conflict (id) do nothing`,
    [VERSION, ORG, AGENT, SESSION],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [VERSION, AGENT]);
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
  // A janela do anti-blast: a mesma frase em vários casos deste arquivo seria "envio em massa".
  await pool.query("delete from outbound_copies where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1", [ORG]);
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.query("delete from conversations where organization_id = $1", [ORG]);
  await pool.query("delete from contacts where organization_id = $1", [ORG]);
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number) values ($1,$2,'Lead de teste','+5511900000771')`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1,$2,$3,$4,'ai_handling',false)`,
    [CONV, ORG, CONTACT, SESSION],
  );
});

afterAll(async () => {
  await pool.query("delete from job_queue where organization_id = $1", [ORG]);
  await pool.query("delete from event_log where organization_id = $1", [ORG]);
  await pool.end();
});

describe("(a) o turno que abre o caso e diz 'já te retorno'", () => {
  it("abre o caso, depois envia: a mensagem sai sem voltar ao modelo e há um caso só", async () => {
    const { fake, estado } = modelo([ferramentas(abrirCaso), ferramentas(enviar(MARINA_1)), texto("")]);
    await turno(fake);

    expect(enviados, estado.resultados.join("\n")).toEqual([MARINA_1]);
    // Camada semântica LIGADA, como na produção (a instalação lê true): o classificador
    // foi chamado para a frase da Marina e respondeu "promessa de retorno". A mensagem sai
    // porque o caso foi aberto neste turno, não porque o sinal estava neutro.
    expect(estado.vereditos, "o classificador semântico não respondeu 'promessa'").toEqual([true]);
    expect(estado.prompts.some((p) => p.includes(VETO)), "a mensagem voltou ao modelo").toBe(false);
    expect(await casos()).toEqual([{ source: "agent", status: "awaiting_human" }]);
    expect(await silencio()).toEqual({ forceHuman: false, silenciada: false, emHandoff: false });
  });

  it("caso já aberto antes do turno: a segunda frase da Marina também sai, sem caso novo", async () => {
    const primeiro = modelo([ferramentas(abrirCaso), ferramentas(enviar(MARINA_1)), texto("")]);
    await turno(primeiro.fake);
    enviados = [];

    const { fake, estado } = modelo([ferramentas(enviar(MARINA_2)), texto("")]);
    await turno(fake, { mensagem: "e o valor?" });

    expect(enviados).toEqual([MARINA_2]);
    // Mesmo sinal semântico ("promessa"), com o caso aberto antes do turno.
    expect(primeiro.estado.vereditos).toEqual([true]);
    expect(estado.vereditos, "o classificador semântico não respondeu 'promessa'").toEqual([true]);
    expect(estado.prompts.some((p) => p.includes(VETO))).toBe(false);
    expect(await casos()).toHaveLength(1);
  });
});

describe("(b) o turno sem caso que escapa uma promessa de retorno", () => {
  it("'te retorno' (sinal semântico): 1ª volta ao modelo, 2ª abre o caso e a mensagem SAI; a conversa não fica calada", async () => {
    const { fake, estado } = modelo([ferramentas(enviar(MARINA_1)), ferramentas(enviar(MARINA_1)), texto("")]);
    await turno(fake);

    expect(estado.classificacoes, "o classificador semântico não rodou").toBeGreaterThan(0);
    expect(estado.prompts[1], "a 1ª tentativa não voltou ao modelo com o veto").toContain(VETO);
    expect(enviados, "o lead ficou sem resposta").toEqual([MARINA_1]);
    expect(await casos()).toEqual([{ source: "guardrail_autofallback", status: "awaiting_human" }]);
    expect(await silencio()).toEqual({ forceHuman: false, silenciada: false, emHandoff: false });

    // C04: a mensagem seguinte do lead chega ao modelo e é respondida.
    enviados = [];
    const seguinte = modelo([ferramentas(enviar(RESPOSTA_SEGUINTE)), texto("")]);
    await turno(seguinte.fake, { mensagem: "e como são as aulas?" });
    expect(seguinte.estado.prompts.length, "o turno seguinte não chegou ao modelo").toBeGreaterThan(0);
    expect(enviados).toEqual([RESPOSTA_SEGUINTE]);
    expect(await casos()).toHaveLength(1);
  });

  it("'a gente se fala' (léxico da 1.86): 1ª volta ao modelo, 2ª abre o caso e a mensagem SAI", async () => {
    const { fake, estado } = modelo([
      ferramentas(enviar(A_GENTE_SE_FALA)),
      ferramentas(enviar(A_GENTE_SE_FALA)),
      texto(""),
    ]);
    await turno(fake, { promessaSemantica: false });

    expect(estado.prompts[1]).toContain(VETO);
    expect(enviados).toEqual([A_GENTE_SE_FALA]);
    expect(await casos()).toEqual([{ source: "guardrail_autofallback", status: "awaiting_human" }]);
    expect(await silencio()).toEqual({ forceHuman: false, silenciada: false, emHandoff: false });
  });

  it("o modelo reformula depois do 1º veto: a reformulada sai e nenhum caso abre", async () => {
    const { fake, estado } = modelo([
      ferramentas(enviar(A_GENTE_SE_FALA)),
      ferramentas(enviar(REFORMULADA)),
      texto(""),
    ]);
    await turno(fake, { promessaSemantica: false });

    expect(estado.prompts[1]).toContain(VETO);
    expect(enviados).toEqual([REFORMULADA]);
    expect(await casos()).toEqual([]);
  });

  it("sem a camada semântica, 'te retorno' não é pego pelo léxico: sai sem veto e sem caso", async () => {
    const { fake, estado } = modelo([ferramentas(enviar(MARINA_1)), texto("")]);
    await turno(fake, { promessaSemantica: false });

    expect(estado.classificacoes).toBe(0);
    expect(estado.prompts.some((p) => p.includes(VETO))).toBe(false);
    expect(enviados).toEqual([MARINA_1]);
    expect(await casos()).toEqual([]);
  });
});
