import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { encerrarOfertaC01 } from "@/lib/followup/c01-encerrar-oferta";
import {
  assinarOrigemC01,
  hashDoConteudoDaOrigem,
  type ConfigOrigemC01,
} from "@/lib/followup/c01-origem";
import type { LeitorFinanceiroC01 } from "@/lib/followup/c01-acompanhamento-fatos";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";

if (!process.env.TEST_DB_CONTAINER)
  throw new Error("Execute somente pelo banco descartável de pnpm test:db.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 6,
});
afterAll(() => pool.end());
const NOW = new Date("2026-10-24T15:00:00Z");
const financeiro: LeitorFinanceiroC01 = async ({ now }) => ({
  status: "nao_comprou_confirmado",
  complete: true,
  checkedAt: now.toISOString(),
});

async function fixture() {
  const org = randomUUID(),
    contact = randomUUID(),
    lead = randomUUID(),
    pipeline = randomUUID(),
    stage = randomUUID(),
    lost = randomUUID(),
    session = randomUUID(),
    conversation = randomUUID(),
    pointer = randomUUID(),
    version = randomUUID(),
    enrollment = randomUUID(),
    message = randomUUID();
  const cfg: ConfigOrigemC01 = {
    enabled: true,
    organizationId: org,
    tokenSha256: "a".repeat(64),
    signingKey: "b".repeat(32),
    allowedKinds: ["oferta"],
  };
  const nodes = [
    { id: "start", type: "trigger", config: {} },
    ...[1, 2, 3, 4].map((i) => ({
      id: `touch${i}`,
      type: "action",
      config: { mode: "text", body: "Mensagem fictícia" },
    })),
    { id: "close", type: "move_lead", config: { stage_id: lost, lost_reason: "no_response" } },
    { id: "end", type: "end", config: { outcome: "exhausted" } },
  ].map((n, i) => ({ ...n, label: n.id, position: { x: 0, y: i * 100 } }));
  const graph = {
    settings: {
      c01_acompanhamento: { version: 1, kind: "oferta", activated_at: "2026-10-01T11:00:00Z" },
    },
    nodes,
    edges: nodes.slice(0, -1).map((n, i) => ({
      id: `e${i}`,
      source: n.id,
      target: nodes[i + 1]!.id,
      condition: { type: "always" },
      priority: 0,
    })),
  };
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Teste de encerramento','Teste de encerramento')",
    [org, `loss-${org}`],
  );
  await pool.query(
    "insert into contacts(id,organization_id,display_name,phone_number) values($1,$2,'Pessoa fictícia','+5511999990001')",
    [contact, org],
  );
  await pool.query(
    "insert into crm_pipelines(id,organization_id,name,slug,settings) values($1,$2,'Funil fictício','ficticio','{}')",
    [pipeline, org],
  );
  await pool.query(
    "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position,is_lost) values($1,$2,$3,'Aberto','aberto',1000,false),($4,$2,$3,'Perdido','perdido',2000,true)",
    [stage, org, pipeline, lost],
  );
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,custom_fields) values($1,$2,$3,$4,$5,'Negociação fictícia',$6)",
    [lead, org, pipeline, stage, contact, { produto_chave: "produto-teste" }],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,status) values($1,$2,$3,'\\x00','STOPPED')",
    [session, org, `teste-${session}`],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status,assignee_kind,last_inbound_at) values($1,$2,$3,$4,'ai_handling','ai','2026-10-10T12:00:00Z')",
    [conversation, org, contact, session],
  );
  const boundary = (
    await pool.query("select fn_service_boundary($1,$2) as value", [org, conversation])
  ).rows[0].value;
  await pool.query(
    "insert into followup_flow_versions(id,organization_id,graph) values($1,$2,$3)",
    [version, org, graph],
  );
  await pool.query(
    "insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,'Cadência fictícia','active',$3)",
    [pointer, org, version],
  );
  await pool.query(
    "insert into followup_enrollments(id,organization_id,pointer_id,version_id,contact_id,conversation_id,current_node_id,status,next_eval_at,service_boundary) values($1,$2,$3,$4,$5,$6,'close','active',$7,$8)",
    [enrollment, org, pointer, version, contact, conversation, NOW, boundary],
  );
  async function msg(id: string, at: Date) {
    return (
      await pool.query(
        `insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status,external_id,sent_at,delivered_at)
      values($1,$2,$3,$4,$5,'outbound','text','Oferta fictícia','delivered',$6,$7,$7) returning *`,
        [id, org, contact, conversation, session, `fake-${id}`, at],
      )
    ).rows[0];
  }
  const anchorAt = new Date("2026-10-10T13:00:00Z");
  const anchor = await msg(message, anchorAt);
  const proof = assinarOrigemC01(cfg, {
    kind: "oferta",
    organizationId: org,
    contactId: contact,
    leadId: lead,
    conversationId: conversation,
    productKey: "produto-teste",
    messageId: message,
    createdAt: anchorAt.toISOString(),
    contentHash: hashDoConteudoDaOrigem(anchor),
  });
  await pool.query(
    "insert into followup_enrollment_events(organization_id,enrollment_id,event_type,payload,idempotency_key) values($1,$2,'c01_origem_entregue',$3,'origin')",
    [org, enrollment, proof],
  );
  const touches: string[] = [];
  for (const i of [1, 2, 3, 4]) {
    const id = randomUUID(),
      job = randomUUID();
    touches.push(id);
    const at = new Date(+NOW - (48 + (4 - i) * 24) * 3600000);
    await msg(id, at);
    await pool.query(
      "insert into job_queue(id,organization_id,contact_id,kind,status,payload) values($1,$2,$3,'followup_turn','done',$4)",
      [job, org, contact, { followup_enrollment_id: enrollment, node_id: `touch${i}` }],
    );
    await pool.query(
      "insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,0,$4,'accepted',$5)",
      [org, contact, job, "a".repeat(64), id],
    );
    await pool.query(
      "insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,payload,idempotency_key,created_at) values($1,$2,$3,'action_sent','{}',$4,$5)",
      [org, enrollment, `touch${i}`, `touch${i}:1`, at],
    );
  }
  const row = async () =>
    (
      await pool.query<EnrollmentRow>("select * from followup_enrollments where id=$1", [
        enrollment,
      ])
    ).rows[0]!;
  const run = async (reader = financeiro, now = NOW) =>
    encerrarOfertaC01(await row(), now, { pool, config: cfg, financeiro: reader });
  const state = async () => ({
    lead: (
      await pool.query("select status,stage_id,lost_reason from crm_leads where id=$1", [lead])
    ).rows[0],
    enrollment: await row(),
    events: (
      await pool.query(
        "select event_type from followup_enrollment_events where enrollment_id=$1 and event_type='c01_oferta_encerrada'",
        [enrollment],
      )
    ).rows,
    activities: (
      await pool.query(
        "select type from crm_lead_activities where lead_id=$1 and source_module='followup'",
        [lead],
      )
    ).rows,
  });
  return {
    org,
    contact,
    lead,
    pipeline,
    stage,
    lost,
    conversation,
    pointer,
    version,
    enrollment,
    cfg,
    graph,
    message,
    touches,
    row,
    run,
    state,
  };
}

describe("perda C01 atômica, no banco oficial descartável", () => {
  it("fecha o negócio da origem após quatro entregas + 48 h; preserva outro já encerrado mais recente e não duplica no replay", async () => {
    const f = await fixture(),
      other = randomUUID();
    await pool.query(
      "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,lost_reason) values($1,$2,$3,$4,$5,'Outra oportunidade fictícia','other')",
      [other, f.org, f.pipeline, f.lost, f.contact],
    );
    const seen: string[] = [];
    expect(
      await f.run(async (input) => {
        seen.push(input.leadId);
        return financeiro(input);
      }),
    ).toEqual({ kind: "closed" });
    expect(seen).toEqual([f.lead]);
    expect(
      (await pool.query("select status from crm_leads where id=$1", [other])).rows[0].status,
    ).toBe("lost");
    expect(await f.run()).toEqual({ kind: "replay" });
    const s = await f.state();
    expect(s.lead).toMatchObject({ status: "lost", stage_id: f.lost, lost_reason: "no_response" });
    expect(s.enrollment).toMatchObject({ status: "completed", outcome: "exhausted" });
    expect(s.events).toHaveLength(1);
    expect(s.activities).toHaveLength(1);
  });
  it("47 h 59 m 59 s adia e mantém o negócio aberto", async () => {
    const f = await fixture();
    expect(await f.run(financeiro, new Date(+NOW - 1000))).toEqual({ kind: "held" });
    const s = await f.state();
    expect(s.lead.status).toBe("open");
    expect(s.enrollment.current_node_id).toBe("close");
    expect(s.events).toHaveLength(0);
  });
  it.each(["sent", "failed", "missing", "blocked", "duplicate"])(
    "recibo %s não permite perda",
    async (mode) => {
      const f = await fixture();
      if (mode === "missing")
        await pool.query("delete from send_ledger where crm_message_id=$1", [f.touches[3]]);
      else if (mode === "duplicate")
        await pool.query("update send_ledger set crm_message_id=$1 where crm_message_id=$2", [
          f.touches[0],
          f.touches[3],
        ]);
      else
        await pool.query(
          "update messages set status=$2,delivered_at=$3,error_code=$4 where id=$1",
          [
            f.touches[3],
            mode === "sent" ? "sent" : "failed",
            mode === "sent" ? null : NOW,
            mode === "blocked" ? "131049" : mode === "failed" ? "999" : null,
          ],
        );
      expect(await f.run()).toEqual({ kind: "held" });
      expect((await f.state()).lead.status).toBe("open");
    },
  );
  it.each(["confirmado", "revisao", "indisponivel", "incompleto", "velho"])(
    "financeiro %s mantém card aberto",
    async (status) => {
      const f = await fixture();
      expect(
        await f.run(async () => ({
          status:
            status === "confirmado"
              ? "confirmado"
              : status === "revisao"
                ? "revisao"
                : status === "indisponivel"
                  ? "indisponivel"
                  : "nao_comprou_confirmado",
          complete: status !== "incompleto",
          checkedAt: new Date(+NOW - (status === "velho" ? 16 * 60000 : 0)).toISOString(),
        })),
      ).toEqual({ kind: "held" });
      expect((await f.state()).lead.status).toBe("open");
    },
  );
  it.each(["reply", "human", "optout", "callback", "product"])(
    "%s depois da seleção impede perda",
    async (change) => {
      const f = await fixture(),
        selected = await f.row();
      if (change === "reply")
        await pool.query("update conversations set last_inbound_at=$2 where id=$1", [
          f.conversation,
          NOW,
        ]);
      if (change === "human")
        await pool.query("update contacts set force_human=true where id=$1", [f.contact]);
      if (change === "optout")
        await pool.query("update contacts set ai_opt_out=true where id=$1", [f.contact]);
      if (change === "callback")
        await pool.query(
          "insert into cron_jobs(organization_id,contact_id,kind,job_kind,next_run_at,payload) values($1,$2,'at','followup_turn',$3,'{}')",
          [f.org, f.contact, NOW],
        );
      if (change === "product")
        await pool.query("update crm_leads set custom_fields='{}' where id=$1", [f.lead]);
      expect(await encerrarOfertaC01(selected, NOW, { pool, config: f.cfg, financeiro })).toEqual({
        kind: "held",
      });
      expect((await f.state()).lead.status).toBe("open");
    },
  );
  it("OFF não consulta financeiro nem altera estado", async () => {
    const f = await fixture();
    f.cfg.enabled = false;
    const before = await f.state();
    await f.run(async () => {
      throw new Error("não deve consultar");
    });
    expect(await f.state()).toEqual(before);
  });
  it("erro de leitura conserva tentativa e não grava sucesso", async () => {
    const f = await fixture(),
      before = await f.state();
    await expect(
      f.run(async () => {
        throw new Error("leitura falhou");
      }),
    ).rejects.toThrow("leitura falhou");
    expect(await f.state()).toEqual(before);
  });
});

it.each(["reply", "human"])(
  "corrida %s: alteração ganha a trava de atendimento antes da perda",
  async (change) => {
    const f = await fixture(),
      selected = await f.row(),
      writer = await pool.connect();
    try {
      await writer.query("begin");
      await writer.query("select fn_service_lock($1,$2)", [f.org, f.contact]);
      const close = encerrarOfertaC01(selected, NOW, { pool, config: f.cfg, financeiro });
      if (change === "reply")
        await writer.query("update conversations set last_inbound_at=$2 where id=$1", [
          f.conversation,
          NOW,
        ]);
      else await writer.query("update contacts set force_human=true where id=$1", [f.contact]);
      await writer.query("commit");
      expect(await close).toEqual({ kind: "held" });
      expect((await f.state()).lead.status).toBe("open");
    } finally {
      await writer.query("rollback");
      writer.release();
    }
  },
);

it.each(["purchase", "callback"])(
  "corrida %s: a trava compartilhada impede o encerramento",
  async (change) => {
    const f = await fixture(),
      selected = await f.row(),
      writer = await pool.connect();
    const key = `callback:${f.org}:${f.contact}`;
    try {
      await writer.query("select pg_advisory_lock(hashtextextended($1,0))", [key]);
      expect(await encerrarOfertaC01(selected, NOW, { pool, config: f.cfg, financeiro })).toEqual({
        kind: "held",
      });
      if (change === "callback")
        await writer.query(
          "insert into cron_jobs(organization_id,contact_id,kind,job_kind,next_run_at,payload) values($1,$2,'at','followup_turn',$3,'{}')",
          [f.org, f.contact, NOW],
        );
      await writer.query("select pg_advisory_unlock(hashtextextended($1,0))", [key]);
      expect(
        await f.run(
          change === "purchase"
            ? async ({ now }) => ({
                status: "confirmado",
                complete: true,
                checkedAt: now.toISOString(),
              })
            : financeiro,
        ),
      ).toEqual({ kind: "held" });
      expect((await f.state()).lead.status).toBe("open");
    } finally {
      await writer.query("select pg_advisory_unlock(hashtextextended($1,0))", [key]);
      writer.release();
    }
  },
);

it("dois encerramentos concorrentes produzem uma única perda", async () => {
  const f = await fixture(),
    selected = await f.row();
  const results = await Promise.all(
    [1, 2].map(() => encerrarOfertaC01(selected, NOW, { pool, config: f.cfg, financeiro })),
  );
  expect(results.filter((r) => r.kind === "closed")).toHaveLength(1);
  expect((await f.state()).events).toHaveLength(1);
  expect((await f.state()).activities).toHaveLength(1);
});

it.each(["before_commit", "after_commit"])(
  "queda %s tem recuperação sem falso sucesso ou duplicidade",
  async (point) => {
    const f = await fixture(),
      selected = await f.row();
    const faultPool = new pg.Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
      max: 1,
    });
    let armed = true;
    faultPool.on("connect", (client) => {
      client.query = new Proxy(client.query, {
        apply(target, receiver, args) {
          const sql = String(args[0]);
          if (armed && point === "before_commit" && sql.includes("fn_followup_apply_step")) {
            armed = false;
            return Promise.reject(new Error("queda antes do commit"));
          }
          const result = Reflect.apply(target, receiver, args);
          if (armed && point === "after_commit" && sql === "commit") {
            armed = false;
            return result.then(() => {
              throw new Error("commit aplicado, resposta perdida");
            });
          }
          return result;
        },
      });
    });
    try {
      await expect(
        encerrarOfertaC01(selected, NOW, { pool: faultPool, config: f.cfg, financeiro }),
      ).rejects.toThrow(point === "before_commit" ? "queda antes" : "resposta perdida");
      const s = await f.state();
      expect(s.lead.status).toBe(point === "before_commit" ? "open" : "lost");
      expect(s.enrollment.current_node_id).toBe(point === "before_commit" ? "close" : "end");
      expect(s.events).toHaveLength(point === "before_commit" ? 0 : 1);
      expect(await encerrarOfertaC01(selected, NOW, { pool, config: f.cfg, financeiro })).toEqual({
        kind: point === "before_commit" ? "closed" : "replay",
      });
      expect((await f.state()).events).toHaveLength(1);
      expect((await f.state()).activities).toHaveLength(1);
    } finally {
      await faultPool.end();
    }
  },
);

it("recibo aceito de outra conversa não serve como entrega desta origem", async () => {
  const f = await fixture();
  const session = randomUUID(),
    conversation = randomUUID();
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,status) values($1,$2,$3,'\\x00','STOPPED')",
    [session, f.org, `outra-${session}`],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversation, f.org, f.contact, session],
  );
  await pool.query("update messages set conversation_id=$2,channel_session_id=$3 where id=$1", [
    f.touches[3],
    conversation,
    session,
  ]);
  expect(await f.run()).toEqual({ kind: "held" });
  expect((await f.state()).lead.status).toBe("open");
});

it("ledger com falha prevalece mesmo se a mensagem tem entrega antiga", async () => {
  const f = await fixture();
  await pool.query("update send_ledger set status='failed' where crm_message_id=$1", [
    f.touches[3],
  ]);
  expect(await f.run()).toEqual({ kind: "held" });
  expect((await f.state()).lead.status).toBe("open");
});

it.each(["won", "lost"])("não sobrescreve negócio já %s", async (status) => {
  const f = await fixture(),
    destination = status === "lost" ? f.lost : randomUUID();
  if (status === "won")
    await pool.query(
      "insert into crm_stages(id,organization_id,pipeline_id,name,slug,position,is_won) values($1,$2,$3,'Ganho','ganho',3000,true)",
      [destination, f.org, f.pipeline],
    );
  await pool.query("update crm_leads set stage_id=$2,lost_reason=$3 where id=$1", [
    f.lead,
    destination,
    status === "lost" ? "other" : null,
  ]);
  const before = (await f.state()).lead;
  expect(await f.run()).toEqual({ kind: "held" });
  expect((await f.state()).lead).toEqual(before);
  expect((await f.state()).events).toHaveLength(0);
});

it("origem com assinatura inválida não consulta finanças nem fecha", async () => {
  const f = await fixture();
  await pool.query(
    "update followup_enrollment_events set payload=jsonb_set(payload,'{signature}',to_jsonb(repeat('0',64))) where enrollment_id=$1 and event_type='c01_origem_entregue'",
    [f.enrollment],
  );
  expect(
    await f.run(async () => {
      throw new Error("não consultar origem inválida");
    }),
  ).toEqual({ kind: "held" });
  expect((await f.state()).lead.status).toBe("open");
});

it("outra organização não alcança a inscrição", async () => {
  const f = await fixture(),
    other = await fixture();
  await expect(
    encerrarOfertaC01({ ...(await f.row()), organization_id: other.org }, NOW, {
      pool,
      config: other.cfg,
      financeiro,
    }),
  ).rejects.toThrow("c01_inscricao_indisponivel");
  expect((await f.state()).lead.status).toBe("open");
});

it("conjunto ambíguo antes da perda mantém aberto sem consultar financeiro", async () => {
  const f = await fixture(),
    other = randomUUID(),
    writer = await pool.connect();
  try {
    await writer.query("begin");
    await writer.query(
      "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,$5,'Outra aberta fictícia')",
      [other, f.org, f.pipeline, f.stage, f.contact],
    );
    let reads = 0;
    const close = f.run(async (input) => {
      reads++;
      return financeiro(input);
    });
    await writer.query("commit");
    expect(await close).toEqual({ kind: "held" });
    expect(reads).toBe(0);
    expect((await f.state()).lead.status).toBe("open");
  } finally {
    await writer.query("rollback");
    writer.release();
  }
});
it("inserção de oportunidade aguarda a proteção do contato até o commit", async () => {
  const f = await fixture(),
    other = randomUUID(),
    writer = await pool.connect();
  const insert =
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,$5,'Nova fictícia')";
  const params = [other, f.org, f.pipeline, f.stage, f.contact];
  try {
    await writer.query("set statement_timeout='250ms'");
    expect(
      await f.run(async (input) => {
        await expect(writer.query(insert, params)).rejects.toMatchObject({ code: "57014" });
        return financeiro(input);
      }),
    ).toEqual({ kind: "closed" });
    await writer.query(insert, params);
    expect(
      (await writer.query("select status from crm_leads where id=$1", [other])).rows[0].status,
    ).toBe("open");
  } finally {
    writer.release();
  }
});
it("conjunto protege também a reabertura de outra oportunidade encerrada", async () => {
  const f = await fixture(),
    other = randomUUID(),
    writer = await pool.connect();
  await pool.query(
    "insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,lost_reason) values($1,$2,$3,$4,$5,'Encerrada fictícia','other')",
    [other, f.org, f.pipeline, f.lost, f.contact],
  );
  try {
    await writer.query("set statement_timeout='250ms'");
    expect(
      await f.run(async (input) => {
        await expect(
          writer.query("update crm_leads set stage_id=$2,lost_reason=null where id=$1", [
            other,
            f.stage,
          ]),
        ).rejects.toMatchObject({ code: "57014" });
        return financeiro(input);
      }),
    ).toEqual({ kind: "closed" });
    expect(
      (await pool.query("select status from crm_leads where id=$1", [other])).rows[0].status,
    ).toBe("lost");
  } finally {
    writer.release();
  }
});
