import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
const state = vi.hoisted(() => ({ pool: null as pg.Pool | null, paid: false, reads: 0, buyAt: 0 }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => state.pool }));
vi.mock("@/lib/leads/fonte-financeira", () => ({
  lerSituacaoFinanceira: async ({ now }: { now: Date }) => {
    state.reads++;
    return {
      status:
        state.paid || (state.buyAt > 0 && state.reads >= state.buyAt)
          ? "confirmado"
          : "nao_comprou_confirmado",
      complete: true,
      checkedAt: now.toISOString(),
      reason: "fixture",
    };
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/leads/agent-activity", () => ({
  emitAgentActivityForContact: vi.fn(async () => {}),
}));
import { applyScheduleFollowup } from "@/lib/agent-engine/agent/schedule-followup";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
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
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import { hashDoCorpo } from "@/lib/api/idempotency";
const port = Number(process.env.TEST_DB_PORT ?? 54329),
  user = process.env.C01_TEST_DB_USER ?? "postgres";
const schema = `c01_acomp_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({
  host: "127.0.0.1",
  port,
  user,
  password: "postgres",
  database: "postgres",
  max: 1,
});
const pool = new pg.Pool({
  host: "127.0.0.1",
  port,
  user,
  password: "postgres",
  database: "postgres",
  max: 6,
  options: `-c search_path=${schema}`,
});
const ids = Array.from(
  { length: 12 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);
const [org, contact, conversation, lead, message, pointer, version, agent, job, outbound, consent] =
  ids as string[];
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
  await admin.query(`create schema ${schema}`);
  await pool.query(`
 create table contacts(id uuid primary key,organization_id uuid,is_blocked boolean default false,ai_opt_out boolean default false,force_human boolean default false,is_anonymized boolean default false,is_merged_into uuid);
 create table conversations(id uuid primary key,organization_id uuid,contact_id uuid,status text default 'open',assignee_kind text default 'ai',bot_silenced_until timestamptz,last_inbound_at timestamptz,service_revision integer default 1,current_demanda_id uuid,channel_session_id uuid);
 create table crm_leads(id uuid primary key,organization_id uuid,contact_id uuid,status text default 'open',custom_fields jsonb,created_at timestamptz default now());
 create table demandas(id uuid,organization_id uuid,revision integer,fechada_em timestamptz);
 create table messages(id uuid primary key,organization_id uuid,contact_id uuid,conversation_id uuid,direction text,type text,body text,metadata jsonb default '{}',media_url text,media_storage_path text,status text,external_id text,sent_at timestamptz,delivered_at timestamptz,read_at timestamptz,error_code text,revoked_at timestamptz);
 create table followup_flow_pointers(id uuid primary key,organization_id uuid,active_version_id uuid,status text);
 create table followup_flow_versions(id uuid primary key,organization_id uuid,graph jsonb);
 create table followup_enrollments(id uuid primary key,organization_id uuid,pointer_id uuid,version_id uuid,contact_id uuid,conversation_id uuid,current_node_id text,status text,next_eval_at timestamptz default now(),service_boundary jsonb,agent_id uuid,cancel_reason text,completed_at timestamptz,claimed_until timestamptz);
 create table followup_enrollment_events(id uuid primary key default gen_random_uuid(),organization_id uuid,enrollment_id uuid,node_id text,event_type text,payload jsonb,idempotency_key text,created_at timestamptz default now(),unique(enrollment_id,idempotency_key));
 create table cron_jobs(id uuid primary key default gen_random_uuid(),organization_id uuid,contact_id uuid,kind text,job_kind text,enabled boolean default true,cancelled_at timestamptz,payload jsonb,next_run_at timestamptz,cancel_reason text,last_error text,attempts integer default 0,updated_at timestamptz);
 create table job_queue(id uuid primary key,organization_id uuid,contact_id uuid,kind text,status text,payload jsonb,last_error text,created_at timestamptz default now());
 create table send_ledger(id uuid primary key default gen_random_uuid(),organization_id uuid,contact_id uuid,job_id uuid,crm_message_id uuid,status text,seq integer);
 create table ai_agents(id uuid,organization_id uuid,published_version_id uuid,paused_at timestamptz,archived_at timestamptz,operation_mode text);
 create table ai_agent_versions(id uuid,organization_id uuid,followup jsonb);
 create table organizations(id uuid,timezone text);
 create table channel_sessions(id uuid,organization_id uuid,provider text,meta_waba_id text);
 create table meta_templates(id uuid,organization_id uuid,channel_session_id uuid,waba_id text,name text,language text,components jsonb,parameter_format text,status text);
 `);
});
beforeEach(async () => {
  vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
  state.paid = false;
  state.reads = 0;
  state.buyAt = 0;
  await pool.query(
    "truncate contacts,conversations,crm_leads,demandas,messages,followup_flow_pointers,followup_flow_versions,followup_enrollments,followup_enrollment_events,cron_jobs,job_queue,send_ledger,ai_agents,ai_agent_versions,organizations,channel_sessions,meta_templates",
  );
  await pool.query("insert into contacts(id,organization_id) values($1,$2)", [contact, org]);
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,last_inbound_at) values($1,$2,$3,$4)",
    [conversation, org, contact, base],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,contact_id,custom_fields) values($1,$2,$3,$4)",
    [lead, org, contact, { produto_chave: "produto-teste" }],
  );
  await pool.query(
    "insert into messages(id,organization_id,contact_id,conversation_id,direction,type,body,status,external_id,sent_at,delivered_at) values($1,$2,$3,$4,'outbound','text','Oferta','delivered','provider-1',$5,$5)",
    [message, org, contact, conversation, base],
  );
  await pool.query("insert into followup_flow_pointers values($1,$2,$3,'active')", [
    pointer,
    org,
    version,
  ]);
  await pool.query("insert into followup_flow_versions values($1,$2,$3)", [version, org, graph]);
  await pool.query(
    "insert into ai_agents(id,organization_id,published_version_id,operation_mode) values($1,$2,$3,'automatic')",
    [agent, org, version],
  );
  await pool.query("insert into ai_agent_versions values($1,$2,$3)", [
    version,
    org,
    { enabled: true, flow_pointer_ids: [pointer] },
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await pool.end();
  await admin.query(`drop schema ${schema} cascade`);
  await admin.end();
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
  async function prepararModelo() {
    const at = "2026-10-25T15:00:00.000Z";
    const components = [{ type: "BODY", text: "Retorno fictício do laboratório." }];
    const contentHash = hashDoCorpo({ name: "retorno_ficticio", language: "pt_BR", parameter_format: "POSITIONAL", components });
    vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify({ ...cfg, callbackTemplate: { enabled: true, connectionId: agent, templateId: pointer, contentHash } }));
    await pool.query("insert into organizations values($1,'America/Sao_Paulo')", [org]);
    await pool.query("insert into channel_sessions values($1,$2,'meta','waba-ficticia')", [agent, org]);
    await pool.query("insert into meta_templates values($1,$2,$3,'waba-ficticia','retorno_ficticio','pt_BR',$4,'POSITIONAL','APPROVED')", [pointer, org, agent, JSON.stringify(components)]);
    await pool.query("update conversations set channel_session_id=$1", [agent]);
    await pool.query("update ai_agent_versions set followup=$1", [{ c01_callback: true, callback_enabled: true }]);
    await pool.query("insert into messages(id,organization_id,contact_id,conversation_id,direction,type,body,status,sent_at) values($1,$2,$3,$4,'inbound','text','Pode me chamar 25/10 às 12h.','received',$5)", [consent, org, contact, conversation, base]);
    await pool.query("insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'inbound_turn','running',$4)", [job, org, contact, { inbound_message_id: consent }]);
    const result = await applyScheduleFollowup(pool, { clock: () => base, c01Callback: true, knobs: { minAheadMs: 0, maxAheadMs: 7 * 86400000, staggerWindowMs: 0 } }, { tenantId: org!, leadId: contact!, sourceJobId: job!, agentId: agent }, { reason: "Retorno solicitado", promised_at: at, promise: "Conversar no horário combinado" });
    expect(result.ok).toBe(true);
    const rows = (await pool.query("select payload,next_run_at from cron_jobs")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.c01_callback.template).toEqual({ connection_id: agent, template_id: pointer, content_hash: contentHash });
    expect(+new Date(rows[0].next_run_at)).toBe(Date.parse(at));
    await pool.query("update job_queue set kind='followup_turn',payload=$1", [rows[0].payload]);
    const context = { organizationId: org!, contactId: contact!, jobId: job! };
    const { supabase } = criarDubleDoHandler({ conversation: { id: conversation }, tabelasDeLeitura: { job_queue: { payload: rows[0].payload } } });
    return { at: new Date(at), context, supabase, payload: rows[0].payload };
  }
  it("modelo: a ferramenta grava prova e horário, e o corte final SQL relê o modelo", async () => {
    const r = await prepararModelo();
    await comEnvioAcompanhamentoC01(r.supabase, r.context, org!, async () => {
      await assertAcompanhamentoC01Supabase(r.supabase, r.context, org!, r.at);
      await pool.query("update meta_templates set status='REJECTED'");
      await expect(assertAcompanhamentoC01Supabase(r.supabase, r.context, org!, r.at)).rejects.toThrow("template_not_approved");
    });
  });
  it("modelo: envio sem recibo não admite segunda tentativa física", async () => {
    const r = await prepararModelo();
    const transport = vi.fn(async () => {});
    await comEnvioAcompanhamentoC01(r.supabase, r.context, org!, async () => {
      await assertAcompanhamentoC01Supabase(r.supabase, r.context, org!, r.at);
      await registrarTentativaEnvioC01(r.context, outbound!);
      await transport();
    });
    await expect(comEnvioAcompanhamentoC01(r.supabase, r.context, org!, async () => {
      await registrarTentativaEnvioC01(r.context, outbound!);
      await transport();
    })).rejects.toThrow("ja_tentado");
    await expect(comEnvioAcompanhamentoC01(r.supabase, r.context, org!, async () => {
      await registrarTentativaEnvioC01(r.context, randomUUID());
      await transport();
    })).rejects.toThrow("entrega_indeterminada");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("modelo: compra confirmada ou agente desativado depois de agendar impede o corte final", async () => {
    const r = await prepararModelo();
    state.paid = true;
    await expect(comEnvioAcompanhamentoC01(r.supabase, r.context, org!, () => assertAcompanhamentoC01Supabase(r.supabase, r.context, org!, r.at))).rejects.toThrow("purchased");
    state.paid = false;
    await pool.query("update ai_agents set operation_mode='copilot'");
    await expect(comEnvioAcompanhamentoC01(r.supabase, r.context, org!, () => assertAcompanhamentoC01Supabase(r.supabase, r.context, org!, r.at))).rejects.toThrow("agent_not_authorized");
  });
  it("matrícula repetida é única; sent não é delivered e origem anterior à ativação não entra", async () => {
    await pool.query("update messages set status='sent',delivered_at=null");
    await expect(enroll()).rejects.toMatchObject({ code: "delivery_unconfirmed" });
    await pool.query("update messages set status='delivered',delivered_at=sent_at");
    const first = await enroll();
    expect(await enroll()).toMatchObject({ status: "replay", enrollment_id: first.enrollment_id });
    expect((await pool.query("select count(*)::int n from followup_enrollments")).rows[0].n).toBe(
      1,
    );
  });
  it("matrícula vencida usa o relógio do banco mesmo com o processo adiantado", async () => {
    const before = (await pool.query("select now() as at")).rows[0].at;
    const processClock = new Date(Math.max(+new Date(before), +now) + 3600000);
    const e = await registrarOrigemEntregueC01(pool, cfg, {
      kind: "oferta", leadId: lead!, productKey: "produto-teste", messageId: message!,
    }, processClock);
    const row = (await pool.query("select next_eval_at,now() as database_now from followup_enrollments where id=$1", [e.enrollment_id])).rows[0];
    expect(+new Date(row.next_eval_at)).toBeGreaterThanOrEqual(+new Date(before));
    expect(+new Date(row.next_eval_at)).toBeLessThanOrEqual(+new Date(row.database_now));
    expect(+new Date(row.next_eval_at)).toBeLessThan(+processClock);
  });
  it("duas matrículas simultâneas não duplicam", async () => {
    const results = await Promise.allSettled([enroll(), enroll()]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await pool.query("select count(*)::int n from followup_enrollments")).rows[0].n).toBe(
      1,
    );
  });
  it("resposta entre aceite e entrega bloqueia matrícula", async () => {
    await pool.query("update messages set delivered_at=sent_at+interval '2 minutes'");
    await pool.query(
      "update conversations set last_inbound_at=last_inbound_at+interval '1 minute'",
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
      "insert into send_ledger(organization_id,contact_id,job_id,status,seq) values($1,$2,$3,'pending',1)",
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
      "insert into messages(id,organization_id,contact_id,conversation_id,direction,type,body,status,sent_at) values($1,$2,$3,$4,'inbound','text','Pode me chamar hoje às 12h.','received',$5)",
      [consent, org, contact, conversation, base],
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
    await pool.query("update conversations set last_inbound_at=$1", [now]);
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
  it.each(["text", "image"] as const)(
    "porta física %s relê compra imediatamente antes do transporte",
    async (type) => {
      const r = await ready();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      vi.stubEnv("WAHA_API_BASE_URL", "http://127.0.0.1:3030");
      vi.stubEnv("WAHA_API_KEY", "fixture");
      const transport = vi.fn<typeof fetch>(async () => Response.json({ key: { id: "falso-1" } }));
      vi.stubGlobal("fetch", transport);
      const fake = criarDubleDoHandler({
        conversation: {
          id: conversation,
          organization_id: org,
          contact_id: contact,
          channel_session_id: agent,
          is_group: false,
          contacts: { phone_number: "+5500000000000", is_blocked: false },
          channel_sessions: {
            provider: "waha",
            waha_session_name: "default",
            status: "WORKING",
            archived_at: null,
          },
        },
        rpcData: true,
        tabelasDeLeitura: {
          followup_enrollments: { version_id: version, contact_id: contact },
          followup_flow_versions: { graph },
        },
      });
      state.buyAt = 2;
      try {
        await sendMessageHandler(
          fake.supabase,
          {
            organization_id: org!,
            actor: { type: "webhook_source", id: job! },
            requestId: "fixture",
            proactiveContext: {
              ...r.c,
              jobClaim: { worker_id: "fixture", acquired_at: now.toISOString() },
            },
          },
          {
            conversation_id: conversation!,
            type,
            body: "Retorno",
            ...(type === "image"
              ? { media_storage_path: `${org}/${conversation}/image.jpg`, media_mime: "image/jpeg" }
              : {}),
          },
        );
      } catch {
        /* veto pode lançar ou persistir falha */
      }
      expect(state.reads).toBeGreaterThanOrEqual(2);
      expect(
        transport.mock.calls.filter((args) => !String(args[0]).includes("/storage/v1/")),
      ).toHaveLength(0);
      expect(fake.mensagens.some((m) => m.status === "sent")).toBe(false);
    },
  );
  it.each([false, true])(
    "ferramenta nativa agenda usando o consentimento do turno, sem IDs do modelo (confirmação curta=%s)",
    async (short) => {
      const sentAt = new Date(+base + 60000);
      await pool.query("update messages set body='Posso te chamar hoje às 12h?' where id=$1", [
        message,
      ]);
      await pool.query(
        "insert into messages(id,organization_id,contact_id,conversation_id,direction,type,body,status,sent_at) values($1,$2,$3,$4,'inbound','text',$5,'received',$6)",
        [
          consent,
          org,
          contact,
          conversation,
          short ? "Sim!" : "Pode me chamar hoje às 12h.",
          sentAt,
        ],
      );
      await pool.query("update conversations set last_inbound_at=$1", [sentAt]);
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
      const rows = (await pool.query("select payload,next_run_at from cron_jobs")).rows;
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
      expect(
        await applyScheduleFollowup(pool, settings, trusted, { ...input, consent_message_id: message }),
      ).toMatchObject({
        ok: false,
        error: { code: "callback_not_confirmed", message: expect.stringContaining("consent_outside_current_turn") },
      });
      expect((await pool.query("select count(*)::int n from cron_jobs")).rows[0].n).toBe(1);
    },
  );
  it("callback cancela somente cadência C01 e jobs da mesma pessoa", async () => {
    const r = await ready();
    await cederCadenciaAoRetornoC01(pool, org!, contact!);
    expect(
      (await pool.query("select status from followup_enrollments where id=$1", [r.e.enrollment_id]))
        .rows[0].status,
    ).toBe("cancelled");
    expect(
      (await pool.query("select status from job_queue where id=$1", [job])).rows[0].status,
    ).toBe("done");
  });
});

describe("pausa após vídeo integrada ao SQL existente", () => {
  const videoKey="curso-ficticio", videoUrl="https://example.invalid/curso", question="Ficou alguma dúvida sobre como funciona?";
  async function videoReady() {
    const { assinarOrigemC01, hashDoConteudoDaOrigem } = await import("@/lib/followup/c01-origem");
    const config = { ...cfg, allowedKinds: ["oferta", "cronograma", "video_curso"] as const,
      videoCourse: { enabled:true, connectionId:agent!, copyStatus:"approved" as const, question,
        catalog:[{key:videoKey, productKey:"produto-teste",url:videoUrl}] } };
    const videoCfg = { ...config, allowedKinds:[...config.allowedKinds] };
    vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(videoCfg));
    const videoGraph=JSON.parse(JSON.stringify(graph));
    videoGraph.settings.c01_acompanhamento.kind="video_curso";
    videoGraph.nodes[1].config.body=question;
    await pool.query("update followup_flow_versions set graph=$1", [videoGraph]);
    await pool.query("update messages set body=$1", [videoUrl]);
    const source=(await pool.query("select * from messages where id=$1",[message])).rows[0];
    const origin={kind:"video_curso" as const,leadId:lead!,productKey:"produto-teste",messageId:message!,videoKey};
    const proof=assinarOrigemC01(videoCfg,{...origin,organizationId:org!,contactId:contact!,conversationId:conversation!,createdAt:base.toISOString(),contentHash:hashDoConteudoDaOrigem(source)});
    await pool.query("update messages set metadata=$1 where id=$2",[{c01_origin:proof},message]);
    return {videoCfg,videoGraph,origin,proof};
  }
  it("matrícula e relógio usam recibo; read sem delivered também funciona", async()=>{
    const v=await videoReady();
    await pool.query("update messages set status='sent',delivered_at=null");
    await expect(registrarOrigemEntregueC01(pool,v.videoCfg,v.origin,now)).rejects.toThrow("delivery_unconfirmed");
    await pool.query("update messages set status='read',read_at=$1",[new Date(+base+5*60000)]);
    const e=await registrarOrigemEntregueC01(pool,v.videoCfg,v.origin,now);
    const f=await lerFatosAcompanhamentoC01(pool,v.videoCfg,{organizationId:org!,contactId:contact!,enrollmentId:e.enrollment_id},now,financial);
    expect(f!.anchor.at).toBe("2026-10-23T13:05:00.000Z");
    expect(f!.videoPolicyReady).toBe(true);
  });
  it("replay e novo balão do mesmo vídeo não geram segunda inscrição",async()=>{
    const v=await videoReady();const first=await registrarOrigemEntregueC01(pool,v.videoCfg,v.origin,now);
    expect(await registrarOrigemEntregueC01(pool,v.videoCfg,v.origin,now)).toEqual({status:"replay",enrollment_id:first.enrollment_id});
    const {assinarOrigemC01}=await import("@/lib/followup/c01-origem");
    const second=randomUUID(),proof=assinarOrigemC01(v.videoCfg,{...v.proof,messageId:second});
    await pool.query("insert into messages select $1,organization_id,contact_id,conversation_id,direction,type,body,$2,media_url,media_storage_path,status,external_id,sent_at,delivered_at,read_at,error_code,revoked_at from messages where id=$3",[second,{c01_origin:proof},message]);
    expect(await registrarOrigemEntregueC01(pool,v.videoCfg,{...v.origin,messageId:second},now)).toEqual({status:"replay",enrollment_id:first.enrollment_id});
    expect((await pool.query("select count(*)::int as n from followup_enrollments")).rows[0].n).toBe(1);
  });
  it.each(["oferta","cronograma"] as const)("%s ativa é preservada, e scanner registra omissão para não rearmar depois",async(kind)=>{
    const oldGraph=JSON.parse(JSON.stringify(graph));oldGraph.settings.c01_acompanhamento.kind=kind;
    await pool.query("update followup_flow_versions set graph=$1",[oldGraph]);
    const old=await registrarOrigemEntregueC01(pool,cfg,{kind,leadId:lead!,productKey:"produto-teste",messageId:message!},now);const v=await videoReady();
    const {inscreverOrigensConfirmadasC01}=await import("@/lib/followup/c01-acompanhamento-origens");
    // A inscrição antiga conserva sua própria versão de oferta.
    const oldVersion=randomUUID();await pool.query("insert into followup_flow_versions values($1,$2,$3)",[oldVersion,org,oldGraph]);
    await pool.query("update followup_enrollments set version_id=$1 where id=$2",[oldVersion,old.enrollment_id]);
    await pool.query("delete from followup_enrollment_events where enrollment_id=$1",[old.enrollment_id]);
    await inscreverOrigensConfirmadasC01(pool,now);
    expect((await pool.query("select status from followup_enrollments where id=$1",[old.enrollment_id])).rows[0].status).toBe("active");
    expect((await pool.query("select metadata from messages where id=$1",[message])).rows[0].metadata.c01_video_omitted.reason).toBe("another_sequence_live");
    await pool.query("update followup_enrollments set status='completed'");
    await inscreverOrigensConfirmadasC01(pool,now);
    expect((await pool.query("select count(*)::int as n from followup_enrollments")).rows[0].n).toBe(1);
    expect(v.videoCfg.videoCourse.enabled).toBe(true);
  });
  it("retorno consentido permanece intacto e vídeo fica omitido com motivo",async()=>{
    await videoReady();
    await pool.query("insert into cron_jobs(organization_id,contact_id,kind,job_kind,next_run_at) values($1,$2,'at','followup_turn',$3)",[org,contact,now]);
    const {inscreverOrigensConfirmadasC01}=await import("@/lib/followup/c01-acompanhamento-origens");
    await inscreverOrigensConfirmadasC01(pool,now);
    expect((await pool.query("select metadata from messages where id=$1",[message])).rows[0].metadata.c01_video_omitted.reason).toBe("callback_has_priority");
    expect((await pool.query("select enabled,next_run_at from cron_jobs")).rows[0]).toMatchObject({enabled:true,next_run_at:now});
    expect((await pool.query("select count(*)::int as n from followup_enrollments")).rows[0].n).toBe(0);
  });
  it("oferta posterior substitui vídeo e guarda o motivo no histórico",async()=>{
    const v=await videoReady();const video=await registrarOrigemEntregueC01(pool,v.videoCfg,v.origin,now);
    const offerPointer=randomUUID(),offerVersion=randomUUID(),offerMessage=randomUUID();
    await pool.query("insert into followup_flow_pointers values($1,$2,$3,'active')",[offerPointer,org,offerVersion]);
    await pool.query("insert into followup_flow_versions values($1,$2,$3)",[offerVersion,org,graph]);
    await pool.query("update ai_agent_versions set followup=$1",[{enabled:true,flow_pointer_ids:[pointer,offerPointer]}]);
    await pool.query("insert into messages select $1,organization_id,contact_id,conversation_id,direction,type,'Oferta nova','{}',media_url,media_storage_path,status,'provider-2',$2,$2,null,null,null from messages where id=$3",[offerMessage,new Date(+base+60000),message]);
    await registrarOrigemEntregueC01(pool,v.videoCfg,{kind:"oferta",leadId:lead!,productKey:"produto-teste",messageId:offerMessage},now);
    expect((await pool.query("select cancel_reason from followup_enrollments where id=$1",[video.enrollment_id])).rows[0].cancel_reason).toBe("oferta_substitui_toque_do_video");
    expect((await pool.query("select payload from followup_enrollment_events where enrollment_id=$1 and event_type='c01_sequencia_substituida'",[video.enrollment_id])).rows[0].payload.reason).toBe("oferta_substitui_toque_do_video");
  });
  it("resposta antes do recibo e origem anterior à ativação não inscrevem",async()=>{
    const v=await videoReady();
    await pool.query("update messages set delivered_at=$1",[new Date(+base+10*60000)]);
    await pool.query("update conversations set last_inbound_at=$1",[new Date(+base+5*60000)]);
    await expect(registrarOrigemEntregueC01(pool,v.videoCfg,v.origin,now)).rejects.toThrow("new_reply");
    await pool.query("update conversations set last_inbound_at=$1",[base]);
    v.videoGraph.settings.c01_acompanhamento.activated_at=new Date(+base+60000).toISOString();
    await pool.query("update followup_flow_versions set graph=$1",[v.videoGraph]);
    await expect(registrarOrigemEntregueC01(pool,v.videoCfg,v.origin,now)).rejects.toThrow("origin_before_activation");
  });
  it("OFF após matrícula bloqueia na porta final comum, sem transporte",async()=>{
    const v=await videoReady();const e=await registrarOrigemEntregueC01(pool,v.videoCfg,v.origin,now);
    await pool.query("update followup_enrollments set current_node_id='touch' where id=$1",[e.enrollment_id]);
    const context={organizationId:org!,contactId:contact!,enrollmentId:e.enrollment_id,nodeId:"touch",jobId:job!};
    const {supabase}=criarDubleDoHandler({conversation:{id:conversation},tabelasDeLeitura:{followup_enrollments:{version_id:version,contact_id:contact},followup_flow_versions:{graph:v.videoGraph}}});
    await comEnvioAcompanhamentoC01(supabase,context,org!,async()=>{
      await assertAcompanhamentoC01Supabase(supabase,context,org!,now);
      vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION",JSON.stringify({...v.videoCfg,videoCourse:{...v.videoCfg.videoCourse,enabled:false}}));
      await expect(assertAcompanhamentoC01Supabase(supabase,context,org!,now)).rejects.toThrow("Acompanhamento C01 bloqueado");
    });
  });
  it.each(["resposta","humano","recusa","compra","falha"])("%s entre seleção e envio impede efeito na porta comum",async(cause)=>{
    const v=await videoReady();const e=await registrarOrigemEntregueC01(pool,v.videoCfg,v.origin,now);
    await pool.query("update followup_enrollments set current_node_id='touch' where id=$1",[e.enrollment_id]);
    const context={organizationId:org!,contactId:contact!,enrollmentId:e.enrollment_id,nodeId:"touch",jobId:job!};
    const {supabase}=criarDubleDoHandler({conversation:{id:conversation},tabelasDeLeitura:{followup_enrollments:{version_id:version,contact_id:contact},followup_flow_versions:{graph:v.videoGraph}}});
    const transport=vi.fn();
    await comEnvioAcompanhamentoC01(supabase,context,org!,async()=>{
      await assertAcompanhamentoC01Supabase(supabase,context,org!,now);
      if(cause==="resposta")await pool.query("update conversations set last_inbound_at=$1",[new Date(+base+60000)]);
      if(cause==="humano")await pool.query("update conversations set assignee_kind='human'");
      if(cause==="recusa")await pool.query("update contacts set ai_opt_out=true");
      if(cause==="compra")state.paid=true;
      if(cause==="falha")await pool.query("update messages set status='failed',error_code='131049' where id=$1",[message]);
      await expect((async()=>{await assertAcompanhamentoC01Supabase(supabase,context,org!,now);transport();})()).rejects.toThrow("Acompanhamento C01 bloqueado");
    });
    expect(transport).not.toHaveBeenCalled();
  });
});
