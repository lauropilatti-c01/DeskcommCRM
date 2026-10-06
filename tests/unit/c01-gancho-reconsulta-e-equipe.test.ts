/**
 * (C01, -c01.6) GANCHO ANTES DO TURNO, o que a entrada com o formulário (CRM-077) pede:
 *   1. o `segurar` grava o `resumo` do formulário (antes gravava vazio);
 *   2. `reconsultar_em_s`: um `inbound_turn` marcado, pelo cron de uma vez, sem
 *      espalhamento, sem agendar duas vezes na re-execução; o pedido da reconsulta leva
 *      `reconsulta: true`; o turno marcado pula a checagem de "já respondido" e nunca
 *      chama o modelo;
 *   3. `passar_a_equipe` (só com `segurar`): a mesma passagem da palavra "atendente".
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MARCA_DA_RECONSULTA,
  respostaDoGanchoSchema,
  rodarGanchoAntesDoTurno,
  type GanchoAntesDoTurnoConfig,
} from "@/lib/agent-engine/agent/gancho-antes-do-turno";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const FORM = "55555555-5555-4555-8555-555555555555";
const ENTRADA = "66666666-6666-4666-8666-666666666666";
const EVENTO = "77777777-7777-4777-8777-777777777777";
const CONFIG: GanchoAntesDoTurnoConfig = { url: "http://gancho.teste/turno", segredo: "s3gr3do", prazoMs: 100 };
const AGORA = new Date("2026-10-06T22:00:00Z");
const PAYLOAD = {
  conversation_id: CONV,
  contact_id: CONTATO,
  channel_session_id: SESSAO,
  inbound_message_id: ENTRADA,
  crm_event_id: EVENTO,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Consulta {
  sql: string;
  params: unknown[];
}

/** Um banco de mentira: responde o que o gancho lê e guarda o que ele escreve. */
function banco(opcoes: { comFormulario?: boolean; reconsultaJaAgendada?: boolean } = {}) {
  const consultas: Consulta[] = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (sql.includes("max(created_at)::text")) return { rows: [{ em: "2026-10-06 21:59:00+00" }], rowCount: 1 };
      if (sql.includes("from conversations c"))
        return { rows: [{ assignee_kind: null, assigned_to_user_id: null, last_inbound_at: null, provider: "meta" }], rowCount: 1 };
      if (sql.includes("'nfm_reply'") && opcoes.comFormulario)
        return {
          rows: [{ id: FORM, interativo: { type: "nfm_reply", response: { escolaridade: "tecnico" } }, sent_at: "2026-10-06T21:59:00Z", processado: false }],
          rowCount: 1,
        };
      if (sql.includes("from crm_leads"))
        return {
          rows: [{ id: "card-1", status: "open", etapa: "novo", custom_fields: {}, tags: [] }],
          rowCount: 1,
        };
      if (sql.includes("payload->>'reconsulta_de'"))
        return { rows: opcoes.reconsultaJaAgendada ? [{ "?column?": 1 }] : [], rowCount: opcoes.reconsultaJaAgendada ? 1 : 0 };
      if (sql.includes("insert into cron_jobs")) return { rows: [{ id: "cron-1", ...Object.fromEntries([]) }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  return { db, consultas };
}

async function rodar(resposta: unknown, opcoes: { comFormulario?: boolean; reconsultaJaAgendada?: boolean; payload?: Record<string, unknown> } = {}) {
  const { db, consultas } = banco(opcoes);
  const pedidos: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      pedidos.push(String(init.body));
      return new Response(JSON.stringify(resposta), { status: 200 });
    }),
  );
  const send = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const desfecho = await rodarGanchoAntesDoTurno({
    pool: db as never,
    log,
    config: CONFIG,
    job: { id: "job-1", organization_id: ORG, payload: opcoes.payload ?? PAYLOAD, kind: "inbound_turn" } as unknown as JobRow,
    tenantId: ORG,
    contactId: CONTATO,
    conversationId: CONV,
    channelSessionId: SESSAO,
    inboundMessageId: ENTRADA,
    agentId: null,
    etiquetasDoContato: [],
    channel: { send } as never,
    optedOutThisTurn: false,
    now: () => AGORA,
  });
  return { desfecho, consultas, pedidos, send, log };
}

const insertsNoCron = (consultas: Consulta[]) => consultas.filter((c) => c.sql.includes("insert into cron_jobs"));

describe("o contrato aceita os campos novos, nos limites", () => {
  it("`reconsultar_em_s` de 30 a 900 segundos, inteiro", () => {
    expect(respostaDoGanchoSchema.safeParse({ acao: "segurar", enviar: [], reconsultar_em_s: 120 }).success).toBe(true);
    expect(respostaDoGanchoSchema.safeParse({ acao: "seguir", reconsultar_em_s: 30 }).success).toBe(true);
    expect(respostaDoGanchoSchema.safeParse({ acao: "segurar", enviar: [], reconsultar_em_s: 10 }).success).toBe(false);
    expect(respostaDoGanchoSchema.safeParse({ acao: "segurar", enviar: [], reconsultar_em_s: 901 }).success).toBe(false);
    expect(respostaDoGanchoSchema.safeParse({ acao: "segurar", enviar: [], reconsultar_em_s: 60.5 }).success).toBe(false);
  });

  it("`passar_a_equipe` só com `segurar`", () => {
    expect(respostaDoGanchoSchema.safeParse({ acao: "segurar", enviar: [], passar_a_equipe: true }).success).toBe(true);
    expect(respostaDoGanchoSchema.safeParse({ acao: "seguir", passar_a_equipe: true }).success).toBe(false);
    expect(respostaDoGanchoSchema.safeParse({ acao: "seguir", passar_a_equipe: false }).success).toBe(true);
  });
});

describe("1. o `segurar` grava o resumo do formulário", () => {
  it("a resposta do formulário fica marcada e com o texto do resumo", async () => {
    const { desfecho, consultas } = await rodar(
      { acao: "segurar", enviar: [], resumo: "Formulário: nível técnico." },
      { comFormulario: true },
    );
    expect(desfecho).toEqual({ fim: true });
    const marca = consultas.find((c) => c.sql.includes("update messages") && c.sql.includes("body = coalesce($4, body)"));
    expect(marca?.params[2]).toBe(FORM);
    expect(marca?.params[3]).toBe("Formulário: nível técnico.");
  });

  it("sem `resumo`, o texto fica como estava (só a marca)", async () => {
    const { consultas } = await rodar({ acao: "segurar", enviar: [] }, { comFormulario: true });
    const marca = consultas.find((c) => c.sql.includes("update messages") && c.sql.includes("body = coalesce($4, body)"));
    expect(marca?.params[3]).toBeNull();
  });
});

describe("2. `reconsultar_em_s`: o turno marcado, pelo cron de uma vez", () => {
  it("`segurar` agenda um `inbound_turn` marcado para daqui a N segundos, sem espalhamento", async () => {
    const { consultas } = await rodar({ acao: "segurar", enviar: [], reconsultar_em_s: 120 }, { comFormulario: true });
    const inserts = insertsNoCron(consultas);
    expect(inserts).toHaveLength(1);
    const p = inserts[0]!.params;
    expect(p[0]).toBe(ORG);
    expect(p[1]).toBe(CONTATO);
    expect(p[2]).toBe("at");
    expect(p[6]).toBe("inbound_turn");
    expect(p[8]).toEqual(new Date(AGORA.getTime() + 120_000));
    expect(p[7]).toMatchObject({ ...PAYLOAD, [MARCA_DA_RECONSULTA]: true, reconsulta_de: "job-1" });
  });

  it("`seguir` também agenda", async () => {
    const { desfecho, consultas } = await rodar({ acao: "seguir", reconsultar_em_s: 60 });
    expect(desfecho.fim).toBe(false);
    expect(insertsNoCron(consultas)).toHaveLength(1);
  });

  it("sem o campo, nada é agendado", async () => {
    const { consultas } = await rodar({ acao: "segurar", enviar: [] });
    expect(insertsNoCron(consultas)).toHaveLength(0);
  });

  it("a re-execução do mesmo job não agenda duas vezes (`reconsulta_de`)", async () => {
    const { consultas } = await rodar({ acao: "segurar", enviar: [], reconsultar_em_s: 120 }, { reconsultaJaAgendada: true });
    expect(insertsNoCron(consultas)).toHaveLength(0);
  });

  it("o pedido do turno marcado leva `reconsulta: true`; o dos outros, não", async () => {
    const marcado = await rodar({ acao: "segurar", enviar: [] }, { payload: { ...PAYLOAD, [MARCA_DA_RECONSULTA]: true } });
    expect(JSON.parse(marcado.pedidos[0]!).reconsulta).toBe(true);
    const normal = await rodar({ acao: "segurar", enviar: [] });
    expect("reconsulta" in JSON.parse(normal.pedidos[0]!)).toBe(false);
  });

  it("com `passar_a_equipe`, nada é agendado", async () => {
    const { consultas } = await rodar({ acao: "segurar", enviar: [], passar_a_equipe: true, reconsultar_em_s: 120 });
    expect(insertsNoCron(consultas)).toHaveLength(0);
  });
});

describe("3. `passar_a_equipe`: a passagem da palavra \"atendente\"", () => {
  it("o contato vai para a equipe (force_human), a conversa é silenciada e os agendados caem", async () => {
    const { desfecho, consultas } = await rodar({ acao: "segurar", enviar: [], motivo: "aluno_zero1", passar_a_equipe: true });
    expect(desfecho).toEqual({ fim: true });
    expect(consultas.some((c) => c.sql.includes("update contacts set force_human = true"))).toBe(true);
    expect(consultas.some((c) => c.sql.includes("update cron_jobs set enabled = false"))).toBe(true);
  });

  it("sem o campo, ninguém é passado", async () => {
    const { consultas } = await rodar({ acao: "segurar", enviar: [] });
    expect(consultas.some((c) => c.sql.includes("force_human = true"))).toBe(false);
  });
});

describe("a reconsulta no turno", () => {
  const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("pula a checagem de \"já respondido\" só no turno marcado, e não roda sem o gancho ligado", () => {
    expect(turno).toMatch(/const reconsulta = eReconsultaDoGancho\(job\.payload\);/);
    expect(turno).toMatch(/if \(reconsulta && deps\.knobs\.ganchoAntesDoTurno === undefined\) \{/);
    expect(turno).toMatch(/if \(!reconsulta && \(await ultimaInboundJaRespondida\(pool, alvo\)\)\) \{/);
  });

  it("o modelo nunca responde no turno marcado: o retorno vem antes do roteiro", () => {
    const depoisDoGancho = turno.slice(turno.indexOf("if (desfechoDoGancho.fim) return;"), turno.indexOf("const roteiro ="));
    expect(depoisDoGancho).toMatch(/if \(eReconsultaDoGancho\(liveJob\(\)\.payload\)\) \{[\s\S]*?return;/);
  });
});
