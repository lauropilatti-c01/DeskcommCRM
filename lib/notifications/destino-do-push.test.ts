import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushPayload } from "./push_payload";

// (C01, -c01.16) Quem recebe o push — `./destino-do-push.ts`.

const estado = { vapidPronto: true, modo: "" };
vi.mock("@/lib/notifications/vapid", () => ({ vapidPronto: () => estado.vapidPronto }));
vi.mock("@/lib/env", () => ({
  env: new Proxy({}, { get: (_t, k) => (k === "PUSH_DE_MENSAGEM" ? estado.modo : "") }),
}));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Marca" }) }));

const paraOrg = vi.fn(async (_org: string, _p: PushPayload) => ({ sent: 3, gone: 0 }));
const paraUsuario = vi.fn(async (_org: string, _u: string, _p: PushPayload) => ({ sent: 1, gone: 0 }));
// Desde a 1.86, o caminho do autor manda só a quem pode ver a conversa.
const paraQuemVe = vi.fn(async (_org: string, _c: string, _p: PushPayload, _so?: ReadonlyArray<string>) => ({ sent: 3, gone: 0 }));
vi.mock("./web_push", () => ({
  enviarPushDaOrg: (o: string, p: PushPayload) => paraOrg(o, p),
  enviarPushAoUsuario: (o: string, u: string, p: PushPayload) => paraUsuario(o, u, p),
  enviarPushAQuemVeAConversa: (o: string, c: string, p: PushPayload, so?: ReadonlyArray<string>) => paraQuemVe(o, c, p, so),
}));

/** Banco falso: cada tabela devolve as linhas que o teste puser, filtradas pelos `eq`. */
type Linha = Record<string, unknown>;
const tabelas: Record<string, Linha[] | Error> = {};
function consulta(tabela: string) {
  const filtros: [string, unknown][] = [];
  const emLista: [string, readonly unknown[]][] = [];
  const resolver = () => {
    const t = tabelas[tabela];
    if (t instanceof Error) return { data: null, error: { message: t.message } };
    const linhas = (t ?? []).filter(
      (l) => filtros.every(([c, v]) => l[c] === v) && emLista.every(([c, vs]) => vs.includes(l[c])),
    );
    return { data: linhas, error: null };
  };
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => (filtros.push([c, v]), q),
    in: (c: string, v: readonly unknown[]) => (emLista.push([c, v]), q),
    order: () => q,
    limit: () => q,
    maybeSingle: async () => {
      const r = resolver();
      return { data: r.data ? r.data[0] ?? null : null, error: r.error };
    },
    then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) => Promise.resolve(resolver()).then(ok, erro),
  };
  return q;
}
const admin = { from: (t: string) => consulta(t), storage: { from: () => ({ createSignedUrl: async () => ({ data: null }) }) } };
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin }));

import { casoEsperandoGente, modoDoPushDeMensagem, responsaveisDaConversa, type AdminDoPush } from "./destino-do-push";
import { webPushInboundHandler } from "./push.handler";

const ORG = "org1";
const membro = (user_id: string, extra: Linha = {}) => ({
  organization_id: ORG, user_id, accepted_at: "2026-10-01T10:00:00Z", revoked_at: null, ...extra,
});
function evento(event_type: string, payload: Record<string, unknown>) {
  return { id: "e1", organization_id: ORG, event_type, entity_kind: "x", entity_id: null, payload, metadata: {}, consumed_by: [], attempts: 0 };
}

beforeEach(() => {
  estado.vapidPronto = true;
  estado.modo = "";
  paraOrg.mockClear();
  paraUsuario.mockClear();
  paraQuemVe.mockClear();
  for (const k of Object.keys(tabelas)) delete tabelas[k];
});

describe("modoDoPushDeMensagem", () => {
  it("vazio, responsavel e valor desconhecido = só o responsável; equipe = todos", () => {
    expect(modoDoPushDeMensagem("")).toBe("responsavel");
    expect(modoDoPushDeMensagem(undefined)).toBe("responsavel");
    expect(modoDoPushDeMensagem("responsavel")).toBe("responsavel");
    expect(modoDoPushDeMensagem("qualquer")).toBe("responsavel");
    expect(modoDoPushDeMensagem(" EQUIPE ")).toBe("equipe");
  });
});

describe("responsaveisDaConversa", () => {
  it("junta a pessoa da conversa e os donos humanos dos negócios abertos, sem repetir", async () => {
    tabelas.conversations = [{ id: "c1", organization_id: ORG, assigned_to_user_id: "u1", contact_id: "k1" }];
    tabelas.crm_leads = [
      { organization_id: ORG, contact_id: "k1", status: "open", owner_kind: "user", owner_user_id: "u2" },
      { organization_id: ORG, contact_id: "k1", status: "open", owner_kind: "user", owner_user_id: "u1" },
      { organization_id: ORG, contact_id: "k1", status: "won", owner_kind: "user", owner_user_id: "u3" },
      { organization_id: ORG, contact_id: "k1", status: "open", owner_kind: "ai", owner_user_id: null },
      { organization_id: "outra", contact_id: "k1", status: "open", owner_kind: "user", owner_user_id: "u9" },
    ];
    tabelas.user_organizations = [membro("u1"), membro("u2"), membro("u3")];
    expect((await responsaveisDaConversa(admin as unknown as AdminDoPush, ORG, "c1", null))?.sort()).toEqual(["u1", "u2"]);
  });
  it("sem ninguém atribuído devolve lista vazia; leitura que falha devolve null", async () => {
    tabelas.conversations = [{ id: "c1", organization_id: ORG, assigned_to_user_id: null, contact_id: "k1" }];
    tabelas.crm_leads = [{ organization_id: ORG, contact_id: "k1", status: "open", owner_kind: "ai", owner_user_id: null }];
    expect(await responsaveisDaConversa(admin as unknown as AdminDoPush, ORG, "c1", "k1")).toEqual([]);
    tabelas.crm_leads = new Error("caiu");
    expect(await responsaveisDaConversa(admin as unknown as AdminDoPush, ORG, "c1", "k1")).toBeNull();
  });
  it("só quem é da equipe agora: revogada e convite pendente saem; leitura da equipe que falha devolve null", async () => {
    tabelas.conversations = [{ id: "c1", organization_id: ORG, assigned_to_user_id: "maria", contact_id: "k1" }];
    tabelas.crm_leads = [
      { organization_id: ORG, contact_id: "k1", status: "open", owner_kind: "user", owner_user_id: "nova" },
      { organization_id: ORG, contact_id: "k1", status: "open", owner_kind: "user", owner_user_id: "priscila" },
    ];
    tabelas.user_organizations = [
      membro("maria", { revoked_at: "2026-10-20T09:00:00Z" }),
      membro("nova", { accepted_at: null }),
      membro("priscila"),
      { ...membro("priscila"), organization_id: "outra", revoked_at: "2026-10-20T09:00:00Z" },
    ];
    expect(await responsaveisDaConversa(admin as unknown as AdminDoPush, ORG, "c1", null)).toEqual(["priscila"]);
    tabelas.user_organizations = new Error("caiu");
    expect(await responsaveisDaConversa(admin as unknown as AdminDoPush, ORG, "c1", null)).toBeNull();
  });
});

describe("casoEsperandoGente", () => {
  const a = admin as unknown as AdminDoPush;
  it("pelo lead_id: acha o caso que espera gente; ignora o que espera o cliente; erro = undefined", async () => {
    tabelas.crm_leads = [{ id: "L1", organization_id: ORG, contact_id: null }];
    tabelas.agent_cases = [
      { id: "caso-l", organization_id: ORG, lead_id: "L1", status: "awaiting_lead" },
      { id: "caso-h", organization_id: ORG, lead_id: "L1", status: "awaiting_human" },
    ];
    expect(await casoEsperandoGente(a, ORG, "L1")).toBe("caso-h");
    expect(await casoEsperandoGente(a, ORG, "L2")).toBeNull();
    tabelas.agent_cases = new Error("caiu");
    expect(await casoEsperandoGente(a, ORG, "L1")).toBeUndefined();
  });
  it("como na produção (lead_id nulo): pela conversa do contato do negócio, o mais recente", async () => {
    tabelas.crm_leads = [{ id: "L1", organization_id: ORG, contact_id: "k1" }];
    tabelas.conversations = [
      { id: "c1", organization_id: ORG, contact_id: "k1" },
      { id: "c2", organization_id: ORG, contact_id: "k1" },
      { id: "cx", organization_id: ORG, contact_id: "k2" },
    ];
    tabelas.agent_cases = [
      { id: "antigo", organization_id: ORG, lead_id: null, conversation_id: "c1", status: "awaiting_human", opened_at: "2026-10-19T10:00:00Z" },
      { id: "novo", organization_id: ORG, lead_id: null, conversation_id: "c2", status: "awaiting_human", opened_at: "2026-10-20T10:00:00Z" },
      { id: "de-outro", organization_id: ORG, lead_id: null, conversation_id: "cx", status: "awaiting_human", opened_at: "2026-10-20T11:00:00Z" },
      { id: "resolvido", organization_id: ORG, lead_id: null, conversation_id: "c1", status: "resolved", opened_at: "2026-10-20T12:00:00Z" },
    ];
    expect(await casoEsperandoGente(a, ORG, "L1")).toBe("novo");
    tabelas.conversations = new Error("caiu");
    expect(await casoEsperandoGente(a, ORG, "L1")).toBeUndefined();
    tabelas.conversations = [];
    tabelas.crm_leads = new Error("caiu");
    expect(await casoEsperandoGente(a, ORG, "L1")).toBeUndefined();
  });
});

describe("push de mensagem de cliente (message.received)", () => {
  const msg = () => evento("message.received", { conversation_id: "c1", contact_id: "k1", body_preview: "oi", type: "text" });

  it("IA atendendo, sem responsável: ninguém é tocado (antes: a equipe toda)", async () => {
    tabelas.conversations = [{ id: "c1", organization_id: ORG, assigned_to_user_id: null, contact_id: "k1" }];
    const r = await webPushInboundHandler.handle(msg());
    expect(r).toMatchObject({ status: "skipped", detail: "sem_responsavel" });
    expect(paraOrg).not.toHaveBeenCalled();
    expect(paraUsuario).not.toHaveBeenCalled();
  });

  it("com responsável: só ela recebe, nunca a organização", async () => {
    tabelas.conversations = [{ id: "c1", organization_id: ORG, assigned_to_user_id: null, contact_id: "k1" }];
    tabelas.crm_leads = [{ organization_id: ORG, contact_id: "k1", status: "open", owner_kind: "user", owner_user_id: "priscila" }];
    tabelas.user_organizations = [membro("priscila")];
    const r = await webPushInboundHandler.handle(msg());
    expect(r).toMatchObject({ status: "ok", detail: "sent:1" });
    expect(paraUsuario).toHaveBeenCalledTimes(1);
    expect(paraUsuario.mock.calls[0]![1]).toBe("priscila");
    expect(paraOrg).not.toHaveBeenCalled();
  });

  it("responsável revogada: ninguém é tocado (nem o aparelho dela, nem a equipe)", async () => {
    tabelas.conversations = [{ id: "c1", organization_id: ORG, assigned_to_user_id: "maria", contact_id: "k1" }];
    tabelas.user_organizations = [membro("maria", { revoked_at: "2026-10-20T09:00:00Z" })];
    const r = await webPushInboundHandler.handle(msg());
    expect(r).toMatchObject({ status: "skipped", detail: "sem_responsavel" });
    expect(paraUsuario).not.toHaveBeenCalled();
    expect(paraOrg).not.toHaveBeenCalled();
  });

  it("leitura do responsável falha: tenta de novo, não manda para todos", async () => {
    tabelas.conversations = new Error("caiu");
    const r = await webPushInboundHandler.handle(msg());
    expect(r.status).toBe("retry");
    expect(paraOrg).not.toHaveBeenCalled();
  });

  it("PUSH_DE_MENSAGEM=equipe devolve o comportamento do autor", async () => {
    estado.modo = "equipe";
    const r = await webPushInboundHandler.handle(msg());
    expect(r.status).toBe("ok");
    // 1.86: sem responsável, todos os que podem ver a conversa (`destinatarios-da-mensagem.ts`).
    expect(paraQuemVe).toHaveBeenCalledTimes(1);
    expect(paraQuemVe.mock.calls[0]![3]).toBeUndefined();
    expect(paraUsuario).not.toHaveBeenCalled();
  });

  it("modo responsavel nunca passa pelo caminho do autor (nem pela regra de todos sem responsável)", async () => {
    tabelas.conversations = [{ id: "c1", organization_id: ORG, assigned_to_user_id: null, contact_id: "k1" }];
    await webPushInboundHandler.handle(msg());
    expect(paraQuemVe).not.toHaveBeenCalled();
    expect(paraOrg).not.toHaveBeenCalled();
  });
});

describe("negócio atribuído (lead.assigned)", () => {
  const atribuido = () => evento("lead.assigned", { lead_id: "L1", to_user_id: "maria" });
  beforeEach(() => {
    tabelas.crm_leads = [{ id: "L1", organization_id: ORG, title: "Fulano", owner_user_id: "maria", pipeline_id: "p1", contact_id: "k1" }];
    tabelas.user_organizations = [membro("maria")];
  });

  it("com caso esperando gente pelo lead_id: 'Caso para você', abrindo o caso", async () => {
    tabelas.agent_cases = [{ id: "caso-1", organization_id: ORG, lead_id: "L1", status: "awaiting_human" }];
    await webPushInboundHandler.handle(atribuido());
    expect(paraUsuario).toHaveBeenCalledTimes(1);
    const [, para, p] = paraUsuario.mock.calls[0]!;
    expect(para).toBe("maria");
    expect(p.title).toBe("Caso para você");
    expect(p.href).toBe("/app/ai/cases?caso=caso-1");
    expect(JSON.stringify(p)).not.toContain("Fulano");
  });

  it("caso da produção (lead_id nulo, na conversa do contato): também 'Caso para você'", async () => {
    tabelas.conversations = [{ id: "c1", organization_id: ORG, contact_id: "k1" }];
    tabelas.agent_cases = [{ id: "caso-1", organization_id: ORG, lead_id: null, conversation_id: "c1", status: "awaiting_human", opened_at: "2026-10-20T10:00:00Z" }];
    await webPushInboundHandler.handle(atribuido());
    expect(paraUsuario.mock.calls[0]![2].title).toBe("Caso para você");
    expect(paraUsuario.mock.calls[0]![2].href).toBe("/app/ai/cases?caso=caso-1");
  });

  it("sem caso: o aviso de sempre ('Lead atribuído a você')", async () => {
    await webPushInboundHandler.handle(atribuido());
    expect(paraUsuario.mock.calls[0]![2].title).toBe("Lead atribuído a você");
  });

  it("destinatária revogada ou com convite pendente: nada sai; leitura da equipe que falha tenta de novo", async () => {
    tabelas.user_organizations = [membro("maria", { revoked_at: "2026-10-20T09:00:00Z" })];
    expect(await webPushInboundHandler.handle(atribuido())).toMatchObject({ status: "skipped", detail: "destinatario_fora_da_equipe" });
    tabelas.user_organizations = [membro("maria", { accepted_at: null })];
    expect(await webPushInboundHandler.handle(atribuido())).toMatchObject({ status: "skipped", detail: "destinatario_fora_da_equipe" });
    tabelas.user_organizations = new Error("caiu");
    expect((await webPushInboundHandler.handle(atribuido())).status).toBe("retry");
    expect(paraUsuario).not.toHaveBeenCalled();
  });
});
