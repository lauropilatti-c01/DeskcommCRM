import { describe, it, expect } from "vitest";
import { avaliarAcompanhamento, type FatosAcompanhamento } from "@/lib/followup/c01-acompanhamento";
import { falhaEsgotaAsTentativas } from "@/lib/agent-engine/agent/ultima-tentativa";
import { EsperaFinanceiraC01Error } from "@/lib/followup/c01-financeiro-espera";
const now = new Date("2026-10-24T18:00:00Z");
const collection = {
  generationId: "33333333-3333-4333-8333-333333333333",
  startedAt: "2026-10-24T17:58:00Z",
  heartbeatAt: now.toISOString(),
  deadlineAt: "2026-10-24T18:13:00Z",
  progress: 2,
};
const f = () =>
  ({
    organizationId: "org",
    contactId: "contact",
    opportunityId: "lead",
    anchor: { kind: "conversa", at: "2026-10-24T15:00:00Z", delivered: true },
    continuation: {
      ready: true,
      replyBarrierAt: "2026-10-24T14:59:00Z",
      notBefore: "2026-10-24T17:00:00Z",
    },
    lastInboundAt: "2026-10-24T14:59:00Z",
    hasNewReply: false,
    human: false,
    optedOut: false,
    restricted: false,
    callbackPending: false,
    anotherSequence: false,
    offerAfterAnchor: false,
    purchase: null,
    template: { approved: false, accountReady: false },
    touches: [],
    financialCollection: collection,
    financialWait: {
      generationId: collection.generationId,
      startedAt: collection.startedAt,
      deadlineAt: collection.deadlineAt,
    },
  }) as unknown as FatosAcompanhamento;
const cfg = {
  version: 1 as const,
  kind: "conversa" as const,
  activated_at: "2026-10-24T11:00:00Z",
};
describe("espera financeira limitada", () => {
  it("coleta na última tentativa não dispara a resposta de falha do agente", () => {
    const job = { attempts: 5, max_attempts: 5, created_at: now.toISOString() };
    expect(falhaEsgotaAsTentativas(job, new Error("falha comum"), +now)).toBe(true);
    expect(
      falhaEsgotaAsTentativas(job, new EsperaFinanceiraC01Error(collection.deadlineAt), +now),
    ).toBe(false);
  });
  it("coleta viva adia 60 s sem aprovar envio", () =>
    expect(avaliarAcompanhamento(cfg, f(), now)).toEqual({
      kind: "defer",
      reason: "projecao_em_coleta",
      until: "2026-10-24T18:01:00.000Z",
    }));
  it("prazo original vencido não renova pela geração nova", () => {
    const facts = f();
    Object.assign(facts, {
      financialWait: {
        generationId: collection.generationId,
        startedAt: "2026-10-24T17:40:00Z",
        deadlineAt: "2026-10-24T17:55:00Z",
      },
    });
    expect(avaliarAcompanhamento(cfg, facts, now)).toEqual({
      kind: "blocked",
      reason: "prazo_da_coleta_financeira_esgotado",
    });
  });
  it.each(["human", "optedOut", "hasNewReply"])("%s vence a espera", (key) => {
    const facts = f();
    Object.assign(facts, { [key]: true });
    expect(avaliarAcompanhamento(cfg, facts, now).kind).toBe("cancel");
  });
  it("sem coleta autenticada não adia falha comum", () => {
    const facts = f();
    Object.assign(facts, { financialCollection: undefined });
    expect(avaliarAcompanhamento(cfg, facts, now).kind).toBe("blocked");
  });
  it("prazo vencido à noite não é adiado para amanhã", () => {
    expect(avaliarAcompanhamento(cfg, f(), new Date("2026-10-25T00:01:00Z"))).toEqual({
      kind: "blocked",
      reason: "prazo_da_coleta_financeira_esgotado",
    });
  });
});
