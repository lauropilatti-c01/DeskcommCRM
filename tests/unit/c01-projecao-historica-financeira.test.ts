import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import {
  lerProjecaoHistorica,
  projecaoHistoricaSchema,
} from "@/lib/leads/projecao-historica-financeira";

const ORG = "11111111-1111-4111-8111-111111111111",
  CONTACT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-24T18:00:00Z"),
  PHONE = "+5511999990001",
  EMAIL = "pessoa@example.test";
const SECRET = "a".repeat(64);
const hash = (kind: string, value: string) =>
  createHmac("sha256", Buffer.from(SECRET, "hex")).update(`${kind}:${value}`).digest("hex");
function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const config = {
    enabled: true,
    baseUrl: "https://history.example.test",
    apiToken: "token-ficticio-nao-e-chave-real-123",
    hmacKeyHex: SECRET,
    scopeHash: "b".repeat(64),
  };
  let contacts = [{ id: CONTACT, phone_number: PHONE, email_normalized: EMAIL }];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    expect(sql).toContain("organization_id=$1");
    expect(sql).toMatch(/^select /);
    expect(params).toEqual([ORG]);
    return { rows: contacts };
  });
  const data: Record<string, unknown> = {
    schema: 1,
    organizationId: ORG,
    scopeHash: config.scopeHash,
    status: "nao_comprou_confirmado",
    reason: "sem_compra_na_identidade_e_periodo_conferidos",
    complete: true,
    checkedAt: "2026-10-24T17:58:00+00:00",
    evidenceHash: "c".repeat(64),
    identityKeys: [{ phoneHash: hash("tel", PHONE), emailHash: hash("email", EMAIL) }],
  };
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = String(init?.body),
      request = JSON.parse(body);
    return new Response(
      JSON.stringify({
        data: {
          ...data,
          requestId: request.requestId,
          requestHash: createHash("sha256").update(body).digest("hex"),
        },
      }),
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const read = () =>
    lerProjecaoHistorica({
      config,
      db: { query } as unknown as Queryable,
      organizationId: ORG,
      contactId: CONTACT,
      phone: PHONE,
      email: null,
      now: NOW,
      signal: new AbortController().signal,
    });
  return {
    config,
    data,
    fetcher,
    query,
    read,
    contacts: (rows: typeof contacts) => {
      contacts = rows;
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("projeção histórica autenticada por pessoa", () => {
  it("coleta viva devolve espera autenticada, sem negativa ou prazo renovado", async () => {
    const f = fixture();
    Object.assign(f.data, {
      status: "indisponivel",
      reason: "projecao_em_coleta",
      complete: false,
      collection: {
        generationId: "33333333-3333-4333-8333-333333333333",
        startedAt: "2026-10-24T17:58:00Z",
        heartbeatAt: "2026-10-24T18:00:00Z",
        deadlineAt: "2026-10-24T18:13:00Z",
        progress: 2,
      },
    });
    const r = await f.read();
    expect(r.status).toBe("indisponivel");
    expect(r.complete).toBe(false);
    expect(r).toHaveProperty("collection", f.data.collection);
  });
  it.each([
    "heartbeat_velho",
    "heartbeat_futuro",
    "prazo_maior",
    "sem_identidade",
    "sem_progresso",
    "status_errado",
  ])("coleta %s não autoriza adiamento", async (mode) => {
    const f = fixture();
    const c = {
      generationId: "33333333-3333-4333-8333-333333333333",
      startedAt: "2026-10-24T17:58:00Z",
      heartbeatAt: "2026-10-24T18:00:00Z",
      deadlineAt: "2026-10-24T18:13:00Z",
      progress: 2,
    };
    Object.assign(f.data, {
      status: "indisponivel",
      reason: "projecao_em_coleta",
      complete: false,
      collection: c,
    });
    if (mode === "heartbeat_velho") {
      c.startedAt = "2026-10-24T17:55:00Z";
      f.data.checkedAt = c.startedAt;
      c.heartbeatAt = "2026-10-24T17:57:00Z";
      c.deadlineAt = "2026-10-24T18:10:00Z";
    }
    if (mode === "heartbeat_futuro") c.heartbeatAt = "2026-10-24T18:00:01Z";
    if (mode === "prazo_maior") c.deadlineAt = "2026-10-24T18:14:00Z";
    if (mode === "sem_identidade") f.data.identityKeys = [];
    if (mode === "sem_progresso") c.progress = 0;
    if (mode === "status_errado") f.data.status = "revisao";
    expect(await f.read()).not.toHaveProperty("collection");
  });
  it("faz uma leitura limitada, sem PII ou token na URL; conserva instante da fonte", async () => {
    const f = fixture();
    const r = await f.read();
    expect(r.status).toBe("nao_comprou_confirmado");
    expect(r.checkedAt).toBe("2026-10-24T17:58:00+00:00");
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [url, init] = f.fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://history.example.test/v1/financial/history/person");
    expect(init?.redirect).toBe("error");
    expect(String(init?.body)).not.toContain(PHONE);
    expect(String(init?.body)).not.toContain(EMAIL);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + f.config.apiToken);
  });
  it.each([
    "expired",
    "future",
    "incomplete",
    "scope",
    "org",
    "extra",
    "empty_identity",
    "foreign_identity",
    "negative_reason",
  ])("recusa resposta %s", async (mode) => {
    const f = fixture();
    if (mode === "expired") f.data.checkedAt = "2026-10-24T17:44:59Z";
    if (mode === "future") f.data.checkedAt = "2026-10-24T18:00:01Z";
    if (mode === "incomplete") f.data.complete = false;
    if (mode === "scope") f.data.scopeHash = "f".repeat(64);
    if (mode === "org") f.data.organizationId = "33333333-3333-4333-8333-333333333333";
    if (mode === "extra") f.data.phone = PHONE;
    if (mode === "empty_identity") f.data.identityKeys = [];
    if (mode === "foreign_identity")
      f.data.identityKeys = [{ phoneHash: "d".repeat(64), emailHash: null }];
    if (mode === "negative_reason") f.data.reason = "base_nao_existe";
    const r = await f.read();
    expect(r.status).not.toBe("nao_comprou_confirmado");
    expect(r.complete).toBe(false);
  });
  it("contraparte descoberta não pode pertencer a outro contato", async () => {
    const f = fixture();
    f.contacts([
      { id: CONTACT, phone_number: PHONE, email_normalized: "" },
      { id: "outra", phone_number: "+5511999990002", email_normalized: EMAIL },
    ]);
    expect(await f.read()).toMatchObject({ status: "revisao", complete: false });
  });
  it("identidade da organização com mais de 20 mil contatos fica indisponível", async () => {
    const f = fixture();
    f.contacts(
      Array.from({ length: 20001 }, () => ({
        id: CONTACT,
        phone_number: PHONE,
        email_normalized: EMAIL,
      })),
    );
    expect(await f.read()).toMatchObject({ status: "indisponivel", complete: false });
  });
  it.each(["confirmado", "revisao", "indisponivel"])("preserva veto %s", async (status) => {
    const f = fixture();
    f.data.status = status;
    f.data.complete = status === "confirmado";
    expect((await f.read()).status).toBe(status);
  });
  it.each([401, 500, 302])("HTTP %i não prova ausência", async (code) => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response("{}", { status: code }));
    expect((await f.read()).status).toBe("indisponivel");
  });
  it("não aceita resposta de outra requisição", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            ...f.data,
            requestId: "33333333-3333-4333-8333-333333333333",
            requestHash: "e".repeat(64),
          },
        }),
      ),
    );
    expect((await f.read()).status).toBe("indisponivel");
  });
  it("teto de bytes também vale sem content-length", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValue(new Response(" ".repeat(16385)));
    expect((await f.read()).status).toBe("indisponivel");
  });
  it("configuração desligada não consulta rede nem banco", async () => {
    const f = fixture();
    f.config.enabled = false;
    expect((await f.read()).status).toBe("indisponivel");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each([
    "http://history.example.test",
    "https://user:secret@history.example.test",
    "https://history.example.test/path",
    "https://history.example.test/?token=x",
  ])("recusa origem %s", (baseUrl) => {
    const f = fixture();
    expect(projecaoHistoricaSchema.safeParse({ ...f.config, baseUrl }).success).toBe(false);
  });
});
