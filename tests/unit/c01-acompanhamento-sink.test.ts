import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { assertAcompanhamentoC01Supabase } from "@/lib/followup/c01-acompanhamento-runtime";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
const org = "11111111-1111-4111-8111-111111111111";
const contact = "22222222-2222-4222-8222-222222222222";
const conversation = "33333333-3333-4333-8333-333333333333";
const context = { organizationId: org, contactId: contact, enrollmentId: "enrollment" };
const ctx: HandlerCtx = {
  organization_id: org,
  actor: { type: "webhook_source", id: "enrollment" },
  requestId: "req",
  proactiveContext: context,
};
const policy = { version: 1, kind: "oferta", activated_at: "2026-10-23T11:00:00.000Z" };
function rig(graph: () => Record<string, unknown>) {
  return criarDubleDoHandler({
    conversation: {
      id: conversation,
      organization_id: org,
      contact_id: contact,
      channel_session_id: "channel",
      is_group: false,
      contacts: { phone_number: "+5500000000000", is_blocked: false },
      channel_sessions: {
        provider: "waha",
        waha_session_name: "default",
        status: "WORKING",
        archived_at: null,
      },
    },
    rpcData: true,
    tabelasDeLeitura: {
      followup_enrollments: { version_id: "version", contact_id: contact },
      followup_flow_versions: () => ({ graph: graph() }),
    },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("C01 na porta real de envio", () => {
  it.each(["text", "template"] as const)(
    "%s não grava mensagem nem chama Meta quando falta integração",
    async (type) => {
      const r = rig(() => ({ settings: { c01_acompanhamento: policy } }));
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        sendMessageHandler(r.supabase, ctx, {
          conversation_id: conversation,
          type,
          body: "Teste",
        } as SendMessageInput),
      ).rejects.toMatchObject({
        code: "c01_acompanhamento_bloqueado",
        details: { reason: "integracao_aplicada_indisponivel" },
      });
      expect(r.mensagens).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("relê a política antes de sair para o canal, mesmo que tenha passado na primeira leitura", async () => {
    let reads = 0;
    const r = rig(() => (++reads === 1 ? {} : { settings: { c01_acompanhamento: policy } }));
    vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
    vi.stubEnv("WAHA_API_KEY", "fixture");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      await sendMessageHandler(r.supabase, ctx, {
        conversation_id: conversation,
        type: "text",
        body: "Teste",
      } as SendMessageInput);
    } catch {
      /* o sink pode lançar ou devolver a linha falha */
    }
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(r.mensagens.some((m) => m.status === "sent")).toBe(false);
  });
  it("não troca a organização nem usa uma flag editável do payload para liberar", async () => {
    const r = rig(() => ({ settings: { c01_acompanhamento: policy } }));
    await expect(
      assertAcompanhamentoC01Supabase(r.supabase, context, "outra-org"),
    ).rejects.toMatchObject({ details: { reason: "organizacao_incompativel" } });
    expect(r.capturas.filtros.followup_enrollments).toBeUndefined();
  });
  it("legado sem política conserva o caminho; política inválida falha fechada", async () => {
    const legacy = rig(() => ({}));
    await expect(
      assertAcompanhamentoC01Supabase(legacy.supabase, context, org),
    ).resolves.toBeUndefined();
    expect(legacy.capturas.filtros.followup_enrollments).toEqual(
      expect.arrayContaining([
        { coluna: "organization_id", valor: org },
        { coluna: "contact_id", valor: contact },
      ]),
    );
    const malformed = rig(() => ({ settings: { c01_acompanhamento: { ...policy, version: 0 } } }));
    await expect(
      assertAcompanhamentoC01Supabase(malformed.supabase, context, org),
    ).rejects.toMatchObject({ details: { reason: "politica_invalida" } });
  });
});
