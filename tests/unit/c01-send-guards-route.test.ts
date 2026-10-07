import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * (C01, -c01.7) A ROTA DOS INTERRUPTORES DA TELA MOSTRA O ESTADO QUE VALE E SÓ MEXE NA
 * LINHA DELA.
 *
 * `GET /api/v1/ai/send-guards` devolve, para cada trava com interruptor, o estado que
 * o turno do agente usa (pela mesma `interpretarTravasDeEnvio`) e de onde ele vem:
 *   - a linha de `org_guardrail_layers`, se existe, manda (`tela`) — inclusive para
 *     desligar a `valor_em_dinheiro` que o JSON liga;
 *   - sem linha, a `valor_em_dinheiro` segue o `settings.travas_de_envio` de antes
 *     (`configuracao`); a outra fica desligada (`padrao`). Nada liga sozinho.
 * `PUT` grava só a linha da trava pedida (lista fechada) e não toca em
 * `organizations.settings`: a configuração que já existe (`dominios`, `urls`) fica.
 */

const ORG = "33333333-3333-4333-8333-333333333333";

let camadas: Array<{ layer: string; enabled: boolean }> = [];
let settings: Record<string, unknown> | null = null;
let gravacoes: Array<{ tabela: string; linha: unknown; opcoes: unknown }> = [];
let tabelasLidas: string[] = [];

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "u1", idioma: "pt-BR", is_platform_admin: false },
    org: { orgId: ORG, role: "admin" },
  }),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tabela: string) => {
      tabelasLidas.push(tabela);
      if (tabela === "organizations") {
        const cadeia = {
          select: () => cadeia,
          eq: (coluna: string, valor: string) => {
            expect([coluna, valor]).toEqual(["id", ORG]);
            return cadeia;
          },
          maybeSingle: async () => ({ data: { settings }, error: null }),
        };
        return cadeia;
      }
      if (tabela === "org_guardrail_layers") {
        const cadeia = {
          select: () => cadeia,
          eq: (coluna: string, valor: string) => {
            expect([coluna, valor]).toEqual(["organization_id", ORG]);
            return cadeia;
          },
          in: async (_coluna: string, chaves: string[]) => ({
            data: camadas.filter((c) => chaves.includes(c.layer)),
            error: null,
          }),
          upsert: (linha: { layer: string; enabled: boolean }, opcoes: unknown) => {
            gravacoes.push({ tabela, linha, opcoes });
            return {
              select: () => ({ maybeSingle: async () => ({ data: { layer: linha.layer, enabled: linha.enabled }, error: null }) }),
            };
          },
        };
        return cadeia;
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  }),
}));

async function rota() {
  return import("@/app/api/v1/ai/send-guards/route");
}

async function lerEstado() {
  const res = await (await rota()).GET();
  expect(res.status).toBe(200);
  const corpo = (await res.json()) as {
    data: { travas: Array<{ trava: string; enabled: boolean; origem: string }>; podeEditar: boolean };
  };
  return Object.fromEntries(corpo.data.travas.map((t) => [t.trava, { enabled: t.enabled, origem: t.origem }]));
}

function pedido(corpo: unknown) {
  return new NextRequest("http://localhost/api/v1/ai/send-guards", {
    method: "PUT",
    body: JSON.stringify(corpo),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  camadas = [];
  settings = null;
  gravacoes = [];
  tabelasLidas = [];
});

describe("(C01) GET /api/v1/ai/send-guards — o estado que vale", () => {
  it("sem linha e sem configuração: as duas desligadas, pelo padrão (nada liga sozinho)", async () => {
    expect(await lerEstado()).toEqual({
      link_e_valor_de_ferramenta: { enabled: false, origem: "padrao" },
      valor_em_dinheiro: { enabled: false, origem: "padrao" },
    });
  });

  it("sem linha, a `valor_em_dinheiro` ligada no JSON aparece ligada, vinda da configuração", async () => {
    settings = { travas_de_envio: { valor_em_dinheiro: { ligada: true } } };
    expect(await lerEstado()).toEqual({
      link_e_valor_de_ferramenta: { enabled: false, origem: "padrao" },
      valor_em_dinheiro: { enabled: true, origem: "configuracao" },
    });
  });

  it("a linha da tela manda: desliga a `valor_em_dinheiro` que o JSON liga, e liga a de link e valor", async () => {
    settings = { travas_de_envio: { valor_em_dinheiro: { ligada: true } } };
    camadas = [
      { layer: "trava:valor_em_dinheiro", enabled: false },
      { layer: "trava:link_e_valor_de_ferramenta", enabled: true },
      // Uma camada que não é trava de envio não entra na conta.
      { layer: "estilo:sem_travessao_longo", enabled: true },
    ];
    expect(await lerEstado()).toEqual({
      link_e_valor_de_ferramenta: { enabled: true, origem: "tela" },
      valor_em_dinheiro: { enabled: false, origem: "tela" },
    });
  });
});

describe("(C01) PUT /api/v1/ai/send-guards — só a linha da trava pedida", () => {
  it("grava a linha da `valor_em_dinheiro` e não toca em `organizations.settings`", async () => {
    settings = { travas_de_envio: { link_permitido: { ligada: true, dominios: ["exemplo.com.br"] } } };
    const res = await (await rota()).PUT(pedido({ trava: "valor_em_dinheiro", enabled: true }));
    expect(res.status).toBe(200);
    expect(gravacoes).toEqual([
      {
        tabela: "org_guardrail_layers",
        linha: expect.objectContaining({ organization_id: ORG, layer: "trava:valor_em_dinheiro", enabled: true }),
        opcoes: { onConflict: "organization_id,layer" },
      },
    ]);
    expect(tabelasLidas).not.toContain("organizations");
    expect(settings).toEqual({ travas_de_envio: { link_permitido: { ligada: true, dominios: ["exemplo.com.br"] } } });
  });

  it("lista fechada: a `link_permitido` (sem interruptor) e campos a mais são recusados, sem gravar nada", async () => {
    const { PUT } = await rota();
    for (const corpo of [
      { trava: "link_permitido", enabled: true },
      { trava: "uma_pergunta", enabled: true },
      { trava: "valor_em_dinheiro", enabled: true, dominios: [] },
      { trava: "valor_em_dinheiro", enabled: "sim" },
    ]) {
      const res = await PUT(pedido(corpo));
      expect(res.status, JSON.stringify(corpo)).toBe(422);
    }
    expect(gravacoes).toEqual([]);
  });
});
