/**
 * (C01, -c01.3, item 6) O NOME DO MODELO DO JEV VEM DO AMBIENTE.
 *
 * O defeito: `MODELO_DO_JEV` era uma constante (`jev-1.13.0`). Pelo OpenRouter o nome
 * válido é `jev-1.13`, e trocar exigia mudar o código e publicar versão.
 *
 * A correção: `JEV_MODEL` (lib/env.ts) define o nome, lido por `modeloDoJev()` na hora
 * do uso (nunca na carga do módulo); vazio ou ausente = a versão fixada de antes
 * (`MODELO_DO_JEV`). O nome vai no corpo da pergunta ao Jev e na telemetria. Nada sai
 * da máquina: o `fetch` é falso.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("@/lib/env");
  vi.resetModules();
});

async function clienteCom(jevModel: string | undefined): Promise<typeof import("@/lib/ai/decisao/cliente")> {
  vi.resetModules();
  vi.doMock("@/lib/env", () => ({ env: { JEV_API_BASE_URL: "", JEV_MODEL: jevModel } }));
  return import("@/lib/ai/decisao/cliente");
}

const RESPOSTA = {
  model: "jev-1.13",
  answers: { clima: { type: "noul", noul: 0.7 } },
  usage: { input_tokens: 10, output_tokens: 0 },
};

async function modeloPedido(jevModel: string | undefined): Promise<{ constante: string; noCorpo: unknown }> {
  const cliente = await clienteCom(jevModel);
  const fetchImpl = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(RESPOSTA), { status: 200, headers: { "content-type": "application/json" } }),
  );
  await cliente.decidir(
    { chave: "tsk_teste", estado: "oi", perguntas: { clima: { tipo: "noul", instrucao: "Gostou?" } } },
    { fetchImpl },
  );
  const corpo = JSON.parse(String(fetchImpl.mock.calls[0]![1].body)) as { model: unknown };
  return { constante: cliente.modeloDoJev(), noCorpo: corpo.model };
}

describe("(C01) o modelo do Jev pelo ambiente", () => {
  it("JEV_MODEL definido: é o nome pedido à API (o do OpenRouter, jev-1.13)", async () => {
    expect(await modeloPedido("jev-1.13")).toEqual({ constante: "jev-1.13", noCorpo: "jev-1.13" });
  });

  it("espaços em volta não entram no nome", async () => {
    expect((await modeloPedido("  jev-1.13  ")).noCorpo).toBe("jev-1.13");
  });

  it("vazio ou ausente: a versão fixada de antes (jev-1.13.0)", async () => {
    expect(await modeloPedido("")).toEqual({ constante: "jev-1.13.0", noCorpo: "jev-1.13.0" });
    expect(await modeloPedido(undefined)).toEqual({ constante: "jev-1.13.0", noCorpo: "jev-1.13.0" });
  });

  it("todo uso do nome lê a função (corpo, telemetria, worker), nenhum a constante", () => {
    for (const f of [
      "lib/ai/decisao/cliente.ts",
      "lib/ai/decisao/pool.ts",
      "lib/ai/decisao/pedidos.ts",
      "lib/ai/decisao/roteador.ts",
      "workers/ai-sentiment-worker.ts",
    ]) {
      const fonte = readFileSync(f, "utf8");
      expect(fonte, f).not.toMatch(/\$\{MODELO_DO_JEV\}|model: MODELO_DO_JEV|\?\? MODELO_DO_JEV,/);
    }
    expect(readFileSync("lib/ai/decisao/cliente.ts", "utf8")).toMatch(
      /export function modeloDoJev\(\): string \{\s*return \(env\.JEV_MODEL \?\? ""\)\.trim\(\) \|\| MODELO_DO_JEV;\s*\}/,
    );
  });

  it("a variável está validada em lib/env.ts e documentada no .env.example", () => {
    expect(readFileSync("lib/env.ts", "utf8")).toMatch(/^\s{2}JEV_MODEL: z\.string\(\)\.optional\(\)\.default\(""\),$/m);
    expect(readFileSync(".env.example", "utf8")).toMatch(/^JEV_MODEL=/m);
  });
});
