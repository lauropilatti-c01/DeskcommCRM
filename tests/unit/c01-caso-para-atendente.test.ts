import { beforeEach, describe, expect, it, vi } from "vitest";

// (C01, -c01.16) O caso aberto ganha uma responsável — `lib/escalacao/caso-para-atendente.handler.ts`.

const estado = { ligado: "", vapid: true, falhar: "" as string };
vi.mock("@/lib/env", () => ({
  env: new Proxy({}, { get: (_t, k) => (k === "CASOS_PARA_ATENDENTES" ? estado.ligado : "") }),
}));
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => estado.vapid }));
const push = vi.fn(async (_o: string, _u: string, _p: { title: string; href: string }) => ({ sent: 1, gone: 0 }));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushAoUsuario: (o: string, u: string, p: { title: string; href: string }) => push(o, u, p),
}));

type Linha = Record<string, unknown>;
type Banco = Record<"agent_cases" | "crm_leads" | "user_organizations" | "conversations" | "crm_pipelines", Linha[]>;
let db: Banco = { agent_cases: [], crm_leads: [], user_organizations: [], conversations: [], crm_pipelines: [] };
function consulta(tabela: string) {
  const conds: ((l: Linha) => boolean)[] = [];
  let patch: Linha | null = null;
  let ordem: { col: string; asc: boolean } | null = null;
  let limite = Infinity;
  const linhas = () => {
    let ls = ((db as Record<string, Linha[]>)[tabela] ?? []).filter((l) => conds.every((c) => c(l)));
    if (ordem) {
      const { col, asc } = ordem;
      ls = [...ls].sort((a, b) => (String(a[col]) < String(b[col]) ? (asc ? -1 : 1) : asc ? 1 : -1));
    }
    return ls.slice(0, limite);
  };
  const executar = () => {
    if (estado.falhar === tabela) return { data: null, error: { message: "caiu" } };
    const ls = linhas();
    if (patch) for (const l of ls) Object.assign(l, patch);
    return { data: ls, error: null };
  };
  const q = {
    select: () => q,
    update: (p: Linha) => ((patch = p), q),
    eq: (c: string, v: unknown) => (conds.push((l) => l[c] === v), q),
    in: (c: string, vs: unknown[]) => (conds.push((l) => vs.includes(l[c])), q),
    is: (c: string, v: unknown) => (conds.push((l) => (l[c] ?? null) === v), q),
    not: (c: string, _op: string, _v: unknown) => (conds.push((l) => (l[c] ?? null) !== null), q),
    order: (col: string, o: { ascending: boolean }) => ((ordem = { col, asc: o.ascending }), q),
    limit: (n: number) => ((limite = n), q),
    maybeSingle: async () => {
      const r = executar();
      return { data: r.data ? r.data[0] ?? null : null, error: r.error };
    },
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(executar()).then(ok, ko),
  };
  return q;
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (t: string) => consulta(t) }) }));

import { casoParaAtendenteHandler, escolherAtendente } from "@/lib/escalacao/caso-para-atendente.handler";

const ORG = "org1";
// Relativos ao relógio: a troca de dono grava `new Date()`, e o teste do push
// repetido compara essa hora com a abertura do caso.
const ABERTO_EM = () => new Date(Date.now() - 60_000).toISOString();
const ONTEM = () => new Date(Date.now() - 86_400_000).toISOString();
const evento = (caseId = "caso-1") => ({
  id: "e1", organization_id: ORG, event_type: "ai.case_opened", entity_kind: "agent_case", entity_id: caseId,
  payload: { case_id: caseId }, metadata: {}, consumed_by: [], attempts: 0,
});
const membro = (user_id: string, role = "agent", extra: Linha = {}) => ({
  organization_id: ORG, user_id, role, accepted_at: "2026-10-20T10:00:00Z", revoked_at: null, ...extra,
});
// Como na produção: `openCase` não preenche `lead_id`; o caso ancora na conversa.
const caso = (id: string, conversa: string, extra: Linha = {}) => ({
  id, organization_id: ORG, status: "awaiting_human", lead_id: null, conversation_id: conversa,
  opened_at: ABERTO_EM(), ...extra,
});
const negocio = (id: string, contato: string, extra: Linha = {}) => ({
  id, organization_id: ORG, contact_id: contato, pipeline_id: "p1", status: "open", owner_user_id: null,
  owner_kind: null, owner_agent_id: null, assigned_at: null, last_activity_at: null,
  created_at: "2026-10-19T09:00:00Z", ...extra,
});

beforeEach(() => {
  estado.ligado = "";
  estado.vapid = true;
  estado.falhar = "";
  push.mockClear();
  db = {
    agent_cases: [caso("caso-1", "c1")],
    conversations: [{ id: "c1", organization_id: ORG, contact_id: "k1" }],
    crm_leads: [negocio("L1", "k1")],
    crm_pipelines: [{ id: "p1", organization_id: ORG, is_default: true, is_archived: false }],
    user_organizations: [membro("priscila"), membro("maria"), membro("lauro", "admin")],
  };
});

describe("escolherAtendente", () => {
  it("menos casos primeiro; empate = quem recebeu há mais tempo (nunca antes de todas); depois o id", () => {
    expect(escolherAtendente([], new Map(), new Map())).toBeNull();
    expect(escolherAtendente(["a", "b"], new Map([["a", 2], ["b", 1]]), new Map())).toBe("b");
    expect(escolherAtendente(["a", "b"], new Map(), new Map([["a", "2026-10-20T12:00:00Z"], ["b", "2026-10-20T11:00:00Z"]]))).toBe("b");
    expect(escolherAtendente(["a", "b"], new Map(), new Map([["a", "2026-10-20T12:00:00Z"]]))).toBe("b");
    expect(escolherAtendente(["b", "a"], new Map(), new Map())).toBe("a");
  });
});

describe("casoParaAtendenteHandler", () => {
  it("caso da produção (sem lead_id): acha o negócio pela conversa e o dá a uma atendente (nunca ao admin)", async () => {
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "atribuido" });
    const l = db.crm_leads[0]!;
    expect(["maria", "priscila"]).toContain(l.owner_user_id);
    expect(l.owner_kind).toBe("user");
    expect(l.assigned_at).toBeTruthy();
    expect(push).not.toHaveBeenCalled(); // o push sai pelo `lead.assigned` que a troca dispara
  });

  it("caso com lead_id (se o autor um dia preencher): usa o negócio dele", async () => {
    db.agent_cases[0]!.lead_id = "L1";
    db.agent_cases[0]!.conversation_id = null;
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "atribuido" });
    expect(["maria", "priscila"]).toContain(db.crm_leads[0]!.owner_user_id);
  });

  it("alterna pela conversa: a segunda vai para a outra (a primeira já tem um caso esperando)", async () => {
    await casoParaAtendenteHandler.handle(evento());
    const primeira = db.crm_leads[0]!.owner_user_id;
    db.agent_cases.push(caso("caso-2", "c2"));
    db.conversations.push({ id: "c2", organization_id: ORG, contact_id: "k2" });
    db.crm_leads.push(negocio("L2", "k2"));
    await casoParaAtendenteHandler.handle(evento("caso-2"));
    expect(db.crm_leads[1]!.owner_user_id).not.toBe(primeira);
  });

  it("alterna também com lead_id preenchido", async () => {
    db.agent_cases[0]!.lead_id = "L1";
    await casoParaAtendenteHandler.handle(evento());
    const primeira = db.crm_leads[0]!.owner_user_id;
    db.agent_cases.push(caso("caso-2", "c2", { lead_id: "L2" }));
    db.crm_leads.push(negocio("L2", "k2"));
    await casoParaAtendenteHandler.handle(evento("caso-2"));
    expect(db.crm_leads[1]!.owner_user_id).not.toBe(primeira);
  });

  it("dois negócios abertos do contato: o do funil padrão; empate sem padrão = nenhum", async () => {
    db.crm_leads = [negocio("L1", "k1", { pipeline_id: "p2" }), negocio("L9", "k1")];
    await casoParaAtendenteHandler.handle(evento());
    expect(db.crm_leads[0]!.owner_user_id).toBeNull();
    expect(db.crm_leads[1]!.owner_user_id).toBeTruthy();
    db.crm_leads = [negocio("L1", "k1", { pipeline_id: "p2" }), negocio("L9", "k1", { pipeline_id: "p3" })];
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("caso_sem_negocio");
  });

  it("negócio que já tem uma pessoa (de antes do caso): fica com ela e ela recebe 'Caso para você'", async () => {
    Object.assign(db.crm_leads[0]!, { owner_user_id: "maria", owner_kind: "user", assigned_at: ONTEM() });
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r.status).toBe("ok");
    expect(db.crm_leads[0]!.owner_user_id).toBe("maria");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]![1]).toBe("maria");
    expect(push.mock.calls[0]![2].title).toBe("Caso para você");
    expect(push.mock.calls[0]![2].href).toBe("/app/ai/cases?caso=caso-1");
  });

  it("worker que atribuiu e caiu antes de marcar o evento: na nova tentativa, sem push repetido", async () => {
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("atribuido");
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "atribuido_por_este_caso" });
    expect(push).not.toHaveBeenCalled();
  });

  it("dona revogada ou com convite pendente: nenhum push ao aparelho dela", async () => {
    Object.assign(db.crm_leads[0]!, { owner_user_id: "maria", owner_kind: "user", assigned_at: ONTEM() });
    db.user_organizations = [membro("priscila"), membro("maria", "agent", { revoked_at: "2026-10-20T11:00:00Z" })];
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("ja_tinha_responsavel:fora_da_equipe");
    db.user_organizations = [membro("priscila"), membro("maria", "agent", { accepted_at: null })];
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("ja_tinha_responsavel:fora_da_equipe");
    expect(push).not.toHaveBeenCalled();
  });

  it("sem atendente (só admin, convite pendente ou revogada): nada muda", async () => {
    db.user_organizations = [membro("lauro", "admin"), membro("p", "agent", { accepted_at: null }), membro("m", "agent", { revoked_at: "2026-10-01" })];
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "sem_atendente" });
    expect(db.crm_leads[0]!.owner_user_id).toBeNull();
  });

  it("caso que espera o cliente, sem negócio aberto, sem conversa ou desligado: não mexe", async () => {
    db.agent_cases[0]!.status = "awaiting_lead";
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("caso_nao_espera_pessoa");
    db.agent_cases[0]!.status = "awaiting_human";
    db.crm_leads[0]!.status = "won";
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("caso_sem_negocio");
    db.crm_leads[0]!.status = "open";
    db.agent_cases[0]!.conversation_id = null;
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("caso_sem_negocio");
    db.agent_cases[0]!.conversation_id = "c1";
    estado.ligado = "desligado";
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("desligado");
    expect(db.crm_leads[0]!.owner_user_id).toBeNull();
  });

  it("leitura que falha (equipe ou conversa): tenta de novo, sem atribuir", async () => {
    for (const tabela of ["user_organizations", "conversations"]) {
      estado.falhar = tabela;
      const r = await casoParaAtendenteHandler.handle(evento());
      expect(r.status).toBe("retry");
      expect(db.crm_leads[0]!.owner_user_id).toBeNull();
    }
  });
});
