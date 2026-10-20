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
let db: Record<string, Linha[]> = {};
function consulta(tabela: string) {
  const conds: ((l: Linha) => boolean)[] = [];
  let patch: Linha | null = null;
  let ordem: { col: string; asc: boolean } | null = null;
  let limite = Infinity;
  const linhas = () => {
    let ls = (db[tabela] ?? []).filter((l) => conds.every((c) => c(l)));
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
const evento = (caseId = "caso-1") => ({
  id: "e1", organization_id: ORG, event_type: "ai.case_opened", entity_kind: "agent_case", entity_id: caseId,
  payload: { case_id: caseId, lead_id: "L1" }, metadata: {}, consumed_by: [], attempts: 0,
});
const membro = (user_id: string, role = "agent", extra: Linha = {}) => ({
  organization_id: ORG, user_id, role, accepted_at: "2026-10-20T10:00:00Z", revoked_at: null, ...extra,
});

beforeEach(() => {
  estado.ligado = "";
  estado.vapid = true;
  estado.falhar = "";
  push.mockClear();
  db = {
    agent_cases: [{ id: "caso-1", organization_id: ORG, status: "awaiting_human", lead_id: "L1" }],
    crm_leads: [{ id: "L1", organization_id: ORG, owner_user_id: null, owner_kind: null, owner_agent_id: null, assigned_at: null }],
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
  it("negócio sem dono vai para uma atendente (nunca para o admin) e vira dono humano", async () => {
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "atribuido" });
    const l = db.crm_leads[0];
    expect(["maria", "priscila"]).toContain(l.owner_user_id);
    expect(l.owner_kind).toBe("user");
    expect(l.assigned_at).toBeTruthy();
    expect(push).not.toHaveBeenCalled(); // o push sai pelo `lead.assigned` que a troca dispara
  });

  it("alterna: a segunda vai para a outra (a primeira já tem um caso esperando)", async () => {
    await casoParaAtendenteHandler.handle(evento());
    const primeira = db.crm_leads[0].owner_user_id;
    db.agent_cases.push({ id: "caso-2", organization_id: ORG, status: "awaiting_human", lead_id: "L2" });
    db.crm_leads.push({ id: "L2", organization_id: ORG, owner_user_id: null, owner_kind: null, assigned_at: null });
    await casoParaAtendenteHandler.handle({ ...evento("caso-2"), payload: { case_id: "caso-2", lead_id: "L2" } });
    expect(db.crm_leads[1].owner_user_id).not.toBe(primeira);
  });

  it("negócio que já tem uma pessoa: fica com ela e ela recebe 'Caso para você'", async () => {
    db.crm_leads[0].owner_user_id = "maria";
    db.crm_leads[0].owner_kind = "user";
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r.status).toBe("ok");
    expect(db.crm_leads[0].owner_user_id).toBe("maria");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][1]).toBe("maria");
    expect(push.mock.calls[0][2].title).toBe("Caso para você");
    expect(push.mock.calls[0][2].href).toBe("/app/ai/cases?caso=caso-1");
  });

  it("sem atendente (só admin, convite pendente ou revogada): nada muda", async () => {
    db.user_organizations = [membro("lauro", "admin"), membro("p", "agent", { accepted_at: null }), membro("m", "agent", { revoked_at: "2026-10-01" })];
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "sem_atendente" });
    expect(db.crm_leads[0].owner_user_id).toBeNull();
  });

  it("caso que espera o cliente, sem negócio ou desligado: não mexe", async () => {
    db.agent_cases[0].status = "awaiting_lead";
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("caso_nao_espera_pessoa");
    db.agent_cases[0].status = "awaiting_human";
    db.agent_cases[0].lead_id = null;
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("caso_sem_negocio");
    db.agent_cases[0].lead_id = "L1";
    estado.ligado = "desligado";
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("desligado");
    expect(db.crm_leads[0].owner_user_id).toBeNull();
  });

  it("leitura que falha: tenta de novo, sem atribuir", async () => {
    estado.falhar = "user_organizations";
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r.status).toBe("retry");
    expect(db.crm_leads[0].owner_user_id).toBeNull();
  });
});
