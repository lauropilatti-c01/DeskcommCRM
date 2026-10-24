import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
/** Retorno consentido: ferramenta, cron, fila e worker reais; somente dados fictícios. */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ financeiro: vi.fn(), ia: vi.fn() }));
vi.mock("@/lib/leads/fonte-financeira", () => ({ lerSituacaoFinanceira: fake.financeiro }));
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => ({
  ...(await original<typeof InboundTurn>()),
  runAgentTurn: fake.ia,
}));

vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => pool }));
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import {
  comEnvioAcompanhamentoC01,
  assertAcompanhamentoC01Supabase,
} from "@/lib/followup/c01-acompanhamento-runtime";
import { claimOfJob } from "@/lib/agent-engine/queue/claim";
import { RetornoC01CanceladoError } from "@/lib/followup/c01-retorno-cancelado";
import { redriveQueued } from "@/lib/agent-engine/edge/crm/session-reconciler";
import { conferirRetornoNoEnvioC01 } from "@/lib/followup/c01-retorno";
import { hashDoCorpo } from "@/lib/api/idempotency";
import { applyScheduleFollowup } from "@/lib/agent-engine/agent/schedule-followup";
import {
  createFollowupTurnHandler,
  type FollowupTurnDeps,
} from "@/lib/agent-engine/agent/followup-turn";
import { tickCron } from "@/lib/agent-engine/cron/scheduler";
import {
  claimJobs,
  completeJob,
  reapExpiredJobs,
  type JobRow,
} from "@/lib/agent-engine/queue/queue";
import {
  withServiceBoundary,
  withServiceJob,
  readCurrentServiceBoundary,
} from "@/lib/atendimento/fronteira-server";
import { disporJobAposFalha } from "@/workers/agent-worker/dispor-job-apos-falha";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import type { ChannelSendInput } from "@/lib/agent-engine/channel-adapter";

if (!process.env.TEST_DB_CONTAINER || !process.env.TEST_DB_TEMPLATE)
  throw new Error("A prova exige o banco descartável do harness oficial.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 8,
});
const CONSENT = new Date("2026-10-24T14:00:00Z");
const DUE = new Date("2026-10-25T15:00:00Z");
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const sent: ChannelSendInput[] = [];
let transportFailure = false;
const fetchDenied = vi.fn(async () => {
  throw new Error("rede externa proibida nesta prova");
});
beforeEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
  transportFailure = false;
  vi.stubGlobal("fetch", fetchDenied);
  fake.ia.mockImplementation(async () => {
    throw new Error("IA proibida nesta prova");
  });
  fake.financeiro.mockImplementation(async ({ now }) => ({
    status: "nao_comprou_confirmado",
    complete: true,
    checkedAt: now.toISOString(),
  }));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.C01_ACOMPANHAMENTO_INTEGRATION;
  await pool.end();
});

async function fixture(template = true) {
  const org = randomUUID(),
    contact = randomUUID(),
    lead = randomUUID(),
    pipeline = randomUUID(),
    stage = randomUUID(),
    channel = randomUUID(),
    conversation = randomUUID(),
    agent = randomUUID(),
    version = randomUUID(),
    model = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name,timezone) values($1,$2,'P1B fictício','P1B fictício','America/Sao_Paulo')",
    [org, `p1b-${org}`],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name,phone_number,source) values($1,$2,'Pessoa fictícia','+5511999990001','whatsapp')",
    [contact, org],
  );
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Funil fictício','ficticio')",
    [pipeline, org],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Aberto','aberto',1000)",
    [stage, org, pipeline],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,custom_fields) values($1,$2,$3,$4,$5,'Oportunidade fictícia',$6)",
    [lead, org, pipeline, stage, contact, { produto_chave: "produto-ficticio" }],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,status,provider,meta_waba_id,meta_phone_number_id) values($1,$2,$3,'\\x00','STOPPED','meta_cloud','p1b-ficticio',$3)",
    [channel, org, `p1b-${channel}`],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status,assignee_kind,last_inbound_at) values($1,$2,$3,$4,'ai_handling','ai',$5)",
    [conversation, org, contact, channel, CONSENT],
  );
  await pool.query(
    "insert into ai_agents(id,organization_id,name,system_prompt,operation_mode) values($1,$2,'Agente fictício','Nunca acessar serviços externos.','automatic')",
    [agent, org],
  );
  await pool.query(
    "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,followup) values($1,$2,$3,1,'Nunca acessar serviços externos.','anthropic','modelo-ficticio',$4,'published',$5)",
    [version, org, agent, channel, { callback_enabled: true, c01_callback: true }],
  );
  await pool.query("update ai_agents set published_version_id=$1 where id=$2", [version, agent]);
  const definition = {
    name: "retorno_p1b_ficticio",
    language: "pt_BR",
    parameter_format: "POSITIONAL",
    components: [{ type: "BODY", text: "Olá! Retomando nossa conversa no horário combinado." }],
  };
  if (template)
    await pool.query(
      "insert into meta_templates(id,organization_id,waba_id,channel_session_id,name,language,status,category,components,parameter_format,contract_hash) values($1,$2,'p1b-ficticio',$3,$4,$5,'APPROVED','MARKETING',$6,$7,'ficticio')",
      [
        model,
        org,
        channel,
        definition.name,
        definition.language,
        JSON.stringify(definition.components),
        definition.parameter_format,
      ],
    );
  process.env.C01_ACOMPANHAMENTO_INTEGRATION = JSON.stringify({
    enabled: true,
    organizationId: org,
    tokenSha256: "a".repeat(64),
    signingKey: "p1b-ficticio-sem-segredo-".repeat(2),
    allowedKinds: ["oferta"],
    ...(template
      ? {
          callbackTemplate: {
            enabled: true,
            connectionId: channel,
            templateId: model,
            contentHash: hashDoCorpo(definition),
          },
        }
      : {}),
  });
  async function inbound(body: string, at = CONSENT) {
    const id = randomUUID();
    await pool.query(
      "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,body,sent_at) values($1,$2,$3,$4,$5,'inbound','text','delivered',$6,$7)",
      [id, org, contact, conversation, channel, body, at],
    );
    // O ingresso real também atualiza este espelho da conversa; inserir apenas a mensagem não o faz.
    await pool.query("update conversations set last_inbound_at=$1 where id=$2", [at, conversation]);
    return { id, body, at };
  }
  const consent = await inbound("Pode me chamar amanhã às 12h");
  async function schedule(message = consent, promisedAt = DUE, replace?: string) {
    const boundary = await readCurrentServiceBoundary(pool, org, conversation);
    return withServiceBoundary(pool, boundary, () =>
      applyScheduleFollowup(
        pool,
        {
          c01Callback: true,
          clock: () => new Date(+message.at + 1000),
          knobs: { minAheadMs: 1000, maxAheadMs: 7 * 86400000, staggerWindowMs: 0 },
        },
        { tenantId: org, leadId: contact, agentId: agent },
        {
          reason: "Retorno solicitado pelo contato fictício",
          promised_at: promisedAt.toISOString(),
          promise: "Retomar no horário confirmado",
          consent_message_id: message.id,
          consent_excerpt: message.body,
          ...(replace ? { replace_pending_id: replace } : {}),
        },
      ),
    );
  }
  async function fire(now = DUE) {
    const result = await tickCron(
      pool,
      { batchSize: 20, staggerWindowMs: 0, retryBaseMs: 1000, now: () => +now },
      log,
    );
    const jobs = await claimJobs(pool, {
      workerId: "p1b-privado",
      maxConcurrency: 20,
      batchSize: 20,
    });
    const job = jobs.find((j) => j.organization_id === org);
    if (!job) throw new Error(`cron sem job: ${JSON.stringify(result)}`);
    expect(job.kind).toBe("followup_turn");
    expect(job.payload).toMatchObject({
      scope: "commercial",
      lead_id: lead,
      product_key: "produto-ficticio",
      service_boundary: {
        organization_id: org,
        contact_id: contact,
        conversation_id: conversation,
      },
    });
    return job;
  }
  async function run(job: JobRow, now = DUE) {
    const deps = {
      clock: () => now,
      log,
      knobs: { historyLimit: 20, maxContextTokens: 3000 },
      crmCfg: {},
      llmCfg: {},
      sleep: async () => {},
      channel: () => ({
        send: async (input: ChannelSendInput) => {
          if (transportFailure) throw new Error("transporte fictício indisponível");
          sent.push(input);
          return {
            kind: "sent",
            idempotencyKey: `p1b-${input.jobId}-${input.seq}`,
            messageId: randomUUID(),
          };
        },
      }),
    } as unknown as FollowupTurnDeps;
    try {
      await withServiceJob(pool, job, () =>
        createFollowupTurnHandler(deps)(job, pool, { workerId: "p1b-privado" }),
      );
      await completeJob(pool, job.id, "p1b-privado", undefined, job.claim_acquired_at);
      return { kind: "completed" };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const terminal =
        error instanceof StaleServiceBoundaryError ||
        (typeof error === "object" &&
          error !== null &&
          "terminal" in error &&
          error.terminal === true);
      await disporJobAposFalha(pool, job, "p1b-privado", error, terminal, log);
      return { kind: "blocked", reason };
    }
  }
  return {
    org,
    contact,
    lead,
    conversation,
    agent,
    channel,
    consent,
    schedule,
    inbound,
    fire,
    run,
    definition,
  };
}

async function state(job: JobRow) {
  return (
    await pool.query(
      "select status,last_error,attempts,run_after,locked_by from job_queue where id=$1",
      [job.id],
    )
  ).rows[0];
}
async function claimAgain(job: JobRow) {
  await pool.query("update job_queue set run_after=now()-interval '1 second' where id=$1", [
    job.id,
  ]);
  return (
    await claimJobs(pool, { workerId: "p1b-privado", maxConcurrency: 20, batchSize: 20 })
  ).find((j) => j.id === job.id);
}

describe("P1B: veto definitivo não revive; incerteza continua recuperável", () => {
  for (const reason of ["resposta", "humano", "compra", "recusa", "revogacao"] as const) {
    it(`${reason}: cancela no worker real e não volta quando o sinal some`, async () => {
      const f = await fixture();
      expect((await f.schedule()).ok).toBe(true);
      const job = await f.fire();
      if (reason === "resposta")
        await f.inbound("Resolvi o que precisava", new Date(+CONSENT + 120000));
      if (reason === "humano")
        await pool.query("update contacts set force_human=true where id=$1", [f.contact]);
      if (reason === "compra")
        fake.financeiro.mockImplementation(async ({ now }) => ({
          status: "confirmado",
          complete: true,
          checkedAt: now.toISOString(),
        }));
      if (reason === "recusa")
        await pool.query("update contacts set ai_opt_out=true where id=$1", [f.contact]);
      if (reason === "revogacao")
        await pool.query("update messages set revoked_at=now() where id=$1", [f.consent.id]);
      const result = await f.run(job);
      expect(result.kind).toBe("blocked");
      expect(await state(job)).toMatchObject({ status: "failed", attempts: 1 });
      // Mesmo restaurando o sinal (pior caso), a promessa antiga acabou. Novo retorno exige novo consentimento.
      await pool.query("update contacts set force_human=false,ai_opt_out=false where id=$1", [
        f.contact,
      ]);
      await pool.query("update messages set revoked_at=null where id=$1", [f.consent.id]);
      await pool.query("update conversations set last_inbound_at=$1 where id=$2", [
        CONSENT,
        f.conversation,
      ]);
      fake.financeiro.mockImplementation(async ({ now }) => ({
        status: "nao_comprou_confirmado",
        complete: true,
        checkedAt: now.toISOString(),
      }));
      expect(await claimAgain(job)).toBeUndefined();
      expect(
        (
          await tickCron(
            pool,
            { batchSize: 20, staggerWindowMs: 0, retryBaseMs: 1000, now: () => +DUE },
            log,
          )
        ).fired,
      ).toBe(0);
      expect(sent).toHaveLength(0);
      expect(fake.ia).not.toHaveBeenCalled();
      expect(fetchDenied).not.toHaveBeenCalled();
    });
  }
  it.each(["ausente", "futuro"])("inbound %s não é evidência de resposta nova", async (kind) => {
    const f = await fixture();
    expect((await f.schedule()).ok).toBe(true);
    const job = await f.fire();
    await pool.query("update conversations set last_inbound_at=$1 where id=$2", [
      kind === "ausente" ? null : new Date(+DUE + 60000),
      f.conversation,
    ]);
    expect(await f.run(job)).toMatchObject({ reason: "c01_callback_inbound_unconfirmed" });
    expect(await state(job)).toMatchObject({ status: "pending", attempts: 1 });
    expect(sent).toHaveLength(0);
    expect(fake.ia).not.toHaveBeenCalled();
  });
  it.each(["incompleta", "inválida", "futura", "vencida"])(
    "compra confirmada com fonte %s fica pendente, sem cancelar definitivamente",
    async (kind) => {
      const f = await fixture();
      expect((await f.schedule()).ok).toBe(true);
      const job = await f.fire();
      fake.financeiro.mockResolvedValue({
        status: "confirmado",
        complete: kind !== "incompleta",
        checkedAt:
          kind === "inválida"
            ? "inválido"
            : new Date(
                +DUE + (kind === "futura" ? 60000 : kind === "vencida" ? -16 * 60000 : 0),
              ).toISOString(),
      });
      expect(await f.run(job)).toMatchObject({ reason: "c01_callback_purchase_unconfirmed" });
      expect(await state(job)).toMatchObject({ status: "pending", attempts: 1 });
      expect(sent).toHaveLength(0);
    },
  );
  it.each(["fonte", "transporte", "configuração", "relógio"])(
    "falha de %s mantém retry com backoff e revalida antes do envio fictício",
    async (kind) => {
      const f = await fixture();
      expect((await f.schedule()).ok).toBe(true);
      const job = await f.fire();
      const config = process.env.C01_ACOMPANHAMENTO_INTEGRATION;
      if (kind === "fonte") fake.financeiro.mockRejectedValue(new Error("fonte indisponível"));
      if (kind === "transporte") transportFailure = true;
      if (kind === "configuração") delete process.env.C01_ACOMPANHAMENTO_INTEGRATION;
      const result = await f.run(job, kind === "relógio" ? new Date(NaN) : DUE);
      expect(result.kind).toBe("blocked");
      const pending = await state(job);
      expect(pending).toMatchObject({ status: "pending", attempts: 1 });
      expect(+new Date(pending.run_after)).toBeGreaterThan(Date.now());
      expect(sent).toHaveLength(0);
      process.env.C01_ACOMPANHAMENTO_INTEGRATION = config;
      transportFailure = false;
      fake.financeiro.mockImplementation(async ({ now }) => ({
        status: "nao_comprou_confirmado",
        complete: true,
        checkedAt: now.toISOString(),
      }));
      const next = await claimAgain(job);
      expect(next).toBeDefined();
      const calls = fake.financeiro.mock.calls.length;
      expect(await f.run(next!)).toMatchObject({ kind: "completed" });
      expect(fake.financeiro.mock.calls.length).toBeGreaterThan(calls);
      expect(await state(job)).toMatchObject({ status: "done", attempts: 2 });
      expect(sent).toHaveLength(1);
      expect(fake.ia).not.toHaveBeenCalled();
      expect(fetchDenied).not.toHaveBeenCalled();
    },
  );
  it("lease antigo não cancela nova tentativa assumida pelo worker", async () => {
    const f = await fixture();
    expect((await f.schedule()).ok).toBe(true);
    const job = await f.fire();
    await pool.query("update contacts set force_human=true where id=$1", [f.contact]);
    const veto = await conferirRetornoNoEnvioC01(
      pool,
      { organizationId: f.org, contactId: f.contact, jobId: job.id },
      DUE,
      new AbortController().signal,
      fake.financeiro,
    ).catch((e) => e);
    expect(veto).toMatchObject({ terminal: true, message: "c01_callback_human" });
    await pool.query("update job_queue set locked_at=now()-interval '1 hour' where id=$1", [
      job.id,
    ]);
    expect((await reapExpiredJobs(pool, { visibilityTimeoutMs: 1000 })).revived).toBe(1);
    const next = await claimAgain(job);
    expect(next).toBeDefined();
    await disporJobAposFalha(pool, job, "p1b-privado", veto, true, log);
    expect(await state(job)).toMatchObject({
      status: "running",
      attempts: 2,
      locked_by: "p1b-privado",
    });
    // A tentativa atual também revalida e encerra; nunca usa a autorização da primeira.
    expect((await f.run(next!)).kind).toBe("blocked");
    expect(await state(job)).toMatchObject({ status: "failed" });
    expect(sent).toHaveLength(0);
  });
});

async function prepared(f: Awaited<ReturnType<typeof fixture>>, job: JobRow) {
  const id = randomUUID();
  await pool.query(
    "insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status) values($1,$2,$3,$4,1,'ficticio','requested')",
    [id, f.org, f.contact, job.id],
  );
  await pool.query(
    "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,body,sent_via,metadata,created_at) values($1,$2,$3,$4,$5,'outbound','text','queued','Texto fictício','ai',$6,now()-interval '1 hour')",
    [id, f.org, f.contact, f.conversation, f.channel, { idempotency_key: id }],
  );
  await pool.query("update channel_sessions set status='WORKING' where id=$1", [f.channel]);
  return id;
}
const watchdog = {
  wahaBaseUrl: "http://127.0.0.1:1",
  wahaApiKey: "fictício",
  intervalMs: 1,
  redriveMinAgeMs: 0,
  redriveBatchSize: 20,
  redriveSpacingMs: 0,
};

describe("P1B: cancelamento entre preparação e canal", () => {
  it("cancela job, mensagem preparada e ledger sem recibo de entrega", async () => {
    const f = await fixture();
    expect((await f.schedule()).ok).toBe(true);
    const job = await f.fire();
    const id = await prepared(f, job);
    await disporJobAposFalha(
      pool,
      job,
      "p1b-privado",
      new RetornoC01CanceladoError("human"),
      true,
      log,
    );
    expect(await state(job)).toMatchObject({ status: "failed" });
    expect(
      (await pool.query("select status,error_code from messages where id=$1", [id])).rows[0],
    ).toMatchObject({ status: "failed", error_code: "c01_callback_cancelled" });
    expect(
      (await pool.query("select status from send_ledger where id=$1", [id])).rows[0].status,
    ).toBe("failed");
    expect(
      (await pool.query("select fn_autonomous_turn_revoked($1,$2) as revoked", [f.org, job.id]))
        .rows[0].revoked,
    ).toBe(true);
    expect(await redriveQueued(pool, watchdog, log)).toBe(0);
    expect(fetchDenied).not.toHaveBeenCalled();
  });
  it("queda depois da revogação preserva o veto; resgate genérico não envia callback C01", async () => {
    const f = await fixture();
    expect((await f.schedule()).ok).toBe(true);
    const job = await f.fire();
    const id = await prepared(f, job);
    const tx = await pool.connect();
    const original = tx.query.bind(tx);
    let fail = true;
    const spy = vi.spyOn(tx, "query").mockImplementation((...args: Parameters<typeof tx.query>) => {
      if (fail && typeof args[0] === "string" && args[0].includes("c01:callback:cancel:messages")) {
        fail = false;
        throw new Error("persistência indisponível");
      }
      return original(...args);
    });
    const isolated = { connect: async () => tx } as unknown as pg.Pool;
    await expect(
      disporJobAposFalha(
        isolated,
        job,
        "p1b-privado",
        new RetornoC01CanceladoError("purchased"),
        true,
        log,
      ),
    ).rejects.toThrow("persistência indisponível");
    spy.mockRestore();
    expect(await state(job)).toMatchObject({ status: "running" });
    expect((await pool.query("select status from messages where id=$1", [id])).rows[0].status).toBe(
      "queued",
    );
    expect(
      (await pool.query("select fn_autonomous_turn_revoked($1,$2) as revoked", [f.org, job.id]))
        .rows[0].revoked,
    ).toBe(true);
    expect(await redriveQueued(pool, watchdog, log)).toBe(0);
    expect(fetchDenied).not.toHaveBeenCalled();
    await pool.query("update job_queue set locked_at=now()-interval '1 hour' where id=$1", [
      job.id,
    ]);
    await reapExpiredJobs(pool, { visibilityTimeoutMs: 1000 });
    const next = await claimAgain(job);
    expect(next).toBeDefined();
    expect((await f.run(next!)).kind).toBe("blocked");
    expect(sent).toHaveLength(0);
    expect(await state(job)).toMatchObject({ status: "failed" });
    expect((await pool.query("select status from messages where id=$1", [id])).rows[0].status).toBe(
      "failed",
    );
  });
});

it("autoridade service_role grava a revogação; callback não altera queued legado", async () => {
  const f = await fixture();
  expect((await f.schedule()).ok).toBe(true);
  const job = await f.fire();
  await prepared(f, job);
  const service = new pg.Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
    options: "-c role=service_role",
    max: 1,
  });
  try {
    expect((await service.query("select current_user as role")).rows[0].role).toBe("service_role");
    await disporJobAposFalha(
      service,
      job,
      "p1b-privado",
      new RetornoC01CanceladoError("restricted"),
      true,
      log,
    );
  } finally {
    await service.end();
  }
  expect(await state(job)).toMatchObject({ status: "failed" });
  const legacy = await fixture();
  expect((await legacy.schedule()).ok).toBe(true);
  const legacyJob = await legacy.fire();
  const id = await prepared(legacy, legacyJob);
  // Origem legada sem contrato C01: permanece no caminho anterior do watchdog.
  await pool.query("update job_queue set payload=payload-'c01_callback'-'scope' where id=$1", [
    legacyJob.id,
  ]);
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ id: "ficticio-watchdog" }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetch);
  expect(await redriveQueued(pool, watchdog, log)).toBe(1);
  expect(fetch).toHaveBeenCalledOnce();
  expect((await pool.query("select status from messages where id=$1", [id])).rows[0].status).toBe(
    "sent",
  );
});

it("sink C01 real relê sob trava: humano entre dois cortes chega terminal à disposição", async () => {
  const f = await fixture();
  expect((await f.schedule()).ok).toBe(true);
  const job = await f.fire();
  const { supabase } = criarDubleDoHandler({
    conversation: {},
    tabelasDeLeitura: { job_queue: { payload: job.payload } },
  });
  const context = {
    organizationId: f.org,
    contactId: f.contact,
    jobId: job.id,
    jobClaim: claimOfJob(job),
  };
  const error = await comEnvioAcompanhamentoC01(supabase, context, f.org, async () => {
    await assertAcompanhamentoC01Supabase(supabase, context, f.org, DUE);
    await pool.query("update contacts set force_human=true where id=$1", [f.contact]);
    await assertAcompanhamentoC01Supabase(supabase, context, f.org, DUE);
  }).catch((e) => e);
  expect(error).toBeInstanceOf(RetornoC01CanceladoError);
  expect(error).toMatchObject({ message: "c01_callback_human", terminal: true });
  await disporJobAposFalha(pool, job, "p1b-privado", error, true, log);
  expect(await state(job)).toMatchObject({ status: "failed" });
  expect(sent).toHaveLength(0);
  expect(fetchDenied).not.toHaveBeenCalled();
});

it("falha ao persistir revogação não anuncia cancelamento nem conclui o job", async () => {
  const f = await fixture();
  expect((await f.schedule()).ok).toBe(true);
  const job = await f.fire();
  const tx = await pool.connect();
  const original = tx.query.bind(tx);
  const spy = vi.spyOn(tx, "query").mockImplementation((...args: Parameters<typeof tx.query>) => {
    if (typeof args[0] === "string" && args[0].includes("c01:callback:cancel:revocation"))
      throw new Error("revogação não persistida");
    return original(...args);
  });
  try {
    await expect(
      disporJobAposFalha(
        { connect: async () => tx } as unknown as pg.Pool,
        job,
        "p1b-privado",
        new RetornoC01CanceladoError("human"),
        true,
        log,
      ),
    ).rejects.toThrow("revogação não persistida");
  } finally {
    spy.mockRestore();
  }
  expect(await state(job)).toMatchObject({ status: "running" });
  expect(
    (await pool.query("select fn_autonomous_turn_revoked($1,$2) as revoked", [f.org, job.id]))
      .rows[0].revoked,
  ).toBe(false);
  expect(sent).toHaveLength(0);
});

it("preserva recibo aceito quando o espelho da mensagem ainda está queued", async () => {
  const f = await fixture();
  expect((await f.schedule()).ok).toBe(true);
  const job = await f.fire();
  const id = await prepared(f, job);
  await pool.query("update send_ledger set status='accepted',crm_message_id=$1 where id=$1", [id]);
  await disporJobAposFalha(
    pool,
    job,
    "p1b-privado",
    new RetornoC01CanceladoError("human"),
    true,
    log,
  );
  expect(await state(job)).toMatchObject({ status: "failed" });
  expect(
    (await pool.query("select status from send_ledger where id=$1", [id])).rows[0].status,
  ).toBe("accepted");
  expect((await pool.query("select status from messages where id=$1", [id])).rows[0].status).toBe(
    "queued",
  );
  // O espelho atrasado não autoriza repetir um aceite, nem rebaixa a prova que já existe.
  expect(await redriveQueued(pool, watchdog, log)).toBe(0);
  expect(fetchDenied).not.toHaveBeenCalled();
});
