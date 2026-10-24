import { randomUUID } from "node:crypto";
import pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";
import {
  registrarDespachoPorMensagem,
  type OrigemDoDespacho,
} from "@/lib/channels/despacho-por-mensagem";
import { enqueueJob } from "@/lib/agent-engine/queue/queue";

if (!process.env.TEST_DB_CONTAINER || !process.env.TEST_DB_PORT)
  throw new Error("Use pnpm test:db: somente banco descartável local.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 12,
});
afterAll(() => pool.end());
const TIPO = "ai_agent.dispatch_requested";
function identifier(s: string) {
  if (!/^[a-z_]+$/.test(s)) throw new Error("Identificador fora do teste");
  return '"' + s + '"';
}
function admin(options: { perderResposta?: boolean; serviceRole?: Set<string> } = {}): SupabaseClient {
  let perder = Boolean(options.perderResposta);
  async function query(sql: string, values: unknown[]) {
    if (!options.serviceRole) return pool.query(sql, values);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role service_role");
      options.serviceRole.add((await client.query("select current_user as role")).rows[0].role);
      const result = await client.query(sql, values);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    from(table: string) {
      if (!["messages", "event_log"].includes(table)) throw new Error("Tabela fora do contrato");
      const filtros: [string, unknown][] = [];
      let cols = "id",
        row: Record<string, unknown> | undefined,
        limite: number | undefined;
      const q = {
        select: (s: string) => {
          cols = s;
          return q;
        },
        eq: (k: string, v: unknown) => {
          filtros.push([k, v]);
          return q;
        },
        limit: (n: number) => {
          limite = n;
          return q;
        },
        insert: (r: Record<string, unknown>) => {
          row = r;
          return q;
        },
        async run() {
          try {
            const fields = cols
              .split(",")
              .map((s) => identifier(s.trim()))
              .join(",");
            let result: pg.QueryResult;
            if (row) {
              const keys = Object.keys(row);
              result = await query(
                `insert into public.${identifier(table)}(${keys.map(identifier).join(",")}) values(${keys.map((_, i) => "$" + (i + 1)).join(",")}) returning ${fields}`,
                Object.values(row),
              );
              if (perder) {
                perder = false;
                return {
                  data: null,
                  error: { code: "08006", message: "resposta perdida depois do commit (seam)" },
                };
              }
            } else {
              const args = filtros.map(([, v]) => v);
              const where = filtros.map(([k], i) => `${identifier(k)}=$${i + 1}`).join(" and ");
              const limit = limite === undefined ? "" : ` limit $${args.push(limite)}`;
              result = await query(
                `select ${fields} from public.${identifier(table)} where ${where}${limit}`,
                args,
              );
            }
            return { data: result.rows, error: null };
          } catch (error) {
            return { data: null, error };
          }
        },
        async maybeSingle() {
          const r = await q.run();
          return { ...r, data: r.data?.length === 1 ? r.data[0] : null };
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return q.run().then(resolve, reject);
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}
async function fixture(): Promise<OrigemDoDespacho> {
  const e = {
    organizationId: randomUUID(),
    contactId: randomUUID(),
    conversationId: randomUUID(),
    channelSessionId: randomUUID(),
    messageId: randomUUID(),
    origem: "teste-descartavel",
  };
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Despacho fictício','Despacho fictício')",
    [e.organizationId, "dsp-" + e.organizationId],
  );
  await pool.query(
    "insert into contacts(id,organization_id,phone_number,display_name) values($1,$2,'+5511999990001','Pessoa fictícia')",
    [e.contactId, e.organizationId],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00')",
    [e.channelSessionId, e.organizationId, "dsp-" + e.channelSessionId],
  );
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id) values($1,$2,$3,$4)",
    [e.conversationId, e.organizationId, e.contactId, e.channelSessionId],
  );
  await pool.query(
    "insert into messages(id,organization_id,contact_id,conversation_id,channel_session_id,direction,type,body,status) values($1,$2,$3,$4,$5,'inbound','text','Somente fixture','delivered')",
    [e.messageId, e.organizationId, e.contactId, e.conversationId, e.channelSessionId],
  );
  return e;
}
const payload = (e: OrigemDoDespacho) => ({
  organization_id: e.organizationId,
  contact_id: e.contactId,
  conversation_id: e.conversationId,
  channel_session_id: e.channelSessionId,
  inbound_message_id: e.messageId,
});
async function events(e: OrigemDoDespacho) {
  return (
    await pool.query(
      "select id,payload from event_log where organization_id=$1 and event_type=$2 and entity_id=$3",
      [e.organizationId, TIPO, e.messageId],
    )
  ).rows;
}
async function queue(e: OrigemDoDespacho, id: string) {
  return enqueueJob(pool, e.organizationId, {
    kind: "inbound_turn",
    leadId: e.contactId,
    sourceEventId: id,
    payload: payload(e),
  });
}

describe("origem estável de despacho no banco canônico", () => {
  it("service_role real lê os vínculos e grava/reutiliza a origem", async () => {
    const e = await fixture();
    const roles = new Set<string>();
    const client = admin({ serviceRole: roles });
    const id = await registrarDespachoPorMensagem(client, e);
    expect(await registrarDespachoPorMensagem(client, e)).toBe(id);
    expect([...roles]).toEqual(["service_role"]);
    expect(await events(e)).toHaveLength(1);
    const first = await queue(e, id);
    expect((await queue(e, id)).job.id).toBe(first.job.id);
  });
  it("outbox da entrada já existe no commit da mensagem", async () => {
    const e = await fixture();
    const r = await pool.query(
      "select count(*)::int as n from event_log where organization_id=$1 and event_type='message.received' and payload->>'message_id'=$2",
      [e.organizationId, e.messageId],
    );
    expect(r.rows[0].n).toBe(1);
  });
  it("oito pedidos concorrentes produzem um evento e um job real", async () => {
    const e = await fixture();
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => registrarDespachoPorMensagem(admin(), e)),
    );
    expect(new Set(ids).size).toBe(1);
    expect(await events(e)).toHaveLength(1);
    const jobs = await Promise.all(ids.map((id) => queue(e, id)));
    expect(new Set(jobs.map((j) => j.job.id)).size).toBe(1);
    expect(jobs.filter((j) => !j.deduped)).toHaveLength(1);
  });
  it("commit com resposta perdida é relido e conserva o job", async () => {
    const e = await fixture();
    await expect(registrarDespachoPorMensagem(admin({ perderResposta: true }), e)).rejects.toThrow(
      "persistência não confirmada",
    );
    expect(await events(e)).toHaveLength(1);
    const id = await registrarDespachoPorMensagem(admin(), e);
    const first = await queue(e, id),
      second = await queue(e, id);
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
  });
  it("preserva evento legado e seu job", async () => {
    const e = await fixture();
    const r = await pool.query("select emit_event($1,'message',$2,$3,'{}',$4) as id", [
      TIPO,
      e.messageId,
      payload(e),
      e.organizationId,
    ]);
    const id = r.rows[0].id;
    const job = await queue(e, id);
    expect(await registrarDespachoPorMensagem(admin(), e)).toBe(id);
    expect((await queue(e, id)).job.id).toBe(job.job.id);
    expect(await events(e)).toHaveLength(1);
  });
  it("conflito de ID com outro tenant não confirma a origem", async () => {
    const e = await fixture(),
      other = await fixture();
    const id = await registrarDespachoPorMensagem(admin(), e);
    await pool.query("update event_log set organization_id=$1 where id=$2", [
      other.organizationId,
      id,
    ]);
    await expect(registrarDespachoPorMensagem(admin(), e)).rejects.toThrow("conflito sem prova");
    expect(await events(e)).toHaveLength(0);
  });
  it("recibo legado com vínculo divergente bloqueia novo pedido", async () => {
    const e = await fixture();
    await pool.query("select emit_event($1,'message',$2,$3,'{}',$4)", [
      TIPO,
      e.messageId,
      { ...payload(e), contact_id: randomUUID() },
      e.organizationId,
    ]);
    await expect(registrarDespachoPorMensagem(admin(), e)).rejects.toThrow(
      "origem anterior ambígua",
    );
    expect(await events(e)).toHaveLength(1);
  });
});
