/**
 * (C01, -c01.8) O TEXTO QUE A BASE MANDA DIZER PASSA PELA TRAVA DE VALOR; O PREÇO DO CURSO NÃO.
 *
 * A decisão (CRM-085 da C01, item 4): "liberar o texto exato da base, o salário da
 * base, a apresentação e o desconto aprovado; preço do curso continua barrado". A trava
 * `valor_em_dinheiro` barrava o salário com o valor exato que a base manda dizer e a
 * porcentagem do cupom aprovado — e deixava passar o cupom ainda não liberado quando
 * escrito como "cupom de 5%" (o "%" só contava com "desconto" ou "off").
 *
 * Agora o trecho exato de um texto afirmável (linha da base externa com o texto para o
 * cliente e a marca de afirmar verdadeira) que uma consulta devolveu neste turno não
 * conta; o resto continua como era, e a porcentagem com cupom ou forma de pagamento
 * passa a contar. Nomes e valores são fictícios, na forma dos reais (regra do C01.md:
 * nada da C01 no código).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CAMINHO_DA_TRAVA = "@/lib/agent-engine/guardrails/valor-em-dinheiro";
const CAMINHO_DO_TEXTO = "@/lib/agent-engine/guardrails/texto-afirmavel";
const CAMINHO_DA_CONFIGURACAO = "@/lib/agent-engine/guardrails/travas-de-envio";

// As linhas da base, como a view de fatos as devolve (colunas fictícias na forma da real).
const SALARIO =
  "Na Empresa Exemplo, o salário base de nível técnico é de R$ 7.412,35 no regime administrativo " +
  "e de R$ 10.981,20 no turno de 12 horas.";
const DESCONTO_5 =
  "No cartão ou à vista, você ganha 5% de desconto com o cupom: é só digitar o código na página de pagamento.";
const CUPOM_5 = "Pra pagamento no cartão ou à vista, consigo um cupom de 5%: é só digitar o código no campo de cupom.";
const CUPOM_10 = "Consigo subir pra 10% no cartão ou à vista: é outro código, no mesmo campo de cupom.";
const APRESENTACAO =
  "O último concurso técnico ainda vale e segue chamando aprovados: só em Operação, já foram mais de 2 mil.";
const PROVA_SOCIAL = "Nossos alunos eram cerca de 1% dos inscritos e ficaram com 10% das vagas.";

const fato = (texto: string, podeAfirmar: unknown = true) => ({
  chave: "fato_exemplo",
  assunto: "exemplo",
  texto_para_o_lead: texto,
  status: "confirmado",
  pode_afirmar: podeAfirmar,
});
/** O resultado de `crm_query_external_data` como o MCP o entrega ao turno. */
const consulta = (linhas: Array<Record<string, unknown>>) => {
  const r = { tabela: "fatos_do_agente", colunas: Object.keys(linhas[0] ?? {}), linhas, linhas_devolvidas: linhas.length };
  return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
};
const OFERTA = {
  plano_id: "plano_completo",
  nome_comercial: "Plano Completo",
  forma_pagamento: "cartao",
  preco_total: 1997,
  parcelas: 12,
  valor_parcela: 166.42,
  pode_afirmar: true,
  condicao: "Essa condição está aberta até 31/10.",
};
const LINK = { plano_id: "plano_completo", url: "https://lp.exemplo.com.br/plano-completo?preco=1997", pode_enviar: true };

type Veredito = { pass: boolean; code?: string; reason?: string; detail?: Record<string, unknown> };
type Modulos = {
  valorEmDinheiroGate: { evaluate: (ctx: unknown) => Veredito };
  textosAfirmaveisNoResultado: (r: unknown, colunas?: { texto: string; podeAfirmar: string }) => Set<string>;
};
async function modulos(): Promise<Modulos> {
  const trava = (await import(/* @vite-ignore */ CAMINHO_DA_TRAVA)) as Pick<Modulos, "valorEmDinheiroGate">;
  const texto = (await import(/* @vite-ignore */ CAMINHO_DO_TEXTO)) as Pick<Modulos, "textosAfirmaveisNoResultado">;
  return { ...trava, ...texto };
}
/** A trava ligada, com os textos afirmáveis que as consultas `resultados` trouxeram neste turno. */
async function avaliar(body: string, ...resultados: unknown[]): Promise<Veredito> {
  const { valorEmDinheiroGate, textosAfirmaveisNoResultado } = await modulos();
  const textos = new Set<string>();
  for (const r of resultados) for (const t of textosAfirmaveisNoResultado(r)) textos.add(t);
  return valorEmDinheiroGate.evaluate({ body, travasDeEnvio: { valorEmDinheiro: { textosAfirmaveis: [...textos] } } });
}

describe("(C01, -c01.8) os textos afirmáveis de um resultado da base externa", () => {
  it("só a linha com o texto e a marca de afirmar estritamente verdadeira", async () => {
    const { textosAfirmaveisNoResultado } = await modulos();
    const r = consulta([fato(SALARIO), fato(CUPOM_5, false), fato(APRESENTACAO, "true"), fato("   "), OFERTA, LINK]);
    expect([...textosAfirmaveisNoResultado(r)]).toEqual([SALARIO]);
    // Pelo JSON do `content` também (o MCP entrega os dois).
    expect([...textosAfirmaveisNoResultado({ content: r.content })]).toEqual([SALARIO]);
  });

  it("as colunas são as da configuração", async () => {
    const { textosAfirmaveisNoResultado } = await modulos();
    const r = consulta([{ frase: SALARIO, afirmar: true }, fato(APRESENTACAO)]);
    expect([...textosAfirmaveisNoResultado(r, { texto: "frase", podeAfirmar: "afirmar" })]).toEqual([SALARIO]);
  });
});

describe("(C01, -c01.8) a trava 'valor em dinheiro' com o texto afirmável da base", () => {
  it("'5%' do fato afirmável do turno passa", async () => {
    expect((await avaliar(DESCONTO_5)).pass).toBe(false);
    expect((await avaliar(DESCONTO_5, consulta([fato(DESCONTO_5)]))).pass).toBe(true);
    expect((await avaliar(CUPOM_5, consulta([fato(CUPOM_5)]))).pass).toBe(true);
    expect((await avaliar(CUPOM_10, consulta([fato(CUPOM_10)]))).pass).toBe(true);
    // Com outras palavras antes e depois do trecho: o que vale é o trecho exato.
    expect(
      (await avaliar(`Entendo! ${CUPOM_5.replace("Pra", "pra")} Quer o link?`, consulta([fato(CUPOM_5)]))).pass,
    ).toBe(true);
  });

  it.each([CUPOM_5, CUPOM_10, DESCONTO_5, "Consigo um cupom de 5% pra você."])(
    "'5%' sem consulta no turno é barrado: %s",
    async (frase) => {
      const v = await avaliar(frase);
      expect(v.pass, frase).toBe(false);
      expect(v.code).toBe("valor_em_dinheiro");
    },
  );

  it.each([CUPOM_5, CUPOM_10, DESCONTO_5])("'5%' de linha com a marca de afirmar falsa é barrado: %s", async (frase) => {
    expect((await avaliar(frase, consulta([fato(frase, false)]))).pass, frase).toBe(false);
    expect((await avaliar(frase, consulta([fato(frase, null)]))).pass, frase).toBe(false);
  });

  it("o número de um texto afirmável não libera o mesmo número noutra frase", async () => {
    // "10%" da prova social não vira desconto; "5%" do cupom não vira "5 reais".
    expect((await avaliar("Consigo 10% de desconto no cartão.", consulta([fato(PROVA_SOCIAL)]))).pass).toBe(false);
    expect((await avaliar("Fica com 10% de desconto.", consulta([fato(PROVA_SOCIAL)]))).pass).toBe(false);
    expect((await avaliar("Consigo um cupom de 5 reais.", consulta([fato(CUPOM_5)]))).pass).toBe(false);
    expect((await avaliar("Te dou 5% de desconto no cartão.", consulta([fato(CUPOM_5)]))).pass).toBe(false);
  });

  it("salário exato do fato passa; arredondado, não", async () => {
    const r = consulta([fato(SALARIO)]);
    expect((await avaliar(SALARIO)).pass).toBe(false);
    expect((await avaliar(SALARIO, r)).pass).toBe(true);
    expect(
      (await avaliar("Boa pergunta! O salário base de nível técnico é de R$ 7.412,35 no regime administrativo.", r))
        .pass,
    ).toBe(true);
    expect((await avaliar("O salário base de nível técnico é de R$ 7.400 no regime administrativo.", r)).pass).toBe(
      false,
    );
    expect((await avaliar("O salário base de nível técnico é de R$ 7412 no regime administrativo.", r)).pass).toBe(
      false,
    );
  });

  it("a apresentação passa ('mais de 2 mil')", async () => {
    expect((await avaliar(APRESENTACAO)).pass).toBe(false);
    expect((await avaliar(APRESENTACAO, consulta([fato(APRESENTACAO)]))).pass).toBe(true);
  });

  it("preço do curso vindo de consulta de oferta ou link continua barrado", async () => {
    const r = consulta([fato(SALARIO), fato(CUPOM_5), OFERTA, LINK]);
    for (const frase of [
      "O Plano Completo sai por R$ 1.997 no cartão.",
      "Fica em 12x de R$ 166,42.",
      "São 12 parcelas de 166,42.",
      "Essa condição está aberta até 31/10: R$ 1.997 à vista.",
    ]) {
      expect((await avaliar(frase, r)).pass, frase).toBe(false);
    }
    // O trecho afirmável não abre brecha para o preço na mesma mensagem.
    expect((await avaliar(`${CUPOM_5} O Plano Completo sai por R$ 1.997.`, r)).pass).toBe(false);
    expect((await avaliar(`${SALARIO} E o curso sai por 12x de R$ 166,42.`, r)).pass).toBe(false);
  });

  it("valor do histórico ou das notas continua barrado (só a consulta do turno libera)", async () => {
    // A nota e a mensagem do cliente não são consulta: o turno não as passa como afirmáveis.
    expect((await avaliar(CUPOM_5)).pass).toBe(false);
    expect((await avaliar(SALARIO, { nota: SALARIO, texto_para_o_lead: SALARIO })).pass).toBe(false);
  });

  it("desligada, nada muda; e `true` (sem textos) segue barrando como antes", async () => {
    const { valorEmDinheiroGate } = await modulos();
    expect(valorEmDinheiroGate.evaluate({ body: DESCONTO_5 }).pass).toBe(true);
    expect(valorEmDinheiroGate.evaluate({ body: DESCONTO_5, travasDeEnvio: {} }).pass).toBe(true);
    expect(valorEmDinheiroGate.evaluate({ body: DESCONTO_5, travasDeEnvio: { valorEmDinheiro: true } }).pass).toBe(
      false,
    );
  });

  it("'100% online', '30% das vagas' e '1% dos inscritos' continuam passando", async () => {
    for (const frase of [
      "O curso é 100% online, no seu ritmo.",
      "Foram 80 aprovados, 30% das vagas nas ênfases com preparação.",
      PROVA_SOCIAL,
      "O curso é 100% online e o acesso sai assim que o pagamento é aprovado.",
    ]) {
      expect((await avaliar(frase)).pass, frase).toBe(true);
    }
  });

  it("o veto ensina a copiar o trecho da base", async () => {
    const v = await avaliar(CUPOM_5);
    expect(v.reason).toMatch(/consulta deste turno, num texto que ela marca como afirmável, copiado com as mesmas palavras/);
    expect(v.detail).toEqual({ trechos: 1 });
  });
});

describe("(C01, -c01.8) a configuração e a ligação no turno", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("as colunas vêm de `valor_em_dinheiro.texto_afirmavel`; ausente = o padrão", async () => {
    const { interpretarTravasDeEnvio } = (await import(/* @vite-ignore */ CAMINHO_DA_CONFIGURACAO)) as {
      interpretarTravasDeEnvio: (v: unknown) => {
        travas: { colunasDoTextoAfirmavel: { texto: string; podeAfirmar: string } };
        invalida: boolean;
      };
    };
    expect(interpretarTravasDeEnvio({}).travas.colunasDoTextoAfirmavel).toEqual({
      texto: "texto_para_o_lead",
      podeAfirmar: "pode_afirmar",
    });
    expect(
      interpretarTravasDeEnvio({
        valor_em_dinheiro: { ligada: true, texto_afirmavel: { coluna_texto: "frase", coluna_pode_afirmar: "afirmar" } },
      }).travas.colunasDoTextoAfirmavel,
    ).toEqual({ texto: "frase", podeAfirmar: "afirmar" });
    expect(
      interpretarTravasDeEnvio({ valor_em_dinheiro: { ligada: true, texto_afirmavel: { coluna_texto: "" } } }).invalida,
    ).toBe(true);
  });

  it("só a consulta sem erro à base externa alimenta os textos afirmáveis, e só com a trava ligada", () => {
    expect(TURNO.match(/textosAfirmaveisNoResultado\(/g)).toHaveLength(1);
    expect(TURNO.match(/const textosAfirmaveis = new Set<string>\(\);/g)).toHaveLength(1);
    const i = TURNO.indexOf("textosAfirmaveisNoResultado(");
    const antes = TURNO.slice(TURNO.lastIndexOf("name === FERRAMENTA_DA_BASE", i), i);
    expect(antes).toMatch(/if \(travasDaOrg\.travas\.valorEmDinheiro && !resultadoComErro\(resultado\)\) \{\s*$/);
    expect(TURNO).toMatch(
      /\.\.\.\(travasDaOrg\.travas\.valorEmDinheiro \? \{ valorEmDinheiro: \{ textosAfirmaveis: \[\.\.\.textosAfirmaveis\] \} \} : \{\}\),/,
    );
  });
});
