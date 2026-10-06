import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * (C01, -c01.5) A RESPOSTA INTERATIVA DO CONTATO NUNCA SE PERDE.
 *
 * Antes: a Meta entrega a resposta de um formulário (WhatsApp Flows), de um botão
 * ou de uma lista como `type: "interactive"` (e o botão de modelo como
 * `type: "button"`). O parser repassava o tipo cru, o CHECK `messages_type_check`
 * (migration 0091) recusava o insert, a rota escrevia "inbound não ingerido" no
 * log e respondia 200: a resposta sumia, a pessoa ficava sem retorno.
 *
 * O teste entra pela ROTA, com a assinatura de verdade, e o dublê do banco aplica
 * o mesmo CHECK da 0091: é o desfecho que a Meta e o inbox enxergam, não a função
 * isolada.
 */

const SESSAO = { id: "sess-1", organizationId: "org-1", wabaId: "waba-1" };
const SEGREDO = "segredo-de-teste";
/** O vocabulário fechado do CHECK `messages_type_check` (migration 0091). */
const TIPOS_DO_CHECK = [
  "text", "image", "video", "audio", "document", "sticker",
  "location", "contact", "reaction", "system", "template",
];

const estado = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  textosPosEntrada: [] as Array<string | null>,
  previas: [] as string[],
}));

vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionByWebhookToken: async () => SESSAO,
}));
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: async () => ({ appSecret: SEGREDO, verifyToken: null }),
  invalidarAppDaMeta: () => undefined,
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
  registrarMensagemIgnorada: async () => undefined,
}));
vi.mock("@/lib/channels/marcar-conversa", () => ({
  marcarConversaComMensagem: async (_a: unknown, m: { preview: string }) => {
    estado.previas.push(m.preview);
  },
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async (_a: unknown, p: { texto: string | null }) => {
    estado.textosPosEntrada.push(p.texto);
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      if (tabela === "channel_sessions") {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          maybeSingle: async () => ({ data: { id: SESSAO.id, organization_id: SESSAO.organizationId }, error: null }),
        };
        return chain;
      }
      if (tabela === "messages") {
        return {
          insert: (payload: Record<string, unknown>) => {
            const aceito = TIPOS_DO_CHECK.includes(String(payload.type));
            if (aceito) estado.inserts.push(payload);
            return {
              select: () => ({
                maybeSingle: async () =>
                  aceito
                    ? { data: { id: `msg-${estado.inserts.length}` }, error: null }
                    : {
                        data: null,
                        error: {
                          code: "23514",
                          message: 'new row for relation "messages" violates check constraint "messages_type_check"',
                        },
                      },
              }),
            };
          },
        };
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
    rpc: async (nome: string) => {
      if (nome === "fn_upsert_wa_contact") return { data: "contact-1", error: null };
      if (nome === "fn_upsert_wa_conversation") return { data: "conv-1", error: null };
      return { data: null, error: null };
    },
  }),
}));

import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";

const ctx = { params: Promise.resolve({ token: "token-de-teste" }) } as never;

/** Envelope `messages` com UMA mensagem do contato, como a Meta entrega. */
function envelope(mensagem: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: SESSAO.wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: "phone-1" },
              contacts: [{ profile: { name: "Contato" }, wa_id: "5511999990000" }],
              messages: [{ from: "5511999990000", timestamp: "1790000000", ...mensagem }],
            },
          },
        ],
      },
    ],
  };
}

async function entregar(corpo: unknown) {
  const cru = JSON.stringify(corpo);
  const req = {
    text: async () => cru,
    headers: new Headers({
      "x-hub-signature-256": `sha256=${createHmac("sha256", SEGREDO).update(cru, "utf8").digest("hex")}`,
    }),
  } as never;
  const res = await POST(req, ctx);
  return { status: res.status, corpo: (await res.json()) as { outcomes: string[] } };
}

/**
 * O exemplo oficial da Meta ("Flow response message webhook", referência de
 * WhatsApp Flows), com os marcadores `<...>` trocados por valores.
 */
const RESPOSTA_DE_FLOW_OFICIAL = {
  context: { from: "16315558151", id: "gBGGEiRVVgBPAgm7FUgc73noXjo" },
  id: "wamid.FLOW1",
  type: "interactive",
  interactive: {
    type: "nfm_reply",
    nfm_reply: {
      name: "flow",
      body: "Sent",
      response_json:
        '{"flow_token": "<FLOW_TOKEN>", "optional_param1": "<value1>", "optional_param2": "<value2>"}',
    },
  },
};

let erros: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  estado.inserts.length = 0;
  estado.textosPosEntrada.length = 0;
  estado.previas.length = 0;
  erros = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  erros.mockRestore();
});

function naoIngeridos(): unknown[] {
  return erros.mock.calls.filter((c: unknown[]) => String(c[0]).includes("inbound não ingerido"));
}

describe("resposta de formulário (nfm_reply)", () => {
  it("o exemplo oficial da Meta vira linha `text` com o original no metadata", async () => {
    const r = await entregar(envelope(RESPOSTA_DE_FLOW_OFICIAL));

    expect(r.status).toBe(200);
    expect(r.corpo.outcomes).toEqual(["ingested"]);
    expect(naoIngeridos()).toEqual([]);
    expect(estado.inserts).toHaveLength(1);
    const linha = estado.inserts[0]!;
    expect(linha).toMatchObject({
      type: "text",
      body: "Formulário respondido",
      external_id: "wamid.FLOW1",
      direction: "inbound",
    });
    expect(linha.metadata).toEqual({
      interactive: {
        type: "nfm_reply",
        name: "flow",
        body: "Sent",
        flow_token: "<FLOW_TOKEN>",
        response: { flow_token: "<FLOW_TOKEN>", optional_param1: "<value1>", optional_param2: "<value2>" },
        raw: RESPOSTA_DE_FLOW_OFICIAL.interactive.nfm_reply.response_json,
      },
      raw_type: "interactive",
      context_id: "gBGGEiRVVgBPAgm7FUgc73noXjo",
    });
  });

  it("as checagens da entrada leem o texto neutro, não as respostas marcadas", async () => {
    await entregar(envelope(RESPOSTA_DE_FLOW_OFICIAL));
    expect(estado.textosPosEntrada).toEqual(["Formulário respondido"]);
    expect(estado.previas).toEqual(["Formulário respondido"]);
  });

  it("`response_json` quebrado não derruba a entrada: resposta nula, bruto guardado", async () => {
    const quebrado = {
      ...RESPOSTA_DE_FLOW_OFICIAL,
      id: "wamid.FLOW2",
      interactive: { type: "nfm_reply", nfm_reply: { name: "flow", body: "Sent", response_json: '{"flow_token": "abc",' } },
    };
    const r = await entregar(envelope(quebrado));

    expect(r.corpo.outcomes).toEqual(["ingested"]);
    expect(naoIngeridos()).toEqual([]);
    expect(estado.inserts[0]).toMatchObject({
      type: "text",
      body: "Formulário respondido",
      metadata: {
        interactive: { type: "nfm_reply", response: null, flow_token: null, raw: '{"flow_token": "abc",' },
        raw_type: "interactive",
      },
    });
  });
});

describe("botão, lista e botão de modelo", () => {
  it("button_reply: o texto é o título do botão", async () => {
    const r = await entregar(
      envelope({
        id: "wamid.BTN",
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "sim-quero", title: "Sim, quero" } },
      }),
    );
    expect(r.corpo.outcomes).toEqual(["ingested"]);
    expect(naoIngeridos()).toEqual([]);
    expect(estado.inserts[0]).toMatchObject({
      type: "text",
      body: "Sim, quero",
      metadata: { interactive: { type: "button_reply", id: "sim-quero", title: "Sim, quero" }, raw_type: "interactive" },
    });
  });

  it("list_reply: título no texto, descrição no metadata", async () => {
    const r = await entregar(
      envelope({
        id: "wamid.LIST",
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: "opcao-2", title: "Segunda opção", description: "Detalhe da opção" },
        },
      }),
    );
    expect(r.corpo.outcomes).toEqual(["ingested"]);
    expect(naoIngeridos()).toEqual([]);
    expect(estado.inserts[0]).toMatchObject({
      type: "text",
      body: "Segunda opção",
      metadata: {
        interactive: { type: "list_reply", id: "opcao-2", title: "Segunda opção", description: "Detalhe da opção" },
      },
    });
  });

  it("button (resposta rápida de modelo): texto do botão, payload no metadata", async () => {
    const r = await entregar(
      envelope({
        id: "wamid.TPL",
        type: "button",
        context: { from: "15550000000", id: "wamid.MODELO" },
        button: { text: "Não", payload: "NAO_PAYLOAD" },
      }),
    );
    expect(r.corpo.outcomes).toEqual(["ingested"]);
    expect(naoIngeridos()).toEqual([]);
    expect(estado.inserts[0]).toMatchObject({
      type: "text",
      body: "Não",
      metadata: {
        interactive: { type: "button", payload: "NAO_PAYLOAD", text: "Não" },
        raw_type: "button",
        context_id: "wamid.MODELO",
      },
    });
  });

  it("texto comum segue igual: sem `interactive` no metadata", async () => {
    await entregar(envelope({ id: "wamid.TXT", type: "text", text: { body: "oi" } }));
    expect(estado.inserts[0]).toMatchObject({ type: "text", body: "oi", metadata: {} });
  });
});
