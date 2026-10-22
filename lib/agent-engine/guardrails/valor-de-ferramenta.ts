/**
 * (C01, -c01.7) OS VALORES EM DINHEIRO DA MENSAGEM E DE ONDE ELES PODEM TER VINDO.
 *
 * A regra (CRM-084 da C01, trazida da agente de cobrança): o texto do agente pede, o
 * programa garante — valor em reais só sai se veio de uma consulta neste turno ou se
 * já saiu numa mensagem nossa da conversa. O modelo arredondava, somava e inventava
 * ("salário de R$ 6.700" com a base dizendo R$ 6.638,64), e nada conferia.
 *
 * Este módulo é a parte pura da conferência: ler os valores da mensagem (só o que é
 * dinheiro: "R$ …" e "… reais"), ler os números de um resultado de ferramenta (de
 * forma larga: número JSON, "1997.00", "6.638,64" no meio de um texto) e ler os
 * valores das mensagens nossas já enviadas. Tudo em CENTAVOS, para "R$ 1.997",
 * "R$ 1.997,00", "R$1997" e "1997.00" serem o mesmo valor.
 *
 * A assimetria é de propósito: na mensagem, só conta o que é claramente dinheiro
 * ("12x", "60 metas", "67 dias" não são valor); no resultado, conta todo número,
 * porque o fato da base vem em texto livre ("salário inicial de R$ 6.638,64",
 * "6.638,64", `"preco": 1997`). Errar para o lado largo na fonte libera um valor que
 * existe na base; errar na mensagem vetaria texto que não fala de dinheiro.
 */
import { linksNoTexto } from './link-permitido';
import { SINAL, textoSemAcento, valoresEmReais } from './texto-afirmavel';

// Número em reais, nas formas que aparecem: milhar com ponto ("6.638,64", "1.997"),
// milhar com vírgula ("1,997.00"), sem milhar ("1997", "166,42", "1997.00"). A ordem
// das alternativas importa: a de milhar vem antes, para "1.997" não virar "1".
const NUMERO =
  '\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';
// (-c01.8, 3ª revisão) Na mensagem, o valor é lido por `valoresEmReais` (abaixo).
const MIL = '(\\s*mil\\b)?';
// Na FONTE, o número tem de estar solto: colado em letra, dígito, "_", ponto ou vírgula
// ("salario_6700", o pedaço "a1b2" de um id) ou ligado por hífen a outro pedaço (o UUID
// "…-4000-8000-…", a data "2026-10-07") não é valor. "6.638,64", "R$6.638,64", "1997.00"
// e o número de um JSON (`"preco":1997`) continuam valendo.
const SOLTO_ANTES = '(?<![\\p{L}\\p{N}_.,])(?<![\\p{L}\\p{N}]-)';
const SOLTO_DEPOIS = '(?![\\p{L}\\p{N}_]|[.,]\\d|-[\\p{L}\\p{N}])';
const RE_QUALQUER_NUMERO = new RegExp(`${SOLTO_ANTES}(${NUMERO})${SOLTO_DEPOIS}${MIL}`, 'giu');

/** O número escrito (em reais) → centavos. `null` quando não é um número. */
export function centavosDoNumero(escrito: string, vezesMil = false): number | null {
  const s = escrito.replace(/\s/g, '');
  let normal: string;
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(s)) normal = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(s)) normal = s.replace(/,/g, '');
  else if (/^\d+(?:[.,]\d{1,2})?$/.test(s)) normal = s.replace(',', '.');
  else return null;
  const reais = Number(normal);
  if (!Number.isFinite(reais)) return null;
  return Math.round(reais * (vezesMil ? 1000 : 1) * 100);
}

/** O texto sem os links: o número dentro de um endereço não é valor. */
function semLinks(texto: string): string {
  let t = texto;
  for (const link of linksNoTexto(texto)) t = t.split(link).join(' ');
  return t;
}

/**
 * (C01, -c01.8, 3ª revisão) Na MENSAGEM, o valor é a expressão monetária inteira, lida
 * como a trava do texto afirmável a lê (`valoresEmReais`): "R$ 5 e 50 centavos" e "5
 * reais e 50" valem 5,50; "R$ 5 000" (espaço comum, fino ou não separável) e "R$ 5
 * mil", 5.000. Antes o "R$ 5" de cada uma valia 5, e passava com a ferramenta dizendo
 * 5. A forma em dúvida não vira valor: é contada à parte (`emDuvida`) e a trava a barra
 * — o que ainda parece dinheiro fora das expressões lidas ("R$ 5,5", "R$ 5,000", "R$ 5
 * milhões", "R$ 5 k", "50 centavos") e a expressão seguida de "e" + número ou "meio"
 * ("R$ 5 e meio", "R$ 5 e 500 centavos").
 *
 * (4ª revisão, -c01.9) Também em dúvida: o sinal de menos ("R$ -997", "-R$ 5", "R$ −5",
 * "-5 reais"), a moeda crua antes ou depois do número ("BRL 5,5", "5,5 R$") e a
 * expressão seguida de "+", "mais", "menos" ou "-" com número ("R$ 5,00 + 50") ou de
 * centavos por extenso ("R$ 5 e cinquenta centavos").
 */
const AINDA_E_DINHEIRO = new RegExp(
  String.raw`(?:r\$|\bbrl) ?(?:${SINAL} ?)?\d` +
    String.raw`|\b\d[\d.,]*(?: ?(?:mil|milh\w*|bilh\w*|mi|bi|k))?(?: de)? ?(?:(?:reais|real|brl)\b|r\$)` +
    String.raw`|\b\d[\d.,]* ?centavos?\b`,
  'g',
);
const CONTINUA_O_VALOR = new RegExp(
  String.raw`^ ?(?:(?:e|mais|menos) |${SINAL} ?)(?:\d|meio\b|meia\b|(?:[a-z]+ ){1,4}centavos?\b)`,
);

/** Os valores em dinheiro da mensagem, em centavos e na ordem, e quantas formas ficaram em dúvida. */
export function lerValoresEmDinheiro(texto: string): { valores: number[]; emDuvida: number } {
  const t = textoSemAcento(texto);
  const valores: number[] = [];
  let emDuvida = 0;
  let fora = '';
  let i = 0;
  for (const { ini, fim, centavos } of valoresEmReais(t)) {
    if (CONTINUA_O_VALOR.test(t.slice(fim))) emDuvida++;
    else valores.push(centavos);
    fora += `${t.slice(i, ini)} | `;
    i = fim;
  }
  fora += t.slice(i);
  emDuvida += fora.match(AINDA_E_DINHEIRO)?.length ?? 0;
  return { valores, emDuvida };
}

/**
 * Os valores em dinheiro da mensagem, em centavos, na ordem: "R$ 1.997", "R$ 1.997,00",
 * "R$1997", "R$ 166,42", "R$ 6 mil", "1.997 reais", "R$ 5 e 50 centavos". Número sem "R$"
 * nem "reais" ("12x", "60 metas") não é dinheiro; a forma em dúvida fica de fora.
 */
export function valoresEmDinheiro(texto: string): number[] {
  return lerValoresEmDinheiro(texto).valores;
}

/** Todo número de um texto livre, em centavos (o "1.997" vale 1.997 reais). */
function numerosNoTexto(texto: string, achados: Set<number>): void {
  const t = semLinks(texto);
  RE_QUALQUER_NUMERO.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_QUALQUER_NUMERO.exec(t)) !== null) {
    const centavos = centavosDoNumero(m[1] ?? '', m[2] !== undefined);
    if (centavos !== null) achados.add(centavos);
    // "6 mil" também é o número 6: a base pode dizer "6 mil" e a mensagem, "R$ 6.000".
    if (m[2] !== undefined) {
      const sem = centavosDoNumero(m[1] ?? '');
      if (sem !== null) achados.add(sem);
    }
  }
  // (3ª revisão) E a expressão monetária inteira, como a mensagem é lida: "R$ 5 e 50
  // centavos" na fonte libera 5,50; "R$ 5 000", 5.000.
  for (const { centavos } of valoresEmReais(textoSemAcento(texto))) achados.add(centavos);
}

/** Chave que diz que o número já está em centavos (`preco_centavos`, `amount_cents`). */
const CHAVE_EM_CENTAVOS = /centavo|cents?\b|_cents|cents_/i;

/**
 * Todos os números de um resultado de ferramenta, em centavos, em profundidade: número
 * JSON (em reais; em centavos quando a chave diz), string que é número ("1997.00") e
 * número no meio de texto ("salário de R$ 6.638,64"). String com JSON dentro (o
 * resultado do MCP chega assim) é lida como JSON também.
 */
export function valoresNoResultado(
  valor: unknown,
  achados: Set<number> = new Set(),
  profundidade = 0,
  chave = '',
): Set<number> {
  if (profundidade > 8 || valor === null || valor === undefined) return achados;
  if (typeof valor === 'number') {
    if (Number.isFinite(valor)) {
      // (Revisão da junção da 1.86.0, achado 4) Chave em centavos com número inteiro:
      // SÓ em centavos. Antes valia também em reais, e `preco_centavos: 199700`
      // liberava "R$ 199.700" (100×) além de "R$ 1.997".
      if (CHAVE_EM_CENTAVOS.test(chave) && Number.isInteger(valor)) achados.add(valor);
      else achados.add(Math.round(valor * 100));
    }
    return achados;
  }
  if (typeof valor === 'string') {
    numerosNoTexto(valor, achados);
    const aparado = valor.trim();
    if (/^[[{]/.test(aparado)) {
      try {
        valoresNoResultado(JSON.parse(aparado) as unknown, achados, profundidade + 1, chave);
      } catch {
        // Não é JSON: o texto já foi lido acima.
      }
    }
    return achados;
  }
  if (Array.isArray(valor)) {
    for (const item of valor) valoresNoResultado(item, achados, profundidade + 1, chave);
    return achados;
  }
  if (typeof valor === 'object') {
    for (const [k, item] of Object.entries(valor as Record<string, unknown>)) {
      valoresNoResultado(item, achados, profundidade + 1, k);
    }
  }
  return achados;
}
