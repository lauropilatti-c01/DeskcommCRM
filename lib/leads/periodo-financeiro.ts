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

/** Decisão C01 de 26/10: effectiveDate Pix sem offset é interpretado como Brasília.
 * Não é alegação de contrato de fuso do Asaas; datas sem hora continuam sem prova. */
export function instantePixAsaas(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(
    value,
  );
  if (!parts) return null;
  const wall = `${parts[1]}T${parts[2]}${parts[3] ?? ""}`;
  const local = Date.parse(`${wall}Z`);
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== wall.slice(0, 19))
    return null;
  const time = Date.parse(`${wall}${parts[4] ?? "-03:00"}`);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
