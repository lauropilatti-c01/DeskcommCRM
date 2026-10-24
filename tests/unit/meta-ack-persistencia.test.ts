import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  linhas: new Map<string, Record<string, unknown>>(),
  falharIds: new Set<string>(),
  efeitos: [] as string[],
  consultaFalha: false,
  sessaoAusente: false,
  sessaoFalha: false,
  conflitoSemLinha: false,
  insertSemId: false,
  statusFalha: false,
  tokenValido: true,
}));
const SEGREDO = "segredo-somente-fixture";
const ORG = "org-ficticia";
const SESSAO = "sessao-ficticia";

vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionByWebhookToken: async () =>
    estado.tokenValido
      ? { id: "sessao-ficticia", organizationId: "org-ficticia", wabaId: "waba-ficticia" }
      : null,
}));
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: async () => ({ appSecret: "segredo-somente-fixture", verifyToken: "teste" }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminFicticio() }));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));
vi.mock("@/lib/escalacao/resposta-whatsapp-ao-caso", () => ({
  consumirRespostaDoSuporteNoWhatsApp: async () => false,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
  registrarMensagemIgnorada: async () => undefined,
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async (_admin: unknown, e: { messageId: string }) => {
    estado.efeitos.push(e.messageId);
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

function adminFicticio() {
  return {
    rpc: async (name: string) => ({
      data:
        name === "fn_upsert_wa_contact"
          ? "contato-ficticio"
          : name === "fn_upsert_wa_conversation"
            ? "conversa-ficticia"
            : null,
      error: null,
    }),
    from(table: string) {
      let inserted: { data: unknown; error: unknown } | null = null;
      let updating = false;
      const filters = new Map<string, unknown>();
      const query = {
        select: (_columns?: string) => query,
        eq: (key: string, value: unknown) => {
          filters.set(key, value);
          return query;
        },
        is: () => query,
        neq: () => query,
        update: () => {
          updating = true;
          return query;
        },
        insert(row: Record<string, unknown>) {
          const external = row.external_id as string;
          const key = `${row.organization_id}:${external}`;
          if (estado.falharIds.has(external))
            inserted = {
              data: null,
              error: { code: "08006", message: "banco indisponível fictício" },
            };
          else if (estado.conflitoSemLinha || estado.linhas.has(key))
            inserted = { data: null, error: { code: "23505", message: "conflito fictício" } };
          else if (estado.insertSemId) inserted = { data: null, error: null };
          else {
            const saved = { ...row, id: "msg-" + external };
            estado.linhas.set(key, saved);
            inserted = { data: { id: saved.id }, error: null };
          }
          return query;
        },
        async maybeSingle() {
          if (inserted) return inserted;
          if (updating && estado.statusFalha)
            return { data: null, error: { code: "08006", message: "status fictício" } };
          if (table === "channel_sessions")
            return {
              data:
                estado.sessaoAusente || estado.sessaoFalha
                  ? null
                  : { id: SESSAO, organization_id: ORG },
              error: estado.sessaoFalha ? { code: "08006", message: "consulta fictícia" } : null,
            };
          if (estado.consultaFalha)
            return { data: null, error: { code: "08006", message: "releitura fictícia" } };
          const rows = [...estado.linhas.values()].filter((row) =>
            [...filters].every(([key, value]) => row[key] === value),
          );
          return { data: rows.length === 1 ? rows[0] : null, error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({
            data: null,
            error:
              updating && estado.statusFalha ? { code: "08006", message: "status fictício" } : null,
          }).then(resolve);
        },
      };
      return query;
    },
  };
}

import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";

function pedido(ids: string[], signature = true, custom?: unknown) {
  const raw = JSON.stringify(
    custom ?? {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-ficticia",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "111" },
                messages: ids.map((id) => ({
                  id,
                  from: "5511999999999",
                  timestamp: "1792836000",
                  type: "text",
                  text: { body: "Mensagem fictícia " + id },
                })),
              },
            },
          ],
        },
      ],
    },
  );
  return {
    text: async () => raw,
    headers: new Headers(
      signature
        ? {
            "x-hub-signature-256": `sha256=${createHmac("sha256", SEGREDO).update(raw).digest("hex")}`,
          }
        : {},
    ),
  } as never;
}
const ctx = { params: Promise.resolve({ token: "token-ficticio" }) };

beforeEach(() => {
  estado.linhas.clear();
  estado.falharIds.clear();
  estado.efeitos = [];
  estado.consultaFalha =
    estado.sessaoAusente =
    estado.sessaoFalha =
    estado.conflitoSemLinha =
      false;
  estado.insertSemId = estado.statusFalha = false;
  estado.tokenValido = true;
});

describe("confirmação do webhook e persistência", () => {
  it("confirma uma mensagem persistida e o replay não repete efeitos", async () => {
    expect((await POST(pedido(["A"]), ctx)).status).toBe(200);
    expect((await POST(pedido(["A"]), ctx)).status).toBe(200);
    expect(estado.linhas.size).toBe(1);
    expect(estado.efeitos).toEqual(["msg-A"]);
  });
  it("falha transitória de insert não recebe ACK200", async () => {
    estado.falharIds.add("A");
    expect((await POST(pedido(["A"]), ctx)).status).toBe(503);
    expect(estado.linhas.size).toBe(0);
  });
  it("lote parcial preserva A; no replay só B nasce e ganha efeitos", async () => {
    estado.falharIds.add("B");
    expect((await POST(pedido(["A", "B"]), ctx)).status).toBe(503);
    expect(estado.linhas.size).toBe(1);
    estado.falharIds.clear();
    expect((await POST(pedido(["A", "B"]), ctx)).status).toBe(200);
    expect(estado.linhas.size).toBe(2);
    expect(estado.efeitos).toEqual(["msg-A", "msg-B"]);
  });
  it("23505 sem mensagem exata não prova duplicata", async () => {
    estado.conflitoSemLinha = true;
    expect((await POST(pedido(["A"]), ctx)).status).toBe(503);
  });
  it.each(["organization_id", "channel_session_id", "direction"])(
    "duplicata com %s diferente não confirma",
    async (campo) => {
      estado.linhas.set("outra:A", {
        id: "msg-A",
        organization_id: ORG,
        external_id: "A",
        channel_session_id: SESSAO,
        direction: "inbound",
        [campo]: "outro",
      });
      estado.conflitoSemLinha = true;
      expect((await POST(pedido(["A"]), ctx)).status).toBe(503);
      expect(estado.efeitos).toEqual([]);
    },
  );
  it("releitura de duplicata indisponível pede retry", async () => {
    await POST(pedido(["A"]), ctx);
    estado.consultaFalha = true;
    expect((await POST(pedido(["A"]), ctx)).status).toBe(503);
    expect(estado.efeitos).toEqual(["msg-A"]);
  });
  it("insert sem ID confirmado não declara sucesso", async () => {
    estado.insertSemId = true;
    expect((await POST(pedido(["A"]), ctx)).status).toBe(503);
  });
  it("consulta de sessão falha é transitória", async () => {
    estado.sessaoFalha = true;
    expect((await POST(pedido(["A"]), ctx)).status).toBe(503);
  });
  it("número comprovadamente não administrado é descarte permanente", async () => {
    estado.sessaoAusente = true;
    const response = await POST(pedido(["A"]), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcomes: ["no_session"] });
    expect(estado.linhas.size).toBe(0);
  });
  it("preserva assinatura, token e validação de payload", async () => {
    expect((await POST(pedido(["A"], false), ctx)).status).toBe(401);
    expect((await POST(pedido([], true, { entry: 3 }), ctx)).status).toBe(400);
    estado.tokenValido = false;
    expect((await POST(pedido(["A"]), ctx)).status).toBe(404);
    expect(estado.linhas.size).toBe(0);
  });
  it("evento irrelevante confirmado não cria retry", async () => {
    expect((await POST(pedido([], true, { object: "page", entry: [] }), ctx)).status).toBe(200);
  });
  it.each(["delivered", "failed"])(
    "falha na escrita do status %s não recebe ACK200",
    async (status) => {
      estado.statusFalha = true;
      const event = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba-ficticia",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "111" },
                  statuses: [
                    {
                      id: "A",
                      status,
                      timestamp: "1792836000",
                      recipient_id: "5511999999999",
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      expect((await POST(pedido([], true, event), ctx)).status).toBe(503);
    },
  );
  it("falha na escrita do estado de modelo não recebe ACK200", async () => {
    estado.statusFalha = true;
    const event = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-ficticia",
          changes: [
            {
              field: "message_template_status_update",
              value: {
                message_template_name: "ficticio",
                message_template_language: "pt_BR",
                event: "APPROVED",
              },
            },
          ],
        },
      ],
    };
    expect((await POST(pedido([], true, event), ctx)).status).toBe(503);
    estado.statusFalha = false;
    expect((await POST(pedido([], true, event), ctx)).status).toBe(200);
  });
});
