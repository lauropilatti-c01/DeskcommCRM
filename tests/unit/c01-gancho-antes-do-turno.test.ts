/**
 * (C01, -c01.5) GANCHO ANTES DO TURNO, as peças: o ambiente que o liga, a assinatura,
 * o contrato da resposta, o que o pedido NÃO leva, o canal que não envia interativo e
 * a ligação no turno. O efeito no turno inteiro (seguir, segurar, re-execução, falhas)
 * está em `tests/invariants/c01-gancho-antes-do-turno.test.ts`, contra Postgres real.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assinaturaDoGancho,
  chamarGancho,
  chaveEDadoPessoal,
  montarPedidoDoGancho,
  rodarGanchoAntesDoTurno,
  trocarResumoNoContexto,
  type GanchoAntesDoTurnoConfig,
  type PedidoDoGancho,
} from "@/lib/agent-engine/agent/gancho-antes-do-turno";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";
import { camposCompactosDoCard } from "@/lib/agent-engine/edge/crm/card-do-contato";
import type { LeadContextMessage } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { corpoDoEnvio } from "@/lib/agent-engine/edge/crm/send-message";
import { hashDoConteudo } from "@/lib/agent-engine/edge/crm/send-ledger";
import { loadEnv } from "@/lib/agent-engine/env";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const base = {
  SUPABASE_DB_URL: "postgres://u:p@localhost:5432/db",
  NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
  SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
};
const knobs = (env: Record<string, string>) =>
  turnKnobsFromEnv(loadEnv({ ...base, ...env } as unknown as NodeJS.ProcessEnv));

const CONFIG: GanchoAntesDoTurnoConfig = { url: "http://gancho.teste/turno", segredo: "s3gr3do", prazoMs: 100 };
const PEDIDO: PedidoDoGancho = {
  versao: 1,
  evento: "turno",
  organizacao_id: ORG,
  agente_id: null,
  conversa: { id: CONV, canal: "meta", pessoa_atendendo: false, ultima_entrada_em: null },
  lead: { id: null, etapa: null, campos: {}, etiquetas: [] },
  mensagens: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("o ambiente liga o gancho; sem a URL, nada", () => {
  it("sem AGENT_PRE_TURN_HOOK_URL o knob nem existe (o turno é o de antes)", () => {
    expect("ganchoAntesDoTurno" in knobs({})).toBe(false);
    expect("ganchoAntesDoTurno" in knobs({ AGENT_PRE_TURN_HOOK_URL: "", AGENT_PRE_TURN_HOOK_SECRET: "x" })).toBe(false);
  });

  it("URL e segredo: liga, com prazo padrão de 4.000 ms ou o configurado", () => {
    expect(knobs({ AGENT_PRE_TURN_HOOK_URL: "https://porteiro.exemplo/turno", AGENT_PRE_TURN_HOOK_SECRET: "x" }).ganchoAntesDoTurno).toEqual({
      url: "https://porteiro.exemplo/turno",
      segredo: "x",
      prazoMs: 4000,
    });
    expect(
      knobs({
        AGENT_PRE_TURN_HOOK_URL: "http://porteiro:8090/turno",
        AGENT_PRE_TURN_HOOK_SECRET: "x",
        AGENT_PRE_TURN_HOOK_TIMEOUT_MS: "1500",
      }).ganchoAntesDoTurno?.prazoMs,
    ).toBe(1500);
  });

  it("URL inválida ou sem segredo: desligado, sem derrubar o boot", () => {
    expect(knobs({ AGENT_PRE_TURN_HOOK_URL: "nao-e-url", AGENT_PRE_TURN_HOOK_SECRET: "x" }).ganchoAntesDoTurno).toBeUndefined();
    expect(knobs({ AGENT_PRE_TURN_HOOK_URL: "ftp://x/y", AGENT_PRE_TURN_HOOK_SECRET: "x" }).ganchoAntesDoTurno).toBeUndefined();
    expect(knobs({ AGENT_PRE_TURN_HOOK_URL: "https://porteiro.exemplo/turno" }).ganchoAntesDoTurno).toBeUndefined();
  });
});

describe("assinatura e chamada", () => {
  it("`t=<unix>,v1=<hmac>` confere com HMAC-SHA256(segredo, \"<t>.\" + corpo)", () => {
    const corpo = JSON.stringify(PEDIDO);
    const esperado = createHmac("sha256", CONFIG.segredo).update(`1790000000.${corpo}`, "utf8").digest("hex");
    expect(assinaturaDoGancho(CONFIG.segredo, corpo, 1790000000)).toBe(`t=1790000000,v1=${esperado}`);
  });

  it("o POST leva o JSON do pedido e a assinatura dele", async () => {
    const fetchMock = vi.fn(async (..._a: unknown[]) => new Response(JSON.stringify({ acao: "seguir" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await chamarGancho(CONFIG, PEDIDO, () => 1790000000);
    expect(r).toEqual({ ok: true, resposta: { acao: "seguir" } });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(CONFIG.url);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(PEDIDO));
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Hook-Signature"]).toBe(assinaturaDoGancho(CONFIG.segredo, JSON.stringify(PEDIDO), 1790000000));
  });

  it("prazo, rede, status fora de 2xx, JSON quebrado e contrato violado viram falha com motivo", async () => {
    const casos: Array<[() => Promise<Response>, string]> = [
      [() => new Promise<Response>(() => {}), "prazo"],
      [async () => Promise.reject(new TypeError("fetch failed")), "rede"],
      [async () => new Response("{}", { status: 500 }), "status"],
      [async () => new Response('{"acao":', { status: 200 }), "resposta_invalida"],
      [async () => new Response(JSON.stringify({ acao: "segurar", enviar: [] }), { status: 200 }), "resposta_invalida"],
      [async () => new Response(JSON.stringify({ acao: "pular" }), { status: 200 }), "resposta_invalida"],
      [
        async () =>
          new Response(JSON.stringify({ acao: "segurar", enviar: [{ tipo: "interativo", interactive: {} }] }), { status: 200 }),
        "resposta_invalida",
      ],
      [
        async () =>
          new Response(JSON.stringify({ acao: "seguir", gravar: { campos: { grande: "x".repeat(20_000) } } }), { status: 200 }),
        "resposta_invalida",
      ],
    ];
    for (const [resposta, motivo] of casos) {
      vi.stubGlobal("fetch", vi.fn((_u: unknown, init: RequestInit) => {
        // O prazo real: o `AbortSignal.timeout` do gancho derruba a espera.
        const espera = resposta();
        return Promise.race([
          espera,
          new Promise<Response>((_, rejeita) => init.signal?.addEventListener("abort", () => rejeita(init.signal!.reason))),
        ]);
      }));
      expect(await chamarGancho(CONFIG, PEDIDO)).toMatchObject({ ok: false, motivo });
    }
  });
});

describe("o pedido não leva dado pessoal", () => {
  it("campo do card com nome de telefone, e-mail ou nome fica de fora; o resto passa", () => {
    for (const k of ["telefone", "Telefone_2", "phone", "celular", "whatsapp", "email", "E-mail", "email_alternativo", "nome", "Nome Completo", "name", "cpf"])
      expect(chaveEDadoPessoal(k)).toBe(true);
    for (const k of ["interesse", "nome_do_produto", "origem", "enviado_em", "pergunta_1", "_interno"])
      expect(chaveEDadoPessoal(k)).toBe(false);
  });

  it("`montarPedidoDoGancho` não lê o contato e filtra os campos do card", async () => {
    const consultas: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        consultas.push(sql);
        if (sql.includes("from conversations c"))
          return { rows: [{ assignee_kind: "user", assigned_to_user_id: null, last_inbound_at: new Date("2026-07-30T14:55:00Z"), provider: "meta_cloud" }] };
        if (sql.includes("from crm_leads l"))
          return {
            rows: [
              {
                id: "card-1", organization_id: ORG, pipeline_id: "p1", status: "open", last_activity_at: null,
                created_at: new Date("2026-07-01T00:00:00Z"), custom_fields: { interesse: "plano-b", telefone: "+5511999990000", nome: "Ana" },
                tags: ["Etiqueta-Antiga"], etapa: "novo",
              },
            ],
          };
        if (sql.includes("from crm_pipelines")) return { rows: [{ id: "p1" }] };
        if (sql.includes("as em") && sql.includes("limit $3"))
          return {
            rows: [
              { direction: "outbound", type: "text", body: "Responda o formulário", interativo: { type: "flow" }, em: new Date("2026-07-30T14:56:00Z") },
              { direction: "inbound", type: "image", body: null, interativo: null, em: new Date("2026-07-30T14:55:00Z") },
            ],
          };
        return { rows: [] };
      }),
    };
    const { pedido, canalEnviaInterativo } = await montarPedidoDoGancho(db as never, {
      organizationId: ORG,
      contactId: CONTATO,
      conversationId: CONV,
      channelSessionId: SESSAO,
      agentId: "agente-1",
      inboundMessageId: null,
      etiquetasDoContato: ["cliente"],
    });
    expect(consultas.some((s) => /from contacts/.test(s))).toBe(false);
    expect(canalEnviaInterativo).toBe(true);
    expect(pedido).toEqual({
      versao: 1,
      evento: "turno",
      organizacao_id: ORG,
      agente_id: "agente-1",
      conversa: { id: CONV, canal: "meta", pessoa_atendendo: true, ultima_entrada_em: "2026-07-30T14:55:00.000Z" },
      lead: { id: "card-1", etapa: "novo", campos: { interesse: "plano-b" }, etiquetas: ["etiqueta-antiga", "cliente"] },
      mensagens: [
        { direcao: "entrada", texto: "[image]", em: "2026-07-30T14:55:00.000Z", interativo: null },
        { direcao: "saida", texto: "Responda o formulário", em: "2026-07-30T14:56:00.000Z", interativo: { type: "flow" } },
      ],
    });
  });
});

describe("7. canal que não envia interativo: o gancho não tenta, e o turno segue para o modelo", () => {
  it("`segurar` com formulário num canal não oficial: nada vai ao canal, decisão anotada como `modelo`", async () => {
    const updates: unknown[][] = [];
    const db = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes("update job_queue")) updates.push(params ?? []);
        if (sql.includes("max(created_at)::text")) return { rows: [{ em: "2026-07-30 14:55:00+00" }] };
        if (sql.includes("from conversations c"))
          return { rows: [{ assignee_kind: null, assigned_to_user_id: null, last_inbound_at: null, provider: "waha" }] };
        return { rows: [] };
      }),
    };
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ acao: "segurar", enviar: [{ tipo: "interativo", interactive: { type: "flow", body: { text: "oi" } } }] }), { status: 200 }),
    ));
    const send = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const desfecho = await rodarGanchoAntesDoTurno({
      pool: db as never,
      log,
      config: CONFIG,
      job: { id: "job-1", organization_id: ORG, payload: {}, kind: "inbound_turn" } as unknown as JobRow,
      tenantId: ORG,
      contactId: CONTATO,
      conversationId: CONV,
      channelSessionId: SESSAO,
      inboundMessageId: null,
      agentId: null,
      etiquetasDoContato: [],
      channel: { send } as never,
      optedOutThisTurn: false,
      now: () => new Date("2026-07-30T15:00:00Z"),
    });
    expect(desfecho).toEqual({ fim: false });
    expect(send).not.toHaveBeenCalled();
    expect(JSON.parse(String(updates.at(-1)![3]))).toEqual({ situacao: "modelo", motivo: "canal_sem_interativo" });
    expect(log.warn.mock.calls.map((c) => c[0])).toContain(
      "gancho antes do turno: canal sem mensagem interativa — o turno segue para o modelo",
    );
  });
});

describe("os campos do card que o modelo lê", () => {
  it("sem chave `_`, sem objeto, texto curto, lista simples vira texto, tetos de chaves e de tamanho", () => {
    expect(
      camposCompactosDoCard({
        interesse: "plano-b",
        _interno: "x",
        bruto: { a: 1 },
        vazio: "  ",
        nulo: null,
        lista: ["a", "b"],
        lista_mista: ["a", { b: 1 }],
        longo: "y".repeat(500),
        numero: 3,
        sim: true,
      }),
    ).toEqual({ interesse: "plano-b", lista: "a, b", longo: "y".repeat(120), numero: 3, sim: true });
    const muitos = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`campo_${i}`, "valor"]));
    expect(Object.keys(camposCompactosDoCard(muitos))).toHaveLength(20);
    const grandes = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`c${i}`, "z".repeat(119)]));
    expect(JSON.stringify(camposCompactosDoCard(grandes)).length).toBeLessThanOrEqual(800);
  });
});

describe("o resumo no contexto já lido pelo turno", () => {
  it("troca a mensagem do formulário (pelo instante), e só ela", () => {
    const fuso = "America/Sao_Paulo";
    const msgs: LeadContextMessage[] = [
      { direction: "inbound", body: "Formulário respondido", sent_at: "2026-07-01T10:00:00-03:00" },
      { direction: "inbound", body: "Formulário respondido", sent_at: "2026-07-30T11:58:00-03:00" },
      { direction: "outbound", body: "Formulário respondido", sent_at: "2026-07-30T11:59:00-03:00" },
    ];
    expect(trocarResumoNoContexto(msgs, { sentAt: "2026-07-01T13:00:00.000Z", resumo: "Resumo antigo" }, fuso)).toBe(true);
    expect(msgs.map((x) => x.body)).toEqual(["Resumo antigo", "Formulário respondido", "Formulário respondido"]);
  });
});

describe("o envio do gancho no ledger e na linha da conversa", () => {
  const FLOW = { type: "flow", body: { text: "Responda" }, action: { name: "flow", parameters: { flow_id: "1" } } };

  it("o hash do interativo ignora o texto do balão (a apresentação o emenda só na 1ª execução)", () => {
    const emendado = { ...FLOW, body: { text: "Sou a assistente virtual. Responda" } };
    expect(hashDoConteudo({ body: emendado.body.text, identidade: "Responda", interactive: emendado } as never)).toBe(
      hashDoConteudo({ body: "Responda", interactive: FLOW } as never),
    );
    const outro = { ...FLOW, action: { name: "flow", parameters: { flow_id: "2" } } };
    expect(hashDoConteudo({ body: "Responda", interactive: outro } as never)).not.toBe(
      hashDoConteudo({ body: "Responda", interactive: FLOW } as never),
    );
  });

  it("`origem` vai a `metadata.origem` da linha", () => {
    const base = { tenantId: ORG, leadId: CONTATO, jobId: "job", seq: -1, conversationId: CONV, body: "Responda" };
    expect(corpoDoEnvio({ ...base, interactive: FLOW, origem: "pre_turn_hook" }, "k").metadata).toEqual({
      idempotency_key: "k",
      origem: "pre_turn_hook",
    });
  });
});

describe("a ligação no turno", () => {
  const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const trecho = turno.slice(turno.indexOf("marca.desviosConferidos = true;"), turno.indexOf("const roteiro ="));

  it("depois dos desvios determinísticos e antes do roteiro, só em `inbound_turn`, fora da prévia e do contato bloqueado", () => {
    expect(trecho).toContain("rodarGanchoAntesDoTurno(");
    expect(trecho).toMatch(
      /if \(gancho !== undefined && !preview && liveJob\(\)\.kind === 'inbound_turn' && !optedOutThisTurn\)/,
    );
    expect(trecho).toMatch(/const gancho = deps\.knobs\.ganchoAntesDoTurno;/);
    expect(trecho).toMatch(/if \(desfechoDoGancho\.fim\) return;/);
  });
});
