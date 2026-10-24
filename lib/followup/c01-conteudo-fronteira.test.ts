import { afterEach, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({ kind: "oferta", facts: null as unknown }));
vi.mock("@/lib/followup/c01-acompanhamento-fatos", () => ({
  lerFatosAcompanhamentoC01: vi.fn(async () => state.facts),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
import { assertAcompanhamentoC01Supabase } from "@/lib/followup/c01-acompanhamento-runtime";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
const org = "11111111-1111-4111-8111-111111111111",
  contact = "22222222-2222-4222-8222-222222222222";
function fixture(kind: "oferta" | "conversa", templates = false, continuation = true) {
  const now = new Date("2026-10-24T18:00:00Z");
  vi.stubEnv(
    "C01_ACOMPANHAMENTO_INTEGRATION",
    JSON.stringify({
      enabled: true,
      organizationId: org,
      tokenSha256: "a".repeat(64),
      signingKey: "b".repeat(40),
      allowedKinds: ["oferta"],
      continuation: {
        enabled: true,
        policyStatus: "approved",
        activatedAt: "2026-10-24T11:00:00Z",
      },
      ...(templates
        ? { offerTemplates: { enabled: true, policyStatus: "approved", bindings: [] } }
        : {}),
    }),
  );
  state.facts = {
    organizationId: org,
    contactId: contact,
    opportunityId: "lead",
    anchor: { kind, at: "2026-10-24T14:00:00Z", delivered: true },
    continuation: {
      replyBarrierAt: "2026-10-24T15:00:00Z",
      notBefore: "2026-10-24T17:00:00Z",
      ready: true,
    },
    lastInboundAt: "2026-10-24T15:00:00Z",
    hasNewReply: false,
    offerAfterAnchor: false,
    human: false,
    optedOut: false,
    restricted: false,
    callbackPending: false,
    anotherSequence: false,
    purchase: {
      source: "aplicada",
      organizationId: org,
      contactId: contact,
      opportunityId: "lead",
      checkedAt: now.toISOString(),
      complete: true,
      identity: "univoca",
      result: "nao_comprou",
    },
    template: { approved: false, accountReady: false },
    touches: [],
  };
  if (!continuation) {
    delete (state.facts as Record<string, unknown>).continuation;
    Object.assign(state.facts as object, { lastInboundAt: "2026-10-24T13:00:00Z" });
  }
  const r = criarDubleDoHandler({
    conversation: { id: "conversation", organization_id: org, contact_id: contact },
    tabelasDeLeitura: {
      followup_enrollment_events: continuation ? { id: "event" } : null,
      followup_enrollments: { version_id: "version", contact_id: contact },
      followup_flow_versions: {
        graph: {
          settings: {
            c01_acompanhamento: { version: 1, kind, activated_at: "2026-10-24T11:00:00Z" },
          },
        },
      },
    },
  });
  return async () => {
    try {
      await assertAcompanhamentoC01Supabase(
        r.supabase,
        { organizationId: org, contactId: contact, enrollmentId: "enrollment", jobId: "job" },
        org,
        now,
      );
    } finally {
      if (kind === "oferta" && !templates)
        expect(r.capturas.filtros.followup_enrollment_events).toEqual(
          expect.arrayContaining([
            { coluna: "organization_id", valor: org },
            { coluna: "enrollment_id", valor: "enrollment" },
            { coluna: "event_type", valor: "c01_continuacao_entregue" },
          ]),
        );
    }
  };
}
afterEach(() => vi.unstubAllEnvs());
it("L2 sem modelos deve vetar watchdog sem conteúdo resolvido", async () => {
  await expect(fixture("oferta")()).rejects.toThrow("contexto");
});
it("controle L1 já veta contexto ausente", async () => {
  await expect(fixture("conversa")()).rejects.toThrow("contexto");
});
it("controle L2 com opt-in modelos já veta contexto ausente", async () => {
  await expect(fixture("oferta", true)()).rejects.toThrow("contexto");
});

it("oferta legada sem continuação preserva o caminho anterior", async () => {
  await expect(fixture("oferta", false, false)()).resolves.toBeUndefined();
});
