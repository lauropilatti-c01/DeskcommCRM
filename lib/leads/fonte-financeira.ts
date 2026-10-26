/** Consulta para a guarda final. Deve ser chamada com a trava de efeito já retida. */
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { lerSituacaoFinanceiraSemOferta } from "./fonte-financeira-sem-oferta";
import type { ColetaFinanceira } from "./coleta-financeira";
export { criarFonteFinanceira } from "./fontes-financeiras";
export interface SituacaoFinanceira {
  status: "confirmado" | "revisao" | "indisponivel" | "nao_comprou_confirmado";
  checkedAt: string;
  complete: boolean;
  reason: string;
  evidenceHash?: string;
  collection?: ColetaFinanceira;
}
export async function lerSituacaoFinanceira(input: {
  db: Queryable;
  organizationId: string;
  contactId: string;
  leadId: string;
  productKey: string;
  now: Date;
  signal: AbortSignal;
}): Promise<SituacaoFinanceira> {
  // Veto comercial por pessoa não é confirmação de Ganho da oferta corrente.
  // A fonte integral conserva identidade, cobertura, frescor e negativa fechada.
  return lerSituacaoFinanceiraSemOferta({
    ...input,
    productKey: null,
    finalidade: "sem_oferta",
    expectedProductKey: input.productKey,
  });
}
