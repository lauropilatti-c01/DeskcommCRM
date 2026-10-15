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
 *
 * (C01, -c01.8, CRM-085 da C01: "1 bolha por resposta, até 700 caracteres") Com o divisor
 * DESLIGADO a trava também age (`semDivisor`): a mensagem que passa do limite
 * (`texto_longo.max_caracteres`, padrão 700) volta para ser reescrita numa mensagem só.
 * Conta caractere como o cliente vê (um emoji é um), com o link inteiro. A régua é a
 * mesma: estilo, no limite de vetos a mensagem sai inteira — nunca cortada, e o link
 * nunca sai partido.
 *
 * (C01, -c01.15) Com o divisor LIGADO, a conta de bolhas sozinha deixava passar a resposta
 * de 3 parágrafos de 340 caracteres (mais de mil no total), e o que passava do teto de
 * mensagens só era barrado se a trava estivesse armada — fora dela, o excedente saía
 * emendado na última bolha sem aviso. Agora, com `maxTotal` (o mesmo
 * `texto_longo.max_caracteres`, padrão 700), a trava barra também o TOTAL da resposta
 * (todas as bolhas somadas, contando os links como o cliente os vê), e o erro de ensino
 * dá os dois números de uma vez: até N parágrafos e até X caracteres no total.
 */
import { splitIntoBubbles } from '../agent/split-message';
import type { Gate, GateVerdict } from './before-send';

export const textoLongoGate: Gate = {
  name: 'texto_longo',
  evaluate: (ctx): GateVerdict => {
    const trava = ctx.travasDeEnvio?.textoLongo;
    if (trava === undefined || trava.restantes < 1) return { pass: true };
    if (trava.semDivisor === true) {
      const caracteres = [...ctx.body.trim()].length;
      if (caracteres <= trava.maxChars) return { pass: true };
      return {
        pass: false,
        code: 'texto_longo',
        reason: renderVetoDeMensagemLonga(caracteres, trava.maxChars),
        // Só números: nunca o corpo (sem PII no trace).
        detail: { caracteres, max_chars: trava.maxChars },
      };
    }
    const bolhas = splitIntoBubbles(ctx.body, trava.maxChars).length;
    if (trava.maxTotal !== undefined) {
      // (C01, -c01.15) O total conta como o cliente vê (um emoji é um), com o link inteiro.
      const caracteres = [...ctx.body.trim()].length;
      if (bolhas <= trava.restantes && caracteres <= trava.maxTotal) return { pass: true };
      return {
        pass: false,
        code: 'texto_longo',
        reason: renderVetoDeRespostaEmBolhas({
          bolhas,
          restantes: trava.restantes,
          maxChars: trava.maxChars,
          caracteres,
          maxTotal: trava.maxTotal,
        }),
        // Só números: nunca o corpo (sem PII no trace).
        detail: {
          bolhas,
          restantes: trava.restantes,
          max_chars: trava.maxChars,
          caracteres,
          max_total: trava.maxTotal,
        },
      };
    }
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

/**
 * (C01, -c01.15) O erro de ensino com o divisor ligado e o limite do total: o que passou
 * (bolhas a mais, caracteres a mais, ou os dois) e os dois limites de uma vez, para a
 * reescrita não trocar um veto pelo outro.
 */
export function renderVetoDeRespostaEmBolhas(conta: {
  bolhas: number;
  restantes: number;
  maxChars: number;
  caracteres: number;
  maxTotal: number;
}): string {
  const { bolhas, restantes, maxChars, caracteres, maxTotal } = conta;
  const motivos = [
    ...(bolhas > restantes
      ? [
          `ela viraria ${bolhas} mensagens no WhatsApp e neste turno só cabem ` +
            (restantes === 1 ? '1 mensagem' : `${restantes} mensagens`),
        ]
      : []),
    ...(caracteres > maxTotal
      ? [`ela tem ${caracteres} caracteres no total, contando os links, e o limite é ${maxTotal}`]
      : []),
  ];
  const paragrafos = restantes === 1 ? '1 parágrafo' : `${restantes} parágrafos`;
  return (
    `A mensagem NÃO foi enviada: ${motivos.join('; e ')}. ` +
    `Reescreva em até ${paragrafos} e até ${maxTotal} caracteres no total ` +
    `(cada parágrafo com até ${maxChars} caracteres, separados por uma linha em branco), ` +
    'numa chamada só de send_message, só com o essencial e sem mudar nenhum link.'
  );
}

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

/** (C01, -c01.8) O erro de ensino sem o divisor: quanto passou e o que fazer. */
export function renderVetoDeMensagemLonga(caracteres: number, maxChars: number): string {
  return (
    `A mensagem NÃO foi enviada: ela tem ${caracteres} caracteres, e cada resposta sai numa mensagem só ` +
    `de até ${maxChars} caracteres. Reescreva em até ${maxChars} caracteres, numa mensagem só, ` +
    'só com o essencial e sem mudar nenhum link.'
  );
}
