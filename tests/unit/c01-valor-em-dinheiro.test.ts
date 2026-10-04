/**
 * (C01, -c01.3, item 3b) NENHUM VALOR EM DINHEIRO DO CURSO NA CONVERSA.
 *
 * O defeito: a regra da C01 (M1 do `docs/comercial/04`) manda deixar valor, parcela,
 * juros e desconto na página de matrícula, mas só o texto pedia isso, e o modelo
 * escrevia parcela e preço (na forma "18x de R$ 157,30") assim mesmo (C10, C41 da volta 19).
 *
 * A trava `valor_em_dinheiro` (ligada por organização) veta o que `extractPromises` lê
 * e as formas da M1 que a régua do laboratório pega (`DINHEIRO_M1` de
 * `lab/simulacao/raio_x.py`), sem pegar data, "2 fases", "60 metas", "67 dias",
 * "12 meses", "6/12", vagas, "100% online" nem o salário do cargo. É trava de
 * conteúdo: contador e fail-safe da promessa semântica.
 *
 * Os casos que TÊM de vetar são as frases do raio-x M1 (verificador de 30/09); os que
 * não podem vetar são os falsos positivos conhecidos. A ligação no turno, pelo código.
 * Nomes, links e valores são fictícios, na forma dos reais (regra do C01.md: nada da
 * C01 no código).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CAMINHO_DA_TRAVA = "@/lib/agent-engine/guardrails/valor-em-dinheiro";
const CAMINHO_DA_CONFIGURACAO = "@/lib/agent-engine/guardrails/travas-de-envio";

type Veredito = { pass: boolean; code?: string; reason?: string; detail?: Record<string, unknown> };
async function avaliar(body: string, ligada = true): Promise<Veredito> {
  const m = (await import(/* @vite-ignore */ CAMINHO_DA_TRAVA)) as {
    valorEmDinheiroGate: { name: string; evaluate: (ctx: unknown) => Veredito };
  };
  expect(m.valorEmDinheiroGate.name).toBe("valor_em_dinheiro");
  return m.valorEmDinheiroGate.evaluate(ligada ? { body, travasDeEnvio: { valorEmDinheiro: true } } : { body });
}

const TEM_DE_VETAR = [
  "O Plano Completo sai por R$ 2.490 à vista.",
  "Fica em 18x de 157,30 no cartão.",
  "Em torno de 4 mil reais.",
  "Dá 118,90 por mês.",
  "São 12 parcelas no Pix.",
  "No cartão é sem juros.",
  "À vista sai 2.490.",
  "Tem 10% de desconto até hoje.",
  "Fica em 18x 157,30 no cartão.",
  "São 18 vezes de 157,30.",
  "Parcelas de 157,30 no cartão.",
  "Dá 157,30 mensais.",
  "Fica 1.690 no Pix.",
  "Entrada de 480,00 e o resto parcelado.",
  "Em até 18x no cartão.",
  "1.690 à vista.",
  "Uns 3 mil no total.",
  "Os juros são de 1,67% ao mês.",
  "Dá pra parcelar em 12 vezes.",
  "Sai por 49 € por mês.",
];

const NAO_PODE_VETAR = [
  "A recomendação é cerca de 2 horas por dia na semana.",
  "No último concurso foram 67 dias entre o edital e a prova.",
  "Com escala 14x14 fica corrido mesmo.",
  "O curso é 100% online, no seu ritmo.",
  "São mais de 3 mil questões no aplicativo.",
  "Foram 80 aprovados, 30% das vagas nas ênfases com preparação.",
  "Os valores e o parcelamento estão na página: https://lp.exemplo.com.br/plano-completo/?nivel=superior",
  "A prova tem 2 fases.",
  "O plano tem 60 metas de estudo.",
  "O acesso do plano de 12 meses começa na matrícula.",
  "Na escala 6/12 dá pra estudar nas folgas.",
  "A inscrição vai até 15/10/2026, e a prova é em 30 de novembro.",
  "O edital previu 1.200 vagas no total.",
  "Há equiparação de 50% por gênero nas vagas.",
  "Só 1% dos inscritos chega à segunda fase.",
  "Concorreram mais de 60 mil candidatos.",
  "O salário inicial de técnico é de R$ 5.800, fora os benefícios.",
  "A página do 18x é https://matricula.escolaexemplo.com.br/pay/concurso-estatal-premium-administracao-completo-18x",
  "Os planos são o Plano Completo e o de 12 meses; a diferença é o tempo de acesso.",
];

describe("(C01) a trava 'valor em dinheiro'", () => {
  it("desarmada (sem a chave), passa qualquer valor", async () => {
    expect((await avaliar("O Plano Completo sai por R$ 2.490.", false)).pass).toBe(true);
  });

  it.each(TEM_DE_VETAR)("veta (forma da M1): %s", async (frase) => {
    const v = await avaliar(frase);
    expect(v.pass, frase).toBe(false);
    expect(v.code).toBe("valor_em_dinheiro");
    expect(v.reason).toMatch(/NÃO foi enviada/);
    expect(v.reason).toMatch(/mande o link exato da página/);
    expect(v.reason).toMatch(/sem escrever nenhum número de dinheiro/);
  });

  it.each(NAO_PODE_VETAR)("não veta (falso positivo conhecido): %s", async (frase) => {
    expect((await avaliar(frase)).pass, frase).toBe(true);
  });

  it("os textos da C10 e da C41 (volta 19) vetam", async () => {
    expect(
      (
        await avaliar(
          "No cartão fica em 18x de R$ 104,20, com juros de 1,67% ao mês; no Pix à vista, R$ 1.690, sem juros.",
        )
      ).pass,
    ).toBe(false);
    expect((await avaliar("No cartão fica em 18 parcelas de R$ 157,30, com juros de 1,67% ao mês.")).pass).toBe(
      false,
    );
  });

  it("o salário não abre brecha para o preço do curso na mesma frase", async () => {
    expect((await avaliar("O salário é de R$ 5.800,00 e o curso sai por R$ 2.490.")).pass).toBe(false);
  });

  it("o trace leva só a contagem", async () => {
    const v = await avaliar("Fica em 18x de 157,30 no cartão.");
    expect(v.detail).toEqual({ trechos: 1 });
  });
});

describe("(C01) a configuração e a ligação no turno e na cadeia", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const CADEIA = readFileSync("lib/agent-engine/guardrails/before-send.ts", "utf8");

  it("liga com `valor_em_dinheiro.ligada`; ausente = desligada", async () => {
    const { interpretarTravasDeEnvio } = (await import(/* @vite-ignore */ CAMINHO_DA_CONFIGURACAO)) as {
      interpretarTravasDeEnvio: (v: unknown) => { travas: { valorEmDinheiro: boolean }; invalida: boolean };
    };
    expect(interpretarTravasDeEnvio({}).travas.valorEmDinheiro).toBe(false);
    expect(interpretarTravasDeEnvio({ valor_em_dinheiro: { ligada: true } }).travas.valorEmDinheiro).toBe(true);
    expect(interpretarTravasDeEnvio({ valor_em_dinheiro: { ligada: 1 } }).invalida).toBe(true);
  });

  it("a cadeia roda a trava depois da de link e antes da de texto longo", () => {
    expect(CADEIA).toMatch(/linkPermitidoGate,\s*valorEmDinheiroGate,/);
  });

  it("é trava de conteúdo, e o turno a arma só com ela ligada", () => {
    expect(TURNO).toMatch(/valor_em_dinheiro: 'valor em dinheiro na conversa',/);
    expect(TURNO).toMatch(
      /\.\.\.\(travasDaOrg\.travas\.valorEmDinheiro \? \{ valorEmDinheiro: true as const \} : \{\}\),/,
    );
  });
});
