/**
 * (C01, -c01.7) AS TRAVAS DE ENVIO QUE SE LIGAM PELA TELA ("Confere antes de enviar").
 *
 * A escolha de cada uma é uma linha de `org_guardrail_layers` com a chave
 * `trava:<nome>` — a coluna `layer` é vocabulário aberto, então não há mudança de
 * banco. Quem lê: o turno do agente (`lerTravasDeEnvioDaOrg`, em `travas-de-envio.ts`)
 * e a rota `/api/v1/ai/send-guards` (a tela e a conferência pela API).
 *
 *   - `link_e_valor_de_ferramenta`: só a linha liga (sem linha = desligada).
 *   - `valor_em_dinheiro`: a linha, se existe, manda; sem linha, vale o
 *     `settings.travas_de_envio.valor_em_dinheiro.ligada` de antes (-c01.3). Assim quem
 *     já ligou pelo JSON continua ligado, e a tela mostra o estado que vale.
 *
 * Lista FECHADA: a rota não aceita outro nome, e nenhuma trava fixa da cadeia se
 * desliga por ela. Nenhuma liga sozinha.
 */
export const TRAVAS_COM_INTERRUPTOR = ['link_e_valor_de_ferramenta', 'valor_em_dinheiro'] as const;
export type TravaComInterruptor = (typeof TRAVAS_COM_INTERRUPTOR)[number];

/** A chave do interruptor em `org_guardrail_layers`. */
export function chaveDoInterruptor(trava: TravaComInterruptor): string {
  return `trava:${trava}`;
}
