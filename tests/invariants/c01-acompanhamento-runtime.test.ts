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
 create table followup_enrollments(id uuid primary key,organization_id uuid,pointer_id uuid,version_id uuid,contact_id uuid,conversation_id uuid,current_node_id text,status text,next_eval_at timestamptz,service_boundary jsonb,agent_id uuid,cancel_reason text,completed_at timestamptz,claimed_until timestamptz);
 create table followup_enrollment_events(id uuid primary key default gen_random_uuid(),organization_id uuid,enrollment_id uuid,node_id text,event_type text,payload jsonb,idempotency_key text,created_at timestamptz default now(),unique(enrollment_id,idempotency_key));
 create table cron_jobs(id uuid primary key default gen_random_uuid(),organization_id uuid,contact_id uuid,kind text,job_kind text,enabled boolean default true,cancelled_at timestamptz,payload jsonb,next_run_at timestamptz,cancel_reason text,last_error text,attempts integer default 0,updated_at timestamptz);
 create table job_queue(id uuid primary key,organization_id uuid,contact_id uuid,kind text,status text,payload jsonb,last_error text,created_at timestamptz default now());
 create table send_ledger(id uuid primary key default gen_random_uuid(),organization_id uuid,contact_id uuid,job_id uuid,crm_message_id uuid,status text,seq integer);
 create table ai_agents(id uuid,organization_id uuid,published_version_id uuid,paused_at timestamptz,archived_at timestamptz,operation_mode text);
 create table ai_agent_versions(id uuid,organization_id uuid,followup jsonb);
 `);
});
beforeEach(async () => {
  vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
  state.paid = false;
  state.reads = 0;
  state.buyAt = 0;
  await pool.query(
    "truncate contacts,conversations,crm_leads,demandas,messages,followup_flow_pointers,followup_flow_versions,followup_enrollments,followup_enrollment_events,cron_jobs,job_queue,send_ledger,ai_agents,ai_agent_versions",
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
      const transport = vi.fn(async () => Response.json({ key: { id: "falso-1" } }));
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
      await expect(
        applyScheduleFollowup(pool, settings, trusted, { ...input, consent_message_id: message }),
      ).rejects.toThrow("consent_outside_current_turn");
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
