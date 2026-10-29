/**
 * (C01, -c01.14) A DEVOLUÇÃO PEDE O TURNO DA MENSAGEM QUE FICOU SEM RESPOSTA.
 *
 * Caso real (Lauro, 28/10): o lead perguntou "qual o valor do curso?" com a
 * conversa com humano; a conversa voltou para a IA e ninguém respondeu, porque
 * `devolverAtendimentoAoAgente` emitia `ai.handoff_resolved` e nenhum pedido de
 * turno. O dublê filtra linhas de verdade (eq, gt, gte, `payload->>chave`,
 * order, limit), então o teste prende o efeito — o `emit_event` que sai —, não
 * a chamada interna.
 */
import { describe, expect, it, vi } from "vitest";

import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import type { Actor } from "@/lib/api/handlers/types";

vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const ORG = "22222222-2222-4222-8222-222222222222";
const CONV = "44444444-4444-4444-8444-444444444444";
const CONTATO = "55555555-5555-4555-8555-555555555555";
const CANAL = "77777777-7777-4777-8777-777777777777";
const ATENDENTE = "11111111-1111-4111-8111-111111111111";
const PERGUNTA = "88888888-8888-4888-8888-888888888888";

const USUARIO: Actor = { type: "user", id: ATENDENTE, role: "manager" };

type Linha = Record<string, unknown>;

function valor(linha: Linha, coluna: string): unknown {
  const [col, chave] = coluna.split("->>");
  const v = linha[col ?? ""];
  return chave === undefined ? v : (v as Linha | null)?.[chave];
}

function fazerSupabase(tabelas: Record<string, Linha[]>, emitFalha?: { message: string }) {
  const rpc: Array<{ fn: string; args: Linha }> = [];
  const from = (tabela: string) => {
    let ehEscrita = false;
    let limite = Infinity;
    const filtros: Array<(l: Linha) => boolean> = [];
    const ordens: Array<[string, boolean]> = [];
    const resultado = () => {
      if (ehEscrita) return [{ id: tabela === "contacts" ? CONTATO : CONV }];
      const linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l)));
      for (const [col, asc] of [...ordens].reverse()) {
        linhas.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      return linhas.slice(0, limite);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      update: () => ((ehEscrita = true), chain),
      insert: () => Promise.resolve({ data: null, error: null }),
      eq: (c: string, v: unknown) => (filtros.push((l) => valor(l, c) === v), chain),
      is: () => chain,
      in: () => chain,
      gt: (c: string, v: string) => (filtros.push((l) => String(valor(l, c)) > v), chain),
      gte: (c: string, v: string) => (filtros.push((l) => String(valor(l, c)) >= v), chain),
      order: (c: string, o?: { ascending?: boolean }) => (ordens.push([c, o?.ascending ?? true]), chain),
      limit: (n: number) => ((limite = n), chain),
      maybeSingle: () => Promise.resolve({ data: resultado()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: resultado(), error: null }).then(res),
    };
    return chain;
  };
  const client = {
    from,
    rpc: (fn: string, args: Linha) => {
      rpc.push({ fn, args });
      const falha = fn === "emit_event" && args.p_event_type === "ai_agent.dispatch_requested";
      return Promise.resolve({ data: null, error: falha ? (emitFalha ?? null) : null });
    },
  };
  return { client, rpc };
}

const ha = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HORA = 60 * MIN;

function inbound(over: Linha = {}): Linha {
  return {
    id: PERGUNTA,
    organization_id: ORG,
    conversation_id: CONV,
    direction: "inbound",
    type: "text",
    sent_at: ha(10 * MIN),
    created_at: ha(10 * MIN),
    ...over,
  };
}

async function devolver(opcoes: {
  mensagens: Linha[];
  eventos?: Linha[];
  emitFalha?: { message: string };
}) {
  const { client, rpc } = fazerSupabase(
    {
      conversations: [
        {
          id: CONV,
          organization_id: ORG,
          contact_id: CONTATO,
          status: "claimed",
          assigned_to_user_id: ATENDENTE,
          assignee_kind: "user",
          bot_silenced_until: "infinity",
          channel_session_id: CANAL,
        },
      ],
      contacts: [{ id: CONTATO, organization_id: ORG, ai_opt_out: false, force_human: true }],
      messages: opcoes.mensagens,
      event_log: opcoes.eventos ?? [],
    },
    opcoes.emitFalha,
  );
  const r = await devolverAtendimentoAoAgente(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { supabase: client as any, organizationId: ORG, actor: USUARIO, requestId: "req-1" },
    { conversationId: CONV },
  );
  const pedidos = rpc.filter(
    (c) => c.fn === "emit_event" && c.args.p_event_type === "ai_agent.dispatch_requested",
  );
  return { r, pedidos, rpc };
}

describe("(C01, -c01.14) devolução com mensagem do lead pendente", () => {
  it("pede o turno da IA para a última inbound sem resposta, depois do ai.handoff_resolved", async () => {
    const { r, pedidos, rpc } = await devolver({
      mensagens: [
        inbound({ id: "antiga", sent_at: ha(40 * MIN), created_at: ha(40 * MIN) }),
        { ...inbound({ id: "resposta-antiga" }), direction: "outbound", created_at: ha(30 * MIN) },
        inbound(),
      ],
    });
    expect(r.ok).toBe(true);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.args).toMatchObject({
      p_entity_kind: "message",
      p_entity_id: PERGUNTA,
      p_organization_id: ORG,
      p_payload: {
        organization_id: ORG,
        conversation_id: CONV,
        contact_id: CONTATO,
        channel_session_id: CANAL,
        inbound_message_id: PERGUNTA,
      },
      p_metadata: { source: "retomada", motivo: "devolvido_com_mensagem_pendente" },
    });
    const tipos = rpc.filter((c) => c.fn === "emit_event").map((c) => c.args.p_event_type);
    expect(tipos.indexOf("ai.handoff_resolved")).toBeLessThan(
      tipos.indexOf("ai_agent.dispatch_requested"),
    );
  });

  it("inbound já respondida não pede turno", async () => {
    const { r, pedidos } = await devolver({
      mensagens: [
        inbound(),
        { ...inbound({ id: "resposta" }), direction: "outbound", created_at: ha(5 * MIN) },
      ],
    });
    expect(r.ok).toBe(true);
    expect(pedidos).toHaveLength(0);
  });

  it("inbound com mais de 23 h não pede turno", async () => {
    const { r, pedidos } = await devolver({
      mensagens: [inbound({ sent_at: ha(23 * HORA + MIN), created_at: ha(23 * HORA + MIN) })],
    });
    expect(r.ok).toBe(true);
    expect(pedidos).toHaveLength(0);
  });

  it("pedido já feito depois do início da devolução não duplica; o anterior a ela não conta", async () => {
    const pedido = (criado: string) => ({
      organization_id: ORG,
      event_type: "ai_agent.dispatch_requested",
      payload: { inbound_message_id: PERGUNTA },
      created_at: criado,
    });
    const jaPedido = await devolver({
      mensagens: [inbound()],
      eventos: [pedido(new Date(Date.now() + 1000).toISOString())],
    });
    expect(jaPedido.pedidos).toHaveLength(0);

    // O pedido de quando a mensagem chegou (com humano, o dreno pulou) não impede.
    const doInbound = await devolver({ mensagens: [inbound()], eventos: [pedido(ha(10 * MIN))] });
    expect(doInbound.pedidos).toHaveLength(1);
  });

  it("falha no pedido do turno não quebra a devolução", async () => {
    const { r, pedidos } = await devolver({
      mensagens: [inbound()],
      emitFalha: { message: "boom" },
    });
    expect(pedidos).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, conversationId: CONV });
  });
});
