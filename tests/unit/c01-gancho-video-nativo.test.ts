/**
 * (C01, -c01.11) O PEDIDO AO GANCHO DIZ QUAL VÍDEO NATIVO SAIU.
 *
 * O vídeo nativo chega ao porteiro só como a legenda (`texto`), sem o link do Panda: a volta
 * de 10 min e a cortesia não sabiam que o vídeo do curso saiu. A linha de vídeo passa a levar
 * `video_chave`, a chave do catálogo (`c01_native_videos`) do arquivo `…/video-<sha256>.mp4`:
 *   (1) vídeo do catálogo → a chave; texto e imagem → sem o campo;
 *   (2) arquivo fora do catálogo ou política ilegível → sem o campo, o resto do pedido igual;
 *   (3) sem vídeo nas mensagens, a política nem é lida.
 * Ids, chaves e hashes são fictícios.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: vi.fn(async () => ({ status: "vetoed", code: "janela_fechada" })),
}));

import { rodarGanchoAntesDoTurno, type GanchoAntesDoTurnoConfig } from "@/lib/agent-engine/agent/gancho-antes-do-turno";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const ENTRADA = "66666666-6666-4666-8666-666666666666";
const CONFIG: GanchoAntesDoTurnoConfig = { url: "http://gancho.teste/turno", segredo: "s3gr3do", prazoMs: 100 };
const AGORA = new Date("2026-10-27T12:00:00Z");
const PAYLOAD = { conversation_id: CONV, contact_id: CONTATO, channel_session_id: SESSAO, inbound_message_id: ENTRADA };

const SHA_CURSO = "a".repeat(64);
const SHA_FORA = "b".repeat(64);
const POLITICA = {
  enabled: true,
  catalog: [{ key: "video_prep_teste", sha256: SHA_CURSO }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

type Linha = { direction: string; type: string; body: string | null; video_arquivo: string | null };
const linha = (type: string, body: string | null, video_arquivo: string | null = null): Linha => ({
  direction: "outbound", type, body, video_arquivo,
});

function banco(mensagens: Linha[], politica: unknown | "erro") {
  const consultas: string[] = [];
  const db = {
    query: vi.fn(async (sql: string) => {
      consultas.push(sql);
      if (sql.includes("c01_native_videos")) {
        if (politica === "erro") throw new Error("statement timeout");
        return { rows: [{ policy: politica }], rowCount: 1 };
      }
      if (sql.includes("as video_arquivo"))
        // A consulta é "desc": a mais nova primeiro.
        return {
          rows: [...mensagens].reverse().map((m, i) => ({ ...m, interativo: null, em: `2026-10-27 11:5${i}:00+00`, situacao: "sent" })),
          rowCount: mensagens.length,
        };
      if (sql.includes("max(created_at)::text")) return { rows: [{ em: "2026-10-27 11:59:00+00" }], rowCount: 1 };
      if (sql.includes("from conversations c"))
        return { rows: [{ assignee_kind: null, assigned_to_user_id: null, last_inbound_at: null, provider: "meta" }], rowCount: 1 };
      if (sql.includes("from crm_leads"))
        return { rows: [{ id: "card-1", status: "open", etapa: "novo", custom_fields: {}, tags: [] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  return { db, consultas };
}

async function pedido(b: ReturnType<typeof banco>) {
  const pedidos: Array<{ mensagens: Array<Record<string, unknown>> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      pedidos.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ acao: "seguir" }), { status: 200 });
    }),
  );
  await rodarGanchoAntesDoTurno({
    pool: b.db as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: CONFIG,
    job: { id: "job-1", organization_id: ORG, payload: PAYLOAD, kind: "inbound_turn" } as unknown as JobRow,
    tenantId: ORG,
    contactId: CONTATO,
    conversationId: CONV,
    channelSessionId: SESSAO,
    inboundMessageId: ENTRADA,
    agentId: null,
    etiquetasDoContato: [],
    channel: { send: vi.fn() } as never,
    optedOutThisTurn: false,
    now: () => AGORA,
  });
  expect(pedidos).toHaveLength(1);
  return pedidos[0]!.mensagens;
}

describe("(1) a linha de vídeo leva a chave do catálogo", () => {
  it("vídeo do catálogo → video_chave; texto → sem o campo", async () => {
    const msgs = await pedido(banco([
      linha("text", "oi"),
      linha("video", "Esse vídeo mostra as aulas por dentro", `${ORG}/${CONV}/video-${SHA_CURSO}.mp4`),
    ], POLITICA));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).not.toHaveProperty("video_chave");
    expect(msgs[1]).toMatchObject({ texto: "Esse vídeo mostra as aulas por dentro", video_chave: "video_prep_teste" });
  });
});

describe("(2) sem chave conhecida, o pedido segue sem o campo", () => {
  it("arquivo fora do catálogo", async () => {
    const msgs = await pedido(banco([linha("video", "legenda", `${ORG}/${CONV}/video-${SHA_FORA}.mp4`)], POLITICA));
    expect(msgs[0]).not.toHaveProperty("video_chave");
    expect(msgs[0]).toMatchObject({ texto: "legenda" });
  });

  it("política ilegível ou com erro de leitura", async () => {
    for (const politica of [{ enabled: true }, "erro"] as const) {
      const msgs = await pedido(banco([linha("video", "legenda", `${ORG}/${CONV}/video-${SHA_CURSO}.mp4`)], politica));
      expect(msgs[0]).not.toHaveProperty("video_chave");
    }
  });
});

describe("(3) sem vídeo, a política não é lida", () => {
  it("só texto e imagem", async () => {
    const b = banco([linha("text", "oi"), linha("image", null)], POLITICA);
    const msgs = await pedido(b);
    expect(msgs.map((m) => m.texto)).toEqual(["oi", "[image]"]);
    expect(b.consultas.some((sql) => sql.includes("c01_native_videos"))).toBe(false);
  });
});
