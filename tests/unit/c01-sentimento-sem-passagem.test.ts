/**
 * (C01, -c01.15, P3) SENTIMENTO BAIXO SEM SILÊNCIO QUANDO A PASSAGEM ESTÁ DESLIGADA.
 *
 * O alerta de clima chamava `triggerHandoff` sempre, e ele cala a conversa para
 * sempre (`bot_silenced_until = 'infinity'`). Com a passagem desligada no agente da
 * conversa (`handoff_tool_enabled = false` na versão publicada), o handler abre um
 * caso para a equipe e a IA continua atendendo. Com a passagem ligada, sem agente
 * resolvido ou com erro de leitura, tudo como antes.
 *
 * O banco é um falso em memória: prova quem é chamado e o que é escrito, não o SQL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Linha = Record<string, unknown>;
const banco: Record<string, Linha[]> = {};
const escritas: Array<{ tabela: string; op: "insert" | "update"; linha: Linha }> = [];
const tabelasComErro = new Set<string>();

/** Um construtor de consulta do supabase-js, só com o que o código usa. */
function consulta(tabela: string) {
  const filtros: Array<(l: Linha) => boolean> = [];
  let inserir: Linha | null = null;
  let limite: number | null = null;
  const linhas = (): Linha[] => {
    const todas = (banco[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
    return limite === null ? todas : todas.slice(0, limite);
  };
  const executar = (): { data: unknown; error: { message: string } | null } => {
    if (tabelasComErro.has(tabela)) return { data: null, error: { message: `falha em ${tabela}` } };
    if (inserir !== null) {
      const nova = { id: `${tabela}-${(banco[tabela]?.length ?? 0) + 1}`, ...inserir };
      (banco[tabela] ??= []).push(nova);
      escritas.push({ tabela, op: "insert", linha: nova });
      return { data: [nova], error: null };
    }
    return { data: linhas(), error: null };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), b),
    is: (c: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) === v), b),
    not: (c: string, _op: string, v: unknown) => (filtros.push((l) => (l[c] ?? null) !== v), b),
    in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), b),
    order: () => b,
    limit: (n: number) => ((limite = n), b),
    insert: (l: Linha) => ((inserir = l), b),
    update: (l: Linha) => {
      escritas.push({ tabela, op: "update", linha: l });
      return b;
    },
    maybeSingle: async () => {
      const r = executar();
      return { data: (r.data as Linha[] | null)?.[0] ?? null, error: r.error };
    },
    single: async () => {
      const r = executar();
      return { data: (r.data as Linha[] | null)?.[0] ?? null, error: r.error };
    },
    then: (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
      Promise.resolve(executar()).then(ok, falha),
  };
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => consulta(t) }),
}));
const BOUNDARY = {
  organization_id: "org-1",
  contact_id: "contato-1",
  conversation_id: "conv-1",
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};
vi.mock("@/lib/atendimento/origem-mensagem", () => ({
  serviceFromMessage: vi.fn(async () => BOUNDARY),
}));
vi.mock("@/lib/atendimento/origem", () => ({
  assertServiceBoundarySupabase: vi.fn(async () => undefined),
}));
const elegibilidade = vi.fn(async () => ({ permite: true, motivo: "gate_aberto", bloqueioPorAllowlist: false }));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: () => elegibilidade(),
}));
vi.mock("@/lib/ai/handoff/orchestrator", () => ({
  triggerHandoff: vi.fn(async () => ({ triggered: true, reason: "low_sentiment" })),
}));

import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { aiHandoffFromSentimentHandler } from "@/workers/ai-handoff-from-sentiment.handler";

const alerta = () =>
  aiHandoffFromSentimentHandler.handle({
    organization_id: "org-1",
    entity_id: "msg-1",
    payload: { message_id: "msg-1", conversation_id: "conv-1", sentiment_score: 0.1, sentiment_engine: "jev" },
  } as unknown as EventRow);

/** Uma conversa ligada a um agente cuja versão publicada tem a passagem `ligada`. */
function cenario(opts: { passagem: boolean; fixado?: boolean }) {
  banco.conversations = [
    {
      id: "conv-1",
      organization_id: "org-1",
      active_ai_agent_id: opts.fixado === false ? null : "agente-1",
      channel_session_id: "conexao-1",
    },
  ];
  banco.ai_agents = [
    {
      id: "agente-1",
      organization_id: "org-1",
      published_version_id: "versao-1",
      archived_at: null,
      priority: 0,
      created_at: "2026-10-01T00:00:00Z",
    },
  ];
  banco.ai_agent_versions = [
    {
      id: "versao-1",
      organization_id: "org-1",
      status: "published",
      channel_session_id: "conexao-1",
      handoff_tool_enabled: opts.passagem,
    },
  ];
  banco.crm_leads = [];
}

const casos = () => escritas.filter((e) => e.tabela === "agent_cases" && e.op === "insert");

beforeEach(() => {
  for (const t of Object.keys(banco)) delete banco[t];
  escritas.length = 0;
  tabelasComErro.clear();
  vi.mocked(triggerHandoff).mockClear();
  elegibilidade.mockClear();
});

describe("(C01) sentimento baixo com a passagem desligada", () => {
  it("abre um caso para a equipe e NÃO chama triggerHandoff (sem silêncio, sem force_human)", async () => {
    cenario({ passagem: false });
    const r = await alerta();

    expect(r).toMatchObject({ status: "ok", detail: "caso_aberto_sem_passagem" });
    expect(triggerHandoff).not.toHaveBeenCalled();
    expect(casos()).toHaveLength(1);
    expect(casos()[0]!.linha).toMatchObject({
      organization_id: "org-1",
      conversation_id: "conv-1",
      source: "agent",
      kind: "outro",
      title: "Cliente insatisfeito (sentimento baixo)",
    });
    expect(String(casos()[0]!.linha.summary)).toContain("medido por jev");
    expect(escritas.filter((e) => e.tabela === "agent_case_events")[0]!.linha).toMatchObject({
      kind: "opened",
      actor_kind: "agent",
    });
    // Nada que cale a conversa: nenhuma escrita em conversations nem em contacts.
    expect(escritas.some((e) => e.tabela === "conversations" || e.tabela === "contacts")).toBe(false);
    expect(JSON.stringify(escritas)).not.toMatch(/bot_silenced_until|force_human/);
  });

  it("sem agente fixado, resolve pelo agente publicado da conexão", async () => {
    cenario({ passagem: false, fixado: false });
    const r = await alerta();

    expect(r.detail).toBe("caso_aberto_sem_passagem");
    expect(triggerHandoff).not.toHaveBeenCalled();
  });

  it("caso já aberto na conversa: não duplica, e o alerta conta como atendido", async () => {
    cenario({ passagem: false });
    banco.agent_cases = [
      { id: "caso-0", organization_id: "org-1", conversation_id: "conv-1", status: "awaiting_human" },
    ];
    const r = await alerta();

    expect(r).toMatchObject({ status: "ok", detail: "caso_ja_aberto_sem_passagem" });
    expect(casos()).toHaveLength(0);
    expect(triggerHandoff).not.toHaveBeenCalled();
  });

  it("conversa que a IA não está atendendo não ganha caso (a régua do triggerHandoff)", async () => {
    cenario({ passagem: false });
    elegibilidade.mockResolvedValueOnce({ permite: false, motivo: "conversa_de_humano", bloqueioPorAllowlist: false });
    const r = await alerta();

    expect(r).toMatchObject({ status: "skipped", detail: "nao_elegivel:conversa_de_humano" });
    expect(casos()).toHaveLength(0);
    expect(triggerHandoff).not.toHaveBeenCalled();
  });
});

describe("(C01) sentimento baixo com a passagem ligada ou sem leitura: igual a hoje", () => {
  it("passagem ligada: chama triggerHandoff e o handler não abre caso", async () => {
    cenario({ passagem: true });
    const r = await alerta();

    expect(triggerHandoff).toHaveBeenCalledTimes(1);
    expect(vi.mocked(triggerHandoff).mock.calls[0]![0]).toMatchObject({ reason: "low_sentiment" });
    expect(r).toMatchObject({ status: "ok", detail: "low_sentiment" });
    expect(casos()).toHaveLength(0);
  });

  it("erro ao ler o agente da conversa: cai no triggerHandoff de hoje", async () => {
    cenario({ passagem: false });
    tabelasComErro.add("ai_agent_versions");
    await alerta();

    expect(triggerHandoff).toHaveBeenCalledTimes(1);
    expect(casos()).toHaveLength(0);
  });

  it("conversa sem agente resolvido: cai no triggerHandoff de hoje", async () => {
    cenario({ passagem: false, fixado: false });
    banco.ai_agent_versions = [];
    await alerta();

    expect(triggerHandoff).toHaveBeenCalledTimes(1);
    expect(casos()).toHaveLength(0);
  });
});
