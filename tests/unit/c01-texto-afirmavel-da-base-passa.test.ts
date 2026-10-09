/**
 * (C01, -c01.8) O TEXTO QUE A BASE MANDA DIZER PASSA PELA TRAVA DE VALOR; O PREÇO DO CURSO NÃO.
 *
 * A decisão (CRM-085 da C01, item 4): "liberar o texto exato da base, o salário da
 * base, a apresentação e o desconto aprovado; preço do curso continua barrado". A trava
 * `valor_em_dinheiro` barrava o salário com o valor exato que a base manda dizer e a
 * porcentagem do cupom aprovado — e deixava passar o cupom ainda não liberado quando
 * escrito como "cupom de 5%" (o "%" só contava com "desconto" ou "off").
 *
 * Agora o valor dentro da FRASE INTEIRA de um texto afirmável (linha da base externa com
 * o texto para o cliente, a marca de afirmar verdadeira e um assunto da lista de
 * permitidos) que uma consulta devolveu neste turno não conta, nem o valor dentro desse
 * texto inteiro; o resto continua como era, procurado no texto original, e a porcentagem
 * com cupom ou forma de pagamento passa a contar. Nomes e valores são fictícios, na forma
 * dos reais (regra do C01.md: nada da C01 no código).
 *
 * (1ª revisão da -c01.8) Os furos que a revisão independente reproduziu viraram casos:
 * o salário liberava "O preço do curso é de R$ 7.412,35." (bastavam 2 palavras em volta);
 * apagar o trecho aprovado tirava o "cupom" de "cupom de 5% ou 10%"; uma linha de preço
 * marcada como afirmável liberava o preço.
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

/** Uma linha da view de fatos; o assunto padrão é o de um fato que libera valor. */
const fato = (texto: string, podeAfirmar: unknown = true, assunto: unknown = "salario") => ({
  chave: "fato_exemplo",
  assunto,
  texto_para_o_lead: texto,
  status: "confirmado",
  pode_afirmar: podeAfirmar,
});
const cupom = (texto: string, podeAfirmar: unknown = true) => fato(texto, podeAfirmar, "desconto");
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
type Colunas = { texto: string; podeAfirmar: string; assunto: string; assuntos: readonly string[] };
type Modulos = {
  valorEmDinheiroGate: { evaluate: (ctx: unknown) => Veredito };
  trechosDeDinheiro: (body: string, afirmaveis?: readonly string[]) => string[];
  textosAfirmaveisNoResultado: (r: unknown, colunas?: Colunas) => Set<string>;
};
async function modulos(): Promise<Modulos> {
  const trava = (await import(/* @vite-ignore */ CAMINHO_DA_TRAVA)) as Pick<
    Modulos,
    "valorEmDinheiroGate" | "trechosDeDinheiro"
  >;
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
  it("só a linha com o texto, a marca de afirmar estritamente verdadeira e assunto permitido", async () => {
    const { textosAfirmaveisNoResultado } = await modulos();
    const r = consulta([fato(SALARIO), cupom(CUPOM_5, false), fato(APRESENTACAO, "true"), fato("   "), OFERTA, LINK]);
    expect([...textosAfirmaveisNoResultado(r)]).toEqual([SALARIO]);
    // Pelo JSON do `content` também (o MCP entrega os dois).
    expect([...textosAfirmaveisNoResultado({ content: r.content })]).toEqual([SALARIO]);
  });

  it("lista de permitidos, falha fechada: assunto fora da lista ou ausente não libera", async () => {
    const { textosAfirmaveisNoResultado } = await modulos();
    const PRECO = "O curso custa R$ 997.";
    const semAssunto = { texto_para_o_lead: PRECO, pode_afirmar: true };
    const r = consulta([fato(PRECO, true, "preco"), fato(PRECO, true, "produto"), fato(PRECO, true, null), semAssunto]);
    expect([...textosAfirmaveisNoResultado(r)]).toEqual([]);
    // Os assuntos padrão: salário, edital, calendário, apresentação e desconto.
    const padrao = consulta([
      fato(SALARIO),
      cupom(CUPOM_5),
      fato(APRESENTACAO, true, "calendario"),
      fato("A banca é a Exemplo.", true, "edital"),
      fato("Para trabalhar lá, o caminho é o concurso.", true, "apresentacao"),
    ]);
    expect(textosAfirmaveisNoResultado(padrao).size).toBe(5);
  });

  it("as colunas e os assuntos são os da configuração", async () => {
    const { textosAfirmaveisNoResultado } = await modulos();
    const r = consulta([{ frase: SALARIO, afirmar: true, tema: "cargo" }, fato(APRESENTACAO)]);
    const colunas = { texto: "frase", podeAfirmar: "afirmar", assunto: "tema", assuntos: ["cargo"] };
    expect([...textosAfirmaveisNoResultado(r, colunas)]).toEqual([SALARIO]);
    expect([...textosAfirmaveisNoResultado(r, { ...colunas, assuntos: [] })]).toEqual([]);
  });
});

describe("(C01, -c01.8) a trava 'valor em dinheiro' com o texto afirmável da base", () => {
  it("'5%' do fato afirmável do turno passa", async () => {
    expect((await avaliar(DESCONTO_5)).pass).toBe(false);
    expect((await avaliar(DESCONTO_5, consulta([cupom(DESCONTO_5)]))).pass).toBe(true);
    expect((await avaliar(CUPOM_5, consulta([cupom(CUPOM_5)]))).pass).toBe(true);
    expect((await avaliar(CUPOM_10, consulta([cupom(CUPOM_10)]))).pass).toBe(true);
    // Com outras frases antes e depois: o que vale é a frase inteira da base.
    expect(
      (await avaliar(`Entendo! ${CUPOM_5.replace("Pra", "pra")} Quer o link?`, consulta([cupom(CUPOM_5)]))).pass,
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
    expect((await avaliar(frase, consulta([cupom(frase, false)]))).pass, frase).toBe(false);
    expect((await avaliar(frase, consulta([cupom(frase, null)]))).pass, frase).toBe(false);
  });

  it("o número de um texto afirmável não libera o mesmo número noutra frase", async () => {
    // "10%" da prova social não vira desconto; "5%" do cupom não vira "5 reais".
    expect((await avaliar("Consigo 10% de desconto no cartão.", consulta([fato(PROVA_SOCIAL)]))).pass).toBe(false);
    expect((await avaliar("Fica com 10% de desconto.", consulta([fato(PROVA_SOCIAL)]))).pass).toBe(false);
    expect((await avaliar("Consigo um cupom de 5 reais.", consulta([cupom(CUPOM_5)]))).pass).toBe(false);
    expect((await avaliar("Te dou 5% de desconto no cartão.", consulta([cupom(CUPOM_5)]))).pass).toBe(false);
  });

  it("o preço com o mesmo número do salário é barrado; juntos, só a frase do salário passa", async () => {
    const { trechosDeDinheiro } = await modulos();
    const r = consulta([fato(SALARIO)]);
    const PRECO = "O preço do curso é de R$ 7.412,35.";
    expect((await avaliar(PRECO, r)).pass).toBe(false);
    expect((await avaliar("O curso sai por R$ 7.412,35 no regime administrativo.", r)).pass).toBe(false);
    expect((await avaliar(`${SALARIO} O preço do curso também é de R$ 7.412,35.`, r)).pass).toBe(false);
    // Só a frase do preço conta: a do salário, igual à da base, não.
    expect(trechosDeDinheiro(SALARIO, [SALARIO])).toEqual([]);
    expect(trechosDeDinheiro(`${SALARIO} O preço do curso também é de R$ 7.412,35.`, [SALARIO])).toHaveLength(1);
    expect(trechosDeDinheiro(`O preço do curso também é de R$ 7.412,35. ${SALARIO}`, [SALARIO])).toHaveLength(1);
  });

  it("cada valor é lido no texto original, com o contexto inteiro (nada é apagado antes)", async () => {
    // O texto inteiro da base dentro de uma frase maior libera só o pedaço dele.
    const A = "Consigo um cupom de 5%";
    const B = "Consigo um cupom de 5% no cartão";
    for (const [frase, base] of [
      ["Consigo um cupom de 5% ou 10% para você.", A],
      ["Consigo um cupom de 5% no cartão ou 10% no pix.", B],
      ["5% no cartão ou 10% no pix.", "5% no cartão"],
    ] as const) {
      expect((await avaliar(frase, consulta([cupom(base)]))).pass, frase).toBe(false);
    }
    // Controle: o texto inteiro da base, sozinho, passa.
    expect((await avaliar(`${A}.`, consulta([cupom(A)]))).pass).toBe(true);
    expect((await avaliar(`Boa notícia: ${B}!`, consulta([cupom(B)]))).pass).toBe(true);
  });

  it("o valor é comparado inteiro, com centavos e milhar: 'R$ 5' aprovado não libera 'R$ 5,50' nem 'R$ 5.999' (2ª revisão)", async () => {
    const BASE = "O cupom abate R$ 5.";
    const r = consulta([cupom(BASE)]);
    expect((await avaliar(BASE, r)).pass).toBe(true);
    expect((await avaliar("Boa notícia: o cupom abate R$ 5!", r)).pass).toBe(true);
    for (const frase of [
      "O cupom abate R$ 5,50.",
      "O cupom abate R$ 5.999.",
      "O cupom abate R$ 5.999,90 no cartão.",
      "O cupom abate R$ 50.",
    ]) {
      expect((await avaliar(frase, r)).pass, frase).toBe(false);
    }
  });

  it("o valor é a expressão monetária inteira: 'R$ 5' aprovado não libera 'R$ 5 e 50 centavos', 'R$ 5 000' nem 'R$ 5 mil' (3ª revisão)", async () => {
    const r = consulta([cupom("O cupom abate R$ 5.")]);
    // O mesmo valor, escrito de outro jeito, passa.
    for (const frase of [
      "O cupom abate R$ 5,00.",
      "O cupom abate R$5,00.",
      "O cupom abate R$5.",
      "O cupom abate 5 reais.",
      "Boa notícia: o cupom abate R$5,00!",
    ]) {
      expect((await avaliar(frase, r)).pass, frase).toBe(true);
    }
    // Valor diferente com o mesmo começo: barrado, na frase igual ou dentro de uma maior.
    for (const frase of [
      "O cupom abate R$ 5 e 50 centavos.",
      "Boa notícia: o cupom abate R$ 5 e 50 centavos!",
      "O cupom abate R$ 5 000.",
      "Boa notícia: o cupom abate R$ 5 000!",
      "O cupom abate R$ 5 000.",
      "O cupom abate R$ 5 000.",
      "O cupom abate R$ 5 000.",
      "O cupom abate R$ 5 mil.",
      "O cupom abate R$ 5 milhões.",
      "O cupom abate R$ 5 e meio.",
      "O cupom abate R$ 5 e 500 centavos.",
      "O cupom abate R$ 5, e mais 50 centavos.",
      "O cupom abate 5 reais e 50.",
      "O cupom abate 5 reais e 50 centavos.",
      "O cupom abate R$ 5,00 000.",
      // As da 2ª revisão continuam barradas.
      "O cupom abate R$ 5,50.",
      "O cupom abate R$ 5.999.",
      "O cupom abate R$ 50.",
    ]) {
      expect((await avaliar(frase, r)).pass, frase).toBe(false);
    }
  });

  it("'5 reais' e 'R$ 5.000' aprovados: o valor igual passa em qualquer escrita; o diferente, não (3ª revisão)", async () => {
    const reais = consulta([cupom("O cupom abate 5 reais.")]);
    for (const frase of ["O cupom abate 5 reais.", "O cupom abate R$ 5.", "O cupom abate 5,00 reais."]) {
      expect((await avaliar(frase, reais)).pass, frase).toBe(true);
    }
    for (const frase of [
      "O cupom abate 5 reais e 50.",
      "O cupom abate 5 reais e 50 centavos.",
      "O cupom abate 5 mil reais.",
      "O cupom abate 1 5 reais.",
      "O cupom abate 15 reais.",
    ]) {
      expect((await avaliar(frase, reais)).pass, frase).toBe(false);
    }
    const mil = consulta([cupom("O cupom abate R$ 5.000.")]);
    for (const frase of [
      "O cupom abate R$ 5.000.",
      "O cupom abate R$ 5 000.",
      "O cupom abate R$ 5 000.",
      "O cupom abate R$ 5 000,00.",
      "O cupom abate R$ 5 mil.",
      "O cupom abate 5 mil reais.",
      "O cupom abate R$ 5.000,00.",
    ]) {
      expect((await avaliar(frase, mil)).pass, frase).toBe(true);
    }
    for (const frase of [
      "O cupom abate R$ 5.000,50.",
      "O cupom abate R$ 5 000,50.",
      "O cupom abate R$ 5.000 e 50 centavos.",
      "O cupom abate R$ 5 mil e 500.",
      "O cupom abate R$ 5.000.000.",
      "O cupom abate R$ 5 000 000.",
      "O cupom abate R$ 5,000.",
    ]) {
      expect((await avaliar(frase, mil)).pass, frase).toBe(false);
    }
  });

  it("parcela fora da base com o mesmo valor da aprovada é barrada: o detector junta por valor (2ª revisão)", async () => {
    const BASE = "O cupom de 5% vale no cartão, em 12x.";
    const r = consulta([cupom(BASE)]);
    expect((await avaliar(BASE, r)).pass).toBe(true);
    for (const frase of [
      `${BASE} O curso é parcelado em 12x.`,
      `${BASE} O curso sai em 12x sem juros.`,
      `${BASE} O curso é parcelado em 18x.`,
    ]) {
      expect((await avaliar(frase, r)).pass, frase).toBe(false);
    }
    // Sem texto afirmável, como antes: o detector do autor lê as parcelas.
    expect((await avaliar("O curso é parcelado em 12x.")).pass).toBe(false);
  });

  it("salário exato do fato passa na frase inteira; arredondado ou pela metade, não", async () => {
    const r = consulta([fato(SALARIO)]);
    expect((await avaliar(SALARIO)).pass).toBe(false);
    expect((await avaliar(SALARIO, r)).pass).toBe(true);
    // Maiúsculas, espaço não separável e a pontuação do fim não contam.
    expect((await avaliar(`Boa pergunta! ${SALARIO.toUpperCase().replace(/ /g, "\u00a0").slice(0, -1)}`, r)).pass).toBe(
      true,
    );
    expect(
      (await avaliar("Boa pergunta! O salário base de nível técnico é de R$ 7.412,35 no regime administrativo.", r))
        .pass,
    ).toBe(false);
    expect((await avaliar(SALARIO.replace("R$ 7.412,35", "R$ 7.400"), r)).pass).toBe(false);
    expect((await avaliar(SALARIO.replace("R$ 7.412,35", "R$ 7412"), r)).pass).toBe(false);
  });

  it("a apresentação passa ('mais de 2 mil')", async () => {
    expect((await avaliar(APRESENTACAO)).pass).toBe(false);
    expect((await avaliar(APRESENTACAO, consulta([fato(APRESENTACAO, true, "calendario")]))).pass).toBe(true);
  });

  it("preço do curso vindo de consulta de oferta ou link continua barrado", async () => {
    const r = consulta([fato(SALARIO), cupom(CUPOM_5), OFERTA, LINK]);
    for (const frase of [
      "O Plano Completo sai por R$ 1.997 no cartão.",
      "Fica em 12x de R$ 166,42.",
      "São 12 parcelas de 166,42.",
      "Essa condição está aberta até 31/10: R$ 1.997 à vista.",
    ]) {
      expect((await avaliar(frase, r)).pass, frase).toBe(false);
    }
    // O texto afirmável não abre brecha para o preço na mesma mensagem.
    expect((await avaliar(`${CUPOM_5} O Plano Completo sai por R$ 1.997.`, r)).pass).toBe(false);
    expect((await avaliar(`${SALARIO} E o curso sai por 12x de R$ 166,42.`, r)).pass).toBe(false);
  });

  it("linha de preço marcada como afirmável, com assunto fora da lista ou sem assunto, não libera", async () => {
    const PRECO = "O curso custa R$ 997.";
    expect((await avaliar(PRECO, consulta([fato(PRECO, true, "preco")]))).pass).toBe(false);
    expect((await avaliar(PRECO, consulta([fato(PRECO, true, "oferta")]))).pass).toBe(false);
    expect((await avaliar(PRECO, consulta([{ texto_para_o_lead: PRECO, pode_afirmar: true }]))).pass).toBe(false);
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

  it("o veto ensina a copiar a frase inteira da base", async () => {
    const v = await avaliar(CUPOM_5);
    expect(v.reason).toMatch(/consulta deste turno, num texto que ela marca como afirmável, copiado na frase inteira, como veio/);
    expect(v.detail).toEqual({ trechos: 1 });
  });
});

describe("(C01, -c01.8) a configuração e a ligação no turno", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("as colunas vêm de `valor_em_dinheiro.texto_afirmavel`; ausente = o padrão", async () => {
    const { interpretarTravasDeEnvio } = (await import(/* @vite-ignore */ CAMINHO_DA_CONFIGURACAO)) as {
      interpretarTravasDeEnvio: (v: unknown) => { travas: { colunasDoTextoAfirmavel: Colunas }; invalida: boolean };
    };
    const PADRAO = {
      texto: "texto_para_o_lead",
      podeAfirmar: "pode_afirmar",
      assunto: "assunto",
      assuntos: ["salario", "edital", "calendario", "apresentacao", "desconto"],
    };
    expect(interpretarTravasDeEnvio({}).travas.colunasDoTextoAfirmavel).toEqual(PADRAO);
    expect(
      interpretarTravasDeEnvio({
        valor_em_dinheiro: { ligada: true, texto_afirmavel: { coluna_texto: "frase", coluna_pode_afirmar: "afirmar" } },
      }).travas.colunasDoTextoAfirmavel,
    ).toEqual({ ...PADRAO, texto: "frase", podeAfirmar: "afirmar" });
    expect(
      interpretarTravasDeEnvio({
        valor_em_dinheiro: { ligada: true, texto_afirmavel: { coluna_assunto: "tema", assuntos: ["salario"] } },
      }).travas.colunasDoTextoAfirmavel,
    ).toEqual({ ...PADRAO, assunto: "tema", assuntos: ["salario"] });
    for (const errado of [{ coluna_texto: "" }, { assuntos: [""] }, { assuntos: "salario" }, { coluna_assunto: 1 }]) {
      expect(
        interpretarTravasDeEnvio({ valor_em_dinheiro: { ligada: true, texto_afirmavel: errado } }).invalida,
        JSON.stringify(errado),
      ).toBe(true);
    }
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
