/**
 * (C01, -c01.16) O PEDIDO AO GANCHO LEVA `caso_aberto` E `caso_aberto_lido`.
 *
 * A pergunta automática do porteiro ("Conseguiu acessar?") não pode sair enquanto a
 * conversa tem um caso em andamento (a equipe vai responder). O pedido passa a dizer:
 *   (1) `caso_aberto`: há caso da conversa esperando gente ou esperando o cliente;
 *       resolvido, escalado ou cancelado não conta;
 *   (2) lido na organização e na conversa do job;
 *   (3) erro de leitura: `caso_aberto: false` e `caso_aberto_lido: false` — o porteiro
 *       segura o envio quando a leitura falhou, em vez de presumir que não há caso.
 * Ids fictícios.
 */
import { describe, expect, it, vi } from "vitest";

import { lerCasoAberto, montarPedidoDoGancho } from "@/lib/agent-engine/agent/gancho-antes-do-turno";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";

type Resposta = { rows: unknown[] } | "erro";

function banco(casos: () => Resposta) {
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (sql.includes("from agent_cases")) {
        const r = casos();
        if (r === "erro") throw new Error("caiu");
        return r;
      }
      return { rows: [] };
    }),
  };
  return { db, consultas };
}

describe("lerCasoAberto", () => {
  it("conta só esperando gente ou o cliente, na organização e na conversa do job", async () => {
    const { db, consultas } = banco(() => ({ rows: [{ aberto: true }] }));
    expect(await lerCasoAberto(db as never, ORG, CONV)).toBe(true);
    const c = consultas.find((q) => q.sql.includes("from agent_cases"))!;
    expect(c.sql).toMatch(/status in \('awaiting_human', 'awaiting_lead'\)/);
    expect(c.sql).toMatch(/organization_id = \$1 and conversation_id = \$2/);
    expect(c.params).toEqual([ORG, CONV]);
  });

  it("sem caso: false; erro ou resposta vazia: null", async () => {
    expect(await lerCasoAberto(banco(() => ({ rows: [{ aberto: false }] })).db as never, ORG, CONV)).toBe(false);
    expect(await lerCasoAberto(banco(() => "erro").db as never, ORG, CONV)).toBeNull();
    expect(await lerCasoAberto(banco(() => ({ rows: [] })).db as never, ORG, CONV)).toBeNull();
  });
});

describe("montarPedidoDoGancho leva o caso", () => {
  const alvo = {
    organizationId: ORG, contactId: CONTATO, conversationId: CONV, channelSessionId: SESSAO,
    agentId: null, inboundMessageId: null, etiquetasDoContato: [] as string[],
  };

  it("caso aberto: true e lido", async () => {
    const { pedido } = await montarPedidoDoGancho(banco(() => ({ rows: [{ aberto: true }] })).db as never, alvo);
    expect(pedido.caso_aberto).toBe(true);
    expect(pedido.caso_aberto_lido).toBe(true);
  });

  it("sem caso: false e lido", async () => {
    const { pedido } = await montarPedidoDoGancho(banco(() => ({ rows: [{ aberto: false }] })).db as never, alvo);
    expect(pedido.caso_aberto).toBe(false);
    expect(pedido.caso_aberto_lido).toBe(true);
  });

  it("leitura que falha: false, mas `caso_aberto_lido: false` (o porteiro segura)", async () => {
    const { pedido } = await montarPedidoDoGancho(banco(() => "erro").db as never, alvo);
    expect(pedido.caso_aberto).toBe(false);
    expect(pedido.caso_aberto_lido).toBe(false);
  });
});
