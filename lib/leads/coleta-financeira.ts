import { z } from "zod";

/** Progresso autenticado não é prova de ausência de compra. */
export const coletaFinanceiraSchema = z
  .object({
    generationId: z.uuid(),
    startedAt: z.string().datetime({ offset: true }),
    heartbeatAt: z.string().datetime({ offset: true }),
    deadlineAt: z.string().datetime({ offset: true }),
    progress: z.number().int().positive(),
  })
  .strict();
export type ColetaFinanceira = z.infer<typeof coletaFinanceiraSchema>;
export interface PrazoColetaFinanceira {
  generationId: string;
  startedAt: string;
  deadlineAt: string;
}
export function coletaFinanceiraViva(value: unknown, now: Date): ColetaFinanceira | null {
  const parsed = coletaFinanceiraSchema.safeParse(value);
  if (!parsed.success) return null;
  const c = parsed.data,
    start = Date.parse(c.startedAt),
    beat = Date.parse(c.heartbeatAt),
    end = Date.parse(c.deadlineAt);
  return start <= beat &&
    beat <= +now &&
    +now - beat <= 120_000 &&
    +now < end &&
    end === start + 900_000
    ? c
    : null;
}
