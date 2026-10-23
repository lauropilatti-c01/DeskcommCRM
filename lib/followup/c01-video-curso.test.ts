import { afterEach, describe, expect, it, vi } from "vitest";
import {
  avaliarAcompanhamento,
  c01AcompanhamentoSchema,
  type FatosAcompanhamento,
} from "./c01-acompanhamento";
import {
  videosDaConsultaC01,
  origemDoVideoEnviadoC01,
  politicaDoVideoValidaC01,
} from "./c01-video-curso";
import { configOrigemC01 } from "./c01-origem";
const org = "11111111-1111-4111-8111-111111111111",
  connection = "22222222-2222-4222-8222-222222222222";
const key = "curso-ficticio",
  url = "https://example.invalid/curso",
  product = "produto-ficticio";
const question = "Ficou alguma dúvida sobre como funciona?";
const cfg = {
  enabled: true,
  organizationId: org,
  tokenSha256: "a".repeat(64),
  signingKey: "b".repeat(32),
  allowedKinds: ["video_curso"],
  videoCourse: {
    enabled: true,
    connectionId: connection,
    copyStatus: "approved",
    question,
    catalog: [{ key, productKey: product, url, sha256: "c".repeat(64) }],
  },
};
const policy = {
  version: 1 as const,
  kind: "video_curso" as const,
  activated_at: "2026-10-23T11:00:00.000Z",
};
const at = new Date("2026-10-23T13:15:00.000Z");
function facts(over: Partial<FatosAcompanhamento> = {}): FatosAcompanhamento {
  return {
    organizationId: org,
    contactId: "contato",
    opportunityId: "negocio",
    anchor: { kind: "video_curso", at: "2026-10-23T13:00:00.000Z", delivered: true },
    lastInboundAt: "2026-10-23T12:59:00.000Z",
    hasNewReply: false,
    offerAfterAnchor: false,
    human: false,
    optedOut: false,
    restricted: false,
    callbackPending: false,
    anotherSequence: false,
    videoPolicyReady: true,
    purchase: {
      source: "aplicada",
      organizationId: org,
      contactId: "contato",
      opportunityId: "negocio",
      checkedAt: at.toISOString(),
      complete: true,
      identity: "univoca",
      result: "nao_comprou",
    },
    template: { approved: true, accountReady: true },
    touches: [],
    ...over,
  };
}
const input = {
  schema: "c01",
  tabela: "agente_pagina",
  filtros: [{ coluna: "enfase_id", operador: "eq", valor: product }],
};
const output = {
  schema: "c01",
  tabela: "agente_pagina",
  conexao: { id: connection },
  linhas: [{ pode_afirmar: true, video_curso_url: url }],
};
afterEach(() => vi.unstubAllEnvs());
describe("toque único após vídeo do curso", () => {
  it("schema aceita modalidade e espera 15 minutos desde a entrega", () => {
    expect(c01AcompanhamentoSchema.safeParse(policy).success).toBe(true);
    expect(avaliarAcompanhamento(policy, facts(), new Date(+at - 1))).toMatchObject({
      kind: "defer",
      until: at.toISOString(),
    });
    expect(avaliarAcompanhamento(policy, facts(), at)).toEqual({
      kind: "send",
      touch: 1,
      transport: "text",
    });
  });
  it.each([
    "hasNewReply",
    "human",
    "optedOut",
    "restricted",
    "callbackPending",
    "anotherSequence",
  ] as const)("%s cancela", (field) =>
    expect(avaliarAcompanhamento(policy, facts({ [field]: true }), at).kind).toBe("cancel"),
  );
  it("resposta vou ver com calma cancela pelo evento, sem classificador ou nova IA", () =>
    expect(
      avaliarAcompanhamento(policy, facts({ lastInboundAt: "2026-10-23T13:05:00Z" }), at),
    ).toMatchObject({ kind: "cancel", reason: "respondeu" }));
  it("oferta posterior cancela o vídeo", () =>
    expect(avaliarAcompanhamento(policy, facts({ offerAfterAnchor: true }), at)).toMatchObject({
      kind: "cancel",
      reason: "oferta_substitui_toque_do_video",
    }));
  it("OFF ou copy proposta bloqueia mesmo com job pronto", () =>
    expect(avaliarAcompanhamento(policy, facts({ videoPolicyReady: false }), at)).toMatchObject({
      kind: "blocked",
      reason: "video_desligado_ou_politica_invalida",
    }));
  it("sent, compra ambígua e ausência de prova não liberam", () => {
    expect(
      avaliarAcompanhamento(
        policy,
        facts({ anchor: { kind: "video_curso", at: at.toISOString(), delivered: false } }),
        at,
      ).kind,
    ).toBe("blocked");
    expect(avaliarAcompanhamento(policy, facts({ purchase: null }), at).kind).toBe("blocked");
    expect(
      avaliarAcompanhamento(
        policy,
        facts({ purchase: { ...facts().purchase!, result: "comprou" } }),
        at,
      ),
    ).toMatchObject({ kind: "cancel", reason: "compra_confirmada" });
  });
  it("janela fechada não usa modelo, e noite aguarda 08h sem renovar janela", () => {
    const night = new Date("2026-10-24T00:01:00Z");
    expect(avaliarAcompanhamento(policy, facts(), night)).toMatchObject({
      kind: "defer",
      reason: "fora_do_horario",
      until: "2026-10-24T11:00:00.000Z",
    });
    const next = new Date("2026-10-24T13:16:00Z");
    expect(
      avaliarAcompanhamento(
        policy,
        facts({ purchase: { ...facts().purchase!, checkedAt: next.toISOString() } }),
        next,
      ),
    ).toMatchObject({ kind: "blocked", reason: "janela_do_video_fechada" });
  });
  it("um toque entregue conclui; falha não conclui nem move para perdido", () => {
    const touch = {
      index: 1,
      messageIds: ["msg"],
      receipts: [
        {
          id: "msg",
          status: "delivered",
          delivered_at: at.toISOString(),
          read_at: null,
          error_code: null,
        },
      ],
    };
    expect(avaliarAcompanhamento(policy, facts({ touches: [touch] }), at)).toEqual({
      kind: "complete",
      reason: "toque_do_video_concluido",
    });
    expect(
      avaliarAcompanhamento(
        policy,
        facts({
          touches: [
            {
              ...touch,
              receipts: [{ ...touch.receipts[0]!, status: "failed", error_code: "131049" }],
            },
          ],
        }),
        at,
      ),
    ).toMatchObject({ kind: "blocked", reason: "entrega_bloqueada" });
  });
  it("consulta executada canônica e catálogo exato; recusa link solto, outra tabela ou produto", () => {
    vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
    const config = configOrigemC01()!;
    expect(videosDaConsultaC01(input, { structuredContent: output }, config)).toEqual([
      { key, productKey: product, url },
    ]);
    for (const row of [{ pode_afirmar: false, video_curso_url: url }, { video_curso_url: url }])
      expect(videosDaConsultaC01(input, { ...output, linhas: [row] }, config)).toEqual([
        { key, productKey: product, url },
      ]);
    for (const args of [
      { ...input, tabela: "outra" },
      { ...input, schema: "outra" },
    ])
      expect(videosDaConsultaC01(args, output, config)).toEqual([]);
    expect(
      videosDaConsultaC01(
        input,
        { ...output, linhas: [{ enfase_id: "outro-produto", video_curso_url: url }] },
        config,
      ),
    ).toEqual([]);
    for (const bad of [
      { ...output, tabela: "agente_videos_canal" },
      { ...output, truncado: true },
      { ...output, conexao: { id: org } },
      { ...output, linhas: [{ pode_afirmar: true, video_curso_url: url + "?outro" }] },
    ])
      expect(videosDaConsultaC01(input, bad, config)).toEqual([]);
  });
  it("captura link só consultado e mídia só com hash/chave canônicos, oportunidade única", async () => {
    vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
    const db = { query: vi.fn(async () => ({ rows: [{ id: connection }] })) };
    const consulted = videosDaConsultaC01(input, output, configOrigemC01()!);
    expect(
      await origemDoVideoEnviadoC01(
        db as never,
        org,
        "contato",
        "conversa",
        url,
        undefined,
        consulted,
      ),
    ).toEqual({ kind: "video_curso", leadId: connection, productKey: product, videoKey: key });
    expect(
      await origemDoVideoEnviadoC01(db as never, org, "contato", "conversa", url, undefined, []),
    ).toBeUndefined();
    expect(
      await origemDoVideoEnviadoC01(
        db as never,
        org,
        "contato",
        "conversa",
        "Assista",
        { type: "video", storagePath: `${org}/conversa/video-${"c".repeat(64)}.mp4` },
        [],
      ),
    ).toMatchObject({ videoKey: key });
    expect(
      await origemDoVideoEnviadoC01(
        db as never,
        org,
        "contato",
        "conversa",
        "Assista",
        { type: "video", storagePath: `outra/conversa/video-${"c".repeat(64)}.mp4` },
        [],
      ),
    ).toBeUndefined();
  });
  it("grafo precisa ser só pergunta fixa revisada e fim, sem IA/template/movimentação", () => {
    vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
    const graph = {
      settings: { c01_acompanhamento: policy },
      nodes: [
        { id: "start", type: "trigger", config: {} },
        { id: "touch", type: "action", config: { mode: "text", body: question } },
        { id: "end", type: "end", config: { outcome: "custom" } },
      ],
      edges: [
        { source: "start", target: "touch", condition: { type: "always" } },
        { source: "touch", target: "end", condition: { type: "always" } },
      ],
    };
    expect(politicaDoVideoValidaC01(graph, configOrigemC01()!)).toBe(true);
    expect(
      politicaDoVideoValidaC01(
        { ...graph, nodes: [...graph.nodes, { id: "bad", type: "move_lead" }] },
        configOrigemC01()!,
      ),
    ).toBe(false);
    expect(
      politicaDoVideoValidaC01(graph, {
        ...configOrigemC01()!,
        videoCourse: { ...configOrigemC01()!.videoCourse!, copyStatus: "proposed" },
      }),
    ).toBe(false);
  });
});

it("fixture exata aceita schema, mas publicação permanece bloqueada", async () => {
  const { readFileSync } = await import("node:fs");
  const { flowGraphSchema } = await import("./graph-schema");
  const { validateFlowForPublish } = await import("./validate-publish");
  const graph = flowGraphSchema.parse(
    JSON.parse(readFileSync("docs/c01/fixtures/video-curso-off.json", "utf8")),
  );
  const result = validateFlowForPublish(graph);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "c01_integracao_pendente" })]),
    );
});
