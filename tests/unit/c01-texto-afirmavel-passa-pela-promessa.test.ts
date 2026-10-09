/**
 * (C01, CRM-089 D4) O TEXTO QUE A BASE MANDA DIZER PASSA TAMBÉM PELA TRAVA DE PROMESSA.
 *
 * O defeito (rodada da v0.28 no laboratório, 09/10): a trava semântica de promessa
 * (`promise_semantic`, um classificador de modelo) vetava fatos da base ditos palavra por
 * palavra, como "o acesso vale até você passar e não expira" e "7 dias de garantia": 7 dos
 * 10 envios vetados foram isso, e a resposta virava "ficou com a equipe". A trava de valor
 * em dinheiro já deixava passar o texto afirmável da base (`texto-afirmavel.ts`); a de
 * promessa, não.
 *
 * A correção: o trecho que reproduz um texto afirmável que a base externa devolveu NESTE
 * turno (a mesma leitura de `trechosAprovados`: a frase inteira, ou o texto inteiro dentro
 * de uma frase maior) não é vetado. O resto da mensagem continua passando pelo
 * classificador: a promessa inventada ("mantenho essa condição até sexta") e o texto da
 * base com acréscimo que muda o sentido ("não expira nunca, e ainda garanto a aprovação")
 * seguem vetados.
 *
 * Diferença de propósito para a trava de dinheiro: aqui vale QUALQUER assunto da linha
 * afirmável. A lista de assuntos de lá existe para o preço marcado por engano não liberar
 * valor; os fatos vetados eram de produto e de garantia, que aquela lista deixa de fora. O
 * valor em dinheiro dentro do texto continua com a trava de dinheiro, que tem a lista dela.
 *
 * O classificador aqui é um dublê determinístico, sem modelo e sem rede: acha a palavra de
 * promessa e devolve o trecho dela, como o auxiliar devolve `suspectPhrase`. Textos
 * fictícios, na forma dos reais (regra do C01.md: nada da C01 no código).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { semanticPromiseGate } from "@/lib/agent-engine/guardrails/before-send";
import { textosAfirmaveisNoResultado } from "@/lib/agent-engine/guardrails/texto-afirmavel";

const CAMINHO_DA_PROMESSA = "@/lib/agent-engine/guardrails/promessa-e-texto-afirmavel";

// As linhas da base, como a view de fatos as devolve.
const ACESSO =
  "No Plano Completo, o acesso vale até você passar e não expira... então, se não passar na próxima prova, " +
  "você continua com o curso.";
const GARANTIA = "Você tem 7 dias de garantia: se cancelar nesse prazo, recebe o valor integral de volta.";
const ACESSO_CURTO = "O acesso vale até você passar e não expira.";

const fato = (texto: string, podeAfirmar: unknown = true, assunto: unknown = "produto") => ({
  chave: "fato_exemplo",
  assunto,
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
  pode_afirmar: true,
  condicao: "Essa condição está aberta até 31/10.",
};

type Classificacao = { isPromise: boolean; suspectPhrase: string | null };
type Veredito = { pass: boolean; code?: string; reason?: string };
type Colunas = { texto: string; podeAfirmar: string; assunto: string };
type Modulo = {
  classificarPromessaComTextoAfirmavel: (
    body: string,
    afirmaveis: readonly string[],
    classificar: (texto: string) => Promise<Classificacao>,
  ) => Promise<Classificacao>;
  textosAfirmaveisDaPromessaNoResultado: (r: unknown, colunas?: Colunas, achados?: Set<string>) => Set<string>;
};
async function modulo(): Promise<Modulo> {
  return (await import(/* @vite-ignore */ CAMINHO_DA_PROMESSA)) as Modulo;
}

/**
 * O dublê do classificador: promessa é a primeira palavra da lista; a frase suspeita vai
 * dela até a próxima pontuação (`trecho`), ou vem nula, ou vem com palavras que não estão
 * na mensagem (`parafraseada`), como o modelo às vezes devolve.
 */
const PALAVRA_DE_PROMESSA = /n[aã]o expira|garant\w*|mantenho|devolv\w*|de gra[cç]a/i;
function duble(frase: "trecho" | "nula" | "parafraseada" = "trecho") {
  const textos: string[] = [];
  const classificar = async (texto: string): Promise<Classificacao> => {
    textos.push(texto);
    const m = PALAVRA_DE_PROMESSA.exec(texto);
    if (m === null) return { isPromise: false, suspectPhrase: null };
    const trecho = texto.slice(m.index).split(/[.!?,;…]/)[0]!.trim();
    return {
      isPromise: true,
      suspectPhrase: frase === "nula" ? null : frase === "parafraseada" ? "promete uma vantagem" : trecho,
    };
  };
  return { classificar, textos };
}

/** A trava com os textos afirmáveis que as consultas `resultados` trouxeram neste turno. */
async function avaliar(
  body: string,
  resultados: unknown[] = [],
  frase: "trecho" | "nula" | "parafraseada" = "trecho",
) {
  const m = await modulo();
  const afirmaveis = new Set<string>();
  for (const r of resultados) m.textosAfirmaveisDaPromessaNoResultado(r, undefined, afirmaveis);
  const d = duble(frase);
  const classificacao = await m.classificarPromessaComTextoAfirmavel(body, [...afirmaveis], d.classificar);
  const veredito = semanticPromiseGate.evaluate({ semanticPromise: classificacao } as never) as Veredito;
  return { classificacao, veredito, lidos: d.textos };
}

describe("(C01, CRM-089 D4) os textos afirmáveis que valem para a trava de promessa", () => {
  it("qualquer assunto, mas só a linha com o texto e a marca de afirmar estritamente verdadeira", async () => {
    const { textosAfirmaveisDaPromessaNoResultado } = await modulo();
    const SEM_ASSUNTO = "O curso tem aulas gravadas.";
    const r = consulta([
      fato(ACESSO),
      fato(GARANTIA, true, "garantia"),
      { texto_para_o_lead: SEM_ASSUNTO, pode_afirmar: true },
      fato("Mantenho a condição até sexta.", false),
      fato("Garanto a aprovação.", "true"),
      fato("Te dou um bônus.", null),
      fato("   "),
      OFERTA,
    ]);
    expect([...textosAfirmaveisDaPromessaNoResultado(r)]).toEqual([ACESSO, GARANTIA, SEM_ASSUNTO]);
    // Pelo JSON do `content` também (o MCP entrega os dois).
    expect([...textosAfirmaveisDaPromessaNoResultado({ content: r.content })]).toEqual([ACESSO, GARANTIA, SEM_ASSUNTO]);
  });

  it("a lista de assuntos da trava de dinheiro não muda: produto e garantia seguem fora dela", () => {
    const r = consulta([fato(ACESSO, true, "produto"), fato(GARANTIA, true, "garantia")]);
    expect([...textosAfirmaveisNoResultado(r)]).toEqual([]);
  });

  it("as colunas são as da configuração da organização", async () => {
    const { textosAfirmaveisDaPromessaNoResultado } = await modulo();
    const r = consulta([{ frase: ACESSO, afirmar: true, tema: "produto" }, fato(GARANTIA)]);
    const colunas = { texto: "frase", podeAfirmar: "afirmar", assunto: "tema" };
    expect([...textosAfirmaveisDaPromessaNoResultado(r, colunas)]).toEqual([ACESSO]);
  });
});

describe("(C01, CRM-089 D4) a trava semântica de promessa com o texto afirmável da base", () => {
  it("o texto exato da base passa, sem gastar o classificador; sem consulta no turno, é vetado", async () => {
    for (const [texto, assunto] of [
      [ACESSO, "produto"],
      [GARANTIA, "garantia"],
    ] as const) {
      const sem = await avaliar(texto);
      expect(sem.veredito.pass, texto).toBe(false);
      expect(sem.veredito.code).toBe("promise_semantic");
      const com = await avaliar(texto, [consulta([fato(texto, true, assunto)])]);
      expect(com.veredito.pass, texto).toBe(true);
      expect(com.classificacao).toEqual({ isPromise: false, suspectPhrase: null });
      expect(com.lidos).toEqual([]);
    }
  });

  it("com outras frases antes e depois, passa; o classificador lê a mensagem inteira e depois só o resto", async () => {
    const body = `Entendo! ${ACESSO} Quer que eu te mande a página?`;
    const v = await avaliar(body, [consulta([fato(ACESSO)])]);
    expect(v.veredito.pass).toBe(true);
    expect(v.lidos).toHaveLength(2);
    expect(v.lidos[0]).toBe(body);
    expect(v.lidos[1]).not.toMatch(/expira/);
    expect(v.lidos[1]).toMatch(/entendo!/);
    expect(v.lidos[1]).toMatch(/quer que eu te mande a pagina\?/);
  });

  it("a primeira frase da base, inteira, passa; maiúscula, acento, formatação e emoji não contam", async () => {
    const base = [consulta([fato(ACESSO), fato(GARANTIA, true, "garantia")])];
    for (const body of [
      "No Plano Completo, o acesso vale até você passar e não expira.",
      "NO PLANO COMPLETO, O ACESSO VALE ATE VOCE PASSAR E NAO EXPIRA!",
      `*${GARANTIA}* 🙂`,
    ]) {
      const v = await avaliar(body, base);
      expect(v.veredito.pass, body).toBe(true);
      expect(v.lidos, body).toEqual([]);
    }
  });

  it("sem trecho da base na mensagem, o classificador lê a mensagem inteira, uma vez, como antes", async () => {
    const v = await avaliar("Quer o link da página?", [consulta([fato(ACESSO_CURTO)])]);
    expect(v.veredito.pass).toBe(true);
    expect(v.lidos).toEqual(["Quer o link da página?"]);
  });

  it.each([
    "Mantenho essa condição até sexta.",
    "Te dou o material de graça.",
    "Garanto que você passa na prova.",
  ])("a promessa inventada é vetada, mesmo com o texto da base no turno: %s", async (body) => {
    const v = await avaliar(body, [consulta([fato(ACESSO), fato(GARANTIA, true, "garantia")])]);
    expect(v.veredito.pass, body).toBe(false);
    expect(v.veredito.code).toBe("promise_semantic");
    // Sem trecho da base na mensagem, o classificador lê a mensagem inteira, como antes.
    expect(v.lidos).toEqual([body]);
  });

  it.each(["trecho", "nula", "parafraseada"] as const)(
    "o texto da base mais uma promessa inventada noutra frase é vetado (frase suspeita %s)",
    async (frase) => {
      const body = `${ACESSO} E mantenho essa condição até sexta.`;
      const v = await avaliar(body, [consulta([fato(ACESSO)])], frase);
      expect(v.veredito.pass).toBe(false);
      expect(v.veredito.code).toBe("promise_semantic");
      // O classificador apontou o trecho da base (ou nada localizável); o resto é relido e veta.
      expect(v.lidos).toHaveLength(2);
      expect(v.lidos[1]).toMatch(/mantenho essa condicao ate sexta/);
      expect(v.lidos[1]).not.toMatch(/expira/);
      if (frase === "trecho") expect(v.classificacao.suspectPhrase).toMatch(/mantenho/);
    },
  );

  it("o texto da base com acréscimo que muda o sentido é vetado", async () => {
    // A frase da base estendida não é a frase da base: nada é aprovado e a mensagem
    // inteira vai ao classificador.
    const estendida = "No Plano Completo, o acesso vale até você passar e não expira nunca, e ainda garanto a aprovação.";
    const a = await avaliar(estendida, [consulta([fato(ACESSO)])]);
    expect(a.veredito.pass).toBe(false);
    expect(a.lidos).toEqual([estendida]);

    // Base de uma frase só, inteira dentro da frase maior: o trecho aprovado acaba em
    // "não expira"; a frase suspeita que passa da borda ("não expira nunca") veta direto.
    const curta = "O acesso vale até você passar e não expira nunca, e ainda garanto a aprovação.";
    const b = await avaliar(curta, [consulta([fato(ACESSO_CURTO)])]);
    expect(b.veredito.pass).toBe(false);
    expect(b.classificacao.suspectPhrase).toBe("não expira nunca");
    expect(b.lidos).toEqual([curta]);

    // Frase suspeita nula: o resto (" nunca, e ainda garanto a aprovação.") é relido e veta.
    const c = await avaliar(curta, [consulta([fato(ACESSO_CURTO)])], "nula");
    expect(c.veredito.pass).toBe(false);
    expect(c.lidos).toHaveLength(2);
    expect(c.lidos[1]).toMatch(/garanto a aprovacao/);

    const d = await avaliar("O acesso vale até você passar e não expira, e devolvo seu dinheiro se reprovar.", [
      consulta([fato(ACESSO_CURTO)]),
    ]);
    expect(d.veredito.pass).toBe(false);
  });

  it("a paráfrase e a frase pela metade são vetadas", async () => {
    const base = [consulta([fato(ACESSO)])];
    for (const body of [
      "O acesso não expira enquanto você não passar.",
      "O acesso vale até você passar e não expira.",
      "No Plano Completo o acesso não expira.",
    ]) {
      const v = await avaliar(body, base);
      expect(v.veredito.pass, body).toBe(false);
      expect(v.lidos, body).toEqual([body]);
    }
  });

  it("linha com a marca de afirmar falsa, nula ou em texto não libera; oferta sem a coluna do texto também não", async () => {
    for (const marca of [false, null, "true", 1]) {
      const v = await avaliar(ACESSO, [consulta([fato(ACESSO, marca)])]);
      expect(v.veredito.pass, String(marca)).toBe(false);
    }
    const v = await avaliar("Essa condição está aberta até 31/10, e mantenho até sexta.", [consulta([OFERTA])]);
    expect(v.veredito.pass).toBe(false);
  });

  it("a frase suspeita que não está na mensagem faz reler o resto: resto limpo passa", async () => {
    const v = await avaliar(`${ACESSO} Quer o link?`, [consulta([fato(ACESSO)])], "parafraseada");
    expect(v.veredito.pass).toBe(true);
    expect(v.lidos).toHaveLength(2);
    expect(v.lidos[1]).toBe("quer o link?");
  });
});

describe("(C01, CRM-089 D4) a ligação no turno, pelo código", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("o classificador do turno passa pela exceção, com os textos afirmáveis da promessa deste turno", () => {
    const i = TURNO.indexOf("const semanticClassifier = camadaLigada(");
    expect(i).toBeGreaterThan(-1);
    const bloco = TURNO.slice(i, TURNO.indexOf(": undefined;", i));
    expect(bloco).toMatch(
      /\(candidate: string\) =>\s*classificarPromessaComTextoAfirmavel\(\s*candidate,\s*\[\.\.\.textosAfirmaveisDaPromessa\],\s*\(texto: string\) =>\s*classifyPromise\(/,
    );
    expect(bloco).toMatch(/candidate: texto,/);
    // O conjunto é do turno (closure), declarado antes do classificador.
    expect(TURNO.match(/const textosAfirmaveisDaPromessa = new Set<string>\(\);/g)).toHaveLength(1);
    expect(TURNO.indexOf("const textosAfirmaveisDaPromessa")).toBeLessThan(i);
  });

  it("só a consulta sem erro à base externa alimenta os textos da promessa, e só com a camada ligada", () => {
    expect(TURNO.match(/textosAfirmaveisDaPromessaNoResultado\(/g)).toHaveLength(1);
    const i = TURNO.indexOf("textosAfirmaveisDaPromessaNoResultado(");
    const antes = TURNO.slice(TURNO.lastIndexOf("name === FERRAMENTA_DA_BASE", i), i);
    expect(antes).toMatch(/if \(semanticClassifier !== undefined && !resultadoComErro\(resultado\)\) \{\s*$/);
    const chamada = TURNO.slice(i, TURNO.indexOf(");", i));
    expect(chamada).toMatch(/resultado,\s*travasDaOrg\.travas\.colunasDoTextoAfirmavel,\s*textosAfirmaveisDaPromessa,?\s*$/);
    // A coleta da trava de dinheiro segue igual, com a lista de assuntos dela.
    expect(TURNO).toMatch(/if \(travasDaOrg\.travas\.valorEmDinheiro && !resultadoComErro\(resultado\)\) \{/);
  });
});
