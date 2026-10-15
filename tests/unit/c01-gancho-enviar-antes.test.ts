/**
 * (C01, -c01.15) GANCHO ANTES DO TURNO, `seguir` com `enviar_antes`: o porteiro manda
 * mensagens fixas (o vídeo do curso, o link da página) e o modelo responde no MESMO
 * turno, sabendo o que o cliente já recebeu.
 *   1. o contrato: `enviar_antes` com o formato do `enviar`, só com `seguir`; chave
 *      desconhecida continua descartada sem recusar a resposta (é por isso que o
 *      porteiro pode mandar `enviar_antes` a uma -c01.14, que segue como `seguir` puro);
 *   2. os itens saem na ordem, pela cadeia de antes do envio, nas posições -101…, e o
 *      turno segue para o modelo com eles no histórico;
 *   3. o item que não sai fica no log, os seguintes não saem e o turno segue para o modelo;
 *   4. a re-execução não manda de novo (nem o item que falhou), e o que o ledger já tem
 *      vai direto ao canal, sem entrar duas vezes no histórico.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: vi.fn(),
}));

import {
  acrescentarEnviadasAntesNoContexto,
  CHAVE_NO_JOB,
  ORIGEM_DO_GANCHO,
  respostaDoGanchoSchema,
  rodarGanchoAntesDoTurno,
  SEQ_DO_ENVIAR_ANTES,
  type GanchoAntesDoTurnoConfig,
} from "@/lib/agent-engine/agent/gancho-antes-do-turno";
import type { LeadContextMessage } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { hashDoConteudo } from "@/lib/agent-engine/edge/crm/send-ledger";
import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const ENTRADA = "66666666-6666-4666-8666-666666666666";
const CONFIG: GanchoAntesDoTurnoConfig = { url: "http://gancho.teste/turno", segredo: "s3gr3do", prazoMs: 100 };
const AGORA = new Date("2026-10-15T21:00:00Z");
const PAYLOAD = { conversation_id: CONV, contact_id: CONTATO, channel_session_id: SESSAO, inbound_message_id: ENTRADA };

const VIDEO = "Olha o vídeo do curso: https://exemplo.com.br/video";
const PAGINA = "E a página da sua formação: https://exemplo.com.br/pagina";
const SEGUIR = {
  acao: "seguir",
  motivo: "boas-vindas",
  enviar_antes: [
    { tipo: "texto", texto: VIDEO },
    { tipo: "texto", texto: PAGINA },
  ],
};

beforeEach(() => {
  // A cadeia de mentira: deixa sair e chama o canal com o corpo, como a de verdade.
  vi.mocked(runBeforeSend).mockReset();
  vi.mocked(runBeforeSend).mockImplementation((async (opts: { body: string; send: (b: string) => Promise<unknown> }) => ({
    status: "sent",
    outcome: await opts.send(opts.body),
  })) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Consulta {
  sql: string;
  params: unknown[];
}

/** Um banco de mentira: responde o que o gancho lê e guarda o que ele escreve. */
function banco(opcoes: { jaNoLedger?: string[]; provider?: string } = {}) {
  const consultas: Consulta[] = [];
  const hashes = new Set((opcoes.jaNoLedger ?? []).map((body) => hashDoConteudo({ body })));
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (sql.includes("from send_ledger") && sql.includes("status='accepted' and body_hash=$3"))
        return hashes.has(String(params[2]))
          ? { rows: [{ id: "recibo-1", status: "accepted", seq: -101, body_hash: params[2] }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      if (sql.includes("max(created_at)::text")) return { rows: [{ em: "2026-10-15 20:59:00+00" }], rowCount: 1 };
      if (sql.includes("from conversations c"))
        return {
          rows: [{ assignee_kind: null, assigned_to_user_id: null, last_inbound_at: null, provider: opcoes.provider ?? "meta" }],
          rowCount: 1,
        };
      if (sql.includes("select provider from channel_sessions"))
        return { rows: [{ provider: opcoes.provider ?? "meta" }], rowCount: 1 };
      if (sql.includes("from crm_leads"))
        return { rows: [{ id: "card-1", status: "open", etapa: "novo", custom_fields: {}, tags: [] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  return { db, consultas };
}

async function rodar(
  resposta: unknown,
  opcoes: {
    jaNoLedger?: string[];
    provider?: string;
    payload?: Record<string, unknown>;
    canal?: (envio: { body: string; seq: number }) => unknown;
  } = {},
) {
  const { db, consultas } = banco(opcoes);
  const fetch = vi.fn(async () => new Response(JSON.stringify(resposta), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const send = vi.fn(async (envio: { body: string; seq: number }) => opcoes.canal?.(envio) ?? { kind: "sent" });
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
  return { desfecho, consultas, send, log, fetch };
}

/** A última anotação do gancho gravada no job. */
const ultimaAnotacao = (consultas: Consulta[]) => {
  const updates = consultas.filter((c) => c.sql.includes("update job_queue") && c.params[2] === CHAVE_NO_JOB);
  return JSON.parse(String(updates.at(-1)!.params[3])) as Record<string, unknown>;
};

describe("1. o contrato", () => {
  it("`enviar_antes` tem o formato do `enviar` (texto ou interativo, até 5) e só vale com `seguir`", () => {
    expect(respostaDoGanchoSchema.safeParse(SEGUIR).success).toBe(true);
    const interativo = { tipo: "interativo", interactive: { type: "flow", body: { text: "Responda" } } };
    expect(respostaDoGanchoSchema.safeParse({ acao: "seguir", enviar_antes: [interativo] }).success).toBe(true);
    expect(respostaDoGanchoSchema.safeParse({ acao: "seguir", enviar_antes: [] }).success).toBe(true);
    expect(respostaDoGanchoSchema.safeParse({ acao: "seguir", enviar_antes: null }).success).toBe(true);
    // fora do formato: texto vazio, tipo desconhecido, mais de 5 itens
    expect(respostaDoGanchoSchema.safeParse({ acao: "seguir", enviar_antes: [{ tipo: "texto", texto: "  " }] }).success).toBe(false);
    expect(respostaDoGanchoSchema.safeParse({ acao: "seguir", enviar_antes: [{ tipo: "audio", url: "x" }] }).success).toBe(false);
    const seis = Array.from({ length: 6 }, (_, i) => ({ tipo: "texto", texto: `item ${i}` }));
    expect(respostaDoGanchoSchema.safeParse({ acao: "seguir", enviar_antes: seis }).success).toBe(false);
    // no `segurar` o que sai é o `enviar`
    expect(
      respostaDoGanchoSchema.safeParse({ acao: "segurar", enviar: [], enviar_antes: [{ tipo: "texto", texto: "oi" }] }).success,
    ).toBe(false);
  });

  it("chave desconhecida é descartada sem recusar a resposta (o que a -c01.14 faz com `enviar_antes`)", () => {
    const lido = respostaDoGanchoSchema.safeParse({ acao: "seguir", resumo: "ok", chave_do_futuro: { qualquer: 1 } });
    expect(lido.success).toBe(true);
    if (!lido.success) return;
    expect(lido.data).not.toHaveProperty("chave_do_futuro");
    expect(lido.data.acao).toBe("seguir");
  });
});

describe("2. os itens saem antes do modelo, e o modelo os lê", () => {
  it("na ordem, pela cadeia, nas posições -101 e -102, com a origem do gancho; o turno segue com eles", async () => {
    const { desfecho, send, consultas } = await rodar(SEGUIR);
    expect(desfecho.fim).toBe(false);
    expect(vi.mocked(runBeforeSend)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runBeforeSend).mock.calls.map((c) => (c[0] as { body: string }).body)).toEqual([VIDEO, PAGINA]);
    // a mesma chamada da cadeia que o `enviar` do `segurar` faz (é resposta ao cliente)
    expect((vi.mocked(runBeforeSend).mock.calls[0]![0] as { resposta: boolean }).resposta).toBe(true);
    expect(send.mock.calls.map((c) => [c[0].body, c[0].seq])).toEqual([
      [VIDEO, SEQ_DO_ENVIAR_ANTES - 1],
      [PAGINA, SEQ_DO_ENVIAR_ANTES - 2],
    ]);
    expect(send.mock.calls.every((c) => (c[0] as { origem?: string }).origem === ORIGEM_DO_GANCHO)).toBe(true);
    if (desfecho.fim) return;
    expect(desfecho.enviadasAntes).toEqual([
      { texto: VIDEO, em: AGORA },
      { texto: PAGINA, em: AGORA },
    ]);
    // a decisão fica anotada como feita: a re-execução não manda de novo
    expect(ultimaAnotacao(consultas)).toMatchObject({ situacao: "decidido", enviar_antes_feito: true });
  });

  it("o histórico que o modelo lê ganha as mensagens enviadas, depois da do cliente", () => {
    const mensagens: LeadContextMessage[] = [
      { direction: "inbound", body: "quero saber do curso", sent_at: "2026-10-15T17:59:00-03:00" },
    ];
    acrescentarEnviadasAntesNoContexto(mensagens, [{ texto: VIDEO, em: AGORA }], "America/Sao_Paulo");
    expect(mensagens).toEqual([
      { direction: "inbound", body: "quero saber do curso", sent_at: "2026-10-15T17:59:00-03:00" },
      { direction: "outbound", body: VIDEO, sent_at: "2026-10-15T18:00:00-03:00" },
    ]);
  });

  it("no turno: acrescenta ao histórico depois do `fim` e antes do roteiro e da abertura do modelo", () => {
    const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    const trecho = turno.slice(turno.indexOf("marca.desviosConferidos = true;"), turno.indexOf("const roteiro ="));
    const fim = trecho.indexOf("if (desfechoDoGancho.fim) return;");
    const acrescenta = trecho.indexOf(
      "acrescentarEnviadasAntesNoContexto(openingContext.context.messages, desfechoDoGancho.enviadasAntes, fusoDaOrg)",
    );
    expect(fim).toBeGreaterThan(-1);
    expect(acrescenta).toBeGreaterThan(fim);
    expect(turno.indexOf("input.buildOpening(")).toBeGreaterThan(turno.indexOf("const roteiro ="));
  });

  it("`seguir` sem `enviar_antes`: nada sai, como antes", async () => {
    const { desfecho, send } = await rodar({ acao: "seguir", motivo: "x" });
    expect(desfecho).toEqual({ fim: false });
    expect(send).not.toHaveBeenCalled();
    expect(vi.mocked(runBeforeSend)).not.toHaveBeenCalled();
  });
});

describe("3. o item que não sai: fica no log e o turno segue para o modelo", () => {
  it("veto da cadeia no 1º item: nada sai, o 2º não é tentado, o turno segue sem `enviadasAntes`", async () => {
    vi.mocked(runBeforeSend).mockResolvedValueOnce({ status: "vetoed", code: "janela_fechada" } as never);
    const { desfecho, send, log, consultas } = await rodar(SEGUIR);
    expect(desfecho).toEqual({ fim: false });
    expect(vi.mocked(runBeforeSend)).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(log.warn.mock.calls.map((c) => c[0])).toContain(
      "gancho antes do turno: enviar_antes parou — o turno segue para o modelo com o que saiu",
    );
    expect(ultimaAnotacao(consultas)).toMatchObject({ enviar_antes_feito: true });
  });

  it("falha do canal no 2º item: o 1º fica, o modelo lê só ele", async () => {
    const { desfecho } = await rodar(SEGUIR, {
      canal: (envio) => (envio.body === PAGINA ? { kind: "failed", error: "sessão caída" } : { kind: "sent" }),
    });
    expect(desfecho.fim).toBe(false);
    if (desfecho.fim) return;
    expect(desfecho.enviadasAntes).toEqual([{ texto: VIDEO, em: AGORA }]);
  });

  it("erro lançado no envio não derruba o turno", async () => {
    vi.mocked(runBeforeSend).mockRejectedValueOnce(new Error("rede"));
    const { desfecho } = await rodar(SEGUIR);
    expect(desfecho).toEqual({ fim: false });
  });

  it("interativo num canal que não o envia: não vai ao canal, e o turno segue para o modelo", async () => {
    const { desfecho, send } = await rodar(
      {
        acao: "seguir",
        enviar_antes: [{ tipo: "interativo", interactive: { type: "flow", body: { text: "Responda" } } }, { tipo: "texto", texto: VIDEO }],
      },
      { provider: "waha" },
    );
    expect(desfecho).toEqual({ fim: false });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("4. a re-execução do job", () => {
  it("com a decisão anotada como feita: não pergunta de novo, nada sai (nem o que falhou) e nada se repete no histórico", async () => {
    const { desfecho, send, fetch } = await rodar(SEGUIR, {
      payload: {
        ...PAYLOAD,
        [CHAVE_NO_JOB]: {
          situacao: "decidido",
          resposta: SEGUIR,
          formulario: null,
          ate: "2026-10-15 20:59:00+00",
          enviar_antes_feito: true,
        },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(vi.mocked(runBeforeSend)).not.toHaveBeenCalled();
    expect(desfecho).toEqual({ fim: false });
  });

  it("caiu entre o envio e a anotação: o que o ledger tem vai direto ao canal, sem a cadeia e sem entrar de novo no histórico", async () => {
    const { desfecho, send } = await rodar(SEGUIR, {
      jaNoLedger: [VIDEO],
      payload: {
        ...PAYLOAD,
        [CHAVE_NO_JOB]: { situacao: "decidido", resposta: SEGUIR, formulario: null, ate: "2026-10-15 20:59:00+00" },
      },
      canal: (envio) => (envio.body === VIDEO ? { kind: "already_sent" } : { kind: "sent" }),
    });
    // o 1º não passa pela cadeia (ela vetaria agora o que já saiu); o 2º passa
    expect(vi.mocked(runBeforeSend).mock.calls.map((c) => (c[0] as { body: string }).body)).toEqual([PAGINA]);
    expect(send.mock.calls.map((c) => c[0].body)).toEqual([VIDEO, PAGINA]);
    expect(desfecho.fim).toBe(false);
    if (desfecho.fim) return;
    expect(desfecho.enviadasAntes).toEqual([{ texto: PAGINA, em: AGORA }]);
  });
});
