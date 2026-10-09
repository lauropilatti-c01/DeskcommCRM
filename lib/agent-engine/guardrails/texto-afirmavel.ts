/**
 * (C01, -c01.8) O TEXTO AFIRMÁVEL DA BASE: O NÚMERO QUE A BASE MANDA DIZER PODE SAIR.
 *
 * A regra (CRM-085 da C01, item 4): a trava `valor_em_dinheiro` barrava também o que a
 * própria base manda dizer — o salário do cargo com o valor exato, o cupom de desconto
 * aprovado, a frase de apresentação com "mais de 2 mil" chamados. O preço do curso
 * continua barrado.
 *
 * O que a base manda dizer é a linha de uma consulta à base externa
 * (`crm_query_external_data`) com um texto pronto para o cliente e a marca de que pode
 * ser afirmado — por padrão as colunas `texto_para_o_lead` e `pode_afirmar`, que a
 * organização troca em `settings.travas_de_envio.valor_em_dinheiro.texto_afirmavel`.
 * Linha sem as duas colunas (oferta, link, preço) ou com a marca falsa não conta. A
 * linha é reconhecida pela forma, não pelo nome da tabela.
 *
 * O que passa é o TRECHO EXATO: o número com as palavras em volta, como a base
 * escreveu (`trechosDaBase`). Só o número não basta — "10%" de uma frase de prova
 * social ("ficaram com 10% das vagas") não pode liberar "10% de desconto". A
 * comparação ignora maiúsculas, acentos, pontuação e espaços; o número vai junto com
 * o que o qualifica ("R$", "%", "mil", "reais", "x"), para "cupom de 5%" não liberar
 * "cupom de 5 reais".
 */
import { linksNoTexto } from './link-permitido';

/** As colunas que marcam a linha afirmável (configuráveis por organização). */
export interface ColunasDoTextoAfirmavel {
  texto: string;
  podeAfirmar: string;
}

export const COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL: Readonly<ColunasDoTextoAfirmavel> = {
  texto: 'texto_para_o_lead',
  podeAfirmar: 'pode_afirmar',
};

/**
 * Os textos afirmáveis de um resultado de consulta, em profundidade: a linha é um
 * objeto com a coluna do texto (string) e a de afirmar estritamente `true`. String com
 * JSON dentro (o resultado do MCP chega assim, no `content` de texto) é lida como JSON.
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
    if (typeof texto === 'string' && texto.trim().length > 0 && linha[colunas.podeAfirmar] === true) {
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

// Um número com o que o qualifica vira UMA palavra ("r$ 6.638,64" → "r$6.638,64",
// "5 %" e "5 por cento" → "5%", "2 mil" → "2mil", "18 x" → "18x"); o resto, palavra a
// palavra. Pontuação e símbolos soltos não contam.
const UNIDADE = '(?:%|por cento\\b|reais\\b|real\\b|euros?\\b|€|x\\b|vezes\\b)';
const PALAVRA = new RegExp(`(?:(?:r\\$|€)\\s?)?\\d+(?:[.,]\\d+)*(?:\\s?mil\\b)?(?:\\s?${UNIDADE})?|[a-z]+`, 'g');

interface Palavra {
  forma: string;
  ini: number;
  fim: number;
  numero: boolean;
}

function palavras(t: string): Palavra[] {
  const saida: Palavra[] = [];
  PALAVRA.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PALAVRA.exec(t)) !== null) {
    const numero = /\d/.test(m[0]);
    const forma = numero ? m[0].replace(/\s/g, '').replace('porcento', '%') : m[0];
    saida.push({ forma, ini: m.index, fim: m.index + m[0].length, numero });
  }
  return saida;
}

/** Quantas palavras (não números) o trecho exato precisa ter em volta do número. */
export const PALAVRAS_EM_VOLTA = 2;

/**
 * Os pedaços de `t` (já em `textoParaConferir`) que são trecho exato de um texto
 * afirmável: a maior sequência de palavras igual nos dois, com pelo menos um número e
 * `PALAVRAS_EM_VOLTA` palavras. Devolve as posições em `t`, para quem chama as apagar
 * antes de procurar dinheiro.
 */
export function trechosDaBase(t: string, afirmaveis: Iterable<string>): Array<[number, number]> {
  const msg = palavras(t);
  const trechos: Array<[number, number]> = [];
  if (!msg.some((p) => p.numero)) return trechos;
  for (const afirmavel of afirmaveis) {
    const base = palavras(textoParaConferir(afirmavel));
    for (let i = 0; i < msg.length; i++) {
      for (let j = 0; j < base.length; j++) {
        // Só o começo de cada sequência igual (a maior): o meio já foi visto nela.
        if (msg[i]!.forma !== base[j]!.forma) continue;
        if (i > 0 && j > 0 && msg[i - 1]!.forma === base[j - 1]!.forma) continue;
        let n = 1;
        while (i + n < msg.length && j + n < base.length && msg[i + n]!.forma === base[j + n]!.forma) n++;
        const seq = msg.slice(i, i + n);
        if (seq.some((p) => p.numero) && seq.filter((p) => !p.numero).length >= PALAVRAS_EM_VOLTA) {
          trechos.push([seq[0]!.ini, seq[seq.length - 1]!.fim]);
        }
      }
    }
  }
  return trechos;
}

/** `t` com os trechos exatos da base trocados por espaço (o mesmo tamanho). */
export function semOsTrechosDaBase(t: string, afirmaveis: Iterable<string>): { texto: string; apagou: boolean } {
  const trechos = trechosDaBase(t, afirmaveis);
  if (trechos.length === 0) return { texto: t, apagou: false };
  // As posições do regex são em unidades UTF-16: troca unidade a unidade.
  const unidades = t.split('');
  for (const [ini, fim] of trechos) for (let k = ini; k < fim; k++) unidades[k] = ' ';
  return { texto: unidades.join(''), apagou: true };
}
