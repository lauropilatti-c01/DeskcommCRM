import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
const fakes = vi.hoisted(() => ({ financeiro: vi.fn(), semOferta: vi.fn(), ia: vi.fn() }));
vi.mock("@/lib/leads/fonte-financeira-sem-oferta", () => ({
  lerSituacaoFinanceiraSemOferta: fakes.semOferta,
}));
vi.mock("@/lib/leads/fonte-financeira", () => ({ lerSituacaoFinanceira: fakes.financeiro }));
vi.mock("@/lib/agent-engine/agent/inbound-turn", async (original) => ({
  ...(await original<typeof InboundTurn>()),
  runAgentTurn: fakes.ia,
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => pool }));
import {
  createFollowupTurnHandler,
  type FollowupTurnDeps,
} from "@/lib/agent-engine/agent/followup-turn";
import { createPgAdminClient, completeTurnForEnrollment } from "@/lib/followup/turn-bridge";
import { avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { enqueueJob, claimJobs, completeJob } from "@/lib/agent-engine/queue/queue";
import { withServiceJob } from "@/lib/atendimento/fronteira-server";
import {
  comEnvioAcompanhamentoC01,
  assertAcompanhamentoC01Supabase,
  decidirAcompanhamentoC01,
} from "@/lib/followup/c01-acompanhamento-runtime";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import type { ChannelSendInput } from "@/lib/agent-engine/channel-adapter";
import { gravarCandidaturaContinuacaoC01 } from "@/lib/followup/c01-continuacao-turno";
import {
  registrarContinuacaoC01,
  type DependenciasContinuacaoC01,
} from "@/lib/followup/c01-continuacao-runtime";
import {
  assinarOrigemC01,
  hashDoConteudoDaOrigem,
  type ConfigOrigemC01,
} from "@/lib/followup/c01-origem";
import { lerFatosAcompanhamentoC01 } from "@/lib/followup/c01-acompanhamento-fatos";
import { avaliarAcompanhamento } from "@/lib/followup/c01-acompanhamento";
import { resolverPassoC01 } from "@/lib/followup/c01-acompanhamento-conteudo";
import {
  EsperaFinanceiraC01Error,
  BloqueioFinanceiroC01Error,
} from "@/lib/followup/c01-financeiro-espera";
import { disporJobFinanceiroC01 } from "@/lib/followup/c01-financeiro-fila";
import { redriveQueued } from "@/lib/agent-engine/edge/crm/session-reconciler";
import { vi } from "vitest";
if (!process.env.TEST_DB_CONTAINER) throw new Error("Use o banco descartável de test:db.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 6,
});
beforeEach(() => {
  vi.clearAllMocks();
  fakes.semOferta.mockImplementation(async ({ now }) => ({
    status: "nao_comprou_confirmado",
    checkedAt: now.toISOString(),
    complete: true,
  }));
  vi.stubGlobal("fetch", async () => {
    throw new Error("Rede externa proibida");
  });
  fakes.ia.mockRejectedValue(new Error("IA proibida"));
  fakes.financeiro.mockImplementation(async ({ now }) => ({
    status: "nao_comprou_confirmado",
    checkedAt: now.toISOString(),
    complete: true,
  }));
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  return pool.end();
});
const NOW = new Date("2026-10-24T15:00:10Z");
const temporaria = (now: Date, startedAt = new Date(+now - 120_000).toISOString()) => ({
  status: "indisponivel" as const,
  complete: false,
  checkedAt: startedAt,
  reason: "projecao_em_coleta",
  collection: {
    generationId: "33333333-3333-4333-8333-333333333333",
    startedAt,
    heartbeatAt: now.toISOString(),
    deadlineAt: new Date(Date.parse(startedAt) + 900_000).toISOString(),
    progress: 2,
  },
});
const deps: DependenciasContinuacaoC01 = {
  financeiro: async ({ now }) => ({
    status: "nao_comprou_confirmado",
    checkedAt: now.toISOString(),
    complete: true,
  }),
  semOferta: async ({ now }) => ({
    status: "nao_comprou_confirmado",
    checkedAt: now.toISOString(),
    complete: true,
  }),
};
async function fixture() {
  const org = randomUUID(),
    contact = randomUUID(),
    conversation = randomUUID(),
    lead = randomUUID(),
    pipeline = randomUUID(),
    stage = randomUUID(),
    session = randomUUID(),
    job = randomUUID(),
    inbound = randomUUID(),
    final = randomUUID(),
    pointer = randomUUID(),
    version = randomUUID(),
    agent = randomUUID(),
    agentVersion = randomUUID();
  const cfg: ConfigOrigemC01 = {
    enabled: true,
    organizationId: org,
    tokenSha256: "a".repeat(64),
    signingKey: "b".repeat(40),
    allowedKinds: ["oferta", "cronograma"],
    continuation: { enabled: true, policyStatus: "approved", activatedAt: "2026-10-24T11:00:00Z" },
  };
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Teste fictício','Teste fictício')",
    [org, `cont-${org}`],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name,phone_number) values($1,$2,'Pessoa fictícia','+5511999990001')",
    [contact, org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,status) values($1,$2,$3,'\\x00','STOPPED')",
    [session, org, `fake-${session}`],
  );
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug,settings) values($1,$2,'Funil fictício','ficticio','{}')",
    [pipeline, org],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Aberto','aberto',1000)",
    [stage, org, pipeline],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,custom_fields,created_at) values($1,$2,$3,$4,$5,'Sem oferta','{}','2026-10-24T12:00:00Z')",
    [lead, org, pipeline, stage, contact],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status,assignee_kind,last_inbound_at) values($1,$2,$3,$4,'ai_handling','ai','2026-10-24T14:59:00Z')",
    [conversation, org, contact, session],
  );
  await pool.query(
    "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,sent_at) values($1,$2,$3,$4,$5,'inbound','text','Quero entender por onde começar','received','2026-10-24T14:59:00Z')",
    [inbound, org, contact, conversation, session],
  );
  await pool.query(
    "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,external_id,sent_at,delivered_at) values($1,$2,$3,$4,$5,'outbound','text','Qual área quer conhecer primeiro?','sent',$6,'2026-10-24T15:00:00Z','2026-10-24T15:00:05Z')",
    [final, org, contact, conversation, session, `wamid.${final}`],
  );
  const jobRow = (
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,status,payload,locked_by,locked_at,attempts,created_at) values($1,$2,$3,'inbound_turn','running',$4,'fixture','2026-10-24T14:59:00Z',1,'2026-10-24T14:59:00Z') returning locked_at::text as claim",
      [job, org, contact, { conversation_id: conversation, inbound_message_id: inbound }],
    )
  ).rows[0];
  await pool.query(
    "insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,0,'fixture','accepted',$4)",
    [org, contact, job, final],
  );
  const nodes = [
    { id: "start", type: "trigger", config: {} },
    {
      id: "touch",
      type: "action",
      config: { mode: "text", body: "Candidata: o texto virá da prova do turno." },
    },
    { id: "end", type: "end", config: { outcome: "custom" } },
  ].map((n, i) => ({ ...n, label: n.id, position: { x: 0, y: i * 100 } }));
  const graph = {
    nodes,
    edges: nodes.slice(0, -1).map((n, i) => ({
      id: `e${i}`,
      source: n.id,
      target: nodes[i + 1]!.id,
      condition: { type: "always" },
    })),
    settings: {
      c01_acompanhamento: {
        version: 1,
        kind: "conversa",
        activated_at: cfg.continuation!.activatedAt,
      },
    },
  };
  await pool.query(
    "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
    [version, org, graph],
  );
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id,trigger_config) values($1,$2,'Continuação fictícia','active',$3,$4)",
    [pointer, org, version, { cancel_on_reply: true }],
  );
  await pool.query(
    "insert into ai_agents(id,organization_id,name,system_prompt,operation_mode) values($1,$2,'Agente fictício','Sem acesso externo.','automatic')",
    [agent, org],
  );
  await pool.query(
    "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,followup) values($1,$2,$3,1,'Sem acesso externo.','anthropic','modelo-ficticio',$4,'published',$5)",
    [agentVersion, org, agent, session, { enabled: true, flow_pointer_ids: [pointer] }],
  );
  await pool.query("update ai_agents set published_version_id=$1 where id=$2", [
    agentVersion,
    agent,
  ]);
  const scope = {
    organizationId: org,
    contactId: contact,
    conversationId: conversation,
    jobId: job,
    workerId: "fixture",
    acquiredAt: jobRow.claim,
  };
  const proposal = {
    estado: "pendente",
    caminho: "L1",
    mensagem_entrada_id: inbound,
    trecho_do_pedido: "entender por onde começar",
    natureza: "informacao_solicitada",
    texto: "Podemos continuar pela área que deseja conhecer.",
  };
  expect(await gravarCandidaturaContinuacaoC01(pool, cfg, scope, proposal, NOW)).toEqual({
    status: "recorded",
  });
  await pool.query("update job_queue set status='done',locked_by=null,locked_at=null where id=$1", [
    job,
  ]);
  return {
    org,
    contact,
    conversation,
    lead,
    pipeline,
    stage,
    session,
    job,
    inbound,
    final,
    pointer,
    version,
    cfg,
    scope,
    proposal,
    graph,
    agentVersion,
  };
}
async function oferta() {
  const f = await fixture(),
    pointer = randomUUID(),
    version = randomUUID(),
    root = randomUUID(),
    originId = randomUUID(),
    receiptId = randomUUID(),
    touchJob = randomUUID();
  await pool.query("update crm_leads set custom_fields=$2 where id=$1", [
    f.lead,
    { produto_chave: "ficticio" },
  ]);
  const nodes = [
    { id: "start", type: "trigger", config: {} },
    ...[1, 2, 3, 4].flatMap((i) => [
      ...(i > 1
        ? [{ id: `wait${i}`, type: "wait", config: { mode: "fixed", duration_ms: 48 * 3600000 } }]
        : []),
      { id: `t${i}`, type: "action", config: { mode: "text", body: `Toque original ${i}` } },
    ]),
    { id: "end", type: "end", config: { outcome: "custom" } },
  ].map((n, i) => ({ ...n, label: n.id, position: { x: 0, y: i * 100 } }));
  const graph = {
    nodes,
    edges: nodes.slice(0, -1).map((n, i) => ({
      id: `e${i}`,
      source: n.id,
      target: nodes[i + 1]!.id,
      condition: { type: "always" },
    })),
    settings: {
      c01_acompanhamento: {
        version: 1,
        kind: "oferta",
        activated_at: f.cfg.continuation!.activatedAt,
      },
    },
  };
  await pool.query(
    "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
    [version, f.org, graph],
  );
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id,trigger_config) values($1,$2,'Oferta fictícia','active',$3,$4)",
    [pointer, f.org, version, { cancel_on_reply: true }],
  );
  const nextAgentVersion = randomUUID();
  await pool.query(
    "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,channel_session_id,status,followup) select $1,organization_id,agent_id,2,system_prompt,provider,model,channel_session_id,'published',$3 from ai_agent_versions where id=$2",
    [nextAgentVersion, f.agentVersion, { enabled: true, flow_pointer_ids: [f.pointer, pointer] }],
  );
  await pool.query("update ai_agents set published_version_id=$1 where published_version_id=$2", [
    nextAgentVersion,
    f.agentVersion,
  ]);
  await pool.query(
    "insert into followup_enrollments(id,organization_id,pointer_id,version_id,contact_id,conversation_id,current_node_id,status,cancel_reason,next_eval_at) values($1,$2,$3,$4,$5,$6,'t1','cancelled','cancel_on_reply',null)",
    [root, f.org, pointer, version, f.contact, f.conversation],
  );
  const origin = (
    await pool.query(
      "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,external_id,sent_at,delivered_at) values($1,$2,$3,$4,$5,'outbound','text','Oferta original','sent',$6,'2026-10-24T12:00:00Z','2026-10-24T12:00:05Z') returning *",
      [originId, f.org, f.contact, f.conversation, f.session, `wamid.${originId}`],
    )
  ).rows[0];
  const proof = assinarOrigemC01(f.cfg, {
    kind: "oferta",
    organizationId: f.org,
    contactId: f.contact,
    conversationId: f.conversation,
    leadId: f.lead,
    productKey: "ficticio",
    messageId: originId,
    createdAt: origin.sent_at.toISOString(),
    contentHash: hashDoConteudoDaOrigem(origin),
  });
  await pool.query(
    "insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key) values($1,$2,'start','c01_origem_entregue',$3,'origin'),($1,$2,'t1','action_sent','{}','touch1')",
    [f.org, root, proof],
  );
  await pool.query(
    "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,external_id,sent_at,delivered_at) values($1,$2,$3,$4,$5,'outbound','text','Toque original 1','sent',$6,'2026-10-24T14:00:05Z','2026-10-24T14:00:06Z')",
    [receiptId, f.org, f.contact, f.conversation, f.session, `wamid.${receiptId}`],
  );
  await pool.query(
    "insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'followup_turn','done',$4)",
    [touchJob, f.org, f.contact, { followup_enrollment_id: root, node_id: "t1" }],
  );
  await pool.query(
    "insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,0,'fixture','accepted',$4)",
    [f.org, f.contact, touchJob, receiptId],
  );
  await pool.query(
    "update job_queue set status='running',locked_by='fixture',locked_at=$2 where id=$1",
    [f.job, f.scope.acquiredAt],
  );
  expect(
    await gravarCandidaturaContinuacaoC01(
      pool,
      f.cfg,
      f.scope,
      { ...f.proposal, caminho: "L2", texto: undefined },
      NOW,
    ),
  ).toEqual({ status: "recorded" });
  await pool.query("update job_queue set status='done',locked_by=null,locked_at=null where id=$1", [
    f.job,
  ]);
  return { ...f, offerPointer: pointer, offerVersion: version, root, originId, receiptId, graph };
}
describe("continuação com PostgreSQL oficial e fontes fictícias", () => {
  it("L1 sem produto nasce depois de entrega e turno concluído, com dedup persistente", async () => {
    const f = await fixture();
    const first = await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps);
    expect(first.status).toBe("enrolled");
    expect(await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps)).toMatchObject({
      status: "replay",
      enrollmentId: first.enrollmentId,
    });
    const row = (
      await pool.query(
        "select current_node_id,next_eval_at,status from followup_enrollments where id=$1",
        [first.enrollmentId],
      )
    ).rows[0];
    expect(row).toMatchObject({ current_node_id: "touch", status: "active" });
    expect(row.next_eval_at.toISOString()).toBe("2026-10-24T17:00:05.000Z");
  });
  it.each(["running", "failed"])("job %s não cria acompanhamento", async (status) => {
    const f = await fixture();
    await pool.query("update job_queue set status=$2 where id=$1", [f.job, status]);
    expect((await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps)).status).toBe("blocked");
  });
  it("sem recibo ou com erro Meta não vira silêncio", async () => {
    const f = await fixture();
    await pool.query("update messages set delivered_at=null where id=$1", [f.final]);
    expect((await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps)).status).toBe("blocked");
    await pool.query(
      "update messages set delivered_at='2026-10-24T15:00:05Z',error_code='131049' where id=$1",
      [f.final],
    );
    expect((await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps)).status).toBe("blocked");
  });
  it("OFF, recusa, humano e compra bloqueiam; ausência de porta sem_oferta também", async () => {
    const f = await fixture();
    expect(
      (await registrarContinuacaoC01(pool, { ...f.cfg, enabled: false }, f.job, NOW, deps)).status,
    ).toBe("off");
    expect(
      (await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, { financeiro: deps.financeiro }))
        .status,
    ).toBe("blocked");
    expect(
      (
        await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, {
          ...deps,
          semOferta: async () => ({
            status: "confirmado",
            complete: true,
            checkedAt: NOW.toISOString(),
          }),
        })
      ).status,
    ).toBe("blocked");
    await pool.query("update contacts set ai_opt_out=true where id=$1", [f.contact]);
    expect((await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps)).status).toBe("blocked");
  });
  it("duas tentativas concorrentes não criam duas inscrições", async () => {
    const f = await fixture();
    const results = await Promise.all(
      [1, 2].map(() => registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps)),
    );
    expect(results.filter((r) => r.status === "enrolled")).toHaveLength(1);
    expect(
      (await pool.query("select id from followup_enrollments where organization_id=$1", [f.org]))
        .rows,
    ).toHaveLength(1);
  });
  it("humano observado antes de inscrever veta de forma durável", async () => {
    const f = await fixture();
    await pool.query("update contacts set force_human=true where id=$1", [f.contact]);
    expect((await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps)).status).toBe("blocked");
    await pool.query("update contacts set force_human=false where id=$1", [f.contact]);
    expect((await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps)).status).toBe("blocked");
  });
  it("texto L1 vem da prova assinada e o próximo corte relê compra/humano", async () => {
    const f = await fixture();
    const e = await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps);
    vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(f.cfg));
    const scope = { organizationId: f.org, contactId: f.contact, enrollmentId: e.enrollmentId! },
      at = new Date("2026-10-24T17:00:05Z");
    expect(
      await resolverPassoC01(pool, { ...scope, nodeId: "touch", connectionId: f.session }, at),
    ).toEqual({ tipo: "texto", body: f.proposal.texto });
    const facts = await lerFatosAcompanhamentoC01(
      pool,
      f.cfg,
      scope,
      at,
      deps.financeiro,
      AbortSignal.timeout(5000),
      deps.semOferta,
    );
    expect(
      avaliarAcompanhamento(
        { version: 1, kind: "conversa", activated_at: f.cfg.continuation!.activatedAt },
        facts!,
        at,
      ),
    ).toEqual({ kind: "send", touch: 1, transport: "text" });
    const paid = await lerFatosAcompanhamentoC01(
      pool,
      f.cfg,
      scope,
      at,
      deps.financeiro,
      AbortSignal.timeout(5000),
      async ({ now }) => ({ status: "confirmado", complete: true, checkedAt: now.toISOString() }),
    );
    expect(
      avaliarAcompanhamento(
        { version: 1, kind: "conversa", activated_at: f.cfg.continuation!.activatedAt },
        paid!,
        at,
      ).kind,
    ).toBe("cancel");
    await pool.query("update contacts set force_human=true where id=$1", [f.contact]);
    const human = await lerFatosAcompanhamentoC01(
      pool,
      f.cfg,
      scope,
      at,
      deps.financeiro,
      AbortSignal.timeout(5000),
      deps.semOferta,
    );
    expect(
      avaliarAcompanhamento(
        { version: 1, kind: "conversa", activated_at: f.cfg.continuation!.activatedAt },
        human!,
        at,
      ).kind,
    ).toBe("cancel");
  });
  it("L2 conserva a oferta raiz, o primeiro recibo e D1, sem recomeçar 2h", async () => {
    const f = await oferta();
    const e = await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps);
    expect(e.status).toBe("enrolled");
    const row = (
      await pool.query("select * from followup_enrollments where id=$1", [e.enrollmentId])
    ).rows[0];
    expect(row.current_node_id).toBe("t2");
    expect(row.next_eval_at.toISOString()).toBe("2026-10-25T12:00:05.000Z");
    const at = new Date(row.next_eval_at),
      facts = await lerFatosAcompanhamentoC01(
        pool,
        f.cfg,
        { organizationId: f.org, contactId: f.contact, enrollmentId: e.enrollmentId! },
        at,
        deps.financeiro,
      );
    expect(facts?.anchor.at).toBe("2026-10-24T12:00:05.000Z");
    expect(facts?.touches[0]?.messageIds).toEqual([f.receiptId]);
    expect(
      avaliarAcompanhamento(
        f.graph.settings.c01_acompanhamento as Parameters<typeof avaliarAcompanhamento>[0],
        facts!,
        at,
      ),
    ).toEqual({ kind: "send", touch: 2, transport: "text" });
  });
  it("L2 recusa recibo incompleto, produto diferente e cancelamento sem resposta", async () => {
    const f = await oferta();
    await pool.query("update messages set delivered_at=null where id=$1", [f.receiptId]);
    expect((await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps)).status).toBe("blocked");
    await pool.query("update messages set delivered_at='2026-10-24T14:00:06Z' where id=$1", [
      f.receiptId,
    ]);
    await pool.query("update followup_enrollments set cancel_reason='recusa' where id=$1", [
      f.root,
    ]);
    expect((await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps)).status).toBe("blocked");
    await pool.query(
      "update followup_enrollments set cancel_reason='cancel_on_reply' where id=$1",
      [f.root],
    );
    await pool.query("update crm_leads set custom_fields=$2 where id=$1", [
      f.lead,
      { produto_chave: "outro" },
    ]);
    expect((await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps)).status).toBe("blocked");
  });
});

describe("prazo financeiro antes da matrícula", () => {
  it("L1 conserva primeiro prazo e intervalo de 60 s; geração nova não renova", async () => {
    const f = await fixture();
    let at = NOW;
    const financial = vi.fn(async () => temporaria(at));
    const pending = { ...deps, semOferta: financial };
    expect((await registrarContinuacaoC01(pool, f.cfg, f.job, at, pending)).reason).toBe(
      "projecao_em_coleta",
    );
    const first = (
      await pool.query("select payload->'c01_financial_wait' as wait from job_queue where id=$1", [
        f.job,
      ])
    ).rows[0].wait;
    expect(first).toMatchObject({
      deadlineAt: temporaria(at).collection.deadlineAt,
      nextCheckAt: new Date(+at + 60_000).toISOString(),
    });
    at = new Date(+NOW + 30_000);
    await registrarContinuacaoC01(pool, f.cfg, f.job, at, pending);
    expect(financial).toHaveBeenCalledTimes(1);
    at = new Date(+NOW + 61_000);
    await registrarContinuacaoC01(pool, f.cfg, f.job, at, pending);
    const later = (
      await pool.query("select payload->'c01_financial_wait' as wait from job_queue where id=$1", [
        f.job,
      ])
    ).rows[0].wait;
    expect(later.deadlineAt).toBe(first.deadlineAt);
    at = new Date(Date.parse(first.deadlineAt) + 1);
    expect((await registrarContinuacaoC01(pool, f.cfg, f.job, at, deps)).reason).toBe(
      "prazo_da_coleta_financeira_esgotado",
    );
    expect(
      (await pool.query("select id from followup_enrollments where organization_id=$1", [f.org]))
        .rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query(
          "select payload?'c01_continuation_omitted' as omitted from job_queue where id=$1",
          [f.job],
        )
      ).rows[0].omitted,
    ).toBe(true);
  });
  it("L1 atualizando→pronta inscreve uma vez; falha real não se autorretoma", async () => {
    const f = await fixture();
    const pending = { ...deps, semOferta: async () => temporaria(NOW) };
    await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, pending);
    const ready = await registrarContinuacaoC01(pool, f.cfg, f.job, new Date(+NOW + 61_000), deps);
    expect(ready.status).toBe("enrolled");
    expect(
      (await registrarContinuacaoC01(pool, f.cfg, f.job, new Date(+NOW + 62_000), deps)).status,
    ).toBe("replay");
    const failed = await fixture();
    await registrarContinuacaoC01(pool, failed.cfg, failed.job, NOW, pending);
    await registrarContinuacaoC01(pool, failed.cfg, failed.job, new Date(+NOW + 61_000), {
      ...deps,
      semOferta: async () => ({
        status: "indisponivel",
        complete: false,
        checkedAt: NOW.toISOString(),
        reason: "projecao_falhou",
      }),
    });
    expect(
      (await registrarContinuacaoC01(pool, failed.cfg, failed.job, new Date(+NOW + 122_000), deps))
        .status,
    ).toBe("blocked");
  });
});

describe("worker real da continuação com transporte fictício", () => {
  async function preparar(path: "L1" | "L2" = "L2") {
    const raw = path === "L2" ? await oferta() : await fixture();
    const f =
      "offerVersion" in raw
        ? raw
        : {
            ...raw,
            offerVersion: raw.version,
            graph: (
              await pool.query("select graph from followup_flow_versions where id=$1", [
                raw.version,
              ])
            ).rows[0].graph,
          };
    const nodeId = path === "L2" ? "t2" : "touch";
    await pool.query("update contacts set source='whatsapp' where id=$1", [f.contact]);
    const enrolled = await registrarContinuacaoC01(pool, f.cfg, f.job, NOW, deps);
    expect(enrolled.status).toBe("enrolled");
    const enrollmentId = enrolled.enrollmentId!;
    vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(f.cfg));
    const at = new Date(path === "L2" ? "2026-10-25T12:00:05Z" : "2026-10-24T17:00:05Z"),
      db = createPgAdminClient(pool);
    db.decidirAcompanhamentoC01 = async (policy, e, now) =>
      decidirAcompanhamentoC01(
        policy,
        { organizationId: e.organization_id, contactId: e.contact_id, enrollmentId: e.id },
        now,
      );
    const row = await db.loadEnrollmentById(f.org, enrollmentId);
    expect(row).not.toBeNull();
    await avancarEnrollmentAtivo(
      {
        db,
        clock: () => at,
        enqueueJob: async (req) => {
          await enqueueJob(pool, req.organization_id, {
            kind: "followup_turn",
            leadId: req.contact_id,
            payload: req.payload,
          });
        },
      },
      row!,
    );
    const jobs = await claimJobs(pool, {
      workerId: "continuidade-ficticia",
      maxConcurrency: 20,
      batchSize: 20,
    });
    const job = jobs.find((j) => j.organization_id === f.org);
    expect(job?.payload).toMatchObject({
      c01_resolve: true,
      followup_enrollment_id: enrollmentId,
      node_id: nodeId,
    });
    expect(job!.payload).not.toHaveProperty("fixed_body");
    const sent: ChannelSendInput[] = [],
      log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const transport = {
      send: async (input: ChannelSendInput) => {
        const e = await db.loadEnrollmentById(f.org, enrollmentId);
        const link = (
          await pool.query(
            "select id from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='c01_continuacao_entregue'",
            [f.org, enrollmentId],
          )
        ).rows[0];
        const supa = criarDubleDoHandler({
          conversation: { id: f.conversation, organization_id: f.org, contact_id: f.contact },
          tabelasDeLeitura: {
            followup_enrollment_events: link ?? null,
            followup_enrollments: { version_id: f.offerVersion, contact_id: f.contact },
            followup_flow_versions: { graph: f.graph },
          },
        }).supabase;
        const context = {
          organizationId: f.org,
          contactId: f.contact,
          conversationId: f.conversation,
          enrollmentId,
          jobId: job!.id,
        };
        return comEnvioAcompanhamentoC01(supa, context, f.org, async () => {
          await assertAcompanhamentoC01Supabase(supa, context, f.org, at);
          expect(e?.current_node_id).toBe(nodeId);
          sent.push(input);
          const id = randomUUID();
          await pool.query(
            "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,external_id,sent_at,delivered_at) values($1,$2,$3,$4,$5,'outbound','text',$6,'sent',$7,$8,$8)",
            [id, f.org, f.contact, f.conversation, f.session, input.body, `fake.${id}`, at],
          );
          await pool.query(
            "insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,$4,'ficticio','accepted',$5)",
            [f.org, f.contact, job!.id, input.seq, id],
          );
          return { kind: "sent" as const, idempotencyKey: `fake-${job!.id}`, messageId: id };
        });
      },
    };
    const workerDeps = {
      clock: () => at,
      log,
      knobs: { historyLimit: 20, maxContextTokens: 3000 },
      crmCfg: {},
      llmCfg: {},
      sleep: async () => {},
      channel: () => transport,
      completeFollowupTurn: async (
        _pool: pg.Pool,
        input: Parameters<NonNullable<FollowupTurnDeps["completeFollowupTurn"]>>[1],
      ) =>
        completeTurnForEnrollment(
          db,
          input.organizationId,
          input.enrollmentId,
          input.nodeId,
          input.result,
          () => at,
          input.jobId,
          input.jobClaim,
        ),
    } as unknown as FollowupTurnDeps;
    const run = () =>
      withServiceJob(pool, job!, () =>
        createFollowupTurnHandler(workerDeps)(job!, pool, { workerId: "continuidade-ficticia" }),
      );
    return { ...f, enrollmentId, at, job: job!, sent, run, db };
  }
  it("motor → fila → worker → porta C01 → transporte fictício usa o toque restante uma só vez", async () => {
    const f = await preparar();
    await f.run();
    await completeJob(pool, f.job.id, "continuidade-ficticia", undefined, f.job.claim_acquired_at);
    expect(f.sent.map((s) => s.body)).toEqual(["Toque original 2"]);
    expect(fakes.ia).not.toHaveBeenCalled();
    expect((await f.db.loadEnrollmentById(f.org, f.enrollmentId))?.current_node_id).toBe("wait3");
    const after = await f.db.loadEnrollmentById(f.org, f.enrollmentId);
    const tickDeps = {
      db: f.db,
      clock: () => f.at,
      enqueueJob: async () => {
        throw new Error("Não deve enviar antes de D3");
      },
    };
    await avancarEnrollmentAtivo(tickDeps, after!);
    const next = await f.db.loadEnrollmentById(f.org, f.enrollmentId);
    expect(next?.current_node_id).toBe("t3");
    await avancarEnrollmentAtivo(tickDeps, next!);
    expect((await f.db.loadEnrollmentById(f.org, f.enrollmentId))?.next_eval_at).toBe(
      "2026-10-27T12:00:05.000Z",
    );
    expect(
      (await pool.query("select status from job_queue where id=$1", [f.job.id])).rows[0].status,
    ).toBe("done");
    // Retry obsoleto chega ao mesmo handler, que descarta o nó concluído antes do canal.
    await expect(f.run()).rejects.toThrow("service_boundary_stale");
    expect(f.sent).toHaveLength(1);
  });
  it("L1 sem produto consome o texto do turno assinado sem chamada de IA", async () => {
    const f = await preparar("L1");
    await f.run();
    expect(f.sent.map((s) => s.body)).toEqual([f.proposal.texto]);
    expect(fakes.ia).not.toHaveBeenCalled();
    expect(fakes.semOferta).toHaveBeenCalled();
    const e = await f.db.loadEnrollmentById(f.org, f.enrollmentId);
    expect(e?.current_node_id).toBe("end");
  });
  const watchdog = {
    wahaBaseUrl: "http://127.0.0.1:1", wahaApiKey: "ficticio", intervalMs: 1,
    redriveMinAgeMs: 0, redriveBatchSize: 200, redriveSpacingMs: 0,
  };
  const watchdogLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  async function mensagemPreparada(f: Awaited<ReturnType<typeof preparar>>, seq = 1, accepted = false) {
    const id = randomUUID();
    await pool.query(
      "insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status) values($1,$2,$3,$4,$5,'ficticio',$6)",
      [id,f.org,f.contact,f.job.id,seq,accepted ? 'accepted' : 'requested'],
    );
    await pool.query(
      "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,status,body,sent_via,metadata,created_at) values($1,$2,$3,$4,$5,'outbound','text','queued','Texto fictício','ai',$6,now()-interval '1 hour')",
      [id,f.org,f.contact,f.conversation,f.session,{idempotency_key:id}],
    );
    await pool.query("update channel_sessions set status='WORKING',waha_session_name='ficticio-'||id::text where id=$1",[f.session]);
    return id;
  }
  it("mensagem preparada: watchdog não resgata C01 antes da disposição financeira", async () => {
    const f = await preparar("L1"), id = await mensagemPreparada(f);
    const fetch = vi.fn(async () => new Response(JSON.stringify({id:'nao-deveria-sair'})));
    vi.stubGlobal('fetch',fetch);
    expect(await redriveQueued(pool,watchdog,watchdogLog)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect((await pool.query('select status from messages where id=$1',[id])).rows[0].status).toBe('queued');
  });
  it("mensagem preparada: bloqueio limpa pendente e preserva recibo accepted", async () => {
    const f = await preparar("L1"), id = await mensagemPreparada(f), accepted = await mensagemPreparada(f,2,true);
    await disporJobFinanceiroC01(pool,f.job,new BloqueioFinanceiroC01Error('compras_sem_conferencia_univoca'),f.at);
    const rows = (await pool.query('select id,status,error_code from messages where id=any($1::uuid[])',[[id,accepted]])).rows;
    expect(rows.find(r=>r.id===id)).toMatchObject({status:'failed',error_code:'c01_financeiro_bloqueado'});
    expect(rows.find(r=>r.id===accepted)?.status).toBe('queued');
    const ledger = (await pool.query('select id,status from send_ledger where id=any($1::uuid[])',[[id,accepted]])).rows;
    expect(ledger.find(r=>r.id===id)?.status).toBe('failed');
    expect(ledger.find(r=>r.id===accepted)?.status).toBe('accepted');
    const fetch = vi.fn();vi.stubGlobal('fetch',fetch);
    expect(await redriveQueued(pool,watchdog,watchdogLog)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("mensagem preparada: watchdog conserva o resgate legado sem grafo C01", async () => {
    const f = await preparar("L1"), id = await mensagemPreparada(f);
    await pool.query("update followup_flow_versions set graph=graph #- '{settings,c01_acompanhamento}' where id=$1",[f.offerVersion]);
    const fetch = vi.fn(async () => new Response(JSON.stringify({id:'recibo-ficticio'})));
    vi.stubGlobal('fetch',fetch);
    expect(await redriveQueued(pool,watchdog,watchdogLog)).toBe(1);
    expect(fetch).toHaveBeenCalledOnce();
    expect((await pool.query('select status from messages where id=$1',[id])).rows[0].status).toBe('sent');
  });
  it("sink segura coleta temporária sem canal e conserva o primeiro prazo", async () => {
    const f = await preparar("L1");
    fakes.semOferta.mockImplementation(async ({ now }) => temporaria(now));
    await expect(f.run()).rejects.toBeInstanceOf(EsperaFinanceiraC01Error);
    expect(f.sent).toHaveLength(0);
    const events = (
      await pool.query(
        "select payload from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='c01_financeiro_em_coleta'",
        [f.org, f.enrollmentId],
      )
    ).rows;
    expect(events).toHaveLength(1);
    expect(events[0].payload.deadlineAt).toBe(temporaria(f.at).collection.deadlineAt);
  });
  async function estacionar() {
    const f = await preparar("L1");
    fakes.semOferta.mockImplementation(async ({ now }) => temporaria(now));
    let error: unknown;
    try {
      await f.run();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(EsperaFinanceiraC01Error);
    if (!(error instanceof EsperaFinanceiraC01Error)) throw error;
    await disporJobFinanceiroC01(pool, f.job, error, f.at);
    const row = (
      await pool.query("select status,attempts,run_after from job_queue where id=$1", [f.job.id])
    ).rows[0];
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(f.job.attempts - 1);
    expect(row.run_after.toISOString()).toBe(new Date(+f.at + 60_000).toISOString());
    expect((await f.db.loadEnrollmentById(f.org, f.enrollmentId))?.next_eval_at).toBe(
      row.run_after.toISOString(),
    );
    expect(f.sent).toHaveLength(0);
    return f;
  }
  async function retomar(f: Awaited<ReturnType<typeof estacionar>>, delay = 61_000) {
    f.at.setTime(+f.at + delay);
    const jobs = await claimJobs(pool, {
      workerId: "continuidade-ficticia",
      maxConcurrency: 30,
      batchSize: 30,
    });
    const current = jobs.find((j) => j.id === f.job.id);
    expect(current).toBeDefined();
    Object.assign(f.job, current);
  }
  it("fila: coleta recuperada envia uma vez sem consumir tentativa ou IA", async () => {
    const f = await estacionar();
    await retomar(f);
    fakes.semOferta.mockImplementation(async ({ now }) => ({
      status: "nao_comprou_confirmado",
      checkedAt: now.toISOString(),
      complete: true,
    }));
    await f.run();
    await completeJob(pool, f.job.id, "continuidade-ficticia", undefined, f.job.claim_acquired_at);
    expect(f.sent).toHaveLength(1);
    expect(fakes.ia).not.toHaveBeenCalled();
    await expect(f.run()).rejects.toThrow();
    expect(f.sent).toHaveLength(1);
  });
  it.each(["falhou", "expirada", "ambigua"])(
    "fila: %s fica em revisão manual mesmo se a fonte recuperar depois",
    async (mode) => {
      const f = await estacionar();
      await retomar(f);
      fakes.semOferta.mockResolvedValue({
        status: mode === "ambigua" ? "revisao" : "indisponivel",
        checkedAt: f.at.toISOString(),
        complete: false,
        reason: `projecao_${mode}`,
      });
      let error: unknown;
      try {
        await f.run();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BloqueioFinanceiroC01Error);
      if (!(error instanceof BloqueioFinanceiroC01Error)) throw error;
      await disporJobFinanceiroC01(pool, f.job, error, f.at);
      const e = await f.db.loadEnrollmentById(f.org, f.enrollmentId);
      expect(e?.status).toBe("paused_manual");
      expect(e?.next_eval_at).toBeNull();
      expect(
        (await pool.query("select status from job_queue where id=$1", [f.job.id])).rows[0].status,
      ).toBe("failed");
      fakes.semOferta.mockImplementation(async ({ now }) => ({
        status: "nao_comprou_confirmado",
        complete: true,
        checkedAt: now.toISOString(),
      }));
      await expect(f.run()).rejects.toThrow();
      expect(f.sent).toHaveLength(0);
    },
  );
  it("fila: lease antigo não consegue estacionar uma aquisição nova", async () => {
    const f = await estacionar(),
      old = { ...f.job };
    await retomar(f);
    await expect(
      disporJobFinanceiroC01(
        pool,
        old,
        new EsperaFinanceiraC01Error(new Date(+f.at + 60_000).toISOString()),
        f.at,
      ),
    ).rejects.toThrow("service_boundary_stale");
    expect(
      (await pool.query("select status from job_queue where id=$1", [f.job.id])).rows[0].status,
    ).toBe("running");
  });
  it("fila: prazo original vencido impede nova geração e não envia retroativamente", async () => {
    const f = await estacionar();
    await retomar(f, 781_000);
    fakes.semOferta.mockImplementation(async ({ now }) => temporaria(now));
    let error: unknown;
    try {
      await f.run();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BloqueioFinanceiroC01Error);
    if (!(error instanceof BloqueioFinanceiroC01Error)) throw error;
    expect(error.message).toBe("prazo_da_coleta_financeira_esgotado");
    await disporJobFinanceiroC01(pool, f.job, error, f.at);
    expect((await f.db.loadEnrollmentById(f.org, f.enrollmentId))?.status).toBe("paused_manual");
    expect(f.sent).toHaveLength(0);
  });
  it.each(["humano", "resposta"])("%s antes do consumo impede retomada L1", async (mode) => {
    const f = await preparar("L1");
    if (mode === "humano")
      await pool.query("update contacts set force_human=true where id=$1", [f.contact]);
    else
      await pool.query(
        "insert into messages(organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,sent_at) values($1,$2,$3,$4,'inbound','text','Agora consigo continuar','received',$5)",
        [f.org, f.contact, f.conversation, f.session, f.at],
      );
    try {
      await f.run();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
    expect(f.sent).toHaveLength(0);
    expect(fakes.ia).not.toHaveBeenCalled();
    expect(
      (
        await pool.query(
          "select id from followup_enrollment_events where enrollment_id=$1 and event_type='action_sent'",
          [f.enrollmentId],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("compra surgida depois da matrícula impede canal e avanço", async () => {
    const f = await preparar();
    fakes.financeiro.mockImplementation(async ({ now }) => ({
      status: "confirmado",
      checkedAt: now.toISOString(),
      complete: true,
    }));
    await expect(f.run()).rejects.toThrow();
    expect(f.sent).toHaveLength(0);
    expect(fakes.ia).not.toHaveBeenCalled();
    expect((await f.db.loadEnrollmentById(f.org, f.enrollmentId))?.current_node_id).toBe("t2");
  });
});
