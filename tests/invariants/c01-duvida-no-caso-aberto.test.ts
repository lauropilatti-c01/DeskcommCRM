import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { openCase, resolveCaseFromHuman } from "@/lib/agent-engine/agent/human-cases";
import { notaDaDuvidaNova, registrarDuvidaNoCasoAberto } from "@/lib/c01/passagem-desligada";

/**
 * (C01, -c01.16) A DÚVIDA NOVA COM O CASO JÁ ABERTO ENTRA NO CASO ABERTO.
 *
 * O defeito (teste-base da Marina v26 no laboratório, 20/10/2026): com um caso aberto na
 * conversa, a segunda dúvida chamava `open_human_case`, `openCase` recusava
 * (`case_already_open`) e o modelo dizia "vou verificar"; a dúvida não ia a ninguém. Com
 * `registrarDuvidaNoCasoAberto` ela vira nota do agente no caso aberto. Postgres real, como
 * `human-cases.test.ts` (`pnpm test:db`).
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "dddddddd-0000-4000-8000-000000000001";
const CONTACT = "dddddddd-0000-4000-8000-000000000002";
const SESSION = "dddddddd-0000-4000-8000-000000000003";
const CONV = "dddddddd-0000-4000-8000-000000000004";
const CONV_SEM_CASO = "dddddddd-0000-4000-8000-000000000005";
const ACTOR = "dddddddd-0000-4000-8000-000000000006";
const ORG_B = "dddddddd-0000-4000-8000-000000000011";
const CONTACT_2 = "dddddddd-0000-4000-8000-000000000007";

const PRIMEIRA = { title: "Embarque", summary: "Quer saber se o cargo embarca", blocker: "Sem fonte para embarque" };
const SEGUNDA = { title: "Periculosidade", summary: "Pergunta se há adicional de periculosidade", blocker: "Sem fonte" };

async function eventos(caseId: string) {
  const { rows } = await pool.query<{ kind: string; actor_kind: string; body: string | null }>(
    `select kind, actor_kind, body from agent_case_events where case_id = $1 order by created_at, id`,
    [caseId],
  );
  return rows;
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'duvida-caso-a', 'Org de Prova', 'Org de Prova'), ($2, 'duvida-caso-b', 'Org B', 'Org B')
     on conflict (id) do nothing`,
    [ORG, ORG_B],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1, $3, 'Contato de Prova', '+5511900001234'), ($2, $3, 'Outro Contato', '+5511900001235')
     on conflict (id) do nothing`,
    [CONTACT, CONTACT_2, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'duvida-caso-sessao', 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $3, $4, $6, 'ai_handling', false), ($2, $3, $5, $6, 'ai_handling', false) on conflict (id) do nothing`,
    [CONV, CONV_SEM_CASO, ORG, CONTACT, CONTACT_2, SESSION],
  );
  await pool.query(
    `insert into auth.users (id, email) values ($1, 'atendente-duvida@prova.test') on conflict (id) do nothing`,
    [ACTOR],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("(C01, -c01.16) dúvida nova com o caso já aberto", () => {
  it("o segundo openCase é recusado e a dúvida nova vira nota do agente no MESMO caso", async () => {
    const primeiro = await openCase(pool, { tenantId: ORG, conversationId: CONV }, PRIMEIRA);
    expect(primeiro.ok).toBe(true);
    if (!primeiro.ok) return;

    const segundo = await openCase(pool, { tenantId: ORG, conversationId: CONV }, SEGUNDA);
    expect(segundo.ok).toBe(false);
    if (!segundo.ok) expect(segundo.error.code).toBe("case_already_open");

    const noCaso = await registrarDuvidaNoCasoAberto(pool, ORG, CONV, SEGUNDA);
    expect(noCaso).toBe(primeiro.caseId);

    const evs = await eventos(primeiro.caseId);
    expect(evs.map((e) => e.kind)).toEqual(["opened", "agent_noted"]);
    expect(evs[1]!.actor_kind).toBe("agent");
    expect(evs[1]!.body).toBe(notaDaDuvidaNova(SEGUNDA));
    expect(evs[1]!.body).toContain("Periculosidade");
    expect(evs[1]!.body).toContain("Pergunta se há adicional de periculosidade");

    const { rows } = await pool.query(`select count(*)::int as n from agent_cases where conversation_id = $1`, [CONV]);
    expect(rows[0]!.n).toBe(1);
  });

  it("caso fechado não recebe nota (null): o chamador abre um novo, que recebe a dúvida", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `select id from agent_cases where conversation_id = $1 and status = 'awaiting_human'`,
      [CONV],
    );
    const fechou = await resolveCaseFromHuman(pool, ORG, rows[0]!.id, ACTOR, "respondido");
    expect(fechou).toBe(true);

    expect(await registrarDuvidaNoCasoAberto(pool, ORG, CONV, SEGUNDA)).toBeNull();
    const antes = await eventos(rows[0]!.id);
    expect(antes.filter((e) => e.kind === "agent_noted")).toHaveLength(1);

    const novo = await openCase(pool, { tenantId: ORG, conversationId: CONV }, SEGUNDA);
    expect(novo.ok).toBe(true);
  });

  it("fechamento ao mesmo tempo que a nota: a nota espera, relê o estado e não cai no caso fechado", async () => {
    const aberto = await openCase(pool, { tenantId: ORG, conversationId: CONV_SEM_CASO }, PRIMEIRA);
    expect(aberto.ok).toBe(true);
    if (!aberto.ok) return;
    const fechando = await pool.connect();
    try {
      await fechando.query("begin");
      await fechando.query(`update agent_cases set status = 'resolved', closed_at = now() where id = $1`, [aberto.caseId]);
      const nota = registrarDuvidaNoCasoAberto(pool, ORG, CONV_SEM_CASO, SEGUNDA);
      await new Promise((r) => setTimeout(r, 300));
      await fechando.query("commit");
      expect(await nota).toBeNull();
    } finally {
      fechando.release();
    }
    const evs = await eventos(aberto.caseId);
    expect(evs.filter((e) => e.kind === "agent_noted")).toHaveLength(0);
    await pool.query(`delete from agent_case_events where case_id = $1`, [aberto.caseId]);
    await pool.query(`delete from agent_cases where id = $1`, [aberto.caseId]);
  });

  it("sem caso aberto na conversa, ou de outra organização: nenhuma nota", async () => {
    expect(await registrarDuvidaNoCasoAberto(pool, ORG, CONV_SEM_CASO, SEGUNDA)).toBeNull();
    expect(await registrarDuvidaNoCasoAberto(pool, ORG_B, CONV, SEGUNDA)).toBeNull();
    const { rows } = await pool.query(
      `select count(*)::int as n from agent_case_events e join agent_cases c on c.id = e.case_id
        where c.conversation_id = any($1::uuid[]) and e.kind = 'agent_noted'`,
      [[CONV, CONV_SEM_CASO]],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("com caso aguardando o lead (awaiting_lead), a nota também entra", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `select id from agent_cases where conversation_id = $1 and status = 'awaiting_human'`,
      [CONV],
    );
    await pool.query(`update agent_cases set status = 'awaiting_lead' where id = $1`, [rows[0]!.id]);
    expect(await registrarDuvidaNoCasoAberto(pool, ORG, CONV, PRIMEIRA)).toBe(rows[0]!.id);
  });
});
