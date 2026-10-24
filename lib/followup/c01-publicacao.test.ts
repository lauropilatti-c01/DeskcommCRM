import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { publishFollowupFlowVersion } from "./publish";
import type { FlowGraph } from "./graph-schema";
const org = "11111111-1111-4111-8111-111111111111",
  pointer = "22222222-2222-4222-8222-222222222222",
  connection = "33333333-3333-4333-8333-333333333333";
interface ConsultaFalsa {
  select(): ConsultaFalsa;
  eq(): ConsultaFalsa;
  is(): ConsultaFalsa;
  neq(): ConsultaFalsa;
  maybeSingle(): Promise<{ data: unknown; error: null }>;
  then(yes: (r: unknown) => unknown): Promise<unknown>;
}
function rig(previousAt?: string, cancelOnReply = true) {
  const rpc = vi.fn(async () => ({ data: connection, error: null }));
  const admin = {
    rpc,
    from: (table: string) => {
      let many = false;
      const q: ConsultaFalsa = {
        select: () => q,
        eq: () => q,
        is: () => q,
        neq: () => {
          many = true;
          return q;
        },
        maybeSingle: async () => ({
          data:
            table === "followup_flow_pointers"
              ? {
                  id: pointer,
                  active_version_id: previousAt ? connection : null,
                  trigger_config: { cancel_on_reply: cancelOnReply },
                }
              : table === "followup_flow_versions"
                ? {
                    graph: {
                      settings: {
                        c01_acompanhamento: { kind: "oferta", activated_at: previousAt },
                      },
                    },
                  }
                : { id: connection, enabled: true },
          error: null,
        }),
        then: (yes: (r: unknown) => unknown) =>
          Promise.resolve({
            data:
              table === "channel_sessions"
                ? [{ id: connection, status: "WORKING" }]
                : many
                  ? []
                  : null,
            error: null,
          }).then(yes),
      };
      return q;
    },
  };
  const graph = {
    settings: { c01_acompanhamento: { version: 1, kind: "oferta", activated_at: null } },
    nodes: [],
    edges: [],
  } as unknown as FlowGraph;
  return {
    admin: admin as never,
    rpc,
    params: { orgId: org, pointerId: pointer, graph, createdBy: connection },
  };
}
function configure() {
  vi.stubEnv(
    "C01_ACOMPANHAMENTO_INTEGRATION",
    JSON.stringify({
      enabled: true,
      organizationId: org,
      offerConnectionId: connection,
      tokenSha256: "a".repeat(64),
      signingKey: "b".repeat(32),
      allowedKinds: ["oferta"],
    }),
  );
  vi.stubEnv(
    "C01_FINANCIAL_INTEGRATIONS_JSON",
    JSON.stringify(
      ["guru", "boleto"].map((provider, i) => ({
        enabled: true,
        integrationId: provider,
        organizationId: org,
        provider,
        sourceAccountId: "fixture",
        tokenSha256: String(i + 1).repeat(64),
        receiptSigningKey: "c".repeat(32),
        baseUrl: "https://example.invalid",
        apiToken: "fixture",
        products: [
          {
            productId: "product",
            offerId: "offer",
            crmProductKey: "produto",
            crmOfferKey: "plano",
            commercialFlowIds: [pointer],
          },
        ],
      })),
    ),
  );
}
afterEach(() => vi.unstubAllEnvs());
describe("publicação C01 verifica o servidor", () => {
  it("data no grafo não substitui integração desligada", async () => {
    const r = rig();
    expect(await publishFollowupFlowVersion(r.admin, r.params)).toMatchObject({
      ok: false,
      code: "validation_failed",
    });
    expect(r.rpc).not.toHaveBeenCalled();
  });
  it("configuração válida e mapas equivalentes permitem o RPC; ainda há guardas por pessoa no envio", async () => {
    configure();
    const r = rig();
    expect(await publishFollowupFlowVersion(r.admin, r.params)).toEqual({
      ok: true,
      version_id: connection,
    });
    expect(r.rpc).toHaveBeenCalledOnce();
  });
  it("primeira ativação é atribuída pelo servidor; data passada/futura do cliente não muda a origem", async () => {
    configure();
    for (const value of [null, "2020-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"]) {
      const r = rig();
      r.params.graph.settings!.c01_acompanhamento!.activated_at = value;
      const before = Date.now();
      expect(await publishFollowupFlowVersion(r.admin, r.params)).toMatchObject({ ok: true });
      const call = r.rpc.mock.calls[0] as unknown as [string, { p_graph: FlowGraph }];
      const at = Date.parse(call[1].p_graph.settings!.c01_acompanhamento!.activated_at!);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(Date.now());
      expect(r.params.graph.settings!.c01_acompanhamento!.activated_at).toBe(value);
    }
  });
  it("republicação preserva a ativação anterior mesmo com rascunho nulo", async () => {
    configure();
    const original = "2026-10-23T11:00:00.000Z",
      r = rig(original);
    expect(await publishFollowupFlowVersion(r.admin, r.params)).toMatchObject({ ok: true });
    const call = r.rpc.mock.calls[0] as unknown as [string, { p_graph: FlowGraph }];
    expect(call[1].p_graph.settings!.c01_acompanhamento!.activated_at).toBe(original);
    expect(r.params.graph.settings!.c01_acompanhamento!.activated_at).toBeNull();
  });
  it("não publica com apenas uma fonte financeira mapeada", async () => {
    configure();
    vi.stubEnv(
      "C01_FINANCIAL_INTEGRATIONS_JSON",
      JSON.stringify(JSON.parse(process.env.C01_FINANCIAL_INTEGRATIONS_JSON!).slice(0, 1)),
    );
    const r = rig();
    expect(await publishFollowupFlowVersion(r.admin, r.params)).toMatchObject({
      ok: false,
      code: "validation_failed",
    });
    expect(r.rpc).not.toHaveBeenCalled();
  });
  it("vídeo exige copy aprovada e catálogo antes da publicação; proposta não chega ao RPC", async () => {
    configure();
    const cfg = JSON.parse(process.env.C01_ACOMPANHAMENTO_INTEGRATION!);
    cfg.allowedKinds.push("video_curso");
    cfg.videoCourse = {
      enabled: true,
      connectionId: connection,
      copyStatus: "proposed",
      question: "Ficou alguma dúvida sobre como funciona?",
      catalog: [
        { key: "curso-fixture", productKey: "produto", url: "https://example.invalid/curso" },
      ],
    };
    const r = rig();
    r.params.graph = JSON.parse(readFileSync("docs/c01/fixtures/video-curso-off.json", "utf8"));
    vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
    expect(await publishFollowupFlowVersion(r.admin, r.params)).toMatchObject({ ok: false });
    expect(r.rpc).not.toHaveBeenCalled();
    cfg.videoCourse.copyStatus = "approved";
    vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
    expect(await publishFollowupFlowVersion(r.admin, r.params)).toMatchObject({ ok: true });
    expect(r.rpc).toHaveBeenCalledOnce();
  });
});

describe("publicação da continuação exige contrato específico", () => {
  function configureContinuation() {
    configure();
    const cfg = JSON.parse(process.env.C01_ACOMPANHAMENTO_INTEGRATION!);
    cfg.continuation = {
      enabled: true,
      policyStatus: "approved",
      activatedAt: "2026-10-24T11:00:00Z",
    };
    vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
    const finance = JSON.parse(process.env.C01_FINANCIAL_INTEGRATIONS_JSON!);
    finance[0].historyCoverage = {
      startedAt: "2020-01-01T00:00:00Z",
      evidenceHash: "d".repeat(64),
    };
    vi.stubEnv("C01_FINANCIAL_INTEGRATIONS_JSON", JSON.stringify(finance));
    return cfg;
  }
  function candidate(cancelOnReply = true) {
    const r = rig(undefined, cancelOnReply);
    r.params.graph = JSON.parse(
      readFileSync("docs/c01/fixtures/continuacao-contextual-off.json", "utf8"),
    );
    return r;
  }
  it("grafo candidato permanece OFF; somente servidor preparado pode publicar", async () => {
    const r = candidate();
    expect(r.params.graph.settings!.c01_acompanhamento!.activated_at).toBeNull();
    expect(await publishFollowupFlowVersion(r.admin, r.params)).toMatchObject({ ok: false });
    configureContinuation();
    expect(await publishFollowupFlowVersion(r.admin, r.params)).toMatchObject({ ok: true });
    expect(r.params.graph.settings!.c01_acompanhamento!.activated_at).toBeNull();
  });
  it("proposta comercial, falta de cobertura ou cancel_on_reply falso não chegam ao RPC", async () => {
    for (const reason of ["proposed", "history", "reply"]) {
      const cfg = configureContinuation(),
        r = candidate(reason !== "reply");
      if (reason === "proposed") {
        cfg.continuation.policyStatus = "proposed";
        vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
      }
      if (reason === "history") {
        const fs = JSON.parse(process.env.C01_FINANCIAL_INTEGRATIONS_JSON!);
        delete fs[0].historyCoverage;
        vi.stubEnv("C01_FINANCIAL_INTEGRATIONS_JSON", JSON.stringify(fs));
      }
      expect(await publishFollowupFlowVersion(r.admin, r.params)).toMatchObject({ ok: false });
      expect(r.rpc).not.toHaveBeenCalled();
    }
  });
});
