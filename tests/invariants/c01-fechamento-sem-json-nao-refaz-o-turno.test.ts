import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as Checkpoint from "@/lib/agent-engine/agent/abertura/checkpoint";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01) O FECHAMENTO SEM JSON NÃO REFAZ O TURNO QUE JÁ FALOU COM O LEAD — o turno
 * inteiro contra Postgres real, com modelo e canal falsos (o harness de
 * `c01-envio-falhado-nao-e-resposta.test.ts`), e a fila de verdade: cada falha do
 * handler volta pelo `failJob` e a tentativa seguinte é claimada como o worker faria.
 *
 * O achado (laboratório, piloto-1 e geral-1, 07 e 08/10/2026): na chamada de
 * fechamento o modelo parou sem devolver o JSON (texto vazio ou uma mensagem de
 * WhatsApp). O erro devolvia o job à fila depois de a resposta ter saído; a nova
 * tentativa refazia o turno e mandava OUTRA mensagem, com outras palavras — o recibo do
 * ledger só barra conteúdo igual. O modelo falso daqui faz o mesmo: cada execução do
 * turno escreve um texto diferente.
 *
 * O que se prova, do jeito que o cliente sentiria:
 *   - fechamento vazio duas vezes depois da resposta: UMA mensagem ao lead, job
 *     concluído na 1ª tentativa, checkpoint mínimo gravado (o do turno anterior, com a
 *     promessa sintética e a próxima ação de retomar pela última resposta) e o aviso na
 *     Central, com o Operador desligado E ligado (ligado, qualquer ferramenta dele conta
 *     como dono e dispensaria o aviso dele). Sem a correção: duas mensagens;
 *   - fechamento vazio e depois JSON: uma mensagem, o checkpoint do modelo;
 *   - turno que não falou com o lead: com as duas chamadas de fechamento sem JSON (a
 *     segunda é a correção do autor, desde a 1.86), o job volta à fila como antes.
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

const ORG = "a3a3a3a3-0000-4000-8000-000000000001";
const CONTACT = "a3a3a3a3-0000-4000-8000-000000000002";
const SESSION = "a3a3a3a3-0000-4000-8000-000000000003";
const CONV = "a3a3a3a3-0000-4000-8000-000000000004";
const MSG = "a3a3a3a3-0000-4000-8000-000000000005";
const AGENTE = "a3a3a3a3-0000-4000-8000-000000000006";
const VERSAO = "a3a3a3a3-0000-4000-8000-000000000007";
/** A mesma configuração com o papel Operador ligado (versão publicada não se altera). */
const VERSAO_COM_OPERADOR = "a3a3a3a3-0000-4000-8000-000000000008";
/** O instante do turno (dentro da janela horária do anti-ban) e o da mensagem do cliente, 5 min antes. */
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";

type Modules = {
  turno: typeof InboundTurn;
  checkpoint: typeof Checkpoint;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

/** Tudo o que chegou ao canal, na ordem. */
let enviados: string[] = [];

/** Cada execução do turno escreve outra resposta, como o modelo de verdade. */
const RESPOSTAS = [
  "Oi! Seu cadastro está ativo, sim.",
  "Confirmado: o cadastro está ativo.",
  "Sim, o cadastro aparece como ativo.",
];
/**
 * O número do caso entra no texto: o anti-blast (`mass_identical`) veta o mesmo corpo
 * repetido entre os casos do arquivo, e o veto esconderia o que se mede aqui.
 */
let caso = 0;
const resposta = (execucao: number) =>
  `${RESPOSTAS[execucao] ?? `Resposta ${execucao + 1}.`} Atendimento ${caso}.`;

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

function pedeCheckpoint(opts: { prompt?: unknown }): boolean {
  // (Junção da 1.86) A segunda chamada de fechamento leva, depois do pedido de
  // checkpoint, a resposta recusada e a correção do autor (`correcaoDoFechamento`):
  // o pedido deixa de ser a última mensagem, então vale qualquer mensagem do usuário.
  const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
  return msgs.some(
    (msg) =>
      msg.role === "user" &&
      Array.isArray(msg.content) &&
      (msg.content as Array<Record<string, unknown>>).some(
        (p) => p.type === "text" && p.text === m.turno.CHECKPOINT_INSTRUCTION,
      ),
  );
}

/**
 * Modelo falso. `responde`: cada execução manda a sua resposta (a 1ª etapa chama
 * `send_message`, a 2ª encerra); `cala`: encerra sem mandar nada. O fechamento devolve
 * os textos de `fechamentos` na ordem; esgotados, o JSON do modelo.
 */
function modelo(modo: "responde" | "cala", fechamentos: string[]) {
  const estado = { etapas: 0, execucoes: 0, fechamentos: 0 };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    if (pedeCheckpoint(opts)) {
      const t = fechamentos[estado.fechamentos] ?? CHECKPOINT_DO_MODELO;
      estado.fechamentos += 1;
      return texto(t);
    }
    const primeiraEtapa = estado.etapas % 2 === 0;
    estado.etapas += 1;
    if (modo === "cala" || !primeiraEtapa) return texto("pronto");
    const body = resposta(estado.execucoes);
    estado.execucoes += 1;
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${estado.etapas}`,
          toolName: "send_message",
          input: JSON.stringify({ body }),
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
          enviados.push(i.body);
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

/**
 * O job do turno pela fila, como o worker o trataria: claim, handler, `completeJob`
 * ou `failJob`; enquanto ele voltar a `pending`, a próxima tentativa é claimada (sem a
 * espera do backoff). Para no `done`, no `dead` ou em `tentativasNoMaximo` execuções.
 */
async function rodaPelaFila(
  handler: ReturnType<typeof montaHandler>,
  maxAttempts: number,
  tentativasNoMaximo = 1,
): Promise<{ jobId: string; erros: string[]; status: string; attempts: number }> {
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
    // Só este job na fila (o operador que o turno enfileira não entra) e sem a espera do backoff.
    await pool.query("update job_queue set status = 'done' where status = 'pending' and id <> $1", [job.id]);
    await pool.query("update job_queue set run_after = now() where id = $1", [job.id]);
    const [claimed] = await m.queue.claimJobs(pool, { workerId: "fechamento", maxConcurrency: 1 });
    if (claimed?.id !== job.id) break;
    try {
      await handler(claimed, pool, { workerId: "fechamento" });
      await m.queue.completeJob(pool, claimed.id, "fechamento");
    } catch (err) {
      erros.push(err instanceof Error ? err.message : String(err));
      await m.queue.failJob(pool, claimed.id, "fechamento", err);
    }
    const { rows } = await pool.query<{ status: string }>("select status from job_queue where id = $1", [job.id]);
    if (rows[0]!.status !== "pending") break;
  }
  const { rows } = await pool.query<{ status: string; attempts: number }>(
    "select status, attempts from job_queue where id = $1",
    [job.id],
  );
  return { jobId: job.id, erros, status: rows[0]!.status, attempts: rows[0]!.attempts };
}

/** O aviso que o checkpoint mínimo abre na Central. */
const AVISO_DO_MINIMO = {
  title: "O registro de um atendimento falhou depois da resposta ao cliente",
  body:
    "A resposta ao cliente saiu, mas o registro do turno falhou. Confira na conversa se ela " +
    "prometeu retorno, horário ou verificação e se já existe retorno agendado antes de agir.",
  severity: "warn",
  status: "open",
};

/** Os avisos de promessa abertos na Central para a conversa. */
async function avisosDaConversa() {
  const { rows } = await pool.query<{ title: string; body: string; severity: string; status: string }>(
    `select title, body, severity, status from agent_inbox_items
      where organization_id = $1 and kind = 'promise_unfulfilled'
        and ref_kind = 'conversation' and ref_id = $2`,
    [ORG, CONV],
  );
  return rows;
}

/** Os checkpoints gravados por este job. */
async function checkpointsDoJob(jobId: string) {
  const { rows } = await pool.query<{
    commitments: string[];
    objections: string[];
    next_action: string | null;
    rolling_summary: string;
    declaracao: unknown;
  }>(
    `select commitments, objections, next_action, rolling_summary, declaracao
       from lead_checkpoints where organization_id = $1 and job_id = $2 order by seq`,
    [ORG, jobId],
  );
  return rows;
}

beforeAll(async () => {
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    checkpoint: await import("@/lib/agent-engine/agent/abertura/checkpoint"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'c01-fechamento-sem-json','Fechamento','Fechamento')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Fechamento','+5511900000781') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-fechamento-sessao','WORKING','\\x00'::bytea)
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
     values ($1,$2,'Agente do fechamento','Você é um atendente de teste.','mcp_agent')
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
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at, max_steps,
                                    operator_enabled)
     values ($1,$2,$3,2,'Você é um atendente de teste.','anthropic','claude-sonnet-4-6',$4,'published',now(),8,true)
     on conflict (id) do nothing`,
    [VERSAO_COM_OPERADOR, ORG, AGENTE, SESSION],
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
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1 and direction = 'outbound'", [ORG]);
  await pool.query("delete from lead_checkpoints where organization_id = $1", [ORG]);
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  // O checkpoint do turno anterior: o que o mínimo herda.
  await pool.query(
    `insert into lead_checkpoints (organization_id, contact_id, commitments, objections, next_action, rolling_summary, declaracao)
     values ($1,$2,'["retornar amanhã"]'::jsonb,'["acha caro"]'::jsonb,'perguntar a área','resumo do turno anterior',
             '{"intencoes":[],"promessas":[],"nada_a_declarar":true}'::jsonb)`,
    [ORG, CONTACT],
  );
});

describe("(C01) fechamento sem JSON depois da resposta ao lead: o turno não é refeito", () => {
  it("vazio duas vezes: uma mensagem só, job concluído na 1ª tentativa, checkpoint mínimo", async () => {
    const mod = modelo("responde", ["", ""]);
    const r = await rodaPelaFila(montaHandler(mod.doGenerate), 3, 3);

    // Sem a correção: o 1º fechamento sem JSON devolve o job à fila, a 2ª tentativa
    // refaz o turno e o lead recebe as três respostas, uma por tentativa.
    expect(enviados).toEqual([resposta(0)]);
    expect(r.erros).toEqual([]);
    expect(r.status).toBe("done");
    expect(r.attempts).toBe(1);
    expect(mod.estado.execucoes).toBe(1);
    expect(mod.estado.fechamentos).toBe(2);
    expect(await checkpointsDoJob(r.jobId)).toEqual([
      {
        commitments: ["retornar amanhã"],
        objections: ["acha caro"],
        next_action: m.checkpoint.PROXIMA_ACAO_DO_FECHAMENTO_FALHO,
        rolling_summary: "resumo do turno anterior",
        declaracao: {
          intencoes: [],
          promessas: [{ o_que: m.checkpoint.PROMESSA_DO_FECHAMENTO_FALHO, prazo: null }],
          nada_a_declarar: false,
        },
      },
    ]);
    // O agente daqui tem o Operador desligado: ninguém apuraria a promessa, e o aviso
    // vai direto à Central, na conversa.
    const avisos = await avisosDaConversa();
    expect(avisos).toEqual([AVISO_DO_MINIMO]);
    // O aviso não afirma o que ninguém verificou (o retorno pode ter sido agendado).
    expect(avisos[0]!.body).not.toContain("nada foi agendado");
    expect(avisos[0]!.body).not.toContain("cumpra você mesmo");
  });

  it("vazio duas vezes com o Operador ligado: ele é enfileirado e o aviso abre do mesmo jeito", async () => {
    await pool.query("update ai_agents set published_version_id = $1 where id = $2", [VERSAO_COM_OPERADOR, AGENTE]);
    try {
      const mod = modelo("responde", ["", ""]);
      const r = await rodaPelaFila(montaHandler(mod.doGenerate), 3, 3);

      expect(enviados).toEqual([resposta(0)]);
      expect(r.status).toBe("done");
      expect(r.attempts).toBe(1);
      const operador = await pool.query(
        "select 1 from job_queue where organization_id = $1 and kind = 'operator_turn' and source_event_id = $2",
        [ORG, r.jobId],
      );
      expect(operador.rowCount).toBe(1);
      // Antes do ajuste, com o Operador enfileirado o turno não avisava: a apuração dele
      // decidia, e qualquer ferramenta chamada (até uma consulta) contava como dono.
      expect(await avisosDaConversa()).toEqual([AVISO_DO_MINIMO]);
    } finally {
      await pool.query("update ai_agents set published_version_id = $1 where id = $2", [VERSAO, AGENTE]);
    }
  });

  it("vazio e depois JSON: uma mensagem só, o checkpoint do modelo", async () => {
    const mod = modelo("responde", [""]);
    const r = await rodaPelaFila(montaHandler(mod.doGenerate), 3, 3);

    expect(enviados).toEqual([resposta(0)]);
    expect(r.erros).toEqual([]);
    expect(r.status).toBe("done");
    expect(r.attempts).toBe(1);
    expect(mod.estado.fechamentos).toBe(2);
    const gravados = await checkpointsDoJob(r.jobId);
    expect(gravados).toHaveLength(1);
    expect(gravados[0]!.rolling_summary).toBe("resumo escrito pelo modelo");
    expect(gravados[0]!.declaracao).toEqual({ intencoes: [], promessas: [], nada_a_declarar: true });
    expect(await avisosDaConversa()).toEqual([]);
  });
});

describe("(C01) o que não muda", () => {
  it("o turno que não falou com o lead e fecha sem JSON volta à fila como antes", async () => {
    // (Junção da 1.86) Sem resposta ao lead, a correção do autor também é pedida: só
    // a falha das DUAS chamadas de fechamento devolve o turno à fila.
    const mod = modelo("cala", ["", ""]);
    const r = await rodaPelaFila(montaHandler(mod.doGenerate), 3, 1);

    expect(enviados).toEqual([]);
    expect(r.erros).toEqual(["fechamento do turno sem JSON de checkpoint — run re-tentado pela fila"]);
    expect(r.status).toBe("pending");
    expect(mod.estado.fechamentos).toBe(2);
    expect(await checkpointsDoJob(r.jobId)).toEqual([]);
  });

  it("o fechamento com JSON na primeira chamada: uma chamada, o checkpoint do modelo", async () => {
    const mod = modelo("responde", []);
    const r = await rodaPelaFila(montaHandler(mod.doGenerate), 3, 3);

    expect(enviados).toEqual([resposta(0)]);
    expect(r.status).toBe("done");
    expect(mod.estado.fechamentos).toBe(1);
    expect((await checkpointsDoJob(r.jobId)).map((c) => c.rolling_summary)).toEqual(["resumo escrito pelo modelo"]);
  });
});
