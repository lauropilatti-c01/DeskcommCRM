import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), fail: vi.fn(), resched: vi.fn(), discard: vi.fn(), notify: vi.fn() }));
vi.mock("@/lib/agent-engine/queue/queue", () => ({ cancelJob: mocks.cancel, failJob: mocks.fail, rescheduleJob: mocks.resched }));
vi.mock("@/lib/atendimento/descartar-followup-obsoleto", () => ({ descartarFollowupObsoleto: mocks.discard }));
vi.mock("@/lib/atendimento/aviso-caso-obsoleto", () => ({ avisarRespostaDeCasoObsoleto: mocks.notify }));
import { disporJobAposFalha, ESPERA_COLETA_RETORNO_C01_MS, PRAZO_COLETA_RETORNO_C01_MS } from "@/workers/agent-worker/dispor-job-apos-falha";

const pool = {} as Pool;
const log = { warn: vi.fn() };
const job = { id: "job", organization_id: "org", kind: "followup_turn", payload: {}, locked_by: "worker", claim_acquired_at: "2026-10-08T12:00:00.123456Z" } as JobRow;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

it("o ramo do catch de follow-up obsoleto usa o descarte e seu log, não fail/retry", async () => {
  await disporJobAposFalha(pool, job, "worker", new StaleServiceBoundaryError(), true, log);
  expect(mocks.discard).toHaveBeenCalledWith(pool, job, "worker", log);
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(mocks.fail).not.toHaveBeenCalled();
});
it("caso obsoleto avisa antes de cancelar com o lease original", async () => {
  const caso = { ...job, kind: "case_reply_turn", payload: { case_id: "case" } } as JobRow;
  await disporJobAposFalha(pool, caso, "worker", new StaleServiceBoundaryError(), true, log);
  expect(mocks.notify).toHaveBeenCalledWith(pool, "org", "case");
  expect(mocks.cancel).toHaveBeenCalledWith(pool, "job", "worker", "service_boundary_stale", job.claim_acquired_at);
  expect(mocks.notify.mock.invocationCallOrder[0]).toBeLessThan(mocks.cancel.mock.invocationCallOrder[0]!);
  expect(mocks.discard).not.toHaveBeenCalled();
});
it("outro veto permanente preserva cancelamento, sem criar descarte de follow-up", async () => {
  await disporJobAposFalha(pool, job, "worker", new Error("veto\nmais detalhes"), true, log);
  expect(mocks.cancel).toHaveBeenCalledWith(pool, "job", "worker", "veto", job.claim_acquired_at);
  expect(mocks.discard).not.toHaveBeenCalled();
});
it("falha transitória mantém retry com precisão do lease", async () => {
  const error = new Error("banco indisponível");
  await disporJobAposFalha(pool, job, "worker", error, false, log);
  expect(mocks.fail).toHaveBeenCalledWith(pool, "job", "worker", error, job.claim_acquired_at);
  expect(mocks.discard).not.toHaveBeenCalled();
});
it("falha de armazenamento propaga ao catch de falha dupla", async () => {
  mocks.discard.mockRejectedValueOnce(new Error("descarte indisponível"));
  await expect(disporJobAposFalha(pool, job, "worker", new StaleServiceBoundaryError(), true, log)).rejects.toThrow("descarte indisponível");
});

describe("CRM-115: retorno C01 atravessa a coleta de compras", () => {
  const retorno = { ...job, payload: { promised_at: "2026-10-27T13:00:00.000Z" } } as JobRow;
  const coleta = new Error("c01_callback_purchase_unconfirmed");
  const em = (iso: string) => vi.useFakeTimers({ now: new Date(iso) });

  it("as esperas sem gastar tentativa cobrem pelo menos 16 min, com folga para a janela livre", () => {
    // Backoff comum: 10+20+40+80 s = 150 s. A coleta ocupa ~11 de cada 15 min.
    expect(PRAZO_COLETA_RETORNO_C01_MS).toBeGreaterThanOrEqual(16 * 60_000);
    expect(ESPERA_COLETA_RETORNO_C01_MS).toBeLessThan(4 * 60_000);
  });
  it("durante o prazo, reagenda 2 min sem gastar tentativa nem cancelar", async () => {
    em("2026-10-27T13:19:00.000Z");
    await disporJobAposFalha(pool, retorno, "worker", coleta, false, log);
    expect(mocks.resched).toHaveBeenCalledWith(pool, "job", "worker", {
      delayMs: 120_000,
      reason: "c01_callback_purchase_unconfirmed",
      acquiredAt: job.claim_acquired_at,
    });
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("passado o prazo, volta ao retry comum", async () => {
    em("2026-10-27T13:20:00.000Z");
    await disporJobAposFalha(pool, retorno, "worker", coleta, false, log);
    expect(mocks.resched).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(pool, "job", "worker", coleta, job.claim_acquired_at);
  });
  it("outro erro do retorno, veto terminal ou retorno sem hora seguem o caminho de antes", async () => {
    em("2026-10-27T13:05:00.000Z");
    await disporJobAposFalha(pool, retorno, "worker", new Error("c01_callback_outside_send_window"), false, log);
    await disporJobAposFalha(pool, job, "worker", coleta, false, log);
    expect(mocks.fail).toHaveBeenCalledTimes(2);
    await disporJobAposFalha(pool, retorno, "worker", coleta, true, log);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.resched).not.toHaveBeenCalled();
  });
});
