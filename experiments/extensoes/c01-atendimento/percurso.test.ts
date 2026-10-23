/**
 * Prova independente P2: baseline integral + PostgreSQL/PostgREST locais.
 * Dados sintéticos. Só login/cookie e ausência de suporte/push são substituídos;
 * requireRole, JWT, RLS, rotas, RPCs, consultas e transições são reais.
 * Não roda modelo, worker de saída, push nem WhatsApp.
 */
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pool: null as pg.Pool | null,
  admin: null as SupabaseClient | null,
  session: null as SupabaseClient | null,
  actor: "",
  org: "",
  role: "agent",
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => h.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.session }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => h.pool }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({
    id: h.actor,
    idioma: "pt-BR",
    is_platform_admin: false,
    organizations: [],
  }),
  orgAtivaSemPortao: async () => ({
    orgId: h.org,
    role: h.role,
    org_status: "active",
    name: "Empresa sintética",
  }),
  mfaEmDivida: async () => false,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => false }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushAQuemVeAConversa: () => {
    throw new Error("push proibido nesta prova");
  },
  enviarPushAoUsuario: () => {
    throw new Error("push proibido nesta prova");
  },
}));

import { openCase } from "@/lib/agent-engine/agent/human-cases";
import { isLeadInHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { createCaseReplyTurnHandler } from "@/lib/agent-engine/agent/case-reply-turn";
import type { InboundTurnDeps } from "@/lib/agent-engine/agent/inbound-turn";
import { casoParaAtendenteHandler } from "@/lib/escalacao/caso-para-atendente.handler";
import { conversasVisiveisDosCasos } from "@/lib/escalacao/chamados";
import { POST as responder } from "@/app/api/v1/ai/cases/[id]/reply/route";
import { POST as assumir } from "@/app/api/v1/conversations/[id]/claim/route";
import { POST as devolver } from "@/app/api/v1/conversations/[id]/reactivate-bot/route";
import type { EventRow } from "@/lib/event-log/dispatcher";

const dbUrl = process.env.C01_P2_DATABASE_URL;
const restUrl = process.env.C01_P2_POSTGREST_URL;
const jwtKey = process.env.C01_P2_JWT_SECRET;
if (!dbUrl || !restUrl || !jwtKey)
  throw new Error("C01_P2_DATABASE_URL/POSTGREST_URL/JWT_SECRET obrigatórios");
for (const url of [dbUrl, restUrl]) {
  if (new URL(url).hostname !== "127.0.0.1")
    throw new Error("Esta prova só aceita serviços locais");
}
const parsedDb = new URL(dbUrl),
  parsedRest = new URL(restUrl);
if (
  !["postgres:", "postgresql:"].includes(parsedDb.protocol) ||
  parsedDb.search ||
  parsedDb.hash ||
  !/^\/c01_p2_[a-zA-Z0-9_]+$/.test(parsedDb.pathname)
) {
  throw new Error("Esta prova exige URL direta de banco descartável c01_p2_*, sem parâmetros");
}
if (
  parsedRest.protocol !== "http:" ||
  parsedRest.pathname !== "/" ||
  parsedRest.search ||
  parsedRest.hash ||
  parsedRest.username ||
  parsedRest.password ||
  jwtKey.length < 32
) {
  throw new Error("Esta prova exige HTTP local direto e chave sintética de 32 caracteres ou mais");
}
const pool = new pg.Pool({ connectionString: dbUrl, max: 4 });
const org = randomUUID(),
  otherOrg = randomUUID(),
  userA = randomUUID(),
  userB = randomUUID();
const manager = randomUUID(),
  viewer = randomUUID(),
  outsider = randomUUID();
const contact = randomUUID(),
  conversation = randomUUID(),
  channel = randomUUID();
const pipeline = randomUUID(),
  stage = randomUUID(),
  lead = randomUUID();
let caseId: string, secondCaseId: string, owner: string;
const originalFetch = globalThis.fetch;

function jwt(role: string, sub?: string) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ role, ...(sub ? { sub } : {}), exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", jwtKey!).update(`${header}.${payload}`).digest("base64url")}`;
}
function client(role: string, sub?: string) {
  return createClient(restUrl!, jwt(role, sub), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.origin !== restUrl) throw new Error("Destino fora do PostgREST local");
        url.pathname = url.pathname.replace(/^\/rest\/v1/, "");
        return originalFetch(url, init);
      },
    },
  });
}
function login(id: string, role = "agent", tenant = org) {
  h.actor = id;
  h.role = role;
  h.org = tenant;
  h.session = client("authenticated", id);
}
function req(path: string, body: unknown = {}) {
  return new NextRequest(`http://127.0.0.1${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}
async function state() {
  return (
    await pool.query(
      `select c.force_human, c.ai_opt_out, v.assignee_kind,
    v.assigned_to_user_id, v.bot_silenced_until, l.owner_user_id
    from contacts c join conversations v on v.contact_id=c.id
    join crm_leads l on l.contact_id=c.id where c.id=$1`,
      [contact],
    )
  ).rows[0];
}
async function newCase() {
  const r = await openCase(
    pool,
    { tenantId: org, conversationId: conversation },
    {
      title: "Dúvida sintética",
      summary: "Contexto fictício",
      blocker: "Confirmar informação de exemplo",
    },
  );
  if (!r.ok) throw new Error(r.error.code);
  return r.caseId;
}
async function effects(caseId: string) {
  return (
    await pool.query(
      `select ac.status,
    (select count(*)::int from agent_case_events where case_id=ac.id) as events,
    (select count(*)::int from job_queue where organization_id=ac.organization_id
      and payload->>'case_id'=ac.id::text) as jobs
    from agent_cases ac where ac.id=$1`,
      [caseId],
    )
  ).rows[0];
}

beforeAll(async () => {
  h.pool = pool;
  h.admin = client("service_role");
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname !== "127.0.0.1") throw new Error("Rede externa proibida nesta prova");
    return originalFetch(input, init);
  });
  await pool.query(
    "insert into organizations (id,slug,legal_name,display_name,settings) values ($1,$2,'Sintética A','Sintética A',$3),($4,$5,'Sintética B','Sintética B','{}')",
    [
      org,
      `p2-${org}`,
      JSON.stringify({ visibility_mode: "own_and_unassigned" }),
      otherOrg,
      `p2-${otherOrg}`,
    ],
  );
  for (const [id, role, tenant] of [
    [userA, "agent", org],
    [userB, "agent", org],
    [manager, "manager", org],
    [viewer, "viewer", org],
    [outsider, "agent", otherOrg],
  ]) {
    await pool.query("insert into auth.users (id,email) values ($1,$2)", [
      id,
      `${id}@example.test`,
    ]);
    await pool.query(
      "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now())",
      [id, tenant, role],
    );
  }
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00'::bytea)",
    [channel, org, `p2-${channel}`],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name) values($1,$2,'Contato fictício P2')",
    [contact, org],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status,assignee_kind) values($1,$2,$3,$4,'ai_handling','ai')",
    [conversation, org, contact, channel],
  );
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Funil fictício','p2')",
    [pipeline, org],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Novo','novo',1000)",
    [stage, org, pipeline],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,status) values($1,$2,$3,$4,$5,'Negócio fictício','open')",
    [lead, org, pipeline, stage, contact],
  );
  login(userA);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await pool.end();
});

describe("P2 — percurso real no baseline, sem saída externa", () => {
  it("controle: tabelas relevantes mantêm RLS e papel agent vem da RPC real", async () => {
    const rls = await pool.query(
      "select relname,relrowsecurity from pg_class where oid in ('contacts'::regclass,'conversations'::regclass,'agent_cases'::regclass,'crm_leads'::regclass)",
    );
    expect(rls.rows).toHaveLength(4);
    expect(rls.rows.every((r) => r.relrowsecurity)).toBe(true);
    expect(await h.session!.rpc("fn_user_role_in_org", { p_org: org })).toMatchObject({
      data: "agent",
      error: null,
    });
  });
  it("abrir caso atribui o negócio sem tomar a conversa nem depender de push", async () => {
    caseId = await newCase();
    const row = (
      await pool.query(
        "select * from event_log where organization_id=$1 and event_type='ai.case_opened' and payload->>'case_id'=$2 order by created_at desc limit 1",
        [org, caseId],
      )
    ).rows[0] as EventRow;
    expect(row).toBeTruthy();
    expect(await casoParaAtendenteHandler.handle(row)).toMatchObject({
      status: "ok",
      detail: "atribuido",
    });
    const s = await state();
    owner = s.owner_user_id;
    expect([userA, userB]).toContain(owner);
    expect(s).toMatchObject({
      assignee_kind: "ai",
      assigned_to_user_id: null,
      force_human: false,
      bot_silenced_until: null,
    });
    expect(await conversasVisiveisDosCasos(h.session!, org)).toContain(conversation);
    expect(await conversasVisiveisDosCasos(client("authenticated", userB), org)).toContain(
      conversation,
    );
  });
  it("resposta interna resolve e enfileira continuidade, sem assumir o cliente", async () => {
    login(owner);
    const r = await responder(
      req("/case/reply", { action: "resolved", body: "Informação confirmada no exemplo" }),
      { params: Promise.resolve({ id: caseId }) },
    );
    expect(r.status, await r.text()).toBe(200);
    expect(
      (await pool.query("select status from agent_cases where id=$1", [caseId])).rows[0].status,
    ).toBe("resolved");
    expect(
      (
        await pool.query(
          "select count(*)::int as n from job_queue where organization_id=$1 and kind='case_reply_turn' and payload->>'case_id'=$2",
          [org, caseId],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(await state()).toMatchObject({
      owner_user_id: owner,
      assignee_kind: "ai",
      assigned_to_user_id: null,
      force_human: false,
    });
  });
  it("assumir cala a IA e mantém a dona comercial independente", async () => {
    secondCaseId = await newCase();
    login(userA);
    const r = await assumir(req("/conversation/claim"), {
      params: Promise.resolve({ id: conversation }),
    });
    expect(r.status, await r.text()).toBe(200);
    expect(await state()).toMatchObject({
      owner_user_id: owner,
      assigned_to_user_id: userA,
      assignee_kind: "user",
    });
    expect((await state()).bot_silenced_until).not.toBeNull();
    expect(await isLeadInHandoff(pool, org, contact)).toBe(true);
  });
  it("agent fora da conversa não vê a pendência; manager vê; outra empresa não vê", async () => {
    expect(await conversasVisiveisDosCasos(client("authenticated", userB), org)).not.toContain(
      conversation,
    );
    expect(await conversasVisiveisDosCasos(client("authenticated", manager), org)).toContain(
      conversation,
    );
    expect(await conversasVisiveisDosCasos(client("authenticated", outsider), org)).not.toContain(
      conversation,
    );
  });
  it("continuidade já enfileirada para antes do modelo quando a atendente assume", async () => {
    const logs: string[] = [];
    const saidaProibida = vi.fn(() => {
      throw new Error("Modelo ou envio proibido nesta prova");
    });
    const deps: InboundTurnDeps = {
      crmCfg: { supabase: h.admin! },
      llmCfg: {},
      knobs: {
        historyLimit: 20,
        maxContextTokens: 1000,
        notesIndexMaxTokens: 500,
        maxSteps: 6,
        queuedRetryDelayMs: 1000,
        breaker: {
          exactFailureWarn: 2,
          exactFailureBlock: 4,
          sameToolFailureWarn: 3,
          sameToolFailureHalt: 6,
          noProgressWarn: 2,
          noProgressBlock: 4,
        },
      },
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      channel: saidaProibida,
      embed: saidaProibida,
    };
    const job = (
      await pool.query(
        "select * from job_queue where organization_id=$1 and kind='case_reply_turn' and payload->>'case_id'=$2",
        [org, caseId],
      )
    ).rows[0];
    const before = await state();
    await createCaseReplyTurnHandler(deps)(job, pool, { workerId: "prova-local" });
    expect(logs).toContain("turno pulado — lead em handoff humano (bot silenciado)");
    expect(saidaProibida).not.toHaveBeenCalled();
    expect(await state()).toEqual(before);
  });
  it("viewer é recusado pelo requireRole real antes de responder", async () => {
    login(viewer, "viewer");
    const r = await responder(req("/case/reply", { action: "resolved", body: "Não deve gravar" }), {
      params: Promise.resolve({ id: secondCaseId }),
    });
    expect(r.status).toBe(403);
    expect(
      (await pool.query("select status from agent_cases where id=$1", [secondCaseId])).rows[0]
        .status,
    ).toBe("awaiting_human");
  });
  it("não permite responder por URL ao caso de uma conversa invisível ao agent", async () => {
    login(userB);
    const before = await effects(secondCaseId);
    const r = await responder(
      req("/case/reply", {
        action: "resolved",
        body: "Não deve alterar a conversa de outra atendente",
      }),
      { params: Promise.resolve({ id: secondCaseId }) },
    );
    expect(r.status, await r.text()).toBe(404);
    expect(await effects(secondCaseId)).toEqual(before);
  });
  it("outra empresa recebe 404 e não produz efeito", async () => {
    login(outsider, "agent", otherOrg);
    const before = await effects(secondCaseId);
    const r = await responder(
      req("/case/reply", { action: "resolved", body: "Não deve atravessar empresas" }),
      { params: Promise.resolve({ id: secondCaseId }) },
    );
    expect(r.status, await r.text()).toBe(404);
    expect(await effects(secondCaseId)).toEqual(before);
  });
  it("erro real ao consultar visibilidade recusa sem resolver ou enfileirar", async () => {
    login(userA);
    const before = await effects(secondCaseId);
    await pool.query("revoke select on public.conversations from authenticated");
    try {
      const r = await responder(
        req("/case/reply", { action: "resolved", body: "Não deve operar com leitura quebrada" }),
        { params: Promise.resolve({ id: secondCaseId }) },
      );
      expect(r.status, await r.text()).toBe(503);
      expect(await effects(secondCaseId)).toEqual(before);
    } finally {
      await pool.query("grant select on public.conversations to authenticated");
    }
  });
  it("manager responde mesmo sem ser a dona da conversa", async () => {
    login(manager, "manager");
    const r = await responder(
      req("/case/reply", { action: "resolved", body: "Resposta sintética da supervisão" }),
      { params: Promise.resolve({ id: secondCaseId }) },
    );
    expect(r.status, await r.text()).toBe(200);
    expect(await effects(secondCaseId)).toMatchObject({ status: "resolved", jobs: 1 });
    expect(await state()).toMatchObject({
      assigned_to_user_id: userA,
      assignee_kind: "user",
      owner_user_id: owner,
    });
  });
  it("devolver pela rota real solta as travas e preserva a dona da venda", async () => {
    login(userA);
    const r = await devolver(req("/conversation/reactivate"), {
      params: Promise.resolve({ id: conversation }),
    });
    expect(r.status, await r.text()).toBe(200);
    expect(await state()).toMatchObject({
      owner_user_id: owner,
      assigned_to_user_id: null,
      assignee_kind: "ai",
      force_human: false,
      bot_silenced_until: null,
    });
    expect(await isLeadInHandoff(pool, org, contact)).toBe(false);
    expect(
      (
        await pool.query(
          "select count(*)::int as n from event_log where organization_id=$1 and event_type='ai.handoff_resolved'",
          [org],
        )
      ).rows[0].n,
    ).toBeGreaterThan(0);
  });
});
