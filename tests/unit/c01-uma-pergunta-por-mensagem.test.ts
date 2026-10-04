/**
 * (C01, -c01.3, item 3c) UMA PERGUNTA POR MENSAGEM.
 *
 * O defeito: a regra da C01 (uma pergunta por mensagem) era só texto, e o modelo
 * fechava a mensagem com duas ou três perguntas — a pessoa respondia uma só.
 *
 * A trava `uma_pergunta` (ligada por organização) conta os "?" do texto inteiro, fora
 * dos links; acima de 1, veta com erro de ensino. Pergunta retórica conta. Trava de
 * estilo: 1º veto ensina; no 2º se desarma no turno e a mensagem passa.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CAMINHO_DA_TRAVA = "@/lib/agent-engine/guardrails/uma-pergunta";
const CAMINHO_DA_CONFIGURACAO = "@/lib/agent-engine/guardrails/travas-de-envio";

type Veredito = { pass: boolean; code?: string; reason?: string; detail?: Record<string, unknown> };
async function avaliar(body: string, ligada = true): Promise<Veredito> {
  const m = (await import(/* @vite-ignore */ CAMINHO_DA_TRAVA)) as {
    umaPerguntaGate: { name: string; evaluate: (ctx: unknown) => Veredito };
  };
  expect(m.umaPerguntaGate.name).toBe("uma_pergunta");
  return m.umaPerguntaGate.evaluate(ligada ? { body, travasDeEnvio: { umaPergunta: true } } : { body });
}

describe("(C01) a trava 'uma pergunta por mensagem'", () => {
  it("desarmada (sem a chave), passa qualquer número de perguntas", async () => {
    expect((await avaliar("Qual a sua ênfase? E a escolaridade? Já estudou antes?", false)).pass).toBe(true);
  });

  it("duas perguntas vetam, com o número e o que fazer", async () => {
    const v = await avaliar("Qual é a sua ênfase? E você já estudou para a Petrobras antes?");
    expect(v.pass).toBe(false);
    expect(v.code).toBe("uma_pergunta");
    expect(v.reason).toMatch(/faz 2 perguntas/);
    expect(v.reason).toMatch(/UMA pergunta só/);
    expect(v.detail).toEqual({ perguntas: 2 });
  });

  it("a pergunta retórica conta", async () => {
    const v = await avaliar("Sabe o que é melhor? O acesso não expira. Quer que eu mande a página?");
    expect(v.pass).toBe(false);
    expect(v.detail).toEqual({ perguntas: 2 });
  });

  it("uma pergunta só passa — também com '??' e em mensagem de vários parágrafos", async () => {
    expect((await avaliar("Perfeito.\n\nQual é a sua ênfase??")).pass).toBe(true);
    expect((await avaliar("O curso é online e o acesso não expira.")).pass).toBe(true);
    expect(
      (await avaliar("Pra Elétrica eu iria no Vitalício.\n\nO acesso não expira.\n\nQuer a página?")).pass,
    ).toBe(true);
  });

  it("o '?' dentro do link não é pergunta", async () => {
    expect(
      (await avaliar("A página é https://lp.c01.com.br/vitalicio/?nivel=superior. Ficou alguma dúvida?")).pass,
    ).toBe(true);
    expect(
      (
        await avaliar(
          "Vê o vídeo: https://player-vz-5f18b79a-58d.tv.pandavideo.com.br/embed/?v=dd8b6425-0048-4707-bb7b-9f6fece1187b e lp.c01.com.br/vitalicio/?nivel=tecnico",
        )
      ).pass,
    ).toBe(true);
  });
});

describe("(C01) a configuração e a ligação no turno e na cadeia", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const CADEIA = readFileSync("lib/agent-engine/guardrails/before-send.ts", "utf8");

  it("liga com `uma_pergunta.ligada`; ausente = desligada", async () => {
    const { interpretarTravasDeEnvio } = (await import(/* @vite-ignore */ CAMINHO_DA_CONFIGURACAO)) as {
      interpretarTravasDeEnvio: (v: unknown) => { travas: { umaPergunta: boolean } };
    };
    expect(interpretarTravasDeEnvio({}).travas.umaPergunta).toBe(false);
    expect(interpretarTravasDeEnvio({ uma_pergunta: { ligada: true } }).travas.umaPergunta).toBe(true);
  });

  it("a cadeia roda a trava depois da de valor e antes da de texto longo", () => {
    expect(CADEIA).toMatch(/valorEmDinheiroGate,\s*umaPerguntaGate,\s*textoLongoGate,/);
  });

  it("é trava de estilo (no limite se desarma no turno e a mensagem passa)", () => {
    expect(TURNO).toMatch(/uma_pergunta: 'umaPergunta',/);
    expect(TURNO).toMatch(
      /travasDaOrg\.travas\.umaPergunta && !estiloDesarmado\('uma_pergunta'\)\s*\?\s*\{ umaPergunta: true as const \}/,
    );
    const iEstilo = TURNO.indexOf("export const TRAVAS_DE_ESTILO");
    const iConteudo = TURNO.indexOf("export const TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE");
    const conteudo = TURNO.slice(iConteudo, TURNO.indexOf("};", iConteudo));
    expect(iEstilo).toBeGreaterThan(-1);
    expect(conteudo).not.toMatch(/uma_pergunta/);
  });
});
