import type pg from "pg";
import { comTravaDeEfeito, type TravaDeEfeito } from "@/lib/agent-engine/db/trava-de-efeito";

export function comTravaDaDistribuicao<T>(
  pool: pg.Pool,
  org: string,
  executar: (trava: TravaDeEfeito) => Promise<T>,
): Promise<{ ocupado: true } | { ocupado: false; resultado: T }> {
  return comTravaDeEfeito(pool, `case-distribution:${org}`, executar);
}
