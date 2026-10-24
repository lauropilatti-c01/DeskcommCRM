import type * as ServiceBoundary from "@/lib/atendimento/fronteira-server";
import type * as SendLedger from "@/lib/agent-engine/edge/crm/send-ledger";
import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WahaChannelAdapter } from "@/lib/agent-engine/edge/channel/waha-adapter";
import { RetornoC01CanceladoError } from "@/lib/followup/c01-retorno-cancelado";
import { ApiError } from "@/lib/api/types";
import type { CrmEdgeConfig } from "@/lib/agent-engine/edge/crm/mcp-client";
const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: h.send }));
vi.mock("@/lib/agent-engine/edge/crm/send-ledger", async (original) => ({
  ...(await original<typeof SendLedger>()),
  sendWithLedger: async (
    _store: unknown,
    _input: unknown,
    send: (key: string, id: string) => Promise<unknown>,
  ) => send("ficticio", "ficticio"),
}));
vi.mock("@/lib/atendimento/fronteira-server", async (original) => ({
  ...(await original<typeof ServiceBoundary>()),
  requireCurrentServiceBoundary: vi.fn(),
}));
beforeEach(() => {
  h.send.mockReset();
});
const input = {
  tenantId: "org",
  leadId: "contact",
  jobId: "job",
  seq: 1,
  conversationId: "conversation",
  body: "Retorno fictício",
};
function adapter() {
  return new WahaChannelAdapter(
    { query: vi.fn(async () => ({ rows: [] })) } as unknown as pg.Pool,
    {} as CrmEdgeConfig,
  );
}
describe("retorno C01: sink → borda CRM → adapter preserva disposição", () => {
  it("mantém a mesma exceção terminal, sem virar CrmTransportError ou unavailable", async () => {
    const error = new RetornoC01CanceladoError("purchased");
    h.send.mockRejectedValue(error);
    await expect(adapter().send(input)).rejects.toBe(error);
  });
  it.each([
    new Error("c01_callback_purchase_unconfirmed"),
    new ApiError(409, "c01_callback_bloqueado", {}, "ficticio"),
  ])("não torna terminal um prefixo ou 409 genérico", async (error) => {
    h.send.mockRejectedValue(error);
    await expect(adapter().send(input)).resolves.toMatchObject({ kind: "unavailable" });
  });
});
