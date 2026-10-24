/** Veto definitivo de UMA promessa C01, não opt-out genérico do contato.
 * O worker já reconhece terminal e cancela somente o job com o lease atual.
 * Falhas de leitura, configuração, relógio e prova incompleta não usam esta classe.
 */
export class RetornoC01CanceladoError extends Error {
  readonly terminal = true;

  constructor(
    reason:
      "consent_changed" | "restricted" | "human" | "new_reply" | "purchased" | "offer_changed",
  ) {
    super(`c01_callback_${reason}`);
    this.name = "RetornoC01CanceladoError";
  }
}
