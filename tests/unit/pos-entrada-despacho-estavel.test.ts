import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aplicarEfeitosPosEntrada, type EntradaDeMensagem } from "@/lib/channels/pos-entrada";

vi.mock("@/lib/leads/nascimento-do-lead", () => ({
  garantirLeadDaConversa: async () => ({ criado: false, motivo: "ja_existe" }),
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehContatoDoNumeroInterno: async () => false,
}));
vi.mock("@/lib/c01/zerar-celular-de-teste", () => ({
  zerarCelularDeTesteSePedido: async () => undefined,
}));
vi.mock("@/lib/dev/kick-local-pipeline", () => ({
  acelerarFollowupDoInbound: async () => undefined,
  drenarEventosDoInbound: async () => undefined,
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const entrada: EntradaDeMensagem & { despachoPorMensagem: true } = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  contactId: "22222222-2222-4222-8222-222222222222",
  conversationId: "33333333-3333-4333-8333-333333333333",
  channelSessionId: "44444444-4444-4444-8444-444444444444",
  messageId: "55555555-5555-4555-8555-555555555555",
  texto: "Mensagem fictícia",
  nomeDoContato: null,
  origem: "teste",
  despachoPorMensagem: true,
};
type Row = Record<string, unknown>;
const eventos = new Map<string, Row>();
let linha: Row;
let leituraFalha = false;
let perderResposta = false;
function admin(): SupabaseClient {
  return {
    async rpc(name: string, args: Row) {
      if (name === "emit_event") {
        const id = randomUUID();
        eventos.set(id, {
          id,
          organization_id: args.p_organization_id,
          event_type: args.p_event_type,
          entity_kind: args.p_entity_kind,
          entity_id: args.p_entity_id,
          payload: args.p_payload,
        });
        return { data: id, error: null };
      }
      return { data: null, error: null };
    },
    from(table: string) {
      const filters = new Map<string, unknown>();
      let inserted: Row | undefined;
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filters.set(k, v);
          return q;
        },
        limit: () => q,
        filter: () => q,
        insert: (r: Row) => {
          inserted = r;
          return q;
        },
        async run() {
          if (table === "event_log") {
            if (leituraFalha && !inserted)
              return { data: null, error: { code: "08006", message: "leitura fictícia" } };
            if (inserted) {
              const id = inserted.id as string;
              if (eventos.has(id))
                return { data: null, error: { code: "23505", message: "duplicata" } };
              eventos.set(id, { ...inserted });
              if (perderResposta) {
                perderResposta = false;
                return { data: null, error: { code: "08006", message: "resposta perdida" } };
              }
              return { data: [inserted], error: null };
            }
            return {
              data: [...eventos.values()].filter((row) =>
                [...filters].every(([k, v]) => row[k] === v),
              ),
              error: null,
            };
          }
          if (table === "messages") return { data: [lineMatch()], error: null };
          if (table === "contacts") return { data: [{ is_personal: false }], error: null };
          if (table === "channel_sessions") return { data: [], error: null };
          return { data: [], error: null };
        },
        async maybeSingle() {
          const r = await q.run();
          return { ...r, data: r.data?.length === 1 ? r.data[0] : null };
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          return q.run().then(resolve, reject);
        },
      };
      function lineMatch() {
        return [...filters].every(([k, v]) => linha[k] === v) ? linha : null;
      }
      return q;
    },
  } as unknown as SupabaseClient;
}
beforeEach(() => {
  eventos.clear();
  leituraFalha = perderResposta = false;
  linha = {
    id: entrada.messageId,
    organization_id: entrada.organizationId,
    contact_id: entrada.contactId,
    conversation_id: entrada.conversationId,
    channel_session_id: entrada.channelSessionId,
    direction: "inbound",
    type: "text",
  };
});
function oldEvent(id = randomUUID()): Row {
  return {
    id,
    organization_id: entrada.organizationId,
    event_type: "ai_agent.dispatch_requested",
    entity_kind: "message",
    entity_id: entrada.messageId,
    payload: {
      organization_id: entrada.organizationId,
      contact_id: entrada.contactId,
      conversation_id: entrada.conversationId,
      channel_session_id: entrada.channelSessionId,
      inbound_message_id: entrada.messageId,
    },
  };
}

describe("pedido de despacho estável pela mensagem", () => {
  it("repetir o pedido conserva um evento", async () => {
    await aplicarEfeitosPosEntrada(admin(), entrada);
    await aplicarEfeitosPosEntrada(admin(), entrada);
    expect(eventos.size).toBe(1);
  });
  it("oito pedidos concorrentes conservam um evento", async () => {
    await Promise.all(Array.from({ length: 8 }, () => aplicarEfeitosPosEntrada(admin(), entrada)));
    expect(eventos.size).toBe(1);
  });
  it("preserva evento legado exato em vez de criar outra origem", async () => {
    const old = oldEvent();
    eventos.set(old.id as string, old);
    await aplicarEfeitosPosEntrada(admin(), entrada);
    expect([...eventos.keys()]).toEqual([old.id]);
  });
  it("resposta perdida depois do commit não vira outro evento", async () => {
    perderResposta = true;
    await aplicarEfeitosPosEntrada(admin(), entrada);
    await aplicarEfeitosPosEntrada(admin(), entrada);
    expect(eventos.size).toBe(1);
  });
  it.each(["organization_id", "contact_id", "conversation_id", "channel_session_id", "direction"])(
    "vínculo divergente em %s bloqueia",
    async (campo) => {
      linha[campo] = randomUUID();
      await aplicarEfeitosPosEntrada(admin(), entrada);
      expect(eventos.size).toBe(0);
    },
  );
  it("leitura indisponível não autoriza evento novo", async () => {
    leituraFalha = true;
    await aplicarEfeitosPosEntrada(admin(), entrada);
    expect(eventos.size).toBe(0);
  });
  it("dois legados já ambíguos são preservados e não ganham um terceiro", async () => {
    const a = oldEvent(),
      b = oldEvent();
    eventos.set(a.id as string, a);
    eventos.set(b.id as string, b);
    await aplicarEfeitosPosEntrada(admin(), entrada);
    expect(eventos.size).toBe(2);
  });
  it("evento anterior com payload divergente não autoriza outro", async () => {
    const a = oldEvent();
    a.payload = { ...(a.payload as Row), contact_id: randomUUID() };
    eventos.set(a.id as string, a);
    await aplicarEfeitosPosEntrada(admin(), entrada);
    expect([...eventos.keys()]).toEqual([a.id]);
  });
});
