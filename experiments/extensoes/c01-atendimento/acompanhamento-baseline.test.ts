import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
const state = vi.hoisted(() => ({ pool: null as pg.Pool | null, paid: false, reads: 0 }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => state.pool }));
vi.mock("@/lib/leads/fonte-financeira", () => ({
  lerSituacaoFinanceira: async ({ now }: { now: Date }) => {
    state.reads++;
    return {
      status: state.paid ? "confirmado" : "nao_comprou_confirmado",
      complete: true,
      checkedAt: now.toISOString(),
      reason: "fixture",
    };
  },
}));
import { registrarOrigemEntregueC01 } from "@/lib/followup/c01-acompanhamento-origens";
import { lerFatosAcompanhamentoC01 } from "@/lib/followup/c01-acompanhamento-fatos";
import {
  comEnvioAcompanhamentoC01,
  assertAcompanhamentoC01Supabase,
  registrarTentativaEnvioC01,
} from "@/lib/followup/c01-acompanhamento-runtime";
import {
  prepararRetornoComercialC01,
  conferirRetornoNoEnvioC01,
  cederCadenciaAoRetornoC01,
} from "@/lib/followup/c01-retorno";
import { applyScheduleFollowup } from "@/lib/agent-engine/agent/schedule-followup";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
const databaseUrl = process.env.C01_P2_DATABASE_URL;
if (!databaseUrl) throw new Error("Banco local c01_p2_* obrigatório");
const destination = new URL(databaseUrl);
if (
  !["postgresql:", "postgres:"].includes(destination.protocol) ||
  destination.hostname !== "127.0.0.1" ||
  !/^\/c01_p2_[a-z0-9_]+$/.test(destination.pathname) ||
  destination.search ||
  destination.hash
)
  throw new Error("Banco local c01_p2_* obrigatório, sem parâmetros que substituam o destino");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
let org = "",
  contact = "",
  conversation = "",
  lead = "",
  message = "",
  pointer = "",
  version = "",
  agent = "",
  job = "",
  outbound = "",
  consent = "";
let channel = "",
  pipeline = "",
  stage = "";
const cfg = {
  enabled: true,
  organizationId: org!,
  tokenSha256: "a".repeat(64),
  signingKey: "b".repeat(32),
  allowedKinds: ["oferta", "cronograma"] as ("oferta" | "cronograma")[],
};
const base = new Date("2026-10-23T13:00:00Z"),
  now = new Date("2026-10-23T15:00:00Z");
const graph = {
  settings: {
    c01_acompanhamento: { version: 1, kind: "oferta", activated_at: "2026-10-23T11:00:00Z" },
  },
  nodes: [
    { id: "start", type: "trigger", label: "Entrada", position: { x: 0, y: 0 }, config: {} },
    {
      id: "touch",
      type: "action",
      label: "Envio",
      position: { x: 0, y: 100 },
      config: { mode: "text", body: "Retorno" },
    },
    {
      id: "end",
      type: "end",
      label: "Fim",
      position: { x: 0, y: 200 },
      config: { outcome: "custom" },
    },
  ],
  edges: [
    { id: "e1", source: "start", target: "touch", condition: { type: "always" } },
    { id: "e2", source: "touch", target: "end", condition: { type: "always" } },
  ],
};
const financial = async () => ({
  status: state.paid ? ("confirmado" as const) : ("nao_comprou_confirmado" as const),
  checkedAt: now.toISOString(),
  complete: true,
});
beforeAll(async () => {
  state.pool = pool;
});
beforeEach(async () => {
  org = randomUUID();
  contact = randomUUID();
  conversation = randomUUID();
  lead = randomUUID();
  message = randomUUID();
  pointer = randomUUID();
  version = randomUUID();
  agent = randomUUID();
  job = randomUUID();
  outbound = randomUUID();
  consent = randomUUID();
  channel = randomUUID();
  pipeline = randomUUID();
  stage = randomUUID();
  cfg.organizationId = org;
  vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
  state.paid = false;
  state.reads = 0;
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Prova acompanhamento','Prova acompanhamento')",
    [org, `review-${org}`],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00')",
    [channel, org, `review-${channel}`],
  );
  await pool.query("insert into contacts(id,organization_id) values($1,$2)", [contact, org]);
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,last_inbound_at,channel_session_id,status,assignee_kind) values($1,$2,$3,$4,$5,'ai_handling','ai')",
    [conversation, org, contact, base, channel],
  );
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Funil fictício','ficticio')",
    [pipeline, org],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Novo','novo',1000)",
    [stage, org, pipeline],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,contact_id,custom_fields,pipeline_id,stage_id,title) values($1,$2,$3,$4,$5,$6,'Prova fictícia')",
    [lead, org, contact, { produto_chave: "produto-teste" }, pipeline, stage],
  );
  await pool.query(
    "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,external_id,sent_at,delivered_at) values($1,$2,$3,$4,$6,'outbound','text','Oferta','delivered','provider-1',$5,$5)",
    [message, org, contact, conversation, base, channel],
  );
  await pool.query(
    "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
    [version, org, graph],
  );
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,active_version_id,status,name) values($1,$2,$3,'active','Prova fictícia')",
    [pointer, org, version],
  );
  await pool.query(
    "insert into ai_agents(id,organization_id,operation_mode,name,system_prompt) values($1,$2,'automatic','Agente fictício','Não contate pessoas')",
    [agent, org],
  );
  await pool.query(
    "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,followup) values($1,$2,$3,1,'Não contate pessoas','openai','synthetic',$4)",
    [version, org, agent, { enabled: true, flow_pointer_ids: [pointer] }],
  );
  await pool.query("update ai_agents set published_version_id=$1 where id=$2", [version, agent]);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pool.end();
});
async function enroll() {
  return registrarOrigemEntregueC01(
    pool,
    cfg,
    { kind: "oferta", leadId: lead!, productKey: "produto-teste", messageId: message! },
    now,
  );
}
async function ready() {
  const e = await enroll();
  await pool.query("update followup_enrollments set current_node_id='touch' where id=$1", [
    e.enrollment_id,
  ]);
  await pool.query(
    "insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'followup_turn','running',$4)",
    [job, org, contact, { followup_enrollment_id: e.enrollment_id, node_id: "touch" }],
  );
  const c = {
    organizationId: org!,
    contactId: contact!,
    enrollmentId: e.enrollment_id,
    nodeId: "touch",
    jobId: job!,
  };
  const { supabase } = criarDubleDoHandler({
    conversation: { id: conversation },
    tabelasDeLeitura: {
      followup_enrollments: { version_id: version, contact_id: contact },
      followup_flow_versions: { graph },
    },
  });
  return { c, supabase, e };
}
describe("acompanhamento com SQL real e transporte falso", () => {
  it("matrícula repetida é única; sent não é delivered", async () => {
    await pool.query("update messages set status='sent',delivered_at=null where id=$1", [message]);
    await expect(enroll()).rejects.toMatchObject({ code: "delivery_unconfirmed" });
    await pool.query("update messages set status='delivered',delivered_at=sent_at where id=$1", [
      message,
    ]);
    const first = await enroll();
    expect(await enroll()).toMatchObject({ status: "replay", enrollment_id: first.enrollment_id });
    expect(
      (
        await pool.query(
          "select count(*)::int n from followup_enrollments where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("origem anterior à ativação é recusada e não cria matrícula", async () => {
    const futureActivation = {
      ...graph,
      settings: {
        c01_acompanhamento: {
          ...graph.settings.c01_acompanhamento,
          activated_at: "2026-10-23T14:00:00Z",
        },
      },
    };
    await pool.query("update followup_flow_versions set graph=$1 where id=$2", [
      futureActivation,
      version,
    ]);
    await expect(enroll()).rejects.toMatchObject({ code: "origin_before_activation" });
    expect(
      (
        await pool.query(
          "select count(*)::int n from followup_enrollments where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("duas matrículas simultâneas não duplicam", async () => {
    const results = await Promise.allSettled([enroll(), enroll()]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(
      (
        await pool.query(
          "select count(*)::int n from followup_enrollments where organization_id=$1",
          [org],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("resposta entre aceite e entrega bloqueia matrícula", async () => {
    await pool.query("update messages set delivered_at=sent_at+interval '2 minutes' where id=$1", [
      message,
    ]);
    await pool.query(
      "update conversations set last_inbound_at=last_inbound_at+interval '1 minute' where id=$1",
      [conversation],
    );
    await expect(enroll()).rejects.toMatchObject({ code: "new_reply" });
  });
  it("compra entre seleção e envio impede o transporte; recuperação depois da tentativa não repete", async () => {
    const r = await ready(),
      transport = vi.fn();
    await expect(
      comEnvioAcompanhamentoC01(r.supabase, r.c, org!, async () => {
        await assertAcompanhamentoC01Supabase(r.supabase, r.c, org!, now);
        state.paid = true;
        await assertAcompanhamentoC01Supabase(r.supabase, r.c, org!, now);
        transport();
      }),
    ).rejects.toMatchObject({ details: { reason: "compra_confirmada" } });
    expect(transport).not.toHaveBeenCalled();
    state.paid = false;
    await comEnvioAcompanhamentoC01(r.supabase, r.c, org!, async () => {
      await assertAcompanhamentoC01Supabase(r.supabase, r.c, org!, now);
      await registrarTentativaEnvioC01(r.c, outbound!);
      await registrarTentativaEnvioC01(r.c, outbound!);
      transport();
    });
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(
      comEnvioAcompanhamentoC01(r.supabase, r.c, org!, async () =>
        registrarTentativaEnvioC01(r.c, outbound!),
      ),
    ).rejects.toThrow("entrega_indeterminada");
  });
  it("a trava impede dois transportes concorrentes e libera no fim", async () => {
    const r = await ready();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = comEnvioAcompanhamentoC01(r.supabase, r.c, org!, async () => {
      entered();
      await gate;
    });
    await began;
    await expect(
      comEnvioAcompanhamentoC01(r.supabase, r.c, org!, async () => {}),
    ).rejects.toMatchObject({ code: "c01_acompanhamento_ocupado" });
    release();
    await first;
    await expect(
      comEnvioAcompanhamentoC01(r.supabase, r.c, org!, async () => {}),
    ).resolves.toBeUndefined();
  });
  it("recibo faltante ou falha permanece visível e não conta como silêncio", async () => {
    const r = await ready();
    await pool.query(
      "insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload) values($1,$2,'touch','action_sent','{}')",
      [org, r.e.enrollment_id],
    );
    await pool.query(
      "insert into send_ledger(organization_id,contact_id,job_id,status,seq,body_hash) values($1,$2,$3,'requested',1,'ficticio')",
      [org, contact, job],
    );
    const f = await lerFatosAcompanhamentoC01(
      pool,
      cfg,
      { organizationId: org!, contactId: contact!, enrollmentId: r.e.enrollment_id },
      now,
      financial,
    );
    expect(f?.touches[0]?.messageIds).toHaveLength(1);
    expect(f?.touches[0]?.receipts).toHaveLength(0);
    await expect(
      comEnvioAcompanhamentoC01(r.supabase, r.c, org!, async () =>
        assertAcompanhamentoC01Supabase(r.supabase, r.c, org!, now),
      ),
    ).rejects.toMatchObject({ code: "c01_acompanhamento_bloqueado" });
  });
  it("callback exige consentimento e prazo executável; nova resposta/compra impedem envio", async () => {
    await pool.query(
      "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,sent_at) values($1,$2,$3,$4,$6,'inbound','text','Pode me chamar hoje às 12h.','received',$5)",
      [consent, org, contact, conversation, base, channel],
    );
    const proof = await prepararRetornoComercialC01(pool, {
      organizationId: org!,
      contactId: contact!,
      leadId: lead!,
      promisedAt: now.toISOString(),
      consent: { consent_message_id: consent!, consent_excerpt: "Pode me chamar hoje às 12h." },
    });
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'followup_turn','running',$4)",
      [job, org, contact, { ...proof, promised_at: now.toISOString() }],
    );
    const scope = { organizationId: org!, contactId: contact!, jobId: job! };
    await expect(
      conferirRetornoNoEnvioC01(
        pool,
        scope,
        new Date(+now - 1),
        new AbortController().signal,
        financial,
      ),
    ).rejects.toThrow("not_due");
    await expect(
      conferirRetornoNoEnvioC01(pool, scope, now, new AbortController().signal, financial),
    ).resolves.toBeUndefined();
    state.paid = true;
    await expect(
      conferirRetornoNoEnvioC01(pool, scope, now, new AbortController().signal, financial),
    ).rejects.toThrow("purchased");
    state.paid = false;
    await pool.query("update conversations set last_inbound_at=$1 where id=$2", [
      now,
      conversation,
    ]);
    await expect(
      conferirRetornoNoEnvioC01(pool, scope, now, new AbortController().signal, financial),
    ).rejects.toThrow("new_reply");
    await pool.query("update messages set body='Pode me chamar amanhã às 12h.' where id=$1", [
      consent,
    ]);
    await expect(
      prepararRetornoComercialC01(pool, {
        organizationId: org!,
        contactId: contact!,
        promisedAt: "2026-10-24T15:00:00.000Z",
        consent: { consent_message_id: consent!, consent_excerpt: "Pode me chamar" },
      }),
    ).rejects.toThrow("template_required_before_promise");
  });
  it.each([false, true])(
    "ferramenta nativa agenda usando o consentimento do turno, sem IDs do modelo (confirmação curta=%s)",
    async (short) => {
      const sentAt = new Date(+base + 60000);
      await pool.query("update messages set body='Posso te chamar hoje às 12h?' where id=$1", [
        message,
      ]);
      await pool.query(
        "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,sent_at) values($1,$2,$3,$4,$7,'inbound','text',$5,'received',$6)",
        [
          consent,
          org,
          contact,
          conversation,
          short ? "Sim!" : "Pode me chamar hoje às 12h.",
          sentAt,
          channel,
        ],
      );
      await pool.query("update conversations set last_inbound_at=$1 where id=$2", [
        sentAt,
        conversation,
      ]);
      await pool.query(
        "insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'inbound_turn','running',$4)",
        [job, org, contact, { inbound_message_id: consent }],
      );
      const settings = {
        clock: () => sentAt,
        c01Callback: true,
        knobs: { minAheadMs: 0, maxAheadMs: 7 * 86400000, staggerWindowMs: 0 },
      };
      const trusted = { tenantId: org!, leadId: contact!, sourceJobId: job! };
      const input = {
        reason: "Retorno solicitado",
        promised_at: now.toISOString(),
        promise: "Conversar no horário combinado",
      };
      const result = await applyScheduleFollowup(pool, settings, trusted, input);
      expect(result.ok).toBe(true);
      const rows = (
        await pool.query("select payload,next_run_at from cron_jobs where organization_id=$1", [
          org,
        ])
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].payload).toMatchObject({
        scope: "commercial",
        lead_id: lead,
        c01_callback: {
          message_id: consent,
          offered_message_id: message,
          promised_at: now.toISOString(),
        },
      });
      expect(+new Date(rows[0].next_run_at)).toBe(+now);
      await expect(
        applyScheduleFollowup(pool, settings, trusted, { ...input, consent_message_id: message }),
      ).rejects.toThrow("consent_outside_current_turn");
      expect(
        (await pool.query("select count(*)::int n from cron_jobs where organization_id=$1", [org]))
          .rows[0].n,
      ).toBe(1);
    },
  );

  it("callback cancela somente cadência C01 e jobs da mesma pessoa", async () => {
    const r = await ready();
    const otherContact = randomUUID(),
      otherJob = randomUUID();
    await pool.query("insert into contacts(id,organization_id) values($1,$2)", [otherContact, org]);
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'followup_turn','pending',$4)",
      [otherJob, org, otherContact, { followup_enrollment_id: randomUUID() }],
    );
    await cederCadenciaAoRetornoC01(pool, org!, contact!);
    expect(
      (await pool.query("select status from job_queue where id=$1", [otherJob])).rows[0].status,
    ).toBe("pending");
    expect(
      (await pool.query("select status from followup_enrollments where id=$1", [r.e.enrollment_id]))
        .rows[0].status,
    ).toBe("cancelled");
    expect(
      (await pool.query("select status from job_queue where id=$1", [job])).rows[0].status,
    ).toBe("done");
  });
});
