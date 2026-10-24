import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { Acesso } from "@/lib/external-db/acesso";
import { lerCatalogoCronogramaC01 } from "./c01-cronograma-catalogo";
import type { ConfigOrigemC01 } from "./c01-origem";

function fixture() {
  const scope = { organizationId: randomUUID(), contactId: randomUUID(), leadId: randomUUID() },
    connectionId = randomUUID();
  const cfg: ConfigOrigemC01 = {
    enabled: true,
    organizationId: scope.organizationId,
    allowedKinds: ["cronograma"],
    tokenSha256: "a".repeat(64),
    signingKey: "b".repeat(40),
    cronogramaCatalog: { enabled: true, policyStatus: "approved", connectionId, bindings: [] },
  };
  const fields: Record<string, unknown> = {
    empresa_alvo: "Petrobras",
    enfase_chave: "PB-NT-2023.2#8",
    enfase_nome: "Nome alterável que não prova material",
    produto_chave: "operacao",
  };
  const data: Record<string, Record<string, unknown>[]> = {
    agente_enfase_detalhe: [
      {
        enfase_chave: fields.enfase_chave,
        enfase: "Operação",
        empresa: "Petrobras",
        career_family_id: "family-operacao",
        produto_id: "operacao",
      },
    ],
    familia_produto: [
      {
        career_family_id: "family-operacao",
        cronograma: '{"Cronograma - Operacao"}',
        empresas: ["Petrobras", "Transpetro"],
      },
    ],
    familia_cargo_alias: [
      {
        career_family_id: "family-operacao",
        sistema: "cronograma",
        alias: "tecnico-operacao-60-metas",
        origem: "enfase_edital",
        edital_id: "PB-NT-2023.2",
      },
    ],
  };
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    expect(values[0]).toBe(scope.organizationId);
    return {
      rows: sql.includes("organizations")
        ? [{ settings: { c01_contextual_catalog: { enabled: true, connection_id: connectionId } } }]
        : [{ id: scope.leadId, custom_fields: fields }],
    };
  });
  const read = vi.fn(async (p) => {
    expect(p.offset).toBe(0);
    expect(p.filtros).toContainEqual(expect.objectContaining({ operador: "eq" }));
    return { linhas: data[p.tabela], limite: p.limite, offset: 0, colunas: p.colunas };
  });
  const open = vi.fn(async (org: string, id: string) => {
    expect([org, id]).toEqual([scope.organizationId, connectionId]);
    return {
      ok: true,
      conexao: { id, organizationId: org, maxRows: 200 },
      dialeto: {
        colunasDaTabela: async (_s: string, t: string) =>
          new Set(
            Object.keys(
              data[t]![0] ?? { career_family_id: 1, sistema: 1, alias: 1, origem: 1, edital_id: 1 },
            ),
          ),
        lerTabela: read,
      },
    } as unknown as Acesso;
  });
  return {
    scope,
    cfg,
    fields,
    data,
    query,
    read,
    open,
    run: () => lerCatalogoCronogramaC01({ query } as unknown as Queryable, cfg, scope, open),
  };
}
describe("A1 consulta o catálogo canônico, sem confiar em etiqueta", () => {
  it("resolve ênfase→família→inventário do edital e usa o nome da base", async () => {
    const f = fixture();
    expect(await f.run()).toMatchObject({
      status: "confirmado",
      enfaseNome: "Operação",
      slug: "tecnico-operacao-60-metas",
    });
    expect(f.read).toHaveBeenCalledTimes(3);
  });
  it("área desconhecida difere de nome conhecido sem chave", async () => {
    const f = fixture();
    delete f.fields.enfase_chave;
    expect((await f.run()).status).toBe("indisponivel");
    delete f.fields.enfase_nome;
    expect((await f.run()).status).toBe("area_desconhecida");
    expect(f.open).not.toHaveBeenCalled();
  });
  it("família sem cronograma no inventário completo significa sem material", async () => {
    const f = fixture();
    f.data.familia_cargo_alias = [];
    f.data.familia_produto![0]!.cronograma = "{}";
    expect((await f.run()).status).toBe("sem_material");
  });
  it("material da outra empresa não autoriza o toque desta empresa", async () => {
    const f = fixture();
    f.data.familia_cargo_alias![0]!.edital_id = "TP-NT-2023";
    expect((await f.run()).status).toBe("sem_material");
  });
  it("chave ausente na base, duplicidade e família fora da empresa não viram sem material", async () => {
    const a = fixture();
    a.data.agente_enfase_detalhe = [];
    expect((await a.run()).status).toBe("indisponivel");
    const b = fixture();
    b.data.agente_enfase_detalhe!.push({ ...b.data.agente_enfase_detalhe![0]! });
    expect((await b.run()).status).toBe("indisponivel");
    const c = fixture();
    c.data.familia_produto![0]!.empresas = ["Transpetro"];
    expect((await c.run()).status).toBe("indisponivel");
  });
  it("fonte não liberada, conexão diferente e leitura truncada bloqueiam", async () => {
    const a = fixture();
    a.open.mockResolvedValue({ ok: false, motivo: "desativada" });
    expect((await a.run()).status).toBe("indisponivel");
    const b = fixture();
    b.read.mockImplementation(async (p) => ({
      linhas: b.data[p.tabela]!,
      limite: 1,
      offset: 0,
      colunas: p.colunas,
    }));
    expect((await b.run()).status).toBe("indisponivel");
    const c = fixture();
    c.query.mockResolvedValue({
      rows: [
        { settings: { c01_contextual_catalog: { enabled: true, connection_id: randomUUID() } } },
      ],
    });
    expect((await c.run()).status).toBe("indisponivel");
    expect(c.open).not.toHaveBeenCalled();
  });
  it("etiqueta manual e nome modificado não mudam falta de material", async () => {
    const f = fixture();
    f.fields.tags = ["a1-enfase-com-cronograma"];
    f.data.familia_cargo_alias = [];
    expect((await f.run()).status).toBe("sem_material");
  });
  it("inventário sem empresa, slug divergente e produto incompatível ficam indisponíveis", async () => {
    const a = fixture();
    a.data.familia_cargo_alias![0]!.edital_id = null;
    expect((await a.run()).status).toBe("indisponivel");
    const b = fixture();
    b.data.familia_cargo_alias![0]!.alias = "https://exemplo.invalid";
    expect((await b.run()).status).toBe("indisponivel");
    const c = fixture();
    c.fields.produto_chave = "outro";
    expect((await c.run()).status).toBe("indisponivel");
  });
});
