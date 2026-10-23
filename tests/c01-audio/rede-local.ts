/** Cerca de rede, não dublê: todos os HTTP permitidos usam fetch nativo. */
export function fecharRedeNoLocal(): { recusadas: string[] } {
  const recusadas: string[] = [];
  const urls = [
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.TRANSCRIPTION_BASE_URL,
    process.env.WAHA_API_BASE_URL,
  ];
  const origens = new Set(
    urls
      .filter((u): u is string => Boolean(u))
      .map((u) => {
        const parsed = new URL(u);
        if (parsed.hostname !== "127.0.0.1" || parsed.protocol !== "http:")
          throw new Error("A prova exige HTTP em 127.0.0.1.");
        return parsed.origin;
      }),
  );
  const db = new URL(process.env.SUPABASE_DB_URL ?? "");
  if (db.hostname !== "127.0.0.1" || !["postgresql:", "postgres:"].includes(db.protocol))
    throw new Error("Banco da prova precisa ser local.");
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (!origens.has(url.origin)) {
      recusadas.push(url.origin);
      throw new Error(`Saída fora da bancada recusada: ${url.origin}`);
    }
    return realFetch(input, { ...init, redirect: "error" });
  };
  return { recusadas };
}
