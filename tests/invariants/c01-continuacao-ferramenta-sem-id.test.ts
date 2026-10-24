import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as Turno from "@/lib/agent-engine/agent/inbound-turn";
import type * as Fila from "@/lib/agent-engine/queue/queue";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Logger from "@/lib/agent-engine/obs/logger";
import type { ChannelSendInput } from "@/lib/agent-engine/channel-adapter";
import { conferirCandidaturaContinuacaoC01 } from "@/lib/followup/c01-continuacao-turno";
import type { ConfigOrigemC01 } from "@/lib/followup/c01-origem";

if (!process.env.TEST_DB_CONTAINER) throw new Error("Use test:db com banco descartável.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 2,
});
let m: {
  turno: typeof Turno;
  fila: typeof Fila;
  fake: typeof Providers.createFakeRegistry;
  logger: typeof Logger.createLogger;
};
const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const texto = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const chamada = (toolName: string, args: unknown) => ({
  content: [
    { type: "tool-call" as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(args) },
  ],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: USO,
  warnings: [],
});
const FECHAMENTO = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "Pessoa pediu orientação; formação pendente.",
  declaracao: { intencoes: [], promessas: [], nada_a_declarar: true },
});
const PEDIDO = "Quero entender por onde começar";
const PROPOSTA = {
  estado: "pendente",
  caminho: "L1",
  trecho_do_pedido: PEDIDO,
  natureza: "informacao_solicitada",
  texto: "Para seguir com a orientação, falta saber sua formação.",
};

beforeAll(async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("Rede externa proibida no teste.");
  });
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    fila: await import("@/lib/agent-engine/queue/queue"),
    fake: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
    logger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
  };
  await pool.query(
    `with v as (insert into playbook_versions (organization_id,layer,content) select null,'platform','Atendente fictício.' where not exists(select 1 from playbook_pointers where organization_id is null and layer='platform') returning id) insert into playbook_pointers(organization_id,layer,version_id) select null,'platform',id from v`,
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await pool.end();
});

async function executar(proposta: Record<string, unknown>, adulterarTurno = false) {
  const org = randomUUID(),
    contact = randomUUID(),
    session = randomUUID(),
    conv = randomUUID(),
    inbound = randomUUID(),
    agent = randomUUID(),
    version = randomUUID(),
    pipeline = randomUUID(),
    stage = randomUUID(),
    lead = randomUUID();
  const now = Date.now();
  const cfg: ConfigOrigemC01 = {
    enabled: true,
    organizationId: org,
    tokenSha256: "a".repeat(64),
    signingKey: "b".repeat(40),
    allowedKinds: ["oferta"],
    continuation: {
      enabled: true,
      policyStatus: "approved",
      activatedAt: new Date(now - 86400_000).toISOString(),
    },
  };
  vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Teste','Teste')",
    [org, `turno-${org}`],
  );
  await pool.query(
    "insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Pessoa fictícia','+5511999990001')",
    [contact, org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted) values($1,$2,$3,'WORKING','\\x00')",
    [session, org, `fake-${session}`],
  );
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug,settings) values($1,$2,'Funil','ficticio','{}')",
    [pipeline, org],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Aberto','aberto',1000)",
    [stage, org, pipeline],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,custom_fields) values($1,$2,$3,$4,$5,'Teste','{}')",
    [lead, org, pipeline, stage, contact],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group,last_inbound_at) values($1,$2,$3,$4,'open',false,$5)",
    [conv, org, contact, session, new Date(now - 60000)],
  );
  await pool.query(
    "insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at) values($1,$2,$3,$4,$5,'text','inbound','delivered',$6,'external_device',$7)",
    [inbound, org, conv, session, contact, PEDIDO, new Date(now - 60000)],
  );
  await pool.query(
    "insert into ai_agents(id,organization_id,name,system_prompt,kind) values($1,$2,'Agente fictício','Atendente fictício.','mcp_agent')",
    [agent, org],
  );
  await pool.query(
    "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,published_at,max_steps) values($1,$2,$3,1,'Atendente fictício.','anthropic','claude-sonnet-4-6',$4,'published',now(),8)",
    [version, org, agent, session],
  );
  await pool.query("update ai_agents set published_version_id=$1 where id=$2", [version, agent]);
  const { job } = await m.fila.enqueueJob(pool, org, {
    kind: "inbound_turn",
    leadId: contact,
    payload: {
      conversation_id: conv,
      contact_id: contact,
      channel_session_id: session,
      inbound_message_id: inbound,
      crm_event_id: randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.fila.claimJobs(pool, {
    workerId: "continuidade-ficticia",
    maxConcurrency: 1,
  });
  if (!claimed || claimed.id !== job.id) throw new Error("Claim não corresponde ao cenário.");
  let step = 0;
  const prompts: string[] = [];
  const schemas: string[] = [];
  const enviados: string[] = [];
  const model = async (options: { prompt: unknown; tools?: unknown }) => {
    prompts.push(JSON.stringify(options.prompt));
    schemas.push(JSON.stringify(options.tools ?? null));
    if (prompts.at(-1)!.includes(m.turno.CHECKPOINT_INSTRUCTION)) return texto(FECHAMENTO);
    const n = step++;
    if (n === 0) return chamada("send_message", { body: "Qual é sua formação?" });
    if (n === 1) {
      if (adulterarTurno)
        await pool.query(
          "update job_queue set payload=jsonb_set(payload,'{inbound_message_id}',$2::jsonb) where id=$1",
          [job.id, JSON.stringify(randomUUID())],
        );
      return chamada("prepare_contextual_followup", proposta);
    }
    return texto(FECHAMENTO);
  };
  const handler = m.turno.createInboundTurnHandler({
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
    log: m.logger(),
    registry: m.fake(model as never),
    clock: () => new Date(),
    sleep: async () => {},
    channel: () =>
      ({
        channel: "ficticio",
        send: async (i: ChannelSendInput) => {
          const id = randomUUID(),
            key = randomUUID();
          enviados.push(i.body);
          // O canal fictício deixa os mesmos fatos aceitos que o adaptador real consulta.
          await pool.query(
            "insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,external_id,sent_at) values($1,$2,$3,$4,$5,'text','outbound','sent',$6,$7,now())",
            [id, org, conv, session, contact, i.body, `ficticio-${id}`],
          );
          await pool.query(
            "insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,$4,$5,$6,'accepted',$7)",
            [
              key,
              org,
              contact,
              i.jobId,
              i.seq,
              createHash("sha256").update(i.body).digest("hex"),
              id,
            ],
          );
          return { kind: "sent", idempotencyKey: key, messageId: id };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
  });
  await handler(claimed, pool, { workerId: "continuidade-ficticia" });
  await m.fila.completeJob(pool, job.id, "continuidade-ficticia");
  const row = (await pool.query("select status,payload from job_queue where id=$1", [job.id]))
    .rows[0];
  const receipts = (
    await pool.query(
      "select status,crm_message_id from send_ledger where organization_id=$1 and job_id=$2",
      [org, job.id],
    )
  ).rows;
  return { row, cfg, inbound, jobId: job.id, prompts, schemas, enviados, receipts };
}

describe("Continuidade C01: identidade pertence ao servidor do turno", () => {
  it("modelo sem UUID atravessa o turno real e grava candidatura assinada após recibo", async () => {
    const r = await executar(PROPOSTA);
    expect(r.enviados).toHaveLength(1);
    expect(r.receipts).toEqual([{ status: "accepted", crm_message_id: expect.any(String) }]);
    expect(r.row.status).toBe("done");
    const proof = conferirCandidaturaContinuacaoC01(r.cfg, r.row.payload.c01_continuation);
    expect(proof).toMatchObject({
      jobId: r.jobId,
      inboundMessageId: r.inbound,
      proposal: { ...PROPOSTA, mensagem_entrada_id: r.inbound },
    });
    expect(r.prompts.some((p) => p.includes(r.inbound))).toBe(false);
    expect(r.schemas.some((s) => s.includes("mensagem_entrada_id"))).toBe(false);
  });
  it("UUID injetado pelo modelo é recusado sem candidatura", async () => {
    const r = await executar({ ...PROPOSTA, mensagem_entrada_id: randomUUID() });
    expect(r.row.payload.c01_continuation).toBeUndefined();
    expect(r.receipts).toHaveLength(1);
  });
  it("entrada inválida não é completada pelo servidor", async () => {
    const r = await executar({ ...PROPOSTA, trecho_do_pedido: "" });
    expect(r.row.payload.c01_continuation).toBeUndefined();
    expect(r.receipts).toHaveLength(1);
  });
  it("mudança do vínculo do job antes da gravação é recusada", async () => {
    const r = await executar(PROPOSTA, true);
    expect(r.row.payload.c01_continuation).toBeUndefined();
    expect(r.receipts).toHaveLength(1);
  });
});
