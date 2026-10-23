import { describe, expect, it, vi, afterEach } from "vitest";
import {
  completarConsultaOfertaC01,
  ofertasDaConsultaC01,
  origemDaOfertaEnviadaC01,
} from "./c01-origem-oferta";
const org = "11111111-1111-4111-8111-111111111111",
  connection = "22222222-2222-4222-8222-222222222222";
const input = { filtros: [{ coluna: "enfase_id", operador: "eq", valor: "produto-teste" }] };
const row = {
  plano_id: "plano-teste",
  pode_afirmar: true,
  link_cartao: "https://example.invalid/comprar",
};
const output = {
  conexao: { id: connection },
  schema: "c01",
  tabela: "agente_pagina",
  linhas: [row],
};
afterEach(() => vi.unstubAllEnvs());
describe("origem de oferta estruturada", () => {
  it("lê a resposta MCP sem exigir coluna omitida, usando filtro executado", () => {
    expect(ofertasDaConsultaC01(input, { structuredContent: output }, connection)).toEqual([
      { productKey: "produto-teste", urls: [row.link_cartao] },
    ]);
    expect(
      ofertasDaConsultaC01(
        input,
        { content: [{ type: "text", text: JSON.stringify(output) }] },
        connection,
      ),
    ).toHaveLength(1);
  });
  it("consulta real inclui a prova de autorização que o prompt não projetou", () => {
    const original = { ...input, schema: "c01", tabela: "agente_links", colunas: ["url"] };
    expect(completarConsultaOfertaC01(original)).toEqual({
      ...original,
      colunas: ["url", "enfase_id", "plano_id", "status", "pode_enviar"],
    });
    expect(original.colunas).toEqual(["url"]);
    expect(
      ofertasDaConsultaC01(
        input,
        {
          ...output,
          tabela: "agente_links",
          linhas: [
            {
              enfase_id: "produto-teste",
              plano_id: "plano-teste",
              url: row.link_cartao,
              status: "confirmado",
              pode_enviar: true,
            },
          ],
        },
        connection,
      ),
    ).toHaveLength(1);
  });
  it("recusa fonte, filtro, permissão e truncamento inadequados", () => {
    for (const bad of [
      { ...output, truncado: true },
      { ...output, conexao: { id: org } },
      { ...output, schema: "public" },
      { ...output, erro: "falhou" },
      { ...output, linhas: [{ ...row, pode_afirmar: false }] },
      { ...output, linhas: [{ ...row, enfase_id: "outro" }] },
    ])
      expect(ofertasDaConsultaC01(input, bad, connection)).toEqual([]);
    expect(ofertasDaConsultaC01({}, output, connection)).toEqual([]);
    expect(
      ofertasDaConsultaC01(input, { isError: true, structuredContent: output }, connection),
    ).toEqual([]);
  });
  it("URL realmente enviada casa com uma única oportunidade do produto", async () => {
    vi.stubEnv(
      "C01_ACOMPANHAMENTO_INTEGRATION",
      JSON.stringify({
        enabled: true,
        organizationId: org,
        tokenSha256: "a".repeat(64),
        signingKey: "b".repeat(32),
        allowedKinds: ["oferta"],
        offerConnectionId: connection,
      }),
    );
    const db = {
      query: vi.fn(async () => ({
        rows: [{ id: connection, custom_fields: { produto_chave: "produto-teste" } }],
      })),
    };
    const offers = ofertasDaConsultaC01(input, output, connection);
    expect(
      await origemDaOfertaEnviadaC01(
        db as never,
        org,
        "contact",
        "Confira " + row.link_cartao,
        offers,
      ),
    ).toEqual({ kind: "oferta", leadId: connection, productKey: "produto-teste" });
    expect(
      await origemDaOfertaEnviadaC01(
        db as never,
        org,
        "contact",
        "https://example.invalid/falso",
        offers,
      ),
    ).toBeUndefined();
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(
      await origemDaOfertaEnviadaC01(db as never, org, "contact", row.link_cartao, offers),
    ).toBeUndefined();
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("organization_id=$1"), [
      org,
      "contact",
      "produto-teste",
    ]);
  });
});
