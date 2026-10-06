/**
 * (C01, -c01.5) ENVIO DE MENSAGEM INTERATIVA: sai pelo canal oficial como a
 * plataforma a descreve; canal que não sabe enviá-la recusa com motivo claro.
 *
 * Pelo HANDLER (`sendMessageHandler`), a única porta de saída: é ele que decide o
 * que a linha da conversa diz e o que vai ao transporte. O canal oficial é o
 * adapter real com `fetch` dublado, para medir o corpo exato do POST na Graph.
 *
 * Antes: o handler não conhecia `interactive`; o canal oficial mandava só o
 * `body` como texto, e o canal não oficial também (a pessoa recebia o texto que
 * anuncia um botão que não existe).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { corpoDoEnvio } from "@/lib/agent-engine/edge/crm/send-message";
import { hashDoConteudo } from "@/lib/agent-engine/edge/crm/send-ledger";
import { sendMessageSchema, type SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const NUMERO = "1103328999528818";

// A credencial da sessão oficial, como a tela de conexão a grava (cifrada).
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const alvo: Record<string, unknown> = {
        maybeSingle: async () => ({
          data: { meta_phone_number_id: NUMERO, meta_token_encrypted: "\\xdeadbeef" },
          error: null,
        }),
      };
      alvo.select = () => alvo;
      alvo.eq = () => alvo;
      alvo.is = () => alvo;
      return alvo;
    },
    rpc: async (nome: string) =>
      nome === "fn_decrypt_oauth" ? { data: "tok-da-sessao", error: null } : { data: null, error: null },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

function conversa(provider: string) {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    provider_conversation_id: null,
    contacts: { phone_number: "+5511999990000", wa_identity: "phone:+5511999990000", wa_lid: null, is_blocked: false },
    channel_sessions: {
      provider,
      waha_session_name: provider === "waha" ? "default" : null,
      meta_phone_number_id: provider === "meta_cloud" ? NUMERO : null,
      zernio_account_id: null,
      status: "WORKING",
      archived_at: null,
    },
  };
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1" };

/** Um formulário (WhatsApp Flows) no formato da Meta, sem dado de ninguém. */
const FORMULARIO = {
  type: "flow",
  body: { text: "Responda em 1 minuto" },
  action: {
    name: "flow",
    parameters: {
      flow_message_version: "3",
      flow_token: "tok-1",
      flow_id: "123",
      flow_cta: "Responder",
      flow_action: "navigate",
      flow_action_payload: { screen: "INICIO" },
    },
  },
};

const pedido = (over: Partial<SendMessageInput> = {}): SendMessageInput =>
  ({ conversation_id: CONV, type: "text", body: "Responda em 1 minuto", interactive: FORMULARIO, ...over }) as SendMessageInput;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("canal oficial: o interativo sai como a plataforma o descreve", () => {
  it("o POST na Graph leva `type: interactive` com o objeto exato, e a linha fica `text`", async () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "wamid.FLOW" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversa("meta_cloud") });

    const msg = await sendMessageHandler(supabase, ctx, pedido());

    expect(msg.status).toBe("sent");
    expect(msg.external_id).toBe("wamid.FLOW");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, { body: string }];
    expect(String(url)).toContain(`/${NUMERO}/messages`);
    expect(JSON.parse(init.body)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "5511999990000",
      type: "interactive",
      interactive: FORMULARIO,
    });
    const linha = capturas.inserts.messages!.at(-1)!;
    expect(linha.type).toBe("text");
    expect(linha.body).toBe("Responda em 1 minuto");
    expect((linha.metadata as Record<string, unknown>).interactive).toEqual(FORMULARIO);
  });
});

describe("canal que não envia interativo: recusa clara, antes da linha existir", () => {
  it("canal não oficial → 422 `interativo_nao_suportado`, nada gravado, nada na rede", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversa("waha") });

    const erro = await sendMessageHandler(supabase, ctx, pedido()).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(422);
    expect((erro as ApiError).code).toBe("interativo_nao_suportado");
    expect(capturas.inserts.messages ?? []).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("o contrato do envio carrega o interativo até o handler", () => {
  it("o schema aceita o objeto livre (só `type`), e só com `type: text` sem mídia", () => {
    const ok = sendMessageSchema.safeParse(pedido());
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.interactive).toEqual(FORMULARIO);
    expect(sendMessageSchema.safeParse(pedido({ interactive: {} as never })).success).toBe(false);
    expect(sendMessageSchema.safeParse(pedido({ type: "image", media_url: "https://x.example/a.jpg" })).success).toBe(false);
  });

  it("`corpoDoEnvio` repassa o interativo como `text` + `interactive`", () => {
    const base = { tenantId: ORG, leadId: CONTACT, jobId: "job", seq: -1, conversationId: CONV, body: "Responda" };
    expect(corpoDoEnvio({ ...base, interactive: FORMULARIO }, "k")).toEqual({
      conversation_id: CONV,
      type: "text",
      body: "Responda",
      interactive: FORMULARIO,
      metadata: { idempotency_key: "k" },
    });
  });

  it("dois interativos com o mesmo texto não são a mesma mensagem no ledger", () => {
    const outro = { ...FORMULARIO, action: { ...FORMULARIO.action, parameters: { ...FORMULARIO.action.parameters, flow_id: "456" } } };
    expect(hashDoConteudo({ body: "Responda", interactive: FORMULARIO } as never)).not.toBe(
      hashDoConteudo({ body: "Responda", interactive: outro } as never),
    );
    expect(hashDoConteudo({ body: "Responda", interactive: FORMULARIO } as never)).not.toBe(
      hashDoConteudo({ body: "Responda" }),
    );
  });
});
