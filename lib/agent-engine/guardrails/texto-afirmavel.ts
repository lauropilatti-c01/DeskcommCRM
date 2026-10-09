/**
 * (C01, -c01.8) O TEXTO AFIRMÁVEL DA BASE: O NÚMERO QUE A BASE MANDA DIZER PODE SAIR.
 *
 * A regra (CRM-085 da C01, item 4): a trava `valor_em_dinheiro` barrava também o que a
 * própria base manda dizer — o salário do cargo com o valor exato, o cupom de desconto
 * aprovado, a frase de apresentação com "mais de 2 mil" chamados. O preço do curso
 * continua barrado.
 *
 * O que a base manda dizer é a linha de uma consulta à base externa
 * (`crm_query_external_data`) com um texto pronto para o cliente, a marca de que pode
 * ser afirmado e um assunto da lista de PERMITIDOS — por padrão as colunas
 * `texto_para_o_lead`, `pode_afirmar` e `assunto`, e os assuntos de
 * `ASSUNTOS_PADRAO_DO_TEXTO_AFIRMAVEL`, que a organização troca em
 * `settings.travas_de_envio.valor_em_dinheiro.texto_afirmavel`. A lista falha fechada:
 * linha sem assunto, ou com assunto fora dela (um preço marcado como afirmável, por
 * engano), não libera nada. Linha sem as colunas (oferta, link) ou com a marca falsa
 * também não. A linha é reconhecida pela forma, não pelo nome da tabela.
 *
 * O que passa é a FRASE INTEIRA (`trechosAprovados`): a frase da mensagem que é igual a
 * uma frase do texto afirmável, ou o texto afirmável inteiro dentro da mensagem. A
 * comparação ignora maiúsculas, acentos, espaços (inclusive o não separável) e a
 * pontuação do fim da frase; nada mais. Duas palavras em volta do número não bastavam:
 * o salário liberava "O preço do curso é de R$ 7.412,35." (1ª revisão da -c01.8).
 */
import { linksNoTexto } from './link-permitido';

/** De onde vem o texto afirmável (configurável por organização). */
export interface ColunasDoTextoAfirmavel {
  texto: string;
  podeAfirmar: string;
  assunto: string;
  /** Os assuntos que liberam valor; a linha com outro assunto, ou sem assunto, não libera. */
  assuntos: readonly string[];
}

/**
 * Os assuntos que liberam valor por padrão: salário, edital e calendário do concurso,
 * apresentação e desconto. Preço, oferta e produto ficam de fora de propósito.
 */
export const ASSUNTOS_PADRAO_DO_TEXTO_AFIRMAVEL: readonly string[] = [
  'salario',
  'edital',
  'calendario',
  'apresentacao',
  'desconto',
];

export const COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL: Readonly<ColunasDoTextoAfirmavel> = {
  texto: 'texto_para_o_lead',
  podeAfirmar: 'pode_afirmar',
  assunto: 'assunto',
  assuntos: ASSUNTOS_PADRAO_DO_TEXTO_AFIRMAVEL,
};

/**
 * Os textos afirmáveis de um resultado de consulta, em profundidade: a linha é um
 * objeto com a coluna do texto (string), a de afirmar estritamente `true` e o assunto
 * (string) na lista de permitidos. String com JSON dentro (o resultado do MCP chega
 * assim, no `content` de texto) é lida como JSON.
 */
export function textosAfirmaveisNoResultado(
  valor: unknown,
  colunas: ColunasDoTextoAfirmavel = COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL,
  achados: Set<string> = new Set(),
  profundidade = 0,
): Set<string> {
  if (profundidade > 8 || valor === null || valor === undefined) return achados;
  if (typeof valor === 'string') {
    const aparado = valor.trim();
    if (/^[[{]/.test(aparado)) {
      try {
        textosAfirmaveisNoResultado(JSON.parse(aparado) as unknown, colunas, achados, profundidade + 1);
      } catch {
        // Texto que não é JSON: não é linha.
      }
    }
    return achados;
  }
  if (Array.isArray(valor)) {
    for (const item of valor) textosAfirmaveisNoResultado(item, colunas, achados, profundidade + 1);
    return achados;
  }
  if (typeof valor === 'object') {
    const linha = valor as Record<string, unknown>;
    const texto = linha[colunas.texto];
    const assunto = linha[colunas.assunto];
    if (
      typeof texto === 'string' &&
      texto.trim().length > 0 &&
      linha[colunas.podeAfirmar] === true &&
      typeof assunto === 'string' &&
      colunas.assuntos.includes(assunto)
    ) {
      achados.add(texto);
    }
    for (const item of Object.values(linha)) textosAfirmaveisNoResultado(item, colunas, achados, profundidade + 1);
  }
  return achados;
}

/** O texto como as travas de valor o leem: sem links, sem acento, minúsculo, espaço simples. */
export function textoParaConferir(texto: string): string {
  let t = texto;
  for (const link of linksNoTexto(texto)) t = t.split(link).join(' ');
  return t
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** A frase para comparar: sem os espaços das pontas e sem a pontuação do fim. */
function fraseParaComparar(frase: string): string {
  return frase.trim().replace(/[\s.!?;:,]+$/, '');
}

/** As frases de `t` (já em `textoParaConferir`), em posições: o fim é `.`, `!` ou `?` antes de espaço ou do fim. */
export function frasesDoTexto(t: string): Array<[number, number]> {
  const frases: Array<[number, number]> = [];
  const fim = /[.!?]+(?= |$)/g;
  let ini = 0;
  let f: RegExpExecArray | null;
  while ((f = fim.exec(t)) !== null) {
    const ate = f.index + f[0].length;
    frases.push([ini, ate]);
    ini = ate;
  }
  if (ini < t.length) frases.push([ini, t.length]);
  return frases.filter(([a, b]) => t.slice(a, b).trim().length > 0);
}

/**
 * Os pedaços de `t` (já em `textoParaConferir`) que vieram da base: a frase igual a uma
 * frase de um texto afirmável, ou o texto afirmável inteiro (entre limites de palavra).
 * Devolve as posições em `t`; quem chama ignora o valor que cai inteiro dentro de um
 * deles e confere todo o resto do texto original, com o contexto inteiro.
 */
export function trechosAprovados(t: string, afirmaveis: Iterable<string>): Array<[number, number]> {
  const aprovados: Array<[number, number]> = [];
  const frasesDaBase = new Set<string>();
  const inteiros: string[] = [];
  for (const afirmavel of afirmaveis) {
    const a = textoParaConferir(afirmavel);
    for (const [ini, fim] of frasesDoTexto(a)) {
      const frase = fraseParaComparar(a.slice(ini, fim));
      if (frase.length > 0) frasesDaBase.add(frase);
    }
    const inteiro = fraseParaComparar(a);
    if (inteiro.length > 0) inteiros.push(inteiro);
  }
  if (frasesDaBase.size === 0) return aprovados;
  for (const [ini, fim] of frasesDoTexto(t)) {
    if (frasesDaBase.has(fraseParaComparar(t.slice(ini, fim)))) aprovados.push([ini, fim]);
  }
  const letraOuNumero = /[a-z0-9]/;
  for (const inteiro of inteiros) {
    for (let i = t.indexOf(inteiro); i !== -1; i = t.indexOf(inteiro, i + 1)) {
      const fim = i + inteiro.length;
      if (i > 0 && letraOuNumero.test(t[i - 1]!)) continue;
      if (fim < t.length && letraOuNumero.test(t[fim]!)) continue;
      aprovados.push([i, fim]);
    }
  }
  // A frase igual e o texto inteiro podem ser o mesmo pedaço: um só, sem sobreposição.
  aprovados.sort((x, y) => x[0] - y[0]);
  const juntos: Array<[number, number]> = [];
  for (const [ini, fim] of aprovados) {
    const ultimo = juntos[juntos.length - 1];
    if (ultimo !== undefined && ini <= ultimo[1]) ultimo[1] = Math.max(ultimo[1], fim);
    else juntos.push([ini, fim]);
  }
  return juntos;
}
