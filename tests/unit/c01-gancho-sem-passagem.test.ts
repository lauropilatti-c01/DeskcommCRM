/**
 * (C01, -c01.15, P1) GANCHO ANTES DO TURNO, `passar_a_equipe` COM A PASSAGEM DESLIGADA.
 *
 * Com a passagem ligada, `passar_a_equipe` faz a passagem da palavra "atendente"
 * (`performHumanHandoff`: `force_human`, `bot_silenced_until = 'infinity'`, agendados
 * cancelados, aviso na Central). Com a passagem desligada na versão publicada do agente
 * (`ctx.passagemDesligada === true`), os itens fixos do gancho saem como sempre e, no
 * lugar da passagem, abre um caso para a equipe com o motivo do gancho: sem `force_human`
 * e sem silêncio, o próximo turno é da IA de novo.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: vi.fn(async (args: { body: string; send: (b: string) => Promise<unknown> }) => ({
    status: "sent",
    outcome: await args.send(args.body),
    trace: [],
  })),
}));
vi.mock("@/lib/leads/handoff-stage-move", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/handoff-stage-move")>()),
  moverLeadParaEtapaDeHandoff: vi.fn(async () => undefined),
}));
vi.mock("@/lib/supabase/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/admin")>()),
  createAdminClient: vi.fn(() => ({})),
}));

import {
  MOTIVO_DA_PASSAGEM_PELO_GANCHO,
  TITULO_DO_CASO_PELO_GANCHO,
  rodarGanchoAntesDoTurno,
  type GanchoAntesDoTurnoConfig,
} from "@/lib/agent-engine/agent/gancho-antes-do-turno";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { moverLeadParaEtapaDeHandoff } from "@/lib/leads/handoff-stage-move";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const ENTRADA = "66666666-6666-4666-8666-666666666666";
const EVENTO = "77777777-7777-4777-8777-777777777777";
const AGENTE = "88888888-8888-4888-8888-888888888888";
const CASO = "99999999-9999-4999-8999-999999999999";
const CONFIG: GanchoAntesDoTurnoConfig = { url: "http://gancho.teste/turno", segredo: "s3gr3do", prazoMs: 100 };
const AGORA = new Date("2026-10-15T18:00:00Z");
const PAYLOAD = {
  conversation_id: CONV,
  contact_id: CONTATO,
  channel_session_id: SESSAO,
  inbound_message_id: ENTRADA,
  crm_event_id: EVENTO,
};
const TEXTO_FIXO = "Recebi seu formulário. Já vou te responder por aqui.";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Consulta {
  sql: string;
  params: unknown[];
}

/** Um banco de mentira: responde o que o gancho lê e guarda o que ele escreve. */
function banco(opcoes: { casoJaAberto?: boolean; falhaNoCaso?: boolean } = {}) {
  const consultas: Consulta[] = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (sql.includes("insert into agent_cases")) {
        if (opcoes.falhaNoCaso) throw new Error("banco fora");
        return opcoes.casoJaAberto ? { rows: [], rowCount: 0 } : { rows: [{ case_id: CASO }], rowCount: 1 };
      }
      if (sql.includes("max(created_at)::text")) return { rows: [{ em: "2026-10-15 17:59:00+00" }], rowCount: 1 };
      if (sql.includes("from conversations c"))
        return { rows: [{ assignee_kind: null, assigned_to_user_id: null, last_inbound_at: null, provider: "meta" }], rowCount: 1 };
      if (sql.includes("from crm_leads"))
        return { rows: [{ id: "card-1", status: "open", etapa: "novo", custom_fields: {}, tags: [] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  return { db, consultas };
}

async function rodar(
  resposta: unknown,
  opcoes: { passagemDesligada?: boolean; casoJaAberto?: boolean; falhaNoCaso?: boolean } = {},
) {
  const { db, consultas } = banco(opcoes);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(resposta), { status: 200 })),
  );
  const send = vi.fn(async (_envio: Record<string, unknown>) => ({ kind: "sent" }));
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const desfecho = await rodarGanchoAntesDoTurno({
    pool: db as never,
    log,
    config: CONFIG,
    job: { id: "job-1", organization_id: ORG, payload: PAYLOAD, kind: "inbound_turn" } as unknown as JobRow,
    tenantId: ORG,
    contactId: CONTATO,
    conversationId: CONV,
    channelSessionId: SESSAO,
    inboundMessageId: ENTRADA,
    agentId: AGENTE,
    etiquetasDoContato: [],
    channel: { send } as never,
    optedOutThisTurn: false,
    now: () => AGORA,
    ...(opcoes.passagemDesligada !== undefined ? { passagemDesligada: opcoes.passagemDesligada } : {}),
  });
  return { desfecho, consultas, send, log };
}

const PASSAR = {
  acao: "segurar",
  enviar: [{ tipo: "texto", texto: TEXTO_FIXO }],
  motivo: "aluno-suporte",
  resumo: "Aluno da turma de 2026 quer ajuda com o acesso.",
  passar_a_equipe: true,
};

const silenciou = (consultas: Consulta[]) =>
  consultas.some(
    (c) =>
      c.sql.includes("force_human = true") ||
      c.sql.includes("bot_silenced_until") ||
      c.sql.includes("last_handoff_reason") ||
      c.sql.includes("insert into agent_inbox_items"),
  );
const insertDoCaso = (consultas: Consulta[]) => consultas.find((c) => c.sql.includes("insert into agent_cases"));
const assentar = () => new Promise((r) => setTimeout(r, 0));

describe("(C01, -c01.15) `passar_a_equipe` com a passagem desligada", () => {
  it("os itens fixos saem como sempre, e o turno termina sem o modelo", async () => {
    const { desfecho, send } = await rodar(PASSAR, { passagemDesligada: true });
    expect(desfecho).toEqual({ fim: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ body: TEXTO_FIXO, conversationId: CONV });
  });

  it("nada de passagem: sem `force_human`, sem silêncio, sem agendados cancelados, sem aviso de passagem na Central", async () => {
    const { consultas } = await rodar(PASSAR, { passagemDesligada: true });
    expect(silenciou(consultas), consultas.map((c) => c.sql).join(" | ")).toBe(false);
    expect(consultas.some((c) => c.sql.includes("update cron_jobs set enabled = false"))).toBe(false);
  });

  it("abre um caso para a equipe com o título do gancho, o resumo dele e o motivo no bloqueio", async () => {
    vi.mocked(moverLeadParaEtapaDeHandoff).mockClear();
    const { consultas } = await rodar(PASSAR, { passagemDesligada: true });
    const caso = insertDoCaso(consultas);
    expect(caso, "nenhum caso aberto").toBeDefined();
    const p = caso!.params;
    expect(p[0]).toBe(ORG);
    expect(p[1]).toBe(CONV);
    expect(p[2]).toBe(AGENTE);
    expect(p[3]).toBe(TITULO_DO_CASO_PELO_GANCHO);
    expect(p[4]).toBe(PASSAR.resumo);
    expect(String(p[5])).toContain("(motivo: aluno-suporte)");
    expect(String(p[5])).toMatch(/passagem de atendimento está desligada/);
    expect(p[7]).toBe("agent");
    // O card vai à etapa de passagem, em best-effort.
    await assentar();
    expect(moverLeadParaEtapaDeHandoff).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, leadId: CONTATO, reason: "gancho_sem_passagem" }),
    );
  });

  it("sem `resumo` do gancho, o caso leva o motivo legível da passagem pelo gancho", async () => {
    const { resumo: _resumo, ...semResumo } = PASSAR;
    const { consultas } = await rodar(semResumo, { passagemDesligada: true });
    expect(insertDoCaso(consultas)?.params[4]).toBe(MOTIVO_DA_PASSAGEM_PELO_GANCHO);
  });

  it("caso já aberto na conversa (`case_already_open`) é sucesso: o turno termina normal, sem passagem", async () => {
    const { desfecho, consultas } = await rodar(PASSAR, { passagemDesligada: true, casoJaAberto: true });
    expect(desfecho).toEqual({ fim: true });
    expect(insertDoCaso(consultas)).toBeDefined();
    expect(silenciou(consultas)).toBe(false);
  });

  it("se o caso não abre, o erro sobe e o job tenta de novo — e nem assim a conversa é silenciada", async () => {
    let consultasDaFalha: Consulta[] = [];
    const { db, consultas } = banco({ falhaNoCaso: true });
    consultasDaFalha = consultas;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(PASSAR), { status: 200 })));
    await expect(
      rodarGanchoAntesDoTurno({
        pool: db as never,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        config: CONFIG,
        job: { id: "job-1", organization_id: ORG, payload: PAYLOAD, kind: "inbound_turn" } as unknown as JobRow,
        tenantId: ORG,
        contactId: CONTATO,
        conversationId: CONV,
        channelSessionId: SESSAO,
        inboundMessageId: ENTRADA,
        agentId: AGENTE,
        etiquetasDoContato: [],
        channel: { send: vi.fn(async () => ({ kind: "sent" })) } as never,
        optedOutThisTurn: false,
        now: () => AGORA,
        passagemDesligada: true,
      }),
    ).rejects.toThrow("banco fora");
    expect(silenciou(consultasDaFalha)).toBe(false);
  });
});

describe("(C01, -c01.15) com a passagem ligada, `passar_a_equipe` é a passagem de sempre", () => {
  for (const [nome, passagemDesligada] of [
    ["passagem ligada (`false`)", false],
    ["sem a informação (o de hoje)", undefined],
  ] as const) {
    it(`${nome}: \`force_human\`, agendados cancelados e nenhum caso aberto pelo gancho`, async () => {
      const { desfecho, consultas, send } = await rodar(
        PASSAR,
        passagemDesligada !== undefined ? { passagemDesligada } : {},
      );
      expect(desfecho).toEqual({ fim: true });
      expect(send).toHaveBeenCalledTimes(1);
      expect(consultas.some((c) => c.sql.includes("update contacts set force_human = true"))).toBe(true);
      expect(consultas.some((c) => c.sql.includes("update cron_jobs set enabled = false"))).toBe(true);
      expect(insertDoCaso(consultas)).toBeUndefined();
    });
  }

  it("sem `passar_a_equipe`, nem caso nem passagem, com a passagem desligada ou não", async () => {
    for (const passagemDesligada of [true, false]) {
      const { consultas } = await rodar({ acao: "segurar", enviar: [] }, { passagemDesligada });
      expect(insertDoCaso(consultas)).toBeUndefined();
      expect(silenciou(consultas)).toBe(false);
    }
  });
});
