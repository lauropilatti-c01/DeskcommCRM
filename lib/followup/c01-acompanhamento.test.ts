import { describe, expect, it } from "vitest";
import {
  avaliarAcompanhamento,
  estadoDoToque,
  type FatosAcompanhamento,
  type Toque,
} from "./c01-acompanhamento";
import { flowGraphSchema } from "./graph-schema";
import { validateFlowForPublish } from "./validate-publish";

const H = 3_600_000;
const inicio = "2026-10-23T13:00:00.000Z";
const config = {
  version: 1 as const,
  kind: "oferta" as const,
  activated_at: "2026-10-23T11:00:00.000Z",
};
const agora = new Date("2026-10-23T15:00:00.000Z");
function fatos(over: Partial<FatosAcompanhamento> = {}): FatosAcompanhamento {
  return {
    organizationId: "org-a",
    contactId: "pessoa-a",
    opportunityId: "negocio-a",
    anchor: { kind: "oferta", at: inicio, delivered: true },
    lastInboundAt: inicio,
    hasNewReply: false,
    offerAfterAnchor: false,
    human: false,
    optedOut: false,
    restricted: false,
    callbackPending: false,
    anotherSequence: false,
    purchase: {
      source: "aplicada",
      organizationId: "org-a",
      contactId: "pessoa-a",
      opportunityId: "negocio-a",
      checkedAt: agora.toISOString(),
      complete: true,
      identity: "univoca",
      result: "nao_comprou",
    },
    template: { approved: false, accountReady: false },
    touches: [],
    ...over,
  };
}
function entregue(index: number, at: string): Toque {
  return {
    index,
    messageIds: [`msg-${index}`],
    receipts: [
      { id: `msg-${index}`, status: "sent", delivered_at: at, read_at: null, error_code: null },
    ],
  };
}

describe("C01: acompanhamento só com prova, sem inferir silêncio de falha", () => {
  it("23 h usa a última mensagem do cliente, e 2 h usa a entrega da oferta", () => {
    expect(avaliarAcompanhamento(config, fatos(), agora)).toMatchObject({
      kind: "send",
      touch: 1,
      transport: "text",
    });
    expect(
      avaliarAcompanhamento(
        { ...config, kind: "cronograma" },
        fatos({ anchor: { kind: "cronograma", at: inicio, delivered: true } }),
        agora,
      ),
    ).toEqual({ kind: "defer", reason: "ainda_nao_venceu", until: "2026-10-24T12:00:00.000Z" });
  });
  it("21h + 2h espera 08h; reavalia janela de 24h quando acorda", () => {
    const f = fatos({
      anchor: { kind: "oferta", at: "2026-10-24T00:00:00.000Z", delivered: true },
      lastInboundAt: "2026-10-23T10:00:00.000Z",
    });
    expect(avaliarAcompanhamento(config, f, new Date("2026-10-24T02:00:00.000Z"))).toMatchObject({
      kind: "defer",
      until: "2026-10-24T11:00:00.000Z",
    });
    const manha = new Date("2026-10-24T11:00:00.000Z");
    f.purchase = { ...f.purchase!, checkedAt: manha.toISOString() };
    expect(avaliarAcompanhamento(config, f, manha)).toEqual({
      kind: "blocked",
      reason: "modelo_ou_conta_indisponivel",
    });
  });
  it.each([
    "hasNewReply",
    "human",
    "optedOut",
    "restricted",
    "callbackPending",
    "anotherSequence",
  ] as const)("cancela o acompanhamento incompatível: %s", (key) => {
    expect(avaliarAcompanhamento(config, fatos({ [key]: true }), agora).kind).toBe("cancel");
  });
  it("não chama observação de confirmação aplicada; identidade ambígua ou sem consulta bloqueia", () => {
    const original = fatos();
    for (const purchase of [
      null,
      { ...original.purchase!, source: "observacao" as const },
      { ...original.purchase!, identity: "ambigua" as const },
      { ...original.purchase!, contactId: "outra-pessoa" },
      { ...original.purchase!, checkedAt: new Date(+agora - 16 * 60_000).toISOString() },
    ]) {
      expect(avaliarAcompanhamento(config, fatos({ purchase }), agora).kind).toBe("blocked");
    }
  });
  it("compra que chega entre seleção e envio cancela no segundo exame", () => {
    const f = fatos();
    expect(avaliarAcompanhamento(config, f, agora).kind).toBe("send");
    f.purchase = { ...f.purchase!, result: "comprou" };
    expect(avaliarAcompanhamento(config, f, agora)).toEqual({
      kind: "cancel",
      reason: "compra_confirmada",
    });
  });
  it("não matricula o passado, não inventa entrega e não aceita ativação ausente", () => {
    expect(avaliarAcompanhamento({ ...config, activated_at: null }, fatos(), agora).kind).toBe(
      "blocked",
    );
    expect(
      avaliarAcompanhamento({ ...config, activated_at: "2026-10-23T14:00:00.000Z" }, fatos(), agora)
        .kind,
    ).toBe("blocked");
    expect(
      avaliarAcompanhamento(
        config,
        fatos({ anchor: { kind: "oferta", at: inicio, delivered: false } }),
        agora,
      ).kind,
    ).toBe("blocked");
  });
  it.each(["131049", "132015", "131047"])(
    "recusa Meta %s não conta como toque entregue nem autoriza nova tentativa",
    (error_code) => {
      const t = entregue(1, inicio);
      t.receipts[0] = { ...t.receipts[0]!, error_code, status: "failed", delivered_at: null };
      expect(estadoDoToque(t)).toBe("blocked");
      expect(avaliarAcompanhamento(config, fatos({ touches: [t] }), agora)).toEqual({
        kind: "blocked",
        reason: "entrega_bloqueada",
      });
    },
  );
  it("sent não é delivered; bolha faltante, repetida e recibo incerto não viram silêncio", () => {
    const t = entregue(1, inicio);
    expect(estadoDoToque({ ...t, receipts: [{ ...t.receipts[0]!, delivered_at: null }] })).toBe(
      "unknown",
    );
    expect(estadoDoToque({ ...t, messageIds: ["msg-1", "msg-2"] })).toBe("unknown");
    expect(estadoDoToque({ ...t, receipts: [t.receipts[0]!, t.receipts[0]!] })).toBe("unknown");
    expect(
      avaliarAcompanhamento(config, fatos({ touches: [{ ...t, receipts: [] }] }), agora),
    ).toEqual({ kind: "blocked", reason: "entrega_sem_confirmacao" });
  });
  it("recibos fora de ordem conservam bloqueio e read prova entrega", () => {
    const t = entregue(1, inicio);
    expect(
      estadoDoToque({
        ...t,
        receipts: [{ ...t.receipts[0]!, delivered_at: null, read_at: inicio }],
      }),
    ).toBe("delivered");
    expect(
      estadoDoToque({
        ...t,
        receipts: [{ ...t.receipts[0]!, status: "sent", error_code: "131049" }],
      }),
    ).toBe("blocked");
  });
  it("Perdido exige quatro toques distintos entregues, 48h e compras conferidas para o negócio", () => {
    const fim = new Date("2026-11-01T15:00:00.000Z");
    const ultimo = new Date(+fim - 48 * H).toISOString();
    const f = fatos({ touches: [1, 2, 3, 4].map((i) => entregue(i, ultimo)) });
    f.purchase = { ...f.purchase!, checkedAt: new Date(+fim - 1000).toISOString() };
    expect(avaliarAcompanhamento(config, f, fim)).toEqual({
      kind: "lost",
      reason: "sem_resposta_apos_quatro_entregas",
    });
    expect(avaliarAcompanhamento(config, f, new Date(+fim - 1))).toMatchObject({ kind: "defer" });
    expect(
      avaliarAcompanhamento(
        config,
        { ...f, touches: [f.touches[0]!, f.touches[0]!, f.touches[2]!, f.touches[3]!] },
        fim,
      ).kind,
    ).toBe("blocked");
    expect(avaliarAcompanhamento(config, { ...f, purchase: null }, fim).kind).toBe("blocked");
  });
  it("a mesma mensagem não prova dois toques, e oferta nova substitui retomada do material", () => {
    const t = entregue(1, inicio);
    expect(
      avaliarAcompanhamento(config, fatos({ touches: [t, { ...t, index: 2 }] }), agora),
    ).toEqual({ kind: "blocked", reason: "toques_incoerentes" });
    expect(
      avaliarAcompanhamento(
        { ...config, kind: "cronograma" },
        fatos({ offerAfterAnchor: true }),
        agora,
      ),
    ).toEqual({ kind: "cancel", reason: "oferta_substitui_retomada_do_cronograma" });
    expect(
      avaliarAcompanhamento(config, fatos({ lastInboundAt: "2026-10-23T14:00:00.000Z" }), agora),
    ).toEqual({ kind: "cancel", reason: "respondeu" });
  });
  it("preserva configuração em roundtrip e recusa publicação enquanto a integração não existe", () => {
    const graph = flowGraphSchema.parse({
      settings: { c01_acompanhamento: { ...config, activated_at: null } },
      nodes: [
        { id: "start", label: "Início", position: { x: 0, y: 0 }, type: "trigger", config: {} },
        {
          id: "end",
          label: "Fim",
          position: { x: 0, y: 100 },
          type: "end",
          config: { outcome: "exhausted" },
        },
      ],
      edges: [{ id: "e", source: "start", target: "end", condition: { type: "always" } }],
    });
    expect(
      flowGraphSchema.parse(JSON.parse(JSON.stringify(graph))).settings?.c01_acompanhamento,
    ).toEqual({ ...config, activated_at: null });
    expect(validateFlowForPublish(graph)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "c01_integracao_pendente" }),
      ]),
    });
  });
});
