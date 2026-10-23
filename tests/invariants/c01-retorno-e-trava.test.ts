import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { withServiceBoundary } from "@/lib/atendimento/fronteira-server";
import { agendaRetorno } from "@/lib/followup/retorno";
import { criaRetornoDbPg } from "@/lib/followup/retorno-pg";
import { comTravaDaDistribuicao } from "@/lib/escalacao/trava-da-distribuicao";

// Cluster de teste local ou o Postgres efêmero do portão. Nunca URL de produção.
const port = Number(process.env.TEST_DB_PORT ?? 54329);
const user = process.env.C01_TEST_DB_USER ?? "postgres";
const schema = `retorno_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ host: "127.0.0.1", port, user, password: "postgres", database: "postgres", max: 1 });
const pool = new pg.Pool({ host: "127.0.0.1", port, user, password: "postgres", database: "postgres", max: 5, options: `-c search_path=${schema}` });
const ORG = "00000000-0000-4000-8000-000000000001";
const CONTATO = "00000000-0000-4000-8000-000000000002";
const db = criaRetornoDbPg(pool);
const novo = { quando: new Date("2026-10-25T13:00:00Z"), payload: { reason: "novo horário pedido", promise: "retorno às 10h", promised_at: "2026-10-25T13:00:00Z" } };

beforeAll(async () => {
  await admin.query(`create schema ${schema}`);
  await pool.query(`create table cron_jobs (
    id uuid primary key default gen_random_uuid(), organization_id uuid not null, contact_id uuid not null,
    kind text not null, job_kind text not null, payload jsonb, next_run_at timestamptz not null,
    enabled boolean not null default true, cancelled_at timestamptz, cancel_reason text,
    last_error text, attempts integer default 0, updated_at timestamptz default now()
  )`);
});
beforeEach(async () => { await pool.query("truncate cron_jobs"); });
afterAll(async () => { await pool.end(); await admin.query(`drop schema ${schema} cascade`); await admin.end(); });
async function original() {
  return db.insere(ORG, { contactId: CONTATO, quando: new Date("2026-10-24T14:00:00Z"), payload: { reason: "original", promise: "retorno às 11h", promised_at: "2026-10-24T14:00:00Z" } });
}

describe("SQL real: retorno e distribuição", () => {
  it("duas primeiras criações simultâneas compartilham a trava e deixam um só retorno", async () => {
    const cfg = { agora: new Date("2026-10-22T20:00:00Z"), janela: { minAheadMs: 0, maxAheadMs: 30 * 86_400_000, staggerWindowMs: 0 } };
    const input = { motivo: "retorno pedido", promessa: "amanhã", prometidoPara: "2026-10-24T14:00:00Z" };
    const rs = await Promise.all(Array.from({ length: 8 }, () => agendaRetorno(db, cfg, { orgId: ORG, contactId: CONTATO }, input)));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect((await pool.query("select count(*)::int n from cron_jobs where enabled")).rows[0].n).toBe(1);
  });
  it("pool com uma conexão agenda dentro da fronteira sem esperar a própria conexão", async () => {
    await pool.query(`create table conversations (organization_id uuid, contact_id uuid, id uuid,
      service_revision integer, current_demanda_id uuid, status text)`);
    await pool.query(`create table demandas (organization_id uuid, contact_id uuid, id uuid,
      revision integer, fechada_em timestamptz)`);
    const conversa = "00000000-0000-4000-8000-000000000003";
    await pool.query("insert into conversations values ($1,$2,$3,1,null,'open')", [ORG, CONTATO, conversa]);
    const unica = new pg.Pool({ host: "127.0.0.1", port, user, password: "postgres", database: "postgres", max: 1, options: `-c search_path=${schema}` });
    try {
      const r = await withServiceBoundary(unica, { organization_id: ORG, contact_id: CONTATO, conversation_id: conversa, service_revision: 1, demanda_id: null, demanda_revision: null }, () =>
        agendaRetorno(criaRetornoDbPg(unica), { agora: new Date("2026-10-22T20:00:00Z"), janela: { minAheadMs: 0, maxAheadMs: 30 * 86_400_000, staggerWindowMs: 0 } },
          { orgId: ORG, contactId: CONTATO }, { motivo: "combinado", promessa: "amanhã", prometidoPara: "2026-10-24T14:00:00Z" }));
      expect(r.ok).toBe(true);
    } finally { await unica.end(); }
  }, 5_000);

  it("duas mudanças simultâneas preservam um único job e só uma vence", async () => {
    const antes = await original();
    const rs = await Promise.all([db.reagenda!(ORG, antes, novo), db.reagenda!(ORG, antes, { ...novo, quando: new Date("2026-10-25T15:00:00Z") })]);
    expect(rs.filter(Boolean)).toHaveLength(1);
    expect((await pool.query("select count(*)::int n from cron_jobs")).rows[0].n).toBe(1);
  });
  it("cancelamento e isolamento de organização impedem a alteração", async () => {
    const antes = await original();
    expect(await db.reagenda!("00000000-0000-4000-8000-000000000009", antes, novo)).toBeNull();
    await db.marcaCancelado(ORG, antes.id, new Date(), "pedido do cliente");
    expect(await db.reagenda!(ORG, antes, novo)).toBeNull();
  });
  it("scheduler com a linha travada dispara primeiro; reagendamento perde sem recriar", async () => {
    const antes = await original();
    const scheduler = await pool.connect();
    try {
      await scheduler.query("begin");
      await scheduler.query("select id from cron_jobs where id=$1 for update", [antes.id]);
      const tentativa = db.reagenda!(ORG, antes, novo);
      await scheduler.query("update cron_jobs set enabled=false where id=$1", [antes.id]);
      await scheduler.query("commit");
      expect(await tentativa).toBeNull();
      expect((await pool.query("select count(*)::int n from cron_jobs")).rows[0].n).toBe(1);
    } finally { scheduler.release(); }
  });
  it("trava segura a organização até o efeito terminar, sem bloquear outra organização", async () => {
    let soltar!: () => void;
    const espera = new Promise<void>((r) => { soltar = r; });
    let entrou!: () => void;
    const dentro = new Promise<void>((r) => { entrou = r; });
    const primeira = comTravaDaDistribuicao(pool, ORG, async (trava) => { entrou(); await espera; await trava.conferir(); return "feito"; });
    await dentro;
    expect(await comTravaDaDistribuicao(pool, ORG, async () => "indevido")).toEqual({ ocupado: true });
    expect(await comTravaDaDistribuicao(pool, "outra-org", async () => "permitido")).toEqual({ ocupado: false, resultado: "permitido" });
    soltar();
    expect(await primeira).toEqual({ ocupado: false, resultado: "feito" });
    expect(await comTravaDaDistribuicao(pool, ORG, async () => "próxima")).toEqual({ ocupado: false, resultado: "próxima" });
  });
});
