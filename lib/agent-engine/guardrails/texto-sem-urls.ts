import { trechosDeLink } from './link-permitido';

/** Usa o mesmo reconhecedor da trava de links; não exclui e-mails nem rótulos. */
export function textoSemUrls(texto: string): string {
  let inicio = 0;
  const partes: string[] = [];
  for (const trecho of trechosDeLink(texto)) {
    partes.push(texto.slice(inicio, trecho.ini));
    inicio = trecho.fim;
  }
  partes.push(texto.slice(inicio));
  return partes.join('');
}

/** Pontos de código, como a régua vigente; não bytes nem unidades UTF-16. */
export function caracteresSemUrls(texto: string): number {
  return [...textoSemUrls(texto).trim()].length;
}
