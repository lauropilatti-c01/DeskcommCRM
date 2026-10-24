import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, expect, it } from "vitest";
import { registrarOrigemEntregueC01 } from "@/lib/followup/c01-acompanhamento-origens";
import { assertCurrentServiceBoundary, parseServiceBoundary } from "@/lib/atendimento/fronteira";

if (!process.env.TEST_DB_CONTAINER || !process.env.TEST_DB_TEMPLATE)
  throw new Error("Esta prova exige o banco descartável do harness oficial.");

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
});
afterAll(() => pool.end());
async function fixture(demanda: boolean) {
  const [
    org,
    contact,
    conversation,
    lead,
    pipeline,
    stage,
    session,
    message,
    pointer,
    version,
    agent,
    av,
  ] = Array.from({ length: 12 }, () => randomUUID());
  const at = new Date("2026-10-24T12:00:00Z");
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Fictício','Fictício')",
    [org, org],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name,phone_number) values($1,$2,'Pessoa fictícia','+5511999990001')",
    [contact, org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,status) values($1,$2,$3,'\\x00','STOPPED')",
    [session, org, session],
  );
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug) values($1,$2,'Fictício','ficticio')",
    [pipeline, org],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position) values($1,$2,$3,'Aberto','aberto',1000)",
    [stage, org, pipeline],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,custom_fields) values($1,$2,$3,$4,$5,'Fictício','{\"produto_chave\":\"produto-ficticio\"}')",
    [lead, org, pipeline, stage, contact],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status,assignee_kind,last_inbound_at) values($1,$2,$3,$4,'ai_handling','ai',$5)",
    [conversation, org, contact, session, new Date(+at - 60000)],
  );
  if (demanda)
    await pool.query(
      "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,sent_at) values($1,$2,$3,$4,$5,'inbound','text','Informação fictícia','received',$6)",
      [randomUUID(), org, contact, conversation, session, new Date(+at - 60000)],
    );
  await pool.query(
    "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,external_id,sent_at,delivered_at) values($1,$2,$3,$4,$5,'outbound','text','Material fictício','delivered',$6,$7,$7)",
    [message, org, contact, conversation, session, randomUUID(), at],
  );
  const graph = {
    settings: {
      c01_acompanhamento: { version: 1, kind: "oferta", activated_at: "2026-10-23T12:00:00Z" },
    },
    nodes: [
      { id: "start", type: "trigger", label: "Entrada", position: { x: 0, y: 0 }, config: {} },
      {
        id: "end",
        type: "end",
        label: "Fim",
        position: { x: 0, y: 100 },
        config: { outcome: "custom" },
      },
    ],
    edges: [{ id: "e", source: "start", target: "end", condition: { type: "always" } }],
  };
  await pool.query(
    "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
    [version, org, graph],
  );
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,'Fictício','active',$3)",
    [pointer, org, version],
  );
  await pool.query(
    "insert into ai_agents(id,organization_id,name,system_prompt,operation_mode) values($1,$2,'Fictício','Fictício','automatic')",
    [agent, org],
  );
  await pool.query(
    "insert into ai_agent_versions(id,organization_id,agent_id,version_number,system_prompt,provider,model,status,followup) values($1,$2,$3,1,'Fictício','anthropic','ficticio','published',$4)",
    [av, org, agent, { enabled: true, flow_pointer_ids: [pointer] }],
  );
  await pool.query("update ai_agents set published_version_id=$1 where id=$2", [av, agent]);
  const cfg = {
    enabled: true,
    organizationId: org!,
    tokenSha256: "a".repeat(64),
    signingKey: "b".repeat(40),
    allowedKinds: ["oferta" as const],
  };
  const input = {
    kind: "oferta" as const,
    leadId: lead!,
    productKey: "produto-ficticio",
    messageId: message!,
  };
  return { org, contact, conversation, session, at, cfg, input };
}
async function current(f: Awaited<ReturnType<typeof fixture>>) {
  return (await pool.query("select fn_service_boundary($1,$2) b", [f.org, f.conversation])).rows[0]
    .b;
}
for (const demanda of [false, true])
  it(`fronteira canônica conserva bigint com demanda ${demanda ? "presente" : "ausente"}`, async () => {
    const f = await fixture(demanda);
    const raw = (
      await pool.query("select service_revision from conversations where id=$1", [f.conversation])
    ).rows[0];
    expect(typeof raw.service_revision).toBe("string");
    const result = await registrarOrigemEntregueC01(pool, f.cfg, f.input, f.at);
    const boundary = (
      await pool.query("select service_boundary from followup_enrollments where id=$1", [
        result.enrollment_id,
      ])
    ).rows[0].service_boundary;
    expect(parseServiceBoundary(boundary)).not.toBeNull();
    expect(typeof boundary.service_revision).toBe("number");
    expect(boundary.demanda_id === null).toBe(!demanda);
    const live = await current(f);
    expect(() => assertCurrentServiceBoundary(boundary, live)).not.toThrow();
    expect((await registrarOrigemEntregueC01(pool, f.cfg, f.input, f.at)).status).toBe("replay");
    await pool.query("update conversations set service_revision=service_revision+1 where id=$1", [
      f.conversation,
    ]);
    const replaced = await current(f);
    expect(() => assertCurrentServiceBoundary(boundary, replaced)).toThrow(
      "service_boundary_stale",
    );
  });
it("revisão fora da faixa segura não cria inscrição", async () => {
  const f = await fixture(false);
  await pool.query("update conversations set service_revision=9007199254740992 where id=$1", [
    f.conversation,
  ]);
  await expect(registrarOrigemEntregueC01(pool, f.cfg, f.input, f.at)).rejects.toThrow(
    "service_boundary_invalid",
  );
  expect(
    (await pool.query("select id from followup_enrollments where organization_id=$1", [f.org]))
      .rows,
  ).toHaveLength(0);
});
it("demanda encerrada e conversa encerrada conservam veto", async () => {
  const f = await fixture(true);
  const result = await registrarOrigemEntregueC01(pool, f.cfg, f.input, f.at);
  const boundary = (
    await pool.query("select service_boundary from followup_enrollments where id=$1", [
      result.enrollment_id,
    ])
  ).rows[0].service_boundary;
  await pool.query("select public.fn_demanda_encerrar($1,$2,$3,'resolvida',null)", [
    f.org,
    boundary.demanda_id,
    boundary.demanda_revision,
  ]);
  const closed = await current(f);
  expect(() => assertCurrentServiceBoundary(boundary, closed)).toThrow("service_boundary_stale");
  await pool.query(
    "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,sent_at) values($1,$2,$3,$4,$5,'inbound','text','Outra demanda fictícia','received',now())",
    [randomUUID(), f.org, f.contact, f.conversation, f.session],
  );
  const changed = await current(f);
  expect(changed.demanda_id).not.toBe(boundary.demanda_id);
  expect(() => assertCurrentServiceBoundary(boundary, changed)).toThrow("service_boundary_stale");
  const other = await fixture(false);
  await pool.query("update conversations set status='closed' where id=$1", [other.conversation]);
  await expect(registrarOrigemEntregueC01(pool, other.cfg, other.input, other.at)).rejects.toThrow(
    "contact_restricted",
  );
});
