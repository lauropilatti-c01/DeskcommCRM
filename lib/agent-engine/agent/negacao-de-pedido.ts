/**
 * (C01) PEDIDO NEGADO LOGO ANTES — "não quero falar com atendente" não é pedido.
 *
 * As duas detecções de pedido de humano (os padrões fixos de `human-handoff.ts`
 * e as palavras configuradas de `matchesHandoffKeyword`) casam o TRECHO que pede
 * ("falar com atendente") sem olhar o que vem antes. Uma negação de vontade logo
 * antes inverte o sentido, e o lead que disse que NÃO quer falar com uma pessoa
 * era transferido para uma.
 *
 * A regra é estreita de propósito: só negação + verbo de VONTADE ("não quero",
 * "nem preciso", "nunca gostaria"), na mesma oração (sem pontuação no meio) e
 * perto (≤ 24 caracteres). "não consigo falar com atendente" NÃO é negação de
 * vontade — é pedido de ajuda — e continua transferindo. Módulo sem imports:
 * `agent-config.ts` e `human-handoff.ts` o usam sem criar ciclo.
 */

/** Janela, em caracteres, antes do pedido em que a negação ainda o alcança. */
export const JANELA_DA_NEGACAO = 24;

const RE_NEGACAO_DE_VONTADE =
  /\b(?:nao|nem|nunca|jamais)\b(?:\s+\w+)?\s+(?:quero|queria|quer|queremos|preciso|precisa|precisava|precisamos|gostaria|gostava|vou|vamos|desejo|desejava|pretendo|pretendia)\b[^,.;:!?\n]*$/;

/** Minúsculas sem diacríticos — a mesma visão que as duas detecções usam. */
export function normalizarParaPedido(texto: string): string {
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '');
}

/**
 * True se, no texto JÁ normalizado, o trecho que começa em `indice` vem logo
 * depois de uma negação de vontade na mesma oração.
 */
export function negadoLogoAntes(textoNormalizado: string, indice: number): boolean {
  if (indice <= 0) return false;
  const antes = textoNormalizado.slice(0, indice);
  const inicioDaOracao = Math.max(
    antes.lastIndexOf(','),
    antes.lastIndexOf('.'),
    antes.lastIndexOf(';'),
    antes.lastIndexOf(':'),
    antes.lastIndexOf('!'),
    antes.lastIndexOf('?'),
    antes.lastIndexOf('\n'),
  );
  const oracao = antes.slice(inicioDaOracao + 1);
  const janela = oracao.slice(-JANELA_DA_NEGACAO);
  return RE_NEGACAO_DE_VONTADE.test(janela);
}
