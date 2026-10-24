import type * as Acompanhamento from "@/lib/followup/c01-acompanhamento-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { RetornoC01CanceladoError } from "@/lib/followup/c01-retorno-cancelado";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
const h = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@/lib/followup/c01-acompanhamento-runtime", async (original) => ({
  ...(await original<typeof Acompanhamento>()),
  comEnvioAcompanhamentoC01: async (
    _db: unknown,
    _scope: unknown,
    _org: unknown,
    action: () => Promise<unknown>,
  ) => action(),
  assertAcompanhamentoC01Supabase: h.check,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
const org = "11111111-1111-4111-8111-111111111111",
  conv = "22222222-2222-4222-8222-222222222222",
  contact = "33333333-3333-4333-8333-333333333333",
  session = "44444444-4444-4444-8444-444444444444";
const ctx: HandlerCtx = {
  organization_id: org,
  actor: { type: "ai_agent", id: "agent-engine", role: "manager" },
  requestId: "fixture",
  proactiveContext: {
    organizationId: org,
    contactId: contact,
    jobId: "55555555-5555-4555-8555-555555555555",
    jobClaim: { worker_id: "ficticio", acquired_at: "2026-10-24T15:00:00Z" },
  },
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  h.check.mockReset();
});
describe("retorno C01: veto atravessa o handler sem ser convertido em mensagem de sucesso", () => {
  it.each(["inicial", "final"])(
    "propaga a exceção tipada no corte %s sem transporte",
    async (cut) => {
      vi.stubEnv("WAHA_API_BASE_URL", "http://127.0.0.1:1");
      vi.stubEnv("WAHA_API_KEY", "ficticio");
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const veto = new RetornoC01CanceladoError("human");
      if (cut === "final") h.check.mockResolvedValueOnce(undefined);
      h.check.mockRejectedValue(veto);
      const { supabase, mensagens } = criarDubleDoHandler({
        conversation: {
          id: conv,
          organization_id: org,
          contact_id: contact,
          channel_session_id: session,
          is_group: false,
          group_chat_id: null,
          contacts: { phone_number: "+5511999990000", wa_identity: null, is_blocked: false },
          channel_sessions: {
            provider: "waha",
            waha_session_name: "ficticio",
            status: "WORKING",
            archived_at: null,
          },
        },
        rpcData: true,
      });
      await expect(
        sendMessageHandler(supabase, ctx, {
          conversation_id: conv,
          type: "text",
          body: "Retorno fictício",
        }),
      ).rejects.toBe(veto);
      expect(fetch).not.toHaveBeenCalled();
      expect(mensagens).toHaveLength(cut === "inicial" ? 0 : 1);
      expect(mensagens.some((m) => m.status === "sent" || m.status === "delivered")).toBe(false);
    },
  );
});
