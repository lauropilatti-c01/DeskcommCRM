/**
 * (C01, -c01.14) TRAVA "MARCADOR ENTRE COLCHETES".
 *
 * O defeito (medido na C01, 14/10/2026): o modelo copiou do exemplo de formato das
 * instruções o marcador no lugar do link ("[link do vídeo]", "[link do teste]") e a
 * mensagem saiu assim para o cliente. A trava de link não pega: marcador não é link.
 *
 * Veta o texto do `send_message` com um trecho entre colchetes (até 80 caracteres, numa
 * linha), fora dos links. Também pega o link em markdown ("[aqui](https://…)"): o
 * WhatsApp não o mostra como link.
 *
 * Trava de CONTEÚDO (`TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE` em `inbound-turn.ts`): o
 * marcador nunca sai. 1º e 2º vetos ensinam; no 3º o turno passa à equipe.
 *
 * Liga por organização: `{ "travas_de_envio": { "marcador_entre_colchetes": { "ligada": true } } }`.
 */
import type { Gate } from './before-send';
import { linksNoTexto } from './link-permitido';

const MARCADOR = /\[[^[\]\n]{1,80}\]/g;

/** Os marcadores entre colchetes do texto, fora dos links. */
export function marcadoresNoTexto(texto: string): string[] {
  let t = texto;
  for (const link of linksNoTexto(texto)) t = t.split(link).join(' ');
  return t.match(MARCADOR) ?? [];
}

export const marcadorEntreColchetesGate: Gate = {
  name: 'marcador_entre_colchetes',
  evaluate: (ctx) => {
    if (ctx.travasDeEnvio?.marcadorEntreColchetes !== true) return { pass: true };
    const marcadores = marcadoresNoTexto(ctx.body);
    if (marcadores.length === 0) return { pass: true };
    return {
      pass: false,
      code: 'marcador_entre_colchetes',
      reason: renderVetoDeMarcador(marcadores[0]!),
      detail: { marcadores: marcadores.length },
    };
  },
};

/** O erro de ensino. */
export function renderVetoDeMarcador(marcador: string): string {
  return (
    `A mensagem NÃO foi enviada: ela tem um marcador entre colchetes (${marcador.slice(0, 82)}) no lugar do ` +
    'conteúdo. Na mensagem para o cliente não vai colchete: ponha o link ou o dado exato que a consulta devolveu, ' +
    'sozinho na linha, ou tire a frase.'
  );
}
