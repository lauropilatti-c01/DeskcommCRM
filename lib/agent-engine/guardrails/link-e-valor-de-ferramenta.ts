/**
 * (C01, -c01.7) TRAVA "LINK E VALOR DE FERRAMENTA": LINK E VALOR EM REAIS SÓ SAEM SE
 * VIERAM DE UMA CONSULTA.
 *
 * A regra (CRM-084 da C01): o texto do agente pede, o programa garante. O modelo
 * trocava parâmetro de link, inventava caminho, arredondava ou inventava valor
 * ("salário de R$ 6.700" com a base dizendo R$ 6.638,64), e só o texto do agente
 * pedia o contrário.
 *
 * Toda URL do corpo e todo valor em dinheiro ("R$ …", "… reais") têm de estar no que
 * o turno libera:
 *   - o que voltou de uma ferramenta de CONSULTA neste turno (a base externa, a base
 *     RAG, a referência de skill — ver `registrarConsulta` em `inbound-turn.ts`);
 *   - o que já saiu numa mensagem nossa desta conversa (do agente, da equipe ou do
 *     gancho antes do turno, inclusive o botão de uma interativa), e o que já saiu
 *     neste turno;
 *   - as URLs fixas da configuração (`settings.travas_de_envio.link_e_valor_de_ferramenta.urls`).
 *
 * O link se compara pela forma da trava `link_permitido` (o mesmo reconhecedor e a
 * mesma normalização: sem a pontuação final, sem a barra final; caminho e parâmetros
 * contam). O valor se compara em centavos (`valor-de-ferramenta.ts`).
 *
 * Trava de CONTEÚDO (`TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE` em `inbound-turn.ts`): 1º veto
 * ensina, 2º ensina e avisa que é a última tentativa, no 3º o texto não sai e o turno
 * passa à equipe com a frase de espera. Nunca libera o envio sem conferência: para
 * dinheiro e link, segurar é melhor que soltar.
 *
 * O veto não cita o link nem o valor (nem ao modelo, nem no trace): o texto vetado
 * não vai a lugar nenhum além do caso aberto para a equipe.
 *
 * Liga e desliga por organização na tela ("Confere antes de enviar"), numa linha de
 * `org_guardrail_layers` (`INTERRUPTOR_DA_TRAVA`) — sem mudança de banco: a coluna
 * `layer` é vocabulário aberto. Vem desligada.
 */
import type { Gate } from './before-send';
import { chaveDoInterruptor } from './interruptores-de-trava';
import { linksNoTexto, normalizarLink } from './link-permitido';
import { valoresEmDinheiro } from './valor-de-ferramenta';

/** O nome da trava na cadeia e na configuração. */
export const NOME_DA_TRAVA = 'link_e_valor_de_ferramenta' as const;

/** A chave do interruptor desta trava em `org_guardrail_layers` (ver `interruptores-de-trava.ts`). */
export const INTERRUPTOR_DA_TRAVA = chaveDoInterruptor(NOME_DA_TRAVA);

/** O código do veto (contador e fail-safe das travas de conteúdo). */
export const CODIGO_DO_VETO_DE_LINK_OU_VALOR = 'link_ou_valor_sem_consulta';

export interface LinkEValorArmado {
  /** Links liberados, já normalizados (`normalizarLink`). */
  links: ReadonlySet<string>;
  /** Valores liberados, em centavos. */
  valores: ReadonlySet<number>;
}

/** O que a mensagem tem fora do liberado — só as contagens (nunca o trecho). */
export function foraDoLiberado(body: string, trava: LinkEValorArmado): { links: number; valores: number } {
  return {
    links: linksNoTexto(body).filter((l) => !trava.links.has(normalizarLink(l))).length,
    valores: valoresEmDinheiro(body).filter((v) => !trava.valores.has(v)).length,
  };
}

/** O erro de ensino: o que fazer, sem repetir o trecho vetado. */
export function renderVetoDeLinkOuValor(fora: { links: number; valores: number }): string {
  const oQue =
    fora.links > 0 && fora.valores > 0
      ? 'link e valor em reais que não vieram'
      : fora.links > 0
        ? 'link que não veio'
        : 'valor em reais que não veio';
  return (
    `A mensagem NÃO foi enviada: ela tem ${oQue} de uma consulta neste turno nem de uma ` +
    'mensagem já enviada nesta conversa. Consulte de novo e use exatamente o que voltou, ou ' +
    'tire o trecho. Nunca comente isso com o cliente.'
  );
}

export const linkEValorDeFerramentaGate: Gate = {
  name: NOME_DA_TRAVA,
  evaluate: (ctx) => {
    const trava = ctx.travasDeEnvio?.linkEValorDeFerramenta;
    if (trava === undefined) return { pass: true };
    const fora = foraDoLiberado(ctx.body, trava);
    if (fora.links === 0 && fora.valores === 0) return { pass: true };
    return {
      pass: false,
      code: CODIGO_DO_VETO_DE_LINK_OU_VALOR,
      reason: renderVetoDeLinkOuValor(fora),
      // Só as contagens no trace: o link e o valor são trechos da mensagem vetada.
      detail: { links: fora.links, valores: fora.valores },
    };
  },
};

/** Os links (normalizados) e os valores (centavos) de uma lista de textos. */
export function linksEValoresDosTextos(textos: Iterable<string>): { links: Set<string>; valores: Set<number> } {
  const links = new Set<string>();
  const valores = new Set<number>();
  for (const texto of textos) {
    for (const link of linksNoTexto(texto)) links.add(normalizarLink(link));
    for (const valor of valoresEmDinheiro(texto)) valores.add(valor);
  }
  return { links, valores };
}
