/**
 * (C01, -c01.15, P8) O `#zerar` DO CELULAR DE TESTE PASSA ANTES DO BLOQUEIO.
 *
 * O comando é atendido pelo gancho antes do turno, que roda dentro do turno — e o
 * turno nunca chega com a conversa calada (passagem ao humano) ou o contato
 * bloqueado (opt-out). Agora a ingestão destrava o celular de teste antes do
 * despacho: tira o bloqueio de opt-out e devolve as conversas à IA pela regra do
 * botão da tela (`devolverAtendimentoAoAgente`). Sem a etiqueta, nada muda.
 *
 * O banco é um fake em memória (três tabelas e as RPCs); a devolução é a de
 * `lib/escalacao/retomada.ts`, substituída por um dublê que aplica o efeito que ela
 * promete (dono humano solto, silêncio nulo, `force_human` falso), porque o que se
 * prova aqui é QUEM a chama e QUANDO, não a devolução em si.
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EntradaDeMensagem } from "@/lib/channels/pos-entrada";

const audit = vi.fn(async (_entrada: Record<string, unknown>) => {});
const devolver = vi.fn();

vi.mock("@/lib/audit", () => ({ audit: (e: Record<string, unknown>) => audit(e) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: vi.fn(async () => {
    sequencia.push("lead");
    return { criado: false, motivo: "ja_existe" };
  }),
}));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarPipelineDeEventos: vi.fn(async () => {}),
  kickLocalPipeline: vi.fn(async () => {}),
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehContatoDoNumeroInterno: vi.fn(async () => false),
}));
vi.mock("@/lib/escalacao/retomada", () => ({
  devolverAtendimentoAoAgente: (...a: unknown[]) => devolver(...a),
}));

type Linha = Record<string, unknown>;
let tabelas: Record<string, Linha[]> = {};
let sequencia: string[] = [];
let escritas: Array<{ tabela: string; payload: Linha }> = [];

/** Builder encadeável do PostgREST: filtros `eq`, efeito no `await` ou no `maybeSingle`. */
function consulta(tabela: string, acao: { tipo: "select" } | { tipo: "update"; payload: Linha }) {
  const filtros: Array<[string, unknown]> = [];
  const linhas = () =>
    (tabelas[tabela] ?? []).filter((l) => filtros.every(([coluna, valor]) => l[coluna] === valor));
  const executar = () => {
    if (acao.tipo === "update") {
      sequencia.push(`update:${tabela}`);
      escritas.push({ tabela, payload: acao.payload });
      for (const l of linhas()) Object.assign(l, acao.payload);
      return { data: null, error: null };
    }
    sequencia.push(`select:${tabela}`);
    return { data: linhas().map((l) => ({ ...l })), error: null };
  };
  const builder: Record<string, unknown> = {
    eq(coluna: string, valor: unknown) {
      filtros.push([coluna, valor]);
      return builder;
    },
    is(coluna: string, valor: unknown) {
      filtros.push([coluna, valor]);
      return builder;
    },
    select() {
      return builder;
    },
    order() {
      return builder;
    },
    limit() {
      return builder;
    },
    async maybeSingle() {
      const r = executar();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error };
    },
    then(resolve: (v: unknown) => void) {
      return Promise.resolve(executar()).then(resolve);
    },
  };
  return builder;
}

const admin = {
  from(tabela: string) {
    return {
      select: () => consulta(tabela, { tipo: "select" }),
      update: (payload: Linha) => consulta(tabela, { tipo: "update", payload }),
    };
  },
  async rpc(nome: string, args: Record<string, unknown>) {
    sequencia.push(`rpc:${(args.p_event_type as string | undefined) ?? nome}`);
    return { error: null };
  },
} as never;

const ORG = "org-1";
const CONTATO = "contato-1";
const CONVERSA = "conversa-1";

const ENTRADA: EntradaDeMensagem = {
  organizationId: ORG,
  contactId: CONTATO,
  conversationId: CONVERSA,
  messageId: "msg-1",
  channelSessionId: "sessao-1",
  texto: "#zerar",
  nomeDoContato: null,
  requestId: "req-1",
  origem: "canal_de_teste",
};

function contato(over: Linha = {}): Linha {
  return {
    organization_id: ORG,
    id: CONTATO,
    tags: ["celular-de-teste"],
    force_human: true,
    is_blocked: true,
    blocked_reason: "stop_keyword",
    blocked_at: "2026-10-15T12:00:00Z",
    ...over,
  };
}

function conversa(over: Linha = {}): Linha {
  return {
    organization_id: ORG,
    id: CONVERSA,
    contact_id: CONTATO,
    bot_silenced_until: "infinity",
    assignee_kind: "ai",
    assigned_to_user_id: null,
    ...over,
  };
}

const oContato = () => tabelas.contacts!.find((l) => l.id === CONTATO)!;
const aConversa = (id = CONVERSA) => tabelas.conversations!.find((l) => l.id === id)!;

async function zerar(over: Partial<EntradaDeMensagem> = {}) {
  const { zerarCelularDeTesteSePedido } = await import("@/lib/c01/zerar-celular-de-teste");
  return zerarCelularDeTesteSePedido(admin, { ...ENTRADA, ...over });
}

async function posEntrada(over: Partial<EntradaDeMensagem> = {}) {
  const { aplicarEfeitosPosEntrada } = await import("@/lib/channels/pos-entrada");
  await aplicarEfeitosPosEntrada(admin, { ...ENTRADA, ...over });
}

beforeEach(() => {
  tabelas = { contacts: [contato()], crm_leads: [], conversations: [conversa()] };
  sequencia = [];
  escritas = [];
  audit.mockClear();
  devolver.mockReset();
  // O efeito que `devolverAtendimentoAoAgente` promete, aplicado ao fake.
  devolver.mockImplementation(async (deps: { organizationId: string }, input: { conversationId: string }) => {
    sequencia.push(`devolver:${input.conversationId}`);
    const alvo = tabelas.conversations!.find(
      (l) => l.id === input.conversationId && l.organization_id === deps.organizationId,
    );
    if (alvo === undefined) return { ok: false, erro: "conversation_not_found" };
    Object.assign(alvo, { bot_silenced_until: null, assignee_kind: "ai", assigned_to_user_id: null });
    const dono = tabelas.contacts!.find((l) => l.id === alvo.contact_id);
    if (dono !== undefined) dono.force_human = false;
    return { ok: true, conversationId: input.conversationId, jaEstavaComOAgente: false, continuidade: {} };
  });
});

describe("(C01, P8) #zerar do celular de teste", () => {
  it("com a etiqueta no contato: a conversa volta à IA e o bloqueio de opt-out sai", async () => {
    const r = await zerar();

    expect(r).toEqual({ aplicado: true, conversasDevolvidas: 1, desbloqueado: true });
    expect(aConversa().bot_silenced_until).toBeNull();
    expect(oContato().force_human).toBe(false);
    expect(oContato()).toMatchObject({ is_blocked: false, blocked_reason: null, blocked_at: null });
    // A devolução é a do botão da tela, com a origem do canal como ator.
    expect(devolver).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        actor: { type: "webhook_source", id: "sessao-1" },
        requestId: "req-1",
      }),
      { conversationId: CONVERSA },
    );
    // O desbloqueio fica no log de auditoria, como na rota da tela, sem telefone.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.unblocked",
        organizationId: ORG,
        resourceId: CONTATO,
        metadata: { contact_id: CONTATO, origem: "zerar_celular_de_teste" },
      }),
    );
  });

  it("a etiqueta só no card do contato também vale", async () => {
    tabelas.contacts = [contato({ tags: [] })];
    tabelas.crm_leads = [{ organization_id: ORG, contact_id: CONTATO, tags: ["  Celular-de-Teste "] }];

    const r = await zerar();

    expect(r.aplicado).toBe(true);
    expect(oContato().is_blocked).toBe(false);
    expect(aConversa().bot_silenced_until).toBeNull();
  });

  it("SEM a etiqueta: nenhuma escrita e nenhuma devolução", async () => {
    tabelas.contacts = [contato({ tags: ["cliente"] })];
    tabelas.crm_leads = [{ organization_id: ORG, contact_id: CONTATO, tags: ["lead-quente"] }];

    const r = await zerar();

    expect(r).toEqual({ aplicado: false, motivo: "sem_etiqueta", conversasDevolvidas: 0, desbloqueado: false });
    expect(escritas).toEqual([]);
    expect(devolver).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(oContato()).toMatchObject({ is_blocked: true, force_human: true });
  });

  it("a etiqueta de OUTRA organização não vale", async () => {
    tabelas.crm_leads = [{ organization_id: "org-2", contact_id: CONTATO, tags: ["celular-de-teste"] }];
    tabelas.contacts = [contato({ tags: [] })];

    expect((await zerar()).aplicado).toBe(false);
    expect(escritas).toEqual([]);
  });

  it("só o comando exato age: maiúsculas e espaços nas pontas valem, texto a mais não", async () => {
    for (const texto of ["#zerar agora", "zerar", "# zerar", "#zerar!", "", null]) {
      const r = await zerar({ texto });
      expect(r, `"${String(texto)}" agiu`).toMatchObject({ aplicado: false, motivo: "nao_e_zerar" });
    }
    // Sem o comando, nem uma consulta: o caminho de toda mensagem não muda.
    expect(sequencia).toEqual([]);

    const r = await zerar({ texto: "  #ZERAR \n" });
    expect(r.aplicado).toBe(true);
  });

  it("bloqueio com outro motivo NÃO é tirado (só o de opt-out)", async () => {
    tabelas.contacts = [contato({ blocked_reason: "manual" })];

    const r = await zerar();

    expect(r.desbloqueado).toBe(false);
    expect(oContato()).toMatchObject({ is_blocked: true, blocked_reason: "manual" });
    expect(audit).not.toHaveBeenCalled();
    // A conversa volta à IA do mesmo jeito.
    expect(aConversa().bot_silenced_until).toBeNull();
  });

  it("as outras conversas caladas do contato também voltam; as que já estão com a IA, não", async () => {
    tabelas.conversations = [
      conversa({ bot_silenced_until: null }),
      conversa({ id: "conversa-2", bot_silenced_until: "infinity" }),
      conversa({ id: "conversa-3", bot_silenced_until: null, assignee_kind: "user" }),
      conversa({ id: "conversa-4", bot_silenced_until: null }),
      conversa({ id: "conversa-5", contact_id: "outro", bot_silenced_until: "infinity" }),
    ];

    const r = await zerar();

    const devolvidas = devolver.mock.calls.map((c) => (c[1] as { conversationId: string }).conversationId);
    expect(devolvidas.sort()).toEqual(["conversa-1", "conversa-2", "conversa-3"]);
    expect(r.conversasDevolvidas).toBe(3);
    expect(aConversa("conversa-5").bot_silenced_until).toBe("infinity");
  });

  it("se a devolução falha, force_human é solto direto e nada lança", async () => {
    devolver.mockResolvedValue({ ok: false, erro: "assignment_conflict" });

    const r = await zerar();

    expect(r).toMatchObject({ aplicado: true, conversasDevolvidas: 0, desbloqueado: true });
    expect(oContato().force_human).toBe(false);
    expect(escritas).toContainEqual({ tabela: "contacts", payload: { force_human: false } });
  });

  it("a constante da etiqueta é a mesma do gancho antes do turno", async () => {
    const { ETIQUETA_DO_CELULAR_DE_TESTE } = await import("@/lib/c01/zerar-celular-de-teste");
    const gancho = readFileSync("lib/agent-engine/agent/gancho-antes-do-turno.ts", "utf8");
    expect(gancho).toContain(`export const ETIQUETA_DO_CELULAR_DE_TESTE = '${ETIQUETA_DO_CELULAR_DE_TESTE}';`);
  });
});

describe("(C01, P8) na ingestão (pos-entrada)", () => {
  it("o #zerar destrava ANTES do despacho do agente", async () => {
    await posEntrada();

    const destravou = sequencia.indexOf(`devolver:${CONVERSA}`);
    const desbloqueou = sequencia.indexOf("update:contacts");
    const despachou = sequencia.indexOf("rpc:ai_agent.dispatch_requested");
    expect(destravou).toBeGreaterThanOrEqual(0);
    expect(desbloqueou).toBeGreaterThanOrEqual(0);
    expect(despachou, "o agente não foi acordado").toBeGreaterThanOrEqual(0);
    expect(destravou).toBeLessThan(despachou);
    expect(desbloqueou).toBeLessThan(despachou);
    expect(oContato()).toMatchObject({ is_blocked: false, force_human: false });
  });

  it("'parar' do celular de teste continua gravando o bloqueio (opt-out inalterado)", async () => {
    tabelas.contacts = [contato({ is_blocked: false, blocked_reason: null, force_human: false })];

    await posEntrada({ texto: "PARAR" });

    expect(oContato()).toMatchObject({ is_blocked: true, blocked_reason: "stop_keyword" });
    expect(devolver).not.toHaveBeenCalled();
  });

  it("#zerar de número sem a etiqueta: o contato segue bloqueado e calado", async () => {
    tabelas.contacts = [contato({ tags: [] })];

    await posEntrada();

    expect(oContato()).toMatchObject({ is_blocked: true, force_human: true });
    expect(aConversa().bot_silenced_until).toBe("infinity");
    expect(devolver).not.toHaveBeenCalled();
  });
});
