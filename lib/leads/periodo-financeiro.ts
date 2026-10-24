/** Limites de uma data recebida; os limites nunca são gravados como horário do pagamento. */
export function intervaloDoPagamento(
  paidAt: string,
  precision?: "instant" | "day",
): { earliest: number; latest: number } | null {
  if (precision !== "day") {
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(paidAt)) return null;
    const time = Date.parse(paidAt);
    return Number.isFinite(time) ? { earliest: time, latest: time } : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) return null;
  const day = Date.parse(`${paidAt}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== paidAt) return null;
  // O contrato Asaas informa date, sem fuso. O envelope ±14 h cobre qualquer
  // fuso civil, em vez de atribuir implicitamente UTC ou meia-noite de Brasília.
  return { earliest: day - 14 * 3_600_000, latest: day + 38 * 3_600_000 - 1 };
}
