import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as SendLedger from "@/lib/agent-engine/edge/crm/send-ledger";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01) A RE-EXECUÇÃO COM FALHA NA POSIÇÃO 1 E SUCESSO NAS 2 E 3 — a regressão de
 * turno completo que a terceira revisão adversarial do Codex (03/10/2026) pediu para
 * o achado 1 (alto): o turno inteiro contra Postgres real, com modelo falso e um
 * canal falso que passa pelo `send_ledger` REAL (como o adapter WAHA faz) e um
 * handler de CRM falso que só registra o que entregou.
 *
 * O cenário: a execução anterior deixou no ledger a posição 1 'failed' (A), e as
 * posições 2 e 3 aceitas (B e C) — teto do turno 3. O job volta à fila; o modelo
 * regenera A, B e C. Antes, a execução partia de "3 enviadas" (a maior posição aceita),
 * as duas ferramentas de envio recusavam por `max_sends_per_turn` antes de consultar o
 * ledger, nada saía, nada falhava, e o job concluía com A sem entrega para sempre.
 * Agora a contagem é de entregas (2): A sai, na posição 4; B e C, já entregues,
 * não saem de novo.
 *
 * (Rodada 5) O cenário do achado 1 da QUARTA revisão: A aceita, B pendente (o CRM
 * segura a mensagem, `queued`) e C ainda não criada. A recuperação conta B como
 * enviada; a re-execução retoma o recibo de B pela mesma chave e o canal devolve
 * `sent` — antes isso contava DE NOVO, o teto fechava em 3 com duas mensagens e C era
 * omitida com o envio devolvendo sucesso. Agora as três saem, nenhuma duplicada, e o
 * teto continua valendo para a quarta.
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
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";
const TETO = 3;

const A = "Oi! Vi que você perguntou sobre o plano.";
const B = "Ele inclui o material e o acesso à plataforma.";
const C = "Quer que eu te mande o link para começar?";
const D = "Posso te ajudar com mais alguma coisa?";

type Modules = {
  turno: typeof InboundTurn;
  ledger: typeof SendLedger;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

/** O que o CRM falso entregou (na ordem), e com que chave de idempotência. */
let entregues: Array<{ body: string; key: string }> = [];

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

/**
 * Modelo falso que manda A, B e C (uma por etapa) e depois encerra. Guarda o que o SDK
 * lhe devolveu, um resultado por chamada de ferramenta (o prompt de cada etapa repete
 * os resultados anteriores).
 */
function modeloQueRegeneraAsTres(textos: readonly string[] = [A, B, C]) {
  const estado = { etapas: 0, checkpoints: 0, resultados: new Map<string, string>() };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result")
          estado.resultados.set(String(parte.toolCallId), JSON.stringify(parte.output ?? parte));
      }
    }
    const ultima = msgs[msgs.length - 1];
    const pedeCheckpoint =
      ultima?.role === "user" &&
      Array.isArray(ultima.content) &&
      (ultima.content as Array<Record<string, unknown>>).some(
        (p) => p.type === "text" && p.text === m.turno.CHECKPOINT_INSTRUCTION,
      );
    if (pedeCheckpoint) {
      estado.checkpoints += 1;
      return {
        content: [{ type: "text" as const, text: CHECKPOINT }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    estado.etapas += 1;
    const body = textos[estado.etapas - 1];
    if (body === undefined) {
      return {
        content: [{ type: "text" as const, text: "ok" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
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

/**
 * O canal falso passa pelo `send_ledger` REAL (como `WahaChannelAdapter.send` →
 * `sendTurnMessage` → `sendWithLedger`), com um handler de CRM que só registra a
 * entrega. É o ledger de verdade que decide `sent`/`already_sent` e a posição.
 */
function montaHandler(doGenerate: unknown) {
  const store = m.ledger.pgSendLedger(pool);
  return m.turno.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 8,
      maxSendsPerTurn: TETO,
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
        channel: "ledger-real",
        send: async (i: {
          tenantId: string;
          leadId: string | null;
          jobId: string;
          seq: number;
          body: string;
        }) => {
          const outcome = await m.ledger.sendWithLedger(
            store,
            { tenantId: i.tenantId, leadId: i.leadId, jobId: i.jobId, seq: i.seq, body: i.body },
            async (key, messageId) => {
              entregues.push({ body: i.body, key });
              // A retomada de um recibo pendente reavalia a mensagem que o CRM já tem
              // (`messageId` é o id dela): o CRM falso a marca enviada, como o real
              // faria quando a sessão volta.
              await pool.query(
                "update messages set status = 'sent' where organization_id = $1 and id = $2",
                [ORG, messageId],
              );
              return { id: messageId, status: "sent" };
            },
          );
          if (outcome.kind === "blocked") return outcome;
          return {
            kind: outcome.kind,
            idempotencyKey: outcome.idempotencyKey,
            messageId: outcome.crmMessageId,
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
  /** O que a execução ANTERIOR deixou no ledger deste job, gravado antes de o handler rodar. */
  antes: (jobId: string) => Promise<void>,
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
      crm_event_id: evento,
    },
    maxAttempts: 2,
  });
  await antes(job.id);
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "rec", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "rec" });
    await m.queue.completeJob(pool, claimed!.id, "rec");
    return { erro: null, jobId: job.id };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "rec", err);
    return { erro: err as Error, jobId: job.id };
  }
}

/** Um recibo como a execução anterior o deixou. Devolve a chave (id do recibo). */
async function recibo(jobId: string, seq: number, status: string, body: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [ORG, CONTACT, jobId, seq, m.ledger.hashDoConteudo({ body }), status],
  );
  return rows[0]!.id;
}

/** A mensagem que o CRM gravou para um recibo e ainda segura (`queued`): o canal a entrega quando a sessão voltar. */
async function mensagemNaFila(chave: string, body: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, metadata)
     values ($1,$2,$3,$4,$5,'text','outbound','queued',$6,'ai',$7::jsonb)`,
    [id, ORG, CONV, SESSION, CONTACT, body, JSON.stringify({ idempotency_key: chave })],
  );
  return id;
}

beforeAll(async () => {
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    ledger: await import("@/lib/agent-engine/edge/crm/send-ledger"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'c01-recuperacao-posicao-1','Recuperação','Recuperação')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Recuperação','+5511900000777') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, waha_session_name,
                                   status, webhook_secret_encrypted)
     values ($1,$2,'waha','c01-recuperacao','WORKING','\\x00'::bytea)
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
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi, me conta do plano?','external_device',$6)
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT, MENSAGEM_DO_CLIENTE_EM],
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

beforeEach(async () => {
  entregues = [];
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1 and direction = 'outbound'", [
    ORG,
  ]);
  // A janela do gate de spinning é por NÚMERO e atravessa os casos: sem limpá-la, o A
  // do terceiro caso casa com os A dos dois anteriores e volta `mass_identical`.
  await pool.query("delete from outbound_copies where organization_id = $1", [ORG]);
});

describe("turno completo — a re-execução com falha na posição 1 e sucesso nas 2 e 3 (achado 1 da terceira revisão)", () => {
  it("posição 1 'failed', 2 e 3 aceitas (teto 3): a re-execução entrega A na posição 4; B e C não saem de novo; o job conclui", async () => {
    const modelo = modeloQueRegeneraAsTres();
    const { erro, jobId } = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000006",
      async (id) => {
        await recibo(id, 1, "failed", A);
        await recibo(id, 2, "accepted", B);
        await recibo(id, 3, "accepted", C);
      },
    );
    expect(erro).toBeNull();

    // O cliente recebeu A — a mensagem que a execução anterior não conseguiu entregar
    // — e só ela. Antes: nada saía (as três chamadas recusadas por teto) e o job
    // concluía do mesmo jeito, com A perdida.
    expect(entregues.map((e) => e.body)).toEqual([A]);

    // No ledger: A aceita na posição 4; as posições antigas como estavam.
    const { rows } = await pool.query<{ seq: number; status: string; body_hash: string }>(
      "select seq, status, body_hash from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows.map((r) => [Number(r.seq), r.status])).toEqual([
      [1, "failed"],
      [2, "accepted"],
      [3, "accepted"],
      [4, "accepted"],
    ]);
    expect(rows[3]!.body_hash).toBe(m.ledger.hashDoConteudo({ body: A }));

    // O modelo pediu as três; depois de A o teto (3) está cheio e as outras duas
    // voltaram como `max_sends_per_turn` — nunca como falha de envio.
    expect(modelo.estado.etapas).toBe(4);
    expect(modelo.estado.checkpoints).toBe(1);
    const resultados = [...modelo.estado.resultados.values()];
    expect(resultados).toHaveLength(3);
    expect(resultados[0]).toMatch(/"status":"enviada"/);
    expect(resultados[1]).toMatch(/max_sends_per_turn/);
    expect(resultados[2]).toMatch(/max_sends_per_turn/);
    expect(resultados.join("\n")).not.toMatch(/envio_falhou/);
  });

  it("posição 1 'requested' sem mensagem (nunca chegou ao CRM), 2 e 3 aceitas: a re-execução RETOMA o recibo de A, na posição 1", async () => {
    const modelo = modeloQueRegeneraAsTres();
    let chaveDeA = "";
    const { erro, jobId } = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000007",
      async (id) => {
        await recibo(id, 1, "requested", A);
        await recibo(id, 2, "accepted", B);
        await recibo(id, 3, "accepted", C);
        const { rows } = await pool.query<{ id: string }>(
          "select id from send_ledger where job_id = $1 and seq = 1",
          [id],
        );
        chaveDeA = rows[0]!.id;
      },
    );
    expect(erro).toBeNull();
    // A saiu com a MESMA chave do recibo pendente: nenhuma posição nova.
    expect(entregues).toEqual([{ body: A, key: chaveDeA }]);
    const { rows } = await pool.query<{ seq: number; status: string }>(
      "select seq, status from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows.map((r) => [Number(r.seq), r.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
  });

  it("(rodada 5) A aceita, B pendente (o CRM segura a mensagem), C ainda não criada (teto 3): as três saem, nenhuma omitida nem duplicada, e a 4ª é recusada por teto", async () => {
    const modelo = modeloQueRegeneraAsTres([A, B, C, D]);
    let chaveDeB = "";
    let mensagemDeB = "";
    const { erro, jobId } = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000008",
      async (id) => {
        await recibo(id, 1, "accepted", A);
        chaveDeB = await recibo(id, 2, "queued", B);
        mensagemDeB = await mensagemNaFila(chaveDeB, B);
      },
    );
    expect(erro).toBeNull();

    // O CRM foi acionado duas vezes: para reavaliar B (a MESMA chave do recibo
    // pendente — a mensagem que ele já tinha) e para C, nova. A já estava entregue.
    // Antes: só B — a retomada contava de novo, o teto fechava em 3 e C era omitida.
    expect(entregues).toEqual([
      { body: B, key: chaveDeB },
      { body: C, key: expect.any(String) },
    ]);
    expect(entregues[1]!.key).not.toBe(chaveDeB);

    // No ledger: B aceita na SUA posição (2), com a mensagem que o CRM já tinha; C na 3.
    const { rows } = await pool.query<{
      seq: number;
      status: string;
      crm_message_id: string | null;
    }>(
      "select seq, status, crm_message_id from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows.map((r) => [Number(r.seq), r.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(rows[1]!.crm_message_id).toBe(mensagemDeB);

    // O cliente tem três mensagens deste job, uma vez cada.
    const { rows: mensagens } = await pool.query<{ body: string; status: string }>(
      "select body, status from messages where organization_id = $1 and direction = 'outbound' order by created_at",
      [ORG],
    );
    expect(mensagens).toEqual([{ body: B, status: "sent" }]);

    // O modelo pediu as quatro: A, B e C voltaram como enviadas; D, como teto cheio.
    expect(modelo.estado.etapas).toBe(5);
    expect(modelo.estado.checkpoints).toBe(1);
    const resultados = [...modelo.estado.resultados.values()];
    expect(resultados).toHaveLength(4);
    expect(resultados[0]).toMatch(/"status":"enviada"/);
    expect(resultados[1]).toMatch(/"status":"enviada"/);
    expect(resultados[2]).toMatch(/"status":"enviada"/);
    expect(resultados[3]).toMatch(/max_sends_per_turn/);
    expect(resultados.join("\n")).not.toMatch(/envio_falhou/);
  });
});
