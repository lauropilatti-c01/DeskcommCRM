import { afterEach, it, expect, vi } from "vitest";
const state = vi.hoisted(() => ({ facts: null as unknown, query: vi.fn() }));
vi.mock("@/lib/followup/c01-acompanhamento-fatos", () => ({
  lerFatosAcompanhamentoC01: vi.fn(async () => state.facts),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({ query: state.query }),
}));
import { assertAcompanhamentoC01Supabase } from "@/lib/followup/c01-acompanhamento-runtime";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
const org = "11111111-1111-4111-8111-111111111111",
  contact = "22222222-2222-4222-8222-222222222222";
function fixture(
  kind: "oferta" | "conversa",
  templates = false,
  continuation = true,
  persisted: { status?: string; waits?: unknown[] } = {},
) {
  const now = new Date("2026-10-24T18:00:00Z");
  // A guarda financeira real relê inscrição e prazo antes do conteúdo.
  // O dublê só responde às duas leituras deste cenário; SQL inesperado falha.
  state.query.mockReset().mockImplementation(async (sql: string, params: unknown[]) => {
    if (
      sql ===
      "select status,current_node_id,steps_taken from followup_enrollments where organization_id=$1 and contact_id=$2 and id=$3"
    ) {
      expect(params).toEqual([org, contact, "enrollment"]);
      return {
        rows: [{ status: persisted.status ?? "active", current_node_id: "send", steps_taken: 1 }],
      };
    }
    if (
      sql ===
      "select payload from followup_enrollment_events where organization_id=$1 and enrollment_id=$2 and event_type='c01_financeiro_em_coleta' and idempotency_key=$3"
    ) {
      expect(params).toEqual([org, "enrollment", "send:1:coleta_financeira"]);
      return { rows: persisted.waits ?? [] };
    }
    throw new Error(`SQL inesperado na fixture: ${sql}`);
  });
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
  return {
    capturas: r.capturas,
    run: async () => {
      await assertAcompanhamentoC01Supabase(
        r.supabase,
        { organizationId: org, contactId: contact, enrollmentId: "enrollment", jobId: "job" },
        org,
        now,
      );
    },
  };
}
function conferirFiltrosDeContinuacao(f: ReturnType<typeof fixture>) {
  expect(f.capturas.filtros.followup_enrollment_events).toEqual(
    expect.arrayContaining([
      { coluna: "organization_id", valor: org },
      { coluna: "enrollment_id", valor: "enrollment" },
      { coluna: "event_type", valor: "c01_continuacao_entregue" },
    ]),
  );
}
afterEach(() => vi.unstubAllEnvs());
it("L2 sem modelos deve vetar watchdog sem conteúdo resolvido", async () => {
  const f = fixture("oferta");
  await expect(f.run()).rejects.toThrow("c01_conteudo_sem_contexto_de_envio");
  conferirFiltrosDeContinuacao(f);
});
it("controle L1 já veta contexto ausente", async () => {
  await expect(fixture("conversa").run()).rejects.toThrow("c01_conteudo_sem_contexto_de_envio");
});
it("controle L2 com opt-in modelos já veta contexto ausente", async () => {
  await expect(fixture("oferta", true).run()).rejects.toThrow("c01_conteudo_sem_contexto_de_envio");
});

it("oferta legada sem continuação preserva o caminho anterior", async () => {
  const f = fixture("oferta", false, false);
  await expect(f.run()).resolves.toBeUndefined();
  conferirFiltrosDeContinuacao(f);
});

it.each(["oferta", "conversa"] as const)(
  "%s com inscrição pausada é vetada antes do conteúdo",
  async (kind) => {
    const f = fixture(kind, false, true, { status: "paused" });
    await expect(f.run()).rejects.toMatchObject({
      code: "c01_acompanhamento_bloqueado",
      details: { terminal: true, reason: "restricao" },
    });
    expect(state.query).toHaveBeenCalledTimes(1);
    expect(f.capturas.filtros.followup_enrollment_events).toBeUndefined();
  },
);

it("prazo financeiro persistido inválido é vetado antes do conteúdo", async () => {
  const f = fixture("oferta", false, true, { waits: [{ payload: { deadlineAt: "inválido" } }] });
  await expect(f.run()).rejects.toMatchObject({
    name: "c01_financeiro_bloqueado",
    message: "prazo_financeiro_incoerente",
    terminal: true,
  });
  expect(state.query).toHaveBeenCalledTimes(2);
  expect(f.capturas.filtros.followup_enrollment_events).toBeUndefined();
});
