/**
 * C01 (-c01.15, P4): a consulta à base externa confere o valor do filtro pelo tipo da
 * coluna, e as três situações chegam distintas ao modelo:
 *
 *   - `valor_invalido`: o valor não combina com a coluna ("Não sei" numa boolean, "abc"
 *     num número, ou o banco recusou pelo tipo: Postgres 22xxx / 42883);
 *   - `indisponivel`: o banco não respondeu (conexão, tempo esgotado);
 *   - sem resultado: a consulta rodou e nada casou (`linhas_devolvidas: 0`).
 *
 * Achado de produção: "Não" numa coluna boolean (`so_ensino_medio`) voltava como "não foi
 * possível consultar o banco externo agora", o mesmo texto do banco fora do ar.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/external-db/acesso", () => ({ abrirAcesso: vi.fn() }));

import { abrirAcesso } from "@/lib/external-db/acesso";
import { converterValoresDosFiltros, erroDeValorDoBanco } from "@/lib/external-db/c01-valor-do-filtro";
import type { Dialeto } from "@/lib/external-db/dialeto";
import type { ColunasDaTabela } from "@/lib/external-db/introspeccao";
import type { ConexaoExterna } from "@/lib/external-db/types";
import { crmQueryExternalData, motivoDoVazioExterno } from "@/lib/mcp/tools/dados-externos";
import type { McpContext } from "@/lib/mcp/types";

// Junção da 1.86: a leitura passa pelo dialeto da conexão (`abrirAcesso` o devolve).
const dialeto = {
  listarTabelas: vi.fn(),
  colunasDaTabela: vi.fn(),
  lerTabela: vi.fn(),
  catalogoCompleto: vi.fn(),
} satisfies { [K in keyof Dialeto]: ReturnType<typeof vi.fn> };
const listarTabelas = dialeto.listarTabelas;
const colunasDaTabela = dialeto.colunasDaTabela;
const lerTabela = dialeto.lerTabela;

const CONEXAO: ConexaoExterna = {
  id: "conn-1",
  organizationId: "org-1",
  dbType: "postgres",
  label: "Base",
  host: "db.exemplo.com",
  port: 5432,
  database: "base",
  username: "leitor",
  password: "segredo",
  sslMode: "require",
  maxRows: 200,
  maxFilters: 20,
  maxResponseBytes: 30_000,
  chaveDoCliente: null,
  sourceMode: "all",
  fontes: [],
  versao: "2026-10-15T00:00:00.000Z",
};

const TIPOS: Record<string, string> = {
  id: "uuid",
  cargo: "text",
  so_ensino_medio: "boolean",
  vagas: "integer",
  salario: "numeric",
  edital_em: "date",
};

function colunas(comTipos = true): ColunasDaTabela {
  const nomes: ColunasDaTabela = new Set(Object.keys(TIPOS));
  if (comTipos) nomes.tipos = new Map(Object.entries(TIPOS));
  return nomes;
}

function ctxFake(): McpContext {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: async () => ({ data: [{ id: "conn-1", label: "Base" }], error: null }),
  };
  return {
    organizationId: "org-1",
    role: "agent",
    actor: { type: "ai_agent", id: "agent-1" },
    apiTokenId: "tok-1",
    requestId: "req-1",
    supabase: { from: () => chain },
  } as unknown as McpContext;
}

type Filtro = { coluna: string; operador: "eq" | "ne" | "in" | "contem" | "gt"; valor?: unknown };

async function consultar(filtros: Filtro[]): Promise<Record<string, unknown>> {
  return (await crmQueryExternalData.handler(
    { connection_id: "conn-1", schema: "public", tabela: "cargos", filtros: filtros as never, limite: 20 },
    ctxFake(),
  )) as Record<string, unknown>;
}

function filtrosLidos(): Array<{ coluna: string; operador: string; valor?: unknown }> {
  return vi.mocked(lerTabela).mock.calls[0]![0].filtros;
}

function erroDoPostgres(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

beforeEach(() => {
  vi.mocked(abrirAcesso).mockReset();
  vi.mocked(colunasDaTabela).mockReset();
  vi.mocked(listarTabelas).mockReset();
  vi.mocked(lerTabela).mockReset();
  vi.mocked(abrirAcesso).mockResolvedValue({ ok: true, conexao: CONEXAO, dialeto: dialeto as unknown as Dialeto });
  vi.mocked(colunasDaTabela).mockResolvedValue(colunas());
  vi.mocked(lerTabela).mockResolvedValue({
    colunas: ["cargo"],
    linhas: [{ cargo: "Técnico" }],
    limite: 20,
    offset: 0,
  });
});

describe("coluna boolean: o que o cliente disse vira verdadeiro/falso", () => {
  it.each([
    ["Não", false],
    ["NÃO", false],
    ["nao", false],
    [" n ", false],
    ["falso", false],
    ["false", false],
    ["0", false],
    [0, false],
    [false, false],
    ["Sim", true],
    ["S", true],
    ["Verdadeiro", true],
    ["TRUE", true],
    ["1", true],
    [1, true],
    [true, true],
  ])("%j vira %s e a consulta roda", async (valor, esperado) => {
    const r = await consultar([{ coluna: "so_ensino_medio", operador: "eq", valor }]);
    expect(r.erro).toBeUndefined();
    expect(filtrosLidos()).toEqual([{ coluna: "so_ensino_medio", operador: "eq", valor: esperado }]);
  });

  it("`in` converte cada item da lista", async () => {
    await consultar([{ coluna: "so_ensino_medio", operador: "in", valor: ["sim", "Não"] }]);
    expect(filtrosLidos()[0]!.valor).toEqual([true, false]);
  });

  it("valor que não converte volta `valor_invalido` com a coluna e o que veio, sem tocar no banco", async () => {
    const r = await consultar([{ coluna: "so_ensino_medio", operador: "eq", valor: "Não sei" }]);
    expect(r.erro).toBe("valor_invalido");
    expect(String(r.mensagem)).toContain("so_ensino_medio é verdadeiro/falso; veio 'Não sei'");
    expect(lerTabela).not.toHaveBeenCalled();
  });

  it("`contem` compara o texto da coluna: o valor vai como veio", async () => {
    await consultar([{ coluna: "so_ensino_medio", operador: "contem", valor: "tr" }]);
    expect(filtrosLidos()[0]!.valor).toBe("tr");
  });
});

describe("outros tipos", () => {
  it("número: texto que não é número volta `valor_invalido`; número em texto passa", async () => {
    const ruim = await consultar([{ coluna: "vagas", operador: "gt", valor: "muitas" }]);
    expect(ruim.erro).toBe("valor_invalido");
    expect(String(ruim.mensagem)).toContain("vagas é número inteiro; veio 'muitas'");

    const quebrado = await consultar([{ coluna: "vagas", operador: "eq", valor: 2.5 }]);
    expect(quebrado.erro).toBe("valor_invalido");

    vi.mocked(lerTabela).mockClear();
    const bom = await consultar([{ coluna: "salario", operador: "gt", valor: "4500,50" }]);
    expect(bom.erro).toBeUndefined();
    expect(filtrosLidos()[0]!.valor).toBe("4500.50");
  });

  it("milhar com ponto (\"1.500\") volta `valor_invalido` em coluna de número, sem virar 1,5", async () => {
    for (const [coluna, valor, espera] of [
      ["salario", "1.500", "salario é número sem ponto de milhar (1500, não 1.500); veio '1.500'"],
      ["salario", "12.000.000", "salario é número sem ponto de milhar"],
      ["vagas", "1.500", "vagas é número inteiro sem ponto de milhar"],
    ] as const) {
      vi.mocked(lerTabela).mockClear();
      const r = await consultar([{ coluna, operador: "gt", valor }]);
      expect(r.erro, valor).toBe("valor_invalido");
      expect(String(r.mensagem)).toContain(espera);
      expect(lerTabela).not.toHaveBeenCalled();
    }
    // O decimal com três casas depois da vírgula, ou com ponto e menos de três, segue.
    for (const [valor, vai] of [["1,500", "1.500"], ["1.50", "1.50"], ["1500", "1500"]] as const) {
      vi.mocked(lerTabela).mockClear();
      const r = await consultar([{ coluna: "salario", operador: "gt", valor }]);
      expect(r.erro, valor).toBeUndefined();
      expect(filtrosLidos()[0]!.valor).toBe(vai);
    }
  });

  it("uuid malformado volta `valor_invalido`", async () => {
    const r = await consultar([{ coluna: "id", operador: "eq", valor: "123" }]);
    expect(r.erro).toBe("valor_invalido");
    expect(String(r.mensagem)).toContain("id é um identificador (uuid); veio '123'");
  });

  it("texto e data vão como vieram (a data inválida o banco recusa e vira `valor_invalido`)", async () => {
    await consultar([
      { coluna: "cargo", operador: "eq", valor: "Técnico" },
      { coluna: "edital_em", operador: "eq", valor: "2026-10-15" },
    ]);
    expect(filtrosLidos().map((f) => f.valor)).toEqual(["Técnico", "2026-10-15"]);
  });

  it("sem os tipos no catálogo, o filtro vai como veio (comportamento de antes)", async () => {
    vi.mocked(colunasDaTabela).mockResolvedValue(colunas(false));
    await consultar([{ coluna: "so_ensino_medio", operador: "eq", valor: "Não" }]);
    expect(filtrosLidos()[0]!.valor).toBe("Não");
  });

  it("o valor ecoado é cortado (o modelo reconhece o que mandou, sem um parágrafo de volta)", () => {
    const longo = "x".repeat(500);
    const r = converterValoresDosFiltros(
      [{ coluna: "vagas", operador: "eq", valor: longo }],
      new Map([["vagas", "integer"]]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensagem.length).toBeLessThan(250);
  });
});

describe("as três situações chegam distintas ao modelo", () => {
  it.each([
    ["22P02", "invalid input syntax for type boolean: \"Não\""],
    ["22007", "invalid input syntax for type date: \"amanhã\""],
    ["22003", "value out of range"],
    ["42883", "operator does not exist: jsonb = text"],
  ])("erro de tipo do banco (%s) vira `valor_invalido`, sem repetir a mensagem do Postgres", async (code, message) => {
    vi.mocked(lerTabela).mockRejectedValue(erroDoPostgres(code, message));
    const r = await consultar([{ coluna: "cargo", operador: "eq", valor: "x" }]);
    expect(r.erro).toBe("valor_invalido");
    expect(String(r.mensagem)).not.toContain(message);
  });

  it.each([
    ["tempo esgotado (57014)", erroDoPostgres("57014", "canceling statement due to statement timeout")],
    ["conexão recusada", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["erro sem código", new Error("Connection terminated unexpectedly")],
  ])("%s vira `indisponivel`", async (_nome, erro) => {
    vi.mocked(lerTabela).mockRejectedValue(erro);
    const r = await consultar([{ coluna: "cargo", operador: "eq", valor: "x" }]);
    expect(r.erro).toBe("indisponivel");
    expect(String(r.mensagem)).toContain("banco externo indisponível agora; tente de novo uma vez");
  });

  it("catálogo fora do ar também é `indisponivel`", async () => {
    vi.mocked(colunasDaTabela).mockRejectedValue(new Error("timeout"));
    vi.mocked(listarTabelas).mockRejectedValue(new Error("timeout"));
    const r = (await crmQueryExternalData.handler(
      { connection_id: "conn-1", schema: "public", tabela: "cargos", limite: 20 },
      ctxFake(),
    )) as Record<string, unknown>;
    expect(r.erro).toBe("indisponivel");
  });

  it("vazio continua sem erro, com `linhas_devolvidas: 0` e o aviso de filtro sem resultado", async () => {
    vi.mocked(lerTabela).mockResolvedValue({ colunas: ["cargo"], linhas: [], limite: 20, offset: 0 });
    const r = await consultar([{ coluna: "so_ensino_medio", operador: "eq", valor: "Não" }]);
    expect(r.erro).toBeUndefined();
    expect(r.linhas_devolvidas).toBe(0);
    expect(r.filtro_sem_resultado).toBeTruthy();
  });

  it("o audit grava só o código, e as mensagens das três situações são diferentes", async () => {
    vi.mocked(lerTabela).mockRejectedValueOnce(erroDoPostgres("22P02", "x"));
    const doBanco = await consultar([{ coluna: "cargo", operador: "eq", valor: "x" }]);
    const doValor = await consultar([{ coluna: "so_ensino_medio", operador: "eq", valor: "talvez" }]);
    vi.mocked(lerTabela).mockRejectedValueOnce(new Error("timeout"));
    const fora = await consultar([{ coluna: "cargo", operador: "eq", valor: "x" }]);
    vi.mocked(lerTabela).mockResolvedValueOnce({ colunas: ["cargo"], linhas: [], limite: 20, offset: 0 });
    const vazio = await consultar([{ coluna: "cargo", operador: "eq", valor: "x" }]);

    expect([doBanco, doValor, fora, vazio].map(motivoDoVazioExterno)).toEqual([
      "valor_invalido",
      "valor_invalido",
      "indisponivel",
      "nenhuma_linha",
    ]);
    expect(new Set([doBanco.mensagem, doValor.mensagem, fora.mensagem]).size).toBe(3);
    // O valor do filtro continua fora do audit (só coluna e operador).
    const redigido = crmQueryExternalData.redigirParaAuditoria?.({
      tabela: "cargos",
      filtros: [{ coluna: "so_ensino_medio", operador: "eq", valor: "talvez" }],
    });
    expect(JSON.stringify(redigido)).not.toContain("talvez");
  });

  it("erroDeValorDoBanco: classe 22 e 42883 sim; o resto não", () => {
    expect(erroDeValorDoBanco({ code: "22P02" })).toBe(true);
    expect(erroDeValorDoBanco({ code: "42883" })).toBe(true);
    expect(erroDeValorDoBanco({ code: "42P01" })).toBe(false);
    expect(erroDeValorDoBanco({ code: "57014" })).toBe(false);
    expect(erroDeValorDoBanco(new Error("x"))).toBe(false);
    expect(erroDeValorDoBanco(null)).toBe(false);
  });
});

describe("colunasDaTabela traz o tipo de cada coluna na mesma leitura do catálogo", () => {
  it("`tipos` mapeia nome → data_type, com uma consulta só", async () => {
    // (Junção da 1.86) Tipo do módulo real: com o vitest 4.1 o `vi.fn()` do mock acima tipa como
    // `Mock<Procedure | Constructable>`, e `typeof colunasDaTabela` deixou de ser chamável.
    const real = await vi.importActual<typeof import("@/lib/external-db/introspeccao")>("@/lib/external-db/introspeccao");
    const selects: string[] = [];
    const linha = (coluna: string, tipo_dado: string, posicao: number) => ({
      schema: "public", nome: "cargos", tipo: "BASE TABLE", coluna, tipo_dado, nulavel: "YES", posicao,
      chave_primaria: null, estimativa: 10,
    });
    const rows = [linha("cargo", "text", 1), linha("so_ensino_medio", "boolean", 2)];
    const client = {
      query: async (text: string) => {
        if (text.trimStart().startsWith("select")) selects.push(text);
        return text.trimStart().startsWith("select") ? { rows, fields: [], rowCount: rows.length } : { rows: [], fields: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client } as never;
    const r = await real.colunasDaTabela(pool, "public", "cargos");
    expect(r).toEqual(new Set(["cargo", "so_ensino_medio"]));
    expect(r?.tipos?.get("so_ensino_medio")).toBe("boolean");
    expect(r?.tipos?.get("cargo")).toBe("text");
    expect(selects).toHaveLength(1);
  });
});
