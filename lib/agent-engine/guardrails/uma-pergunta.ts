/**
 * (C01, -c01.3, item 3c) TRAVA "UMA PERGUNTA POR MENSAGEM".
 *
 * A regra da C01 (`docs/comercial/02`): uma pergunta por mensagem, para a pessoa saber
 * o que responder. Só o texto pedia isso, e o modelo fechava a mensagem com duas ou três
 * perguntas — e a pessoa respondia uma só.
 *
 * Conta os "?" do texto inteiro do `send_message` (uma sequência "??" vale uma), fora
 * dos links (o "?" de `?nivel=` não é pergunta). Acima de 1, veta com erro de ensino.
 * Pergunta retórica conta: "Sabe o melhor? …" é uma pergunta na tela da pessoa.
 *
 * Trava de ESTILO: 1º veto ensina; no 2º se desarma no turno e a mensagem passa como
 * está (`TRAVAS_DE_ESTILO` em `inbound-turn.ts`).
 */
import type { Gate } from './before-send';
import { linksNoTexto } from './link-permitido';

/** Quantas perguntas o texto faz: grupos de "?" fora dos links. */
export function contarPerguntas(texto: string): number {
  let t = texto;
  for (const link of linksNoTexto(texto)) t = t.split(link).join(' ');
  return (t.match(/\?+/g) ?? []).length;
}

export const umaPerguntaGate: Gate = {
  name: 'uma_pergunta',
  evaluate: (ctx) => {
    if (ctx.travasDeEnvio?.umaPergunta !== true) return { pass: true };
    const perguntas = contarPerguntas(ctx.body);
    if (perguntas <= 1) return { pass: true };
    return {
      pass: false,
      code: 'uma_pergunta',
      reason: renderVetoDePerguntas(perguntas),
      detail: { perguntas },
    };
  },
};

/** O erro de ensino. */
export function renderVetoDePerguntas(perguntas: number): string {
  return (
    `A mensagem NÃO foi enviada: ela faz ${perguntas} perguntas. Reescreva com UMA pergunta só ` +
    '(a mais importante agora), sem pergunta retórica; as outras ficam para depois da resposta.'
  );
}
