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
import { aplicarTetoAsNovas, splitForSend, splitIntoBubbles } from '../agent/split-message';
import type { Gate, GateVerdict } from './before-send';
import { trechosDeLink } from './link-permitido';

/**
 * (C01, -c01.15, 2ª rodada) A SAÍDA REAL do divisor para o corpo: as mensagens físicas que
 * o envio mandaria, pelas MESMAS funções do `sendInBubbles` (`splitForSend` e o teto do
 * turno de `aplicarTetoAsNovas`), e não a conta de parágrafos — o `split_max_chars` parte
 * o parágrafo longo em mais de uma mensagem, e o teto emenda o excedente na última.
 *
 * - `naturais`: as mensagens do divisor antes do teto; `fisicas`: as que sairiam;
 *   `emendou`: o teto juntou mensagens na última (a saída que a trava não deixa passar);
 * - `paragrafos`: os blocos separados por linha em branco (para o erro de ensino dizer
 *   quando é o parágrafo longo que vira duas mensagens);
 * - `linksPartidos`: links do corpo (o reconhecedor da trava `link_permitido`) que não
 *   saem inteiros numa mensagem só. O divisor não parte link (`trechosIndivisiveis`); a
 *   conferência é a rede, sobre o que sairia.
 *
 * Na re-execução do job as mensagens que o ledger já conhece não gastam o teto
 * (`jaRegistrada` no envio); aqui todas contam: a trava, síncrona, não lê o ledger, e
 * fica do lado mais estrito.
 */
export function saidaEmBolhas(
  body: string,
  maxChars: number,
  restantes: number,
): {
  naturais: number;
  fisicas: string[];
  emendou: boolean;
  paragrafos: number;
  linksPartidos: number;
} {
  const naturais = splitForSend(body, true, maxChars);
  const fisicas = aplicarTetoAsNovas(
    naturais,
    naturais.map(() => false),
    Math.max(1, restantes),
  );
  const paragrafos = body
    .trim()
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== '').length;
  const linksPartidos = trechosDeLink(body)
    .map((t) => body.slice(t.ini, t.fim))
    .filter((link) => !fisicas.some((bolha) => bolha.includes(link))).length;
  return { naturais: naturais.length, fisicas, emendou: fisicas.length < naturais.length, paragrafos, linksPartidos };
}

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
    if (trava.maxTotal !== undefined) {
      // (C01, -c01.15) A saída real: as mensagens físicas do divisor (com o parágrafo longo
      // partido), sem emenda do teto, todas no turno, o total como o cliente vê (um emoji é
      // um, o link inteiro) e cada link inteiro numa mensagem.
      const saida = saidaEmBolhas(ctx.body, trava.maxChars, trava.restantes);
      const bolhas = saida.naturais;
      const caracteres = [...ctx.body.trim()].length;
      if (!saida.emendou && bolhas <= trava.restantes && caracteres <= trava.maxTotal && saida.linksPartidos === 0) {
        return { pass: true };
      }
      return {
        pass: false,
        code: 'texto_longo',
        reason: renderVetoDeRespostaEmBolhas({
          bolhas,
          restantes: trava.restantes,
          maxChars: trava.maxChars,
          caracteres,
          maxTotal: trava.maxTotal,
          paragrafos: saida.paragrafos,
          linksPartidos: saida.linksPartidos,
        }),
        // Só números: nunca o corpo (sem PII no trace).
        detail: {
          bolhas,
          restantes: trava.restantes,
          max_chars: trava.maxChars,
          caracteres,
          max_total: trava.maxTotal,
          ...(saida.paragrafos !== bolhas ? { paragrafos: saida.paragrafos } : {}),
          ...(saida.linksPartidos > 0 ? { links_partidos: saida.linksPartidos } : {}),
        },
      };
    }
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
  paragrafos?: number;
  linksPartidos?: number;
}): string {
  const { bolhas, restantes, maxChars, caracteres, maxTotal } = conta;
  const paragrafosDoCorpo = conta.paragrafos ?? bolhas;
  const motivos = [
    ...(bolhas > restantes
      ? [
          `ela viraria ${bolhas} mensagens no WhatsApp e neste turno só cabem ` +
            (restantes === 1 ? '1 mensagem' : `${restantes} mensagens`) +
            // O parágrafo longo é partido pelo sistema: dizer, para a reescrita não só juntar parágrafos.
            (bolhas > paragrafosDoCorpo
              ? ` (parágrafo com mais de ${maxChars} caracteres é partido em mais de uma mensagem)`
              : ''),
        ]
      : []),
    ...(caracteres > maxTotal
      ? [`ela tem ${caracteres} caracteres no total, contando os links, e o limite é ${maxTotal}`]
      : []),
    ...((conta.linksPartidos ?? 0) > 0 ? ['um link sairia partido entre mensagens'] : []),
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
