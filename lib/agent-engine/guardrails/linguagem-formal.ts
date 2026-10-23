import type { Gate, GateVerdict } from './before-send';
import { textoSemUrls } from './texto-sem-urls';

/** CRM-089 e CRM-108: lista literal; não amplia para sinônimos ou flexões. */
const EXPRESSOES = [
  'gostaria',
  'veja',
  'trabalhar a constância',
  'cujo',
  'mediante',
  'ademais',
  'o qual',
  'selecione',
] as const;

const padrao = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${EXPRESSOES.map((s) => s.replaceAll(' ', '\\s+')).join('|')})(?![\\p{L}\\p{N}_])`,
  'giu',
);

/** Estilo opcional: o turno desarma após dois vetos e mantém os bloqueios de conteúdo. */
export const linguagemFormalGate: Gate = {
  name: 'linguagem_formal',
  evaluate: (ctx): GateVerdict => {
    if (ctx.travasDeEnvio?.linguagemFormal !== true) return { pass: true };
    const expressoes = [...textoSemUrls(ctx.body).normalize('NFC').matchAll(padrao)].length;
    if (expressoes === 0) return { pass: true };
    return {
      pass: false,
      code: 'linguagem_formal',
      reason:
        'A mensagem NÃO foi enviada: contém linguagem formal ou de manual. ' +
        `Reescreva sem estas expressões: ${EXPRESSOES.join(', ')}. ` +
        'Responda ao pedido da pessoa com palavras simples, sem mudar fatos, valores ou links e sem acrescentar oferta ou pergunta.',
      // Só a quantidade, nunca o corpo nem o trecho encontrado.
      detail: { expressoes },
    };
  },
};
