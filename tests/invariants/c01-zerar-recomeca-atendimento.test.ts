// (C01, -c01.15+zerar) O `#zerar` do celular de teste recomeça o atendimento: os casos
// abertos da conversa fecham sem turno de devolução, a demanda atual é encerrada e, na
// próxima mensagem do cliente, a IA lê só o que veio depois (mensagens e caso).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recomecarAtendimentoDoCelularDeTeste } from "@/lib/agent-engine/agent/gancho-antes-do-turno";
import { hasOpenCaseForContact } from "@/lib/agent-engine/agent/human-cases";
import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { seedGov, GOV_ORG, GOV_SESSION } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});
const contact = randomUUID();
const conversation = randomUUID();

async function mensagem(direction: "inbound" | "outbound", body: string) {
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,sent_via,body,sent_at)
     values($1,$2,$3,$4,$5,'text',$6,'received','ai',$7,clock_timestamp())`,
    [randomUUID(), GOV_ORG, conversation, GOV_SESSION, contact, direction, body],
  );
  await pool.query("select fn_mark_conversation_message($1,$2,$3,clock_timestamp())", [
    conversation,
    direction,
    body,
  ]);
}
async function contexto() {
  const r = await getLeadContext(
    pool,
    {} as never,
    { tenantId: GOV_ORG, leadId: contact, conversationId: conversation, fuso: "America/Sao_Paulo" },
    { historyLimit: 20, maxTokens: 4000 },
  );
  expect(r.ok).toBe(true);
  return r.ok ? r.context : null;
}
async function contar(sql: string) {
  return (await pool.query<{ n: number }>(sql, [GOV_ORG])).rows[0]!.n;
}

beforeAll(async () => {
  seedGov();
  await pool.query("insert into contacts(id,organization_id,display_name) values($1,$2,'Celular de teste')", [
    contact,
    GOV_ORG,
  ]);
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,
    [conversation, GOV_ORG, contact, GOV_SESSION],
  );
});
afterAll(async () => {
  await pool.end();
});

describe("#zerar recomeça o atendimento do celular de teste", () => {
  it("fecha caso e demanda sem enviar nada; a IA passa a ver só o que veio depois", async () => {
    await mensagem("inbound", "PERGUNTA_DE_ANTES");
    await mensagem("outbound", "RESPOSTA_DE_ANTES o preparatório que te mostrei");
    await pool.query(
      `insert into agent_cases (id, organization_id, conversation_id, title, summary, blocker, status)
       values ($1, $2, $3, 'Caso de antes', 'resumo', 'bloqueio', 'awaiting_human')`,
      [randomUUID(), GOV_ORG, conversation],
    );
    await mensagem("inbound", "#zerar");
    await mensagem("outbound", "Zerado");
    expect(await hasOpenCaseForContact(pool, GOV_ORG, conversation)).toBe(true);
    expect(JSON.stringify(await contexto())).toContain("PERGUNTA_DE_ANTES");

    const jobsAntes = await contar("select count(*)::int n from job_queue where organization_id=$1");
    const saidasAntes = await contar(
      "select count(*)::int n from messages where organization_id=$1 and direction='outbound'",
    );
    const r = await recomecarAtendimentoDoCelularDeTeste(pool, GOV_ORG, conversation);
    expect(r).toEqual({ casos: 1, demanda: true });
    expect(await hasOpenCaseForContact(pool, GOV_ORG, conversation)).toBe(false);
    // Nada sai e nenhum turno é enfileirado (o "resolver" da Central roda a devolução).
    expect(await contar("select count(*)::int n from job_queue where organization_id=$1")).toBe(jobsAntes);
    expect(
      await contar("select count(*)::int n from messages where organization_id=$1 and direction='outbound'"),
    ).toBe(saidasAntes);
    // Repetir não muda nada (sem caso aberto, sem demanda aberta).
    expect(await recomecarAtendimentoDoCelularDeTeste(pool, GOV_ORG, conversation)).toEqual({
      casos: 0,
      demanda: false,
    });

    await mensagem("inbound", "PERGUNTA_DE_DEPOIS");
    const depois = await contexto();
    const texto = JSON.stringify(depois?.messages);
    expect(texto).toContain("PERGUNTA_DE_DEPOIS");
    expect(texto).not.toContain("PERGUNTA_DE_ANTES");
    expect(texto).not.toContain("RESPOSTA_DE_ANTES");
    expect(texto).not.toContain("Zerado");
    expect(texto).not.toContain("#zerar");
    const abertas = await pool.query(
      "select count(*)::int n from demandas where organization_id=$1 and contact_id=$2 and fechada_em is null",
      [GOV_ORG, contact],
    );
    expect(abertas.rows[0].n).toBe(1);
  });
});
