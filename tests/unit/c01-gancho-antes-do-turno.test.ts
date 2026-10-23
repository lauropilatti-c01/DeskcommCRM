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
  TETO_DO_MOTIVO,
  TETO_DO_RESUMO,
  trocarResumoNoContexto,
  type GanchoAntesDoTurnoConfig,
  type PedidoDoGancho,
} from "@/lib/agent-engine/agent/gancho-antes-do-turno";
import { inboundsNaoRespondidos, semRespostasDeFormulario } from "@/lib/agent-engine/agent/inbound-turn";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";
import { camposCompactosDoCard } from "@/lib/agent-engine/edge/crm/card-do-contato";
import {
  COLUNAS_DO_FORMULARIO,
  corpoDaMensagem,
  getLeadContext,
  MARCA_DE_PROCESSADO,
  type LeadContextMessage,
} from "@/lib/agent-engine/edge/crm/get-lead-context";
import { textoDaRespostaDeFormulario } from "@/lib/channels/interativo";
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
  celular_de_teste: false,
  caso_aberto: false,
  caso_aberto_lido: true,
  contato_id: CONTATO,
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

  it("`segurar` com `enviar: []` está no contrato (o silêncio de propósito)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ acao: "segurar", enviar: [] }), { status: 200 })));
    expect(await chamarGancho(CONFIG, PEDIDO)).toEqual({ ok: true, resposta: { acao: "segurar", enviar: [] } });
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
      [async () => new Response(JSON.stringify({ acao: "segurar" }), { status: 200 }), "resposta_invalida"],
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

  it("`montarPedidoDoGancho` não põe dado do contato no pedido e filtra os campos do card", async () => {
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
        if (sql.includes("from agent_cases")) return { rows: [{ aberto: true }] };
        if (sql.includes("as em") && sql.includes("limit $3"))
          return {
            rows: [
              {
                direction: "outbound", type: "text", body: "Responda o formulário", interativo: { type: "flow" },
                em: new Date("2026-07-30T14:56:00Z"), situacao: "failed", erro: "131026",
              },
              { direction: "inbound", type: "image", body: null, interativo: null, em: new Date("2026-07-30T14:55:00Z"), situacao: "delivered", erro: null },
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
    // (-c01.15) O contato só é lido pela conferência do celular de teste (telefone e
    // etiquetas, para o `celular_de_teste`); nome, e-mail e telefone não vão ao pedido.
    const doContato = consultas.filter((s) => /from contacts/.test(s));
    expect(doContato).toHaveLength(1);
    expect(doContato[0]).toMatch(/as etiquetas/);
    expect(doContato[0]).not.toMatch(/\bname\b|email/);
    expect(canalEnviaInterativo).toBe(true);
    expect(pedido).toEqual({
      versao: 1,
      evento: "turno",
      organizacao_id: ORG,
      agente_id: "agente-1",
      conversa: { id: CONV, canal: "meta", pessoa_atendendo: true, ultima_entrada_em: "2026-07-30T14:55:00.000Z" },
      celular_de_teste: false,
      caso_aberto: true,
      caso_aberto_lido: true,
      contato_id: CONTATO,
      lead: { id: "card-1", etapa: "novo", campos: { interesse: "plano-b" }, etiquetas: ["etiqueta-antiga", "cliente"] },
      mensagens: [
        { direcao: "entrada", texto: "[image]", em: "2026-07-30T14:55:00.000Z", interativo: null, status: "delivered" },
        {
          direcao: "saida", texto: "Responda o formulário", em: "2026-07-30T14:56:00.000Z", interativo: { type: "flow" },
          status: "failed", erro: "131026",
        },
      ],
    });
    // A situação vem da linha (falha que a Meta avisou depois, entrega, leitura); do
    // erro, só o código: o texto do erro não é lido.
    const sqlDasMensagens = consultas.find((c) => c.includes("as em") && c.includes("limit $3"))!;
    expect(sqlDasMensagens).toMatch(/case when status = 'failed' then error_code end as erro/);
    expect(sqlDasMensagens).not.toMatch(/error_message/);
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
    expect(JSON.parse(String(updates.at(-1)![3]))).toEqual({
      situacao: "modelo",
      motivo: "canal_sem_interativo",
      ate: "2026-07-30 14:55:00+00",
    });
    expect(log.warn.mock.calls.map((c) => c[0])).toContain(
      "gancho antes do turno: canal sem mensagem interativa — o turno segue para o modelo",
    );
  });
});

describe("os campos do card que o modelo lê", () => {
  it("dado pessoal (telefone, nome, e-mail, cpf e variantes) e texto com cara de JSON ficam de fora", () => {
    expect(
      camposCompactosDoCard({
        interesse: "plano-b",
        telefone: "+5511999990000",
        Celular_2: "+5511988880000",
        whatsapp_alternativo: "+5511977770000",
        nome: "Ana",
        "Nome Completo": "Ana Lima",
        email: "ana@teste.example",
        "E-mail": "ana2@teste.example",
        cpf: "000.000.000-00",
        qualificacao_datas: '{"inicio":"2026-07-01","fim":"2026-07-30"}',
        lista_em_json: '["a","b"]',
        nome_do_produto: "Plano B",
      }),
    ).toEqual({ interesse: "plano-b", nome_do_produto: "Plano B" });
  });

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
    ).toEqual({ interesse: "plano-b", lista: "a, b", longo: "y".repeat(119) + "…", numero: 3, sim: true });
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

  it("acha a resposta pela marca de formulário, com as respostas montadas no lugar do texto neutro", () => {
    const fuso = "America/Sao_Paulo";
    const msgs: LeadContextMessage[] = [
      { direction: "inbound", body: "Resumo de antes", sent_at: "2026-07-01T10:00:00-03:00", formulario: true },
      { direction: "inbound", body: "Formulário respondido:\npergunta_1: opcao_a", sent_at: "2026-07-30T11:58:00-03:00", formulario: true },
    ];
    // Sem o instante (precisão diferente): a mais nova ainda sem resumo.
    expect(trocarResumoNoContexto(msgs, { sentAt: null, resumo: "Resumo novo" }, fuso)).toBe(true);
    expect(msgs.map((x) => x.body)).toEqual(["Resumo de antes", "Resumo novo"]);
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

describe("contrato tolerante: resumo e motivo", () => {
  const responde = (corpo: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(corpo), { status: 200 })));

  it("`resumo` vazio ou só espaço vale ausente; acima do teto, cortado; `motivo` longo, cortado — a resposta vale", async () => {
    responde({ acao: "seguir", resumo: "   ", motivo: "m".repeat(500) });
    const vazio = await chamarGancho(CONFIG, PEDIDO);
    expect(vazio.ok).toBe(true);
    if (!vazio.ok) return;
    expect(vazio.resposta.resumo ?? null).toBeNull();
    expect(vazio.resposta.motivo).toBe("m".repeat(TETO_DO_MOTIVO));

    responde({ acao: "seguir", resumo: `  ${"r".repeat(TETO_DO_RESUMO + 900)}  ` });
    const longo = await chamarGancho(CONFIG, PEDIDO);
    expect(longo.ok).toBe(true);
    if (!longo.ok) return;
    expect(longo.resposta.resumo).toBe("r".repeat(TETO_DO_RESUMO));
  });
});

describe("a resposta do formulário que o modelo lê sem o resumo do gancho", () => {
  const RESPOSTA = {
    flow_token: "tok-teste",
    pergunta_1: "opcao_a",
    pergunta_2: ["opcao_b", "opcao_c"],
    vazia: "  ",
    numero: 3,
  };

  it("uma resposta por linha (`chave: valor`), sem o `flow_token`; a mesma resposta dá o mesmo texto", () => {
    const esperado = "Formulário respondido:\npergunta_1: opcao_a\npergunta_2: opcao_b, opcao_c\nnumero: 3";
    expect(textoDaRespostaDeFormulario(RESPOSTA)).toBe(esperado);
    expect(textoDaRespostaDeFormulario({ ...RESPOSTA })).toBe(esperado);
    expect(textoDaRespostaDeFormulario(null)).toBe("Formulário respondido");
    expect(textoDaRespostaDeFormulario({ flow_token: "x" })).toBe("Formulário respondido");
  });

  it("o corpo da linha (histórico e linha do job) é o texto montado só enquanto ela tem o texto neutro", () => {
    const linha = { type: "text", media_url: null, media_storage_path: null, media_derived_text: null };
    expect(
      corpoDaMensagem({ ...linha, body: "Formulário respondido", e_formulario: true, formulario_resposta: RESPOSTA }),
    ).toBe(textoDaRespostaDeFormulario(RESPOSTA));
    // Com o resumo do gancho na linha, o resumo.
    expect(
      corpoDaMensagem({ ...linha, body: "Resumo do formulário", e_formulario: true, formulario_resposta: RESPOSTA }),
    ).toBe("Resumo do formulário");
    // Texto igual ao neutro numa mensagem que não é formulário: fica como está.
    expect(corpoDaMensagem({ ...linha, body: "Formulário respondido", e_formulario: false })).toBe("Formulário respondido");
  });

  it("3ª rodada: processada pelo gancho, vale o corpo gravado, mesmo o texto neutro (formulário inválido)", () => {
    const linha = { type: "text", media_url: null, media_storage_path: null, media_derived_text: null };
    expect(
      corpoDaMensagem({
        ...linha,
        body: "Formulário respondido",
        e_formulario: true,
        formulario_resposta: RESPOSTA,
        formulario_processado: true,
      }),
    ).toBe("Formulário respondido");
    // A coluna sai das colunas do formulário, que o histórico e a linha do job leem.
    expect(COLUNAS_DO_FORMULARIO).toContain(
      `coalesce(metadata->>'${MARCA_DE_PROCESSADO}', '') = 'true' as formulario_processado`,
    );
    expect(MARCA_DE_PROCESSADO).toBe("gancho_processado");
  });

  it("3ª rodada: a chave com nome de dado pessoal fica fora do texto montado", () => {
    expect(
      textoDaRespostaDeFormulario({
        flow_token: "tok-teste",
        pergunta_1: "opcao_a",
        nome: "Ana",
        "Nome Completo": "Ana Lima",
        telefone: "+5511999990000",
        whatsapp_2: "+5511988880000",
        "E-mail": "ana@teste.example",
        cpf: "000.000.000-00",
        nome_do_produto: "Plano B",
      }),
    ).toBe("Formulário respondido:\npergunta_1: opcao_a\nnome_do_produto: Plano B");
  });
});

describe("resposta de formulário fora das checagens determinísticas", () => {
  it("o resumo (ou as respostas) com cara de pedido de humano não entra nos inbounds que as checagens leem", () => {
    const msgs: LeadContextMessage[] = [
      { direction: "outbound", body: "Oi!", sent_at: "2026-07-30T11:50:00-03:00" },
      { direction: "inbound", body: "Prefere falar com um atendente", sent_at: "2026-07-30T11:55:00-03:00", formulario: true },
      { direction: "inbound", body: "ok, obrigado", sent_at: "2026-07-30T11:56:00-03:00" },
    ];
    expect(inboundsNaoRespondidos(semRespostasDeFormulario(msgs))).toEqual(["ok, obrigado"]);
    // O formulário continua no contexto (o modelo e a tela o veem): só a lista o deixa de fora.
    expect(semRespostasDeFormulario(msgs)).toHaveLength(2);
    expect(msgs).toHaveLength(3);
  });
});

describe("os campos do card só entram no contexto com o gancho ligado", () => {
  function dbComCard() {
    const consultas: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        consultas.push(sql);
        if (sql.includes("from contacts"))
          return {
            rows: [{
              name: "Ana", display_name: null, email: null, phone_number: "5511", tags: [], is_blocked: false,
              source: "whatsapp", consent: null, is_anonymized: false,
            }],
          };
        if (sql.includes("from crm_leads l"))
          return {
            rows: [{
              id: "card-1", organization_id: ORG, pipeline_id: "p1", status: "open", last_activity_at: null,
              created_at: new Date("2026-07-01T00:00:00Z"), custom_fields: { interesse: "plano-b", telefone: "+5511999990000" },
              tags: [], etapa: "novo",
            }],
          };
        if (sql.includes("from crm_pipelines")) return { rows: [{ id: "p1" }] };
        return { rows: [] };
      }),
    };
    return { db, consultas };
  }
  const INPUT = { tenantId: ORG, leadId: CONTATO, conversationId: CONV, fuso: "America/Sao_Paulo" };
  const KNOBS = { historyLimit: 20, maxTokens: 4000 };

  it("sem o pedido (gancho desligado): nem a consulta ao card, nem o bloco — o contexto da -c01.3", async () => {
    const { db, consultas } = dbComCard();
    const r = await getLeadContext(db as never, {} as never, INPUT, KNOBS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("campos_do_card" in r.context).toBe(false);
    expect(consultas.some((c) => c.includes("from crm_leads"))).toBe(false);
  });

  it("com o pedido: o bloco, sem o telefone do card", async () => {
    const { db } = dbComCard();
    const r = await getLeadContext(db as never, {} as never, { ...INPUT, camposDoCard: true }, KNOBS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.campos_do_card).toEqual({ interesse: "plano-b" });
  });

  it("o turno pede os campos só quando o knob do gancho existe", () => {
    const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    expect(turno.match(/camposDoCard: deps\.knobs\.ganchoAntesDoTurno !== undefined/g)).toHaveLength(2);
  });
});
