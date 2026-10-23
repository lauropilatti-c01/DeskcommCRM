/**
 * A confirmação de pagamento é uma afirmação da integração financeira, nunca
 * da IA, do formulário ou da edição comum. Convenção reservada do fork: não
 * depende de confiança em um `source`/recibo fornecido no corpo da chamada.
 *
 * Esta candidata NÃO inclui o escritor financeiro autenticado. Por isso um
 * funil que exige esta confirmação continua impedido de ganhar: aceitar o
 * booleano legado seria aceitar a mesma escrita genérica que fechamos aqui.
 */
import { ApiError } from "@/lib/api/types";

export const CAMPO_DE_CONFIRMACAO_FINANCEIRA = "pagamento_confirmado";
export const RECUSA_DE_CONFIRMACAO_FINANCEIRA =
  "Pagamento confirmado só pode ser registrado pela integração financeira autorizada. O relato do cliente não confirma o pagamento.";
export const RECUSA_DE_GANHO_SEM_INTEGRACAO =
  "A confirmação financeira ainda não tem uma integração autorizada disponível. Não marque Ganho nem preencha a confirmação manualmente.";

export function campoDeConfirmacaoFinanceira(chave: string): boolean {
  return chave.toLowerCase() === CAMPO_DE_CONFIRMACAO_FINANCEIRA;
}

export function recusarEscritaFinanceiraGenerica(
  campos: Record<string, unknown> | null | undefined,
  requestId: string,
): void {
  if (campos && Object.keys(campos).some(campoDeConfirmacaoFinanceira)) {
    throw new ApiError(
      422,
      "financial_field_read_only",
      undefined,
      requestId,
      RECUSA_DE_CONFIRMACAO_FINANCEIRA,
    );
  }
}
