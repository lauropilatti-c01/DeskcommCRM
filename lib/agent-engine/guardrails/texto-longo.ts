/**
 * (C01, -c01.3, item 2) TRAVA "TEXTO LONGO": A RESPOSTA CABE NAS MENSAGENS DO TURNO.
 *
 * Com o divisor ligado, cada parágrafo vira uma mensagem e o que passa do teto de
 * mensagens do turno (`MAX_SENDS_PER_TURN`) vai emendado na última — que então passa
 * do `split_max_chars`. Com o teto por bolha baixo (300–350, o que o laboratório quer
 * agora que o divisor não parte link), a resposta comprida sairia com uma última bolha
 * enorme. A trava veta antes: a resposta viraria mais bolhas do que cabem no turno →
 * o modelo reescreve mais curto. Estilo, não conteúdo: no limite de vetos o turno a
 * desarma e a mensagem sai dividida como hoje (ver `TRAVAS_DE_ESTILO` em
 * `inbound-turn.ts`).
 *
 * Armada só pelo `send_message`, com a trava ligada em `organizations.settings` e o
 * divisor ligado (`travas-de-envio.ts`). Sem mensagem restante no turno não julga:
 * o teto de envios já recusa por outro caminho.
 */
import { splitIntoBubbles } from '../agent/split-message';
import type { Gate } from './before-send';

export const textoLongoGate: Gate = {
  name: 'texto_longo',
  evaluate: (ctx) => {
    const trava = ctx.travasDeEnvio?.textoLongo;
    if (trava === undefined || trava.restantes < 1) return { pass: true };
    const bolhas = splitIntoBubbles(ctx.body, trava.maxChars).length;
    if (bolhas <= trava.restantes) return { pass: true };
    return {
      pass: false,
      code: 'texto_longo',
      reason: renderVetoDeTextoLongo(bolhas, trava.restantes, trava.maxChars),
      // Só números: nunca o corpo (sem PII no trace).
      detail: { bolhas, restantes: trava.restantes, max_chars: trava.maxChars },
    };
  },
};

/** O erro de ensino: quanto passou e o que fazer. */
export function renderVetoDeTextoLongo(bolhas: number, restantes: number, maxChars: number): string {
  const cabem = restantes === 1 ? '1 mensagem' : `${restantes} mensagens`;
  return (
    `A mensagem NÃO foi enviada: ela viraria ${bolhas} mensagens no WhatsApp e neste turno só cabem ` +
    `${cabem} de até ${maxChars} caracteres. Reescreva mais curta, em no máximo ` +
    `${restantes === 1 ? 'um parágrafo curto' : `${restantes} parágrafos curtos`}, ` +
    'só com o essencial e sem mudar nenhum link.'
  );
}
