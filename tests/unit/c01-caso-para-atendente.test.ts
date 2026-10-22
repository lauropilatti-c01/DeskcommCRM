import { beforeEach, describe, expect, it, vi } from "vitest";

// (C01, -c01.16) O caso aberto ganha uma responsável — `lib/escalacao/caso-para-atendente.handler.ts`.

const estado = { ligado: "", vapid: true, falhar: "" as string, naoVeem: [] as string[] };
vi.mock("@/lib/env", () => ({
  env: new Proxy({}, { get: (_t, k) => (k === "CASOS_PARA_ATENDENTES" ? estado.ligado : "") }),
}));
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => estado.vapid }));
const push = vi.fn(async (_o: string, _u: string, _p: { title: string; href: string }) => ({ sent: 1, gone: 0 }));
// Quem vê a conversa: todo mundo, menos `estado.naoVeem` (a visibilidade restrita do autor).
const paraQuemVe = vi.fn(async (_o: string, _conv: string, _p: { title: string; href: string }, so?: readonly string[]) => ({
  sent: (so ?? []).filter((u) => !estado.naoVeem.includes(u)).length,
  gone: 0,
}));
vi.mock("@/lib/notifications/web_push", () => ({
  enviarPushAoUsuario: (o: string, u: string, p: { title: string; href: string }) => push(o, u, p),
  enviarPushAQuemVeAConversa: (o: string, c: string, p: { title: string; href: string }, so?: readonly string[]) =>
    paraQuemVe(o, c, p, so),
}));

type Linha = Record<string, unknown>;
type Banco = Record<"agent_cases" | "crm_leads" | "user_organizations" | "conversations" | "crm_pipelines" | "event_log", Linha[]>;
let db: Banco = { agent_cases: [], crm_leads: [], user_organizations: [], conversations: [], crm_pipelines: [], event_log: [] };
/** `payload->>campo` e `snapshot->campo` leem dentro do jsonb, como o PostgREST. */
const valor = (l: Linha, c: string) => {
  const [col, campo] = c.includes("->>") ? c.split("->>") : c.split("->");
  return campo === undefined ? l[c] : ((l[col!] as Linha | undefined)?.[campo] ?? null);
};
/** `apelido:coluna->campo` no select vira um campo da linha devolvida. */
const projetar = (l: Linha, apelidos: [string, string][]) =>
  apelidos.length === 0 ? l : { ...l, ...Object.fromEntries(apelidos.map(([a, c]) => [a, valor(l, c)])) };
function consulta(tabela: string) {
  const conds: ((l: Linha) => boolean)[] = [];
  let patch: Linha | null = null;
  let ordem: { col: string; asc: boolean } | null = null;
  let limite = Infinity;
  let apelidos: [string, string][] = [];
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
    if (patch) {
      for (const l of ls) {
        // O gatilho do banco (`fn_emit_event_on_lead_change`): troca de dono emite `lead.assigned`.
        if (tabela === "crm_leads" && "owner_user_id" in patch && patch.owner_user_id !== l.owner_user_id) {
          db.event_log.push({
            organization_id: l.organization_id, event_type: "lead.assigned", entity_kind: "lead", entity_id: l.id,
            payload: { lead_id: l.id, from_user_id: l.owner_user_id ?? null, to_user_id: patch.owner_user_id },
            created_at: new Date().toISOString(),
          });
        }
        Object.assign(l, patch);
      }
    }
    return { data: ls.map((l) => projetar(l, apelidos)), error: null };
  };
  const q = {
    select: (cols = "") => {
      apelidos = cols
        .split(",")
        .map((c) => c.trim())
        .filter((c) => /^\w+:.+->/.test(c))
        .map((c) => c.split(":") as [string, string]);
      return q;
    },
    update: (p: Linha) => ((patch = p), q),
    eq: (c: string, v: unknown) => (conds.push((l) => valor(l, c) === v), q),
    in: (c: string, vs: unknown[]) => (conds.push((l) => vs.includes(l[c])), q),
    is: (c: string, v: unknown) => (conds.push((l) => (valor(l, c) ?? null) === v), q),
    gte: (c: string, v: string) => (conds.push((l) => Date.parse(String(l[c])) >= Date.parse(v)), q),
    neq: (c: string, v: unknown) => (conds.push((l) => valor(l, c) !== v), q),
    not: (c: string, _op: string, _v: unknown) => (conds.push((l) => (valor(l, c) ?? null) !== null), q),
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
  opened_at: ABERTO_EM(), summary: "O cliente pediu a segunda via.", context_snapshot: { last_messages: [] }, ...extra,
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
  estado.naoVeem = [];
  push.mockClear();
  paraQuemVe.mockClear();
  db = {
    agent_cases: [caso("caso-1", "c1")],
    conversations: [{ id: "c1", organization_id: ORG, contact_id: "k1" }],
    crm_leads: [negocio("L1", "k1")],
    crm_pipelines: [{ id: "p1", organization_id: ORG, is_default: true, is_archived: false }],
    event_log: [],
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

  it("dois negócios abertos do contato: o do funil padrão; empate sem padrão = nenhum negócio (vai ao rodízio, sem tocar em card)", async () => {
    db.crm_leads = [negocio("L1", "k1", { pipeline_id: "p2" }), negocio("L9", "k1")];
    await casoParaAtendenteHandler.handle(evento());
    expect(db.crm_leads[0]!.owner_user_id).toBeNull();
    expect(db.crm_leads[1]!.owner_user_id).toBeTruthy();
    db.crm_leads = [negocio("L1", "k1", { pipeline_id: "p2" }), negocio("L9", "k1", { pipeline_id: "p3" })];
    // (Achado 3) Antes, `caso_sem_negocio` e ninguém avisado. Sem o negócio do
    // caso, o caso segue o rodízio dos casos sem negócio; nenhum card muda.
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("sem_negocio:rodizio:sent:1");
    expect(db.crm_leads.map((l) => l.owner_user_id)).toEqual([null, null]);
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
    expect(db.event_log).toHaveLength(1); // o `lead.assigned` da troca, que leva o "Caso para você"
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "atribuido_por_este_caso" });
    expect(push).not.toHaveBeenCalled();
  });

  it("dona de antes do caso, e um PATCH reenvia a mesma dona depois da abertura: o push sai (a API renova assigned_at sem lead.assigned)", async () => {
    Object.assign(db.crm_leads[0]!, { owner_user_id: "maria", owner_kind: "user", assigned_at: new Date().toISOString() });
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "ja_tinha_responsavel:sent:1" });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0]![1]).toBe("maria");
  });

  it("lead.assigned de antes da abertura, ou de outra dona, não prova o aviso deste caso", async () => {
    Object.assign(db.crm_leads[0]!, { owner_user_id: "maria", owner_kind: "user", assigned_at: ONTEM() });
    const assigned = (para: string, quando: string, de: string | null = null) => ({
      organization_id: ORG, event_type: "lead.assigned", entity_kind: "lead", entity_id: "L1",
      payload: { lead_id: "L1", from_user_id: de, to_user_id: para }, created_at: quando,
    });
    db.event_log = [assigned("maria", ONTEM()), assigned("priscila", new Date().toISOString())];
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("ja_tinha_responsavel:sent:1");
    db.event_log = [assigned("maria", new Date().toISOString())];
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("atribuido_por_este_caso");
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("carga: o caso conta só para a dona do negócio escolhido do contato, não para todas", async () => {
    // Contato k5 tem dois negócios abertos: o do funil padrão é da maria; o outro, da priscila.
    db.agent_cases.push(caso("caso-5", "c5"));
    db.conversations.push({ id: "c5", organization_id: ORG, contact_id: "k5" });
    db.crm_leads.push(
      negocio("L5", "k5", { owner_user_id: "maria", owner_kind: "user" }),
      negocio("L6", "k5", { pipeline_id: "p2", owner_user_id: "priscila", owner_kind: "user" }),
    );
    await casoParaAtendenteHandler.handle(evento());
    expect(db.crm_leads[0]!.owner_user_id).toBe("priscila");
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

  it("caso que espera o cliente, sem conversa ou desligado: não mexe", async () => {
    db.agent_cases[0]!.status = "awaiting_lead";
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("caso_nao_espera_pessoa");
    db.agent_cases[0]!.status = "awaiting_human";
    db.agent_cases[0]!.conversation_id = null;
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("caso_sem_negocio:sem_conversa");
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

// (Revisão da junção da 1.86, achado 3) Cliente que só tem negócio ganho (o aluno
// que já comprou e volta com dúvida), ou sem negócio: o caso ia só para a Central,
// sem ninguém avisado. Decisão do Lauro (20/10): os casos para a equipe se
// distribuem entre as atendentes, alternando, com aviso pelo push do CRM. Vale o
// mesmo rodízio do caso com negócio (`escolherAtendente`), sem tocar em negócio.
describe("caso sem negócio aberto: rodízio entre as atendentes, sem tocar em negócio", () => {
  const soGanho = () => {
    db.crm_leads[0]!.status = "won";
  };
  const atendenteDoCaso = (id = "caso-1") =>
    ((db.agent_cases.find((c) => c.id === id)!.context_snapshot as Linha).c01_atendente as Linha | undefined)?.user_id;

  it("só negócio ganho: uma atendente (nunca o admin) recebe o push, visível a ela; negócio e funil intactos", async () => {
    soGanho();
    const antes = JSON.stringify(db.crm_leads);
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "sem_negocio:rodizio:sent:1" });
    const escolhida = atendenteDoCaso();
    expect(["maria", "priscila"]).toContain(escolhida);
    expect(paraQuemVe).toHaveBeenCalledTimes(1);
    expect(paraQuemVe.mock.calls[0]![1]).toBe("c1");
    expect(paraQuemVe.mock.calls[0]![2].title).toBe("Caso para você");
    expect(paraQuemVe.mock.calls[0]![3]).toEqual([escolhida]);
    expect(push).not.toHaveBeenCalled(); // nunca o caminho que ignora a visibilidade
    expect(JSON.stringify(db.crm_leads)).toBe(antes);
    expect(db.event_log).toHaveLength(0); // nenhum lead.assigned
    expect((db.agent_cases[0]!.context_snapshot as Linha).last_messages).toEqual([]); // o snapshot do autor fica
  });

  it("alterna: o segundo caso sem negócio vai para a outra atendente", async () => {
    soGanho();
    await casoParaAtendenteHandler.handle(evento());
    db.agent_cases.push(caso("caso-2", "c2"));
    db.conversations.push({ id: "c2", organization_id: ORG, contact_id: "k2" });
    await casoParaAtendenteHandler.handle(evento("caso-2"));
    expect(atendenteDoCaso("caso-2")).toBeTruthy();
    expect(atendenteDoCaso("caso-2")).not.toBe(atendenteDoCaso());
  });

  it("alterna também quando o primeiro caso já foi resolvido (desempata pela vez mais antiga)", async () => {
    soGanho();
    await casoParaAtendenteHandler.handle(evento());
    db.agent_cases[0]!.status = "resolved";
    db.agent_cases.push(caso("caso-2", "c2"));
    db.conversations.push({ id: "c2", organization_id: ORG, contact_id: "k2" });
    await casoParaAtendenteHandler.handle(evento("caso-2"));
    expect(atendenteDoCaso("caso-2")).not.toBe(atendenteDoCaso());
  });

  it("o caso sem negócio pesa na carga do caso com negócio que vem depois", async () => {
    soGanho();
    await casoParaAtendenteHandler.handle(evento());
    db.agent_cases.push(caso("caso-2", "c2"));
    db.conversations.push({ id: "c2", organization_id: ORG, contact_id: "k2" });
    db.crm_leads.push(negocio("L2", "k2"));
    await casoParaAtendenteHandler.handle(evento("caso-2"));
    expect(db.crm_leads[1]!.owner_user_id).not.toBe(atendenteDoCaso());
  });

  it("a escolhida não vê a conversa: nada de push para ela (nem sem prévia)", async () => {
    soGanho();
    estado.naoVeem = ["maria", "priscila"];
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "ok", detail: "sem_negocio:rodizio:sent:0" });
    expect(push).not.toHaveBeenCalled();
  });

  it("nova tentativa do mesmo evento: mantém a mesma atendente e manda o aviso de novo", async () => {
    soGanho();
    await casoParaAtendenteHandler.handle(evento());
    const primeira = atendenteDoCaso();
    db.user_organizations.push(membro("ana")); // a vez mudaria para a ana
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r.detail).toBe("sem_negocio:rodizio:sent:1");
    expect(atendenteDoCaso()).toBe(primeira);
    expect(paraQuemVe.mock.calls[1]![3]).toEqual([primeira]);
  });

  it("sem atendente: só a Central, com o motivo registrado", async () => {
    soGanho();
    db.user_organizations = [membro("lauro", "admin")];
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "caso_sem_negocio:sem_atendente" });
    expect(atendenteDoCaso()).toBeUndefined();
    expect(paraQuemVe).not.toHaveBeenCalled();
  });

  it("sem negócio nenhum (contato sem card): o mesmo rodízio", async () => {
    db.crm_leads = [];
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r.detail).toBe("sem_negocio:rodizio:sent:1");
    expect(["maria", "priscila"]).toContain(atendenteDoCaso());
  });

  it("caso anonimizado no meio do caminho: não regrava o snapshot apagado", async () => {
    soGanho();
    db.agent_cases[0]!.summary = "[resumo anonimizado]";
    db.agent_cases[0]!.context_snapshot = {};
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "caso_sem_negocio:anonimizado" });
    expect(db.agent_cases[0]!.context_snapshot).toEqual({});
    expect(paraQuemVe).not.toHaveBeenCalled();
  });

  it("vapid ausente: grava a vez (o rodízio anda) e não tenta o push", async () => {
    soGanho();
    estado.vapid = false;
    const r = await casoParaAtendenteHandler.handle(evento());
    expect(r).toMatchObject({ status: "skipped", detail: "sem_negocio:rodizio:vapid_ausente" });
    expect(atendenteDoCaso()).toBeTruthy();
    expect(paraQuemVe).not.toHaveBeenCalled();
  });
});

// A produção tem dois membros admin: o Lauro e a conta de serviço "Claude", que
// os roteiros usam. Elegível ao rodízio é só o papel `agent` (convite aceito,
// não revogada): a conta de serviço nunca recebe caso, nem com negócio nem sem.
describe("conta de serviço (admin) nunca entra no rodízio", () => {
  it("com atendentes: oito casos, com e sem negócio, nenhum para o Lauro nem para a conta Claude", async () => {
    db.user_organizations = [membro("lauro", "admin"), membro("claude", "admin"), membro("priscila"), membro("maria")];
    db.agent_cases = [];
    db.conversations = [];
    db.crm_leads = [];
    for (let i = 1; i <= 8; i++) {
      db.agent_cases.push(caso(`caso-${i}`, `c${i}`));
      db.conversations.push({ id: `c${i}`, organization_id: ORG, contact_id: `k${i}` });
      db.crm_leads.push(negocio(`L${i}`, `k${i}`, i % 2 === 0 ? { status: "won" } : {}));
      await casoParaAtendenteHandler.handle(evento(`caso-${i}`));
    }
    const donos = db.crm_leads.filter((l) => l.status === "open").map((l) => l.owner_user_id);
    const daVez = db.agent_cases.flatMap((c) => {
      const v = (c.context_snapshot as Linha).c01_atendente as Linha | undefined;
      return v ? [v.user_id] : [];
    });
    expect(donos).toHaveLength(4);
    expect(daVez).toHaveLength(4);
    for (const quem of [...donos, ...daVez]) expect(["priscila", "maria"]).toContain(quem);
    const avisados = paraQuemVe.mock.calls.flatMap((c) => [...(c[3] ?? [])]);
    expect(avisados).not.toContain("claude");
    expect(avisados).not.toContain("lauro");
  });

  it("só o Lauro e a conta Claude (como na produção hoje), ou a conta como manager: ninguém recebe, só a Central", async () => {
    db.crm_leads[0]!.status = "won";
    for (const equipe of [
      [membro("lauro", "admin"), membro("claude", "admin")],
      [membro("lauro", "admin"), membro("claude", "manager")],
    ]) {
      db.user_organizations = equipe;
      const r = await casoParaAtendenteHandler.handle(evento());
      expect(r).toMatchObject({ status: "skipped", detail: "caso_sem_negocio:sem_atendente" });
    }
    db.crm_leads[0]!.status = "open";
    expect((await casoParaAtendenteHandler.handle(evento())).detail).toBe("sem_atendente");
    expect(db.crm_leads[0]!.owner_user_id).toBeNull();
    expect((db.agent_cases[0]!.context_snapshot as Linha).c01_atendente).toBeUndefined();
    expect(paraQuemVe).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});
