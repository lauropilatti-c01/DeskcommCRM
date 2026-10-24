import { describe, expect, it } from "vitest";
import { avaliarAcompanhamento, type FatosAcompanhamento } from "./c01-acompanhamento";
const now = new Date("2026-10-24T17:00:00Z");
function facts(): FatosAcompanhamento {
  return {
    organizationId: "org",
    contactId: "contact",
    opportunityId: "lead",
    anchor: { kind: "conversa", at: "2026-10-24T15:00:00Z", delivered: true },
    continuation: {
      replyBarrierAt: "2026-10-24T14:59:00Z",
      notBefore: now.toISOString(),
      ready: true,
    },
    lastInboundAt: "2026-10-24T14:59:00Z",
    hasNewReply: false,
    offerAfterAnchor: false,
    human: false,
    optedOut: false,
    restricted: false,
    callbackPending: false,
    anotherSequence: false,
    purchase: {
      source: "aplicada",
      organizationId: "org",
      contactId: "contact",
      opportunityId: "lead",
      checkedAt: now.toISOString(),
      complete: true,
      identity: "univoca",
      result: "nao_comprou",
    },
    template: { approved: false, accountReady: false },
    touches: [],
  };
}
const config = {
  version: 1 as const,
  kind: "conversa" as const,
  activated_at: "2026-10-24T11:00:00Z",
};
describe("mesmo motor e revalidação da continuação", () => {
  it("L1 espera exatamente 2h e bloqueia sem prova financeira", () => {
    expect(avaliarAcompanhamento(config, facts(), new Date(+now - 1)).kind).toBe("defer");
    expect(avaliarAcompanhamento(config, facts(), now)).toEqual({
      kind: "send",
      touch: 1,
      transport: "text",
    });
    expect(avaliarAcompanhamento(config, { ...facts(), purchase: null }, now).kind).toBe("blocked");
  });
  it("L1 completa após um toque e não ganha modelo fora da janela", () => {
    const f = facts();
    f.touches = [
      {
        index: 1,
        messageIds: ["m"],
        receipts: [
          {
            id: "m",
            status: "sent",
            delivered_at: now.toISOString(),
            read_at: null,
            error_code: null,
          },
        ],
      },
    ];
    expect(avaliarAcompanhamento(config, f, now)).toEqual({
      kind: "complete",
      reason: "continuacao_unica_concluida",
    });
    const late = new Date(+now + 24 * 3600000);
    const g = facts();
    g.purchase!.checkedAt = late.toISOString();
    expect(avaliarAcompanhamento(config, g, late).kind).toBe("blocked");
  });
  it("L2 conserva a âncora e recibo da oferta, mas a resposta anterior à continuação não cancela de novo", () => {
    const f = facts();
    f.anchor = { kind: "oferta", at: "2026-10-23T17:00:00Z", delivered: true };
    f.touches = [
      {
        index: 1,
        messageIds: ["t1"],
        receipts: [
          {
            id: "t1",
            status: "sent",
            delivered_at: "2026-10-23T19:00:00Z",
            read_at: null,
            error_code: null,
          },
        ],
      },
    ];
    expect(
      avaliarAcompanhamento(
        { ...config, kind: "oferta", activated_at: "2026-10-23T11:00:00Z" },
        f,
        now,
      ),
    ).toEqual({ kind: "send", touch: 2, transport: "text" });
    f.lastInboundAt = "2026-10-24T15:00:01Z";
    expect(avaliarAcompanhamento({ ...config, kind: "oferta" }, f, now)).toEqual({
      kind: "cancel",
      reason: "respondeu",
    });
  });
  it.each(["human", "optedOut", "callbackPending", "anotherSequence", "restricted"] as const)(
    "revalida o veto %s",
    (key) => {
      const f = facts();
      f[key] = true;
      expect(avaliarAcompanhamento(config, f, now).kind).toBe("cancel");
    },
  );
});

it("worker tardio não recupera dois prazos antigos seguidos", () => {
  const f = facts();
  f.anchor = { kind: "oferta", at: "2026-10-20T12:00:00Z", delivered: true };
  expect(
    avaliarAcompanhamento(
      { ...config, kind: "oferta", activated_at: "2026-10-20T11:00:00Z" },
      f,
      now,
    ),
  ).toEqual({ kind: "blocked", reason: "orcamento_vencido_sem_intervalo" });
});
