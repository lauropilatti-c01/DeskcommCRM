/**
 * (C01, -c01.15) UMA RESPOSTA POR TURNO, com o divisor de bolhas ligado.
 *
 * Com `split_messages`, quem parte a resposta em bolhas é o `sendInBubbles`, em ordem e
 * com a pausa de quem digita; o modelo escreve UM `send_message` em parágrafos. A
 * instrução já pedia isso (`instrucaoDeBolhas`: "Nunca chame send_message mais de uma vez
 * no mesmo turno"), mas nada no código impedia: o modelo mandava a resposta, consultava
 * a base e mandava outra — duas respostas para uma mensagem do cliente, e o teto de
 * mensagens do turno (`MAX_SENDS_PER_TURN`) era gasto pela primeira.
 *
 * A regra, aqui: depois de um `send_message` que SAIU (`ok: true` — o canal aceitou,
 * já tinha o conteúdo, ou o segura para entregar), o seguinte no mesmo turno é recusado,
 * com o erro de ensino. Quantas bolhas físicas o primeiro mandou não importa: é uma
 * resposta. O que não saiu (veto de trava, teto, falha do canal, resposta obsoleta) não
 * conta, e o modelo pode tentar de novo.
 *
 * As chamadas rodam UMA DE CADA VEZ, na ordem em que chegam: o AI SDK executa em paralelo
 * as chamadas de uma mesma etapa, e sem a fila as duas passariam pela conferência antes
 * de qualquer uma terminar. Com a fila, a segunda espera a primeira e só sai se a
 * primeira não saiu.
 *
 * Fora daqui, de propósito:
 * - as mensagens fixas do gancho antes do turno (`gancho-antes-do-turno.ts`) vão pela
 *   cadeia direto, sem esta ferramenta: não contam;
 * - a frase de espera dos fail-safes sai de dentro do mesmo `execute` (não é outra
 *   chamada);
 * - a re-execução do job: o estado é da execução (closure), e a mensagem que o ledger
 *   já tinha volta como `already_sent` (`ok: true`): é a resposta desta execução;
 * - a prévia do agente troca o `execute` inteiro (`preview.ts`) e não passa por aqui.
 */

type Execute = (entrada: unknown, opcoes: unknown) => unknown;

/** O erro de ensino da segunda resposta no turno. */
export function recusaPorRespostaJaEnviada() {
  return {
    ok: false as const,
    error: {
      code: 'uma_resposta_por_turno' as const,
      message:
        'Esta mensagem NÃO foi enviada: você já respondeu ao cliente neste turno, e cada turno tem uma ' +
        'resposta só. Tudo o que for dizer vai numa única chamada de send_message, em parágrafos curtos ' +
        'separados por uma linha em branco. NÃO chame send_message de novo — encerre o turno agora.',
    },
  };
}

/** O resultado do `send_message` que é resposta enviada (`sent`, `already_sent`, `queued`). */
export function respostaSaiu(resultado: unknown): boolean {
  return typeof resultado === 'object' && resultado !== null && (resultado as { ok?: unknown }).ok === true;
}

/**
 * Envolve a ferramenta `send_message` do turno. Estado só nesta chamada: criar o
 * envoltório por turno é o que o zera entre turnos. `aoRecusar` recebe, a cada recusa,
 * quantas já houve no turno (o turno grava no log, para medir no laboratório).
 */
export function umaRespostaPorTurno<T extends { execute?: unknown }>(
  ferramenta: T,
  aoRecusar?: (recusadas: number) => void,
): T {
  const executar = ferramenta.execute;
  if (typeof executar !== 'function') return ferramenta;
  let respondeu = false;
  let recusadas = 0;
  let fila: Promise<unknown> = Promise.resolve();
  const execute: Execute = (entrada, opcoes) => {
    const vez = fila.then(async () => {
      if (respondeu) {
        recusadas += 1;
        aoRecusar?.(recusadas);
        return recusaPorRespostaJaEnviada();
      }
      const resultado = await (executar as Execute).call(ferramenta, entrada, opcoes);
      if (respostaSaiu(resultado)) respondeu = true;
      return resultado;
    });
    // A fila segue mesmo se uma chamada lançar (o erro volta a quem chamou).
    fila = vez.catch(() => undefined);
    return vez;
  };
  return { ...ferramenta, execute };
}
