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

// Número em reais, nas formas que aparecem: milhar com ponto ("6.638,64", "1.997"),
// milhar com vírgula ("1,997.00"), sem milhar ("1997", "166,42", "1997.00"). A ordem
// das alternativas importa: a de milhar vem antes, para "1.997" não virar "1".
const NUMERO =
  '\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';
// Não começa nem termina no meio de outro número ("1997.001" não vira "1997.00").
const NUMERO_INTEIRO = `(?<![\\d.,])(${NUMERO})(?![\\d]|[.,]\\d)`;
const MIL = '(\\s*mil\\b)?';
const RE_COM_CIFRAO = new RegExp(`R\\$\\s*${NUMERO_INTEIRO}${MIL}`, 'gi');
const RE_COM_REAIS = new RegExp(`${NUMERO_INTEIRO}${MIL}\\s*(?:reais|real)\\b`, 'gi');
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
 * Os valores em dinheiro da mensagem, em centavos, na ordem: "R$ 1.997", "R$ 1.997,00",
 * "R$1997", "R$ 166,42", "R$ 6 mil", "1.997 reais". Número sem "R$" nem "reais"
 * ("12x", "60 metas") não é dinheiro.
 */
export function valoresEmDinheiro(texto: string): number[] {
  const t = semLinks(texto);
  const achados: Array<{ ini: number; centavos: number }> = [];
  for (const re of [RE_COM_CIFRAO, RE_COM_REAIS]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      // O lugar do NÚMERO (não do "R$"): "R$ 10 reais" casa nas duas formas e conta uma vez.
      const ini = m.index + m[0].indexOf(m[1] ?? '');
      if (achados.some((a) => a.ini === ini)) continue;
      const centavos = centavosDoNumero(m[1] ?? '', m[2] !== undefined);
      if (centavos !== null) achados.push({ ini, centavos });
    }
  }
  return achados.sort((a, b) => a.ini - b.ini).map((a) => a.centavos);
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
      achados.add(Math.round(valor * 100));
      if (CHAVE_EM_CENTAVOS.test(chave) && Number.isInteger(valor)) achados.add(valor);
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
