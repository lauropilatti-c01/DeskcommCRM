import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { lerRetratoFinanceiro, MAX_SNAPSHOT_ROWS } from "@/lib/leads/retrato-financeiro";

if (!process.env.TEST_DB_CONTAINER || !process.env.TEST_DB_PORT)
  throw new Error("Use pnpm test:db: este teste exige o banco descartável do roteiro.");
const connectionString = `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`;
const pool = new pg.Pool({ connectionString, max: 3 });
afterAll(() => pool.end());

async function seed() {
  const org = randomUUID(),
    contact = randomUUID(),
    lead = randomUUID(),
    pipeline = randomUUID(),
    stage = randomUUID();
  await pool.query(
    "INSERT INTO organizations(id,slug,legal_name,display_name) VALUES($1,$2,'Fictício','Fictício')",
    [org, `snapshot-${org}`],
  );
  await pool.query(
    "INSERT INTO contacts(id,organization_id,display_name,phone_number,email) VALUES($1,$2,'Nome privado de teste','+5511999990001','pessoa@example.test')",
    [contact, org],
  );
  await pool.query(
    "INSERT INTO crm_pipelines(id,organization_id,name,slug) VALUES($1,$2,'Fictício','teste')",
    [pipeline, org],
  );
  await pool.query(
    "INSERT INTO crm_stages(id,organization_id,pipeline_id,name,slug,position) VALUES($1,$2,$3,'Aberto','aberto',1000)",
    [stage, org, pipeline],
  );
  await pool.query(
    "INSERT INTO crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,custom_fields) VALUES($1,$2,$3,$4,$5,'Título privado de teste',$6)",
    [
      lead,
      org,
      pipeline,
      stage,
      contact,
      {
        produto_chave: "produto-ficticio",
        plano_oferecido: "plano-ficticio",
        observacao: "conversa privada",
      },
    ],
  );
  return { org, contact, lead };
}

describe("retrato financeiro com PostgreSQL real descartável", () => {
  it("isola organizações, preserva duplicidade de identidade e projeta só campos mínimos", async () => {
    const a = await seed(),
      b = await seed();
    await pool.query(
      "INSERT INTO contacts(id,organization_id,display_name,phone_number,email,is_merged_into) VALUES($1,$2,'Duplicidade fictícia','+5511999990001','pessoa@example.test',$3)",
      [randomUUID(), a.org, a.contact],
    );
    const before = await pool.query("SELECT status,custom_fields FROM crm_leads WHERE id=$1", [
      a.lead,
    ]);
    const p = await lerRetratoFinanceiro(pool, a.org);
    expect(p.contacts).toHaveLength(2);
    expect(p.opportunities).toHaveLength(1);
    expect(p.opportunities[0]).toMatchObject({
      id: a.lead,
      contact_id: a.contact,
      custom_fields: { produto_chave: "produto-ficticio", plano_oferecido: "plano-ficticio" },
    });
    const serialized = JSON.stringify(p);
    for (const absent of [
      b.org,
      b.contact,
      b.lead,
      "Nome privado",
      "Título privado",
      "conversa privada",
      "observacao",
    ])
      expect(serialized).not.toContain(absent);
    expect(
      (await pool.query("SELECT status,custom_fields FROM crm_leads WHERE id=$1", [a.lead])).rows,
    ).toEqual(before.rows);
  });
  it("o limite de linhas gera erro em vez de um censo incompleto", async () => {
    const a = await seed();
    await pool.query(
      "INSERT INTO contacts(id,organization_id,display_name) SELECT gen_random_uuid(),$1,'Fictício' FROM generate_series(1,$2)",
      [a.org, MAX_SNAPSHOT_ROWS],
    );
    await expect(lerRetratoFinanceiro(pool, a.org)).rejects.toThrow(
      "financial_snapshot_unavailable",
    );
  });
  it("role submetida a RLS não produz zero falso nem parcial", async () => {
    const a = await seed();
    // Papel apenas no banco descartável do teste; não é migration do produto.
    await pool.query("CREATE ROLE c01_snapshot_fixture_ro NOLOGIN");
    await pool.query("GRANT USAGE ON SCHEMA public TO c01_snapshot_fixture_ro");
    await pool.query("GRANT SELECT ON contacts,crm_leads TO c01_snapshot_fixture_ro");
    const restricted = new pg.Pool({
      connectionString,
      options: "-c role=c01_snapshot_fixture_ro",
      max: 1,
    });
    try {
      await expect(lerRetratoFinanceiro(restricted, a.org)).rejects.toThrow(
        "financial_snapshot_unavailable",
      );
    } finally {
      await restricted.end();
    }
  });
});
