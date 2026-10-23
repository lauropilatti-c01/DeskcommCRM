import type pg from "pg";

export interface TravaDeEfeito {
  conferir: () => Promise<void>;
  signal: AbortSignal;
  db: pg.PoolClient;
}

/** A conexão fica retida até terminar a decisão e os efeitos, inclusive os HTTP. */
export async function comTravaDeEfeito<T>(
  pool: pg.Pool,
  chave: string,
  executar: (trava: TravaDeEfeito) => Promise<T>,
): Promise<{ ocupado: true } | { ocupado: false; resultado: T }> {
  const db = await pool.connect();
  const abort = new AbortController();
  let erro: Error | undefined;
  let travado = false;
  const caiu = (e: Error) => { erro = e; abort.abort(e); };
  db.on("error", caiu);
  try {
    travado = (await db.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1,0)) as locked", [chave],
    )).rows[0]?.locked === true;
    if (!travado) return { ocupado: true };
    const conferir = async () => {
      if (erro) throw erro;
      // Round-trip na MESMA conexão: se o lock morreu, não usar o retrato lido.
      await db.query("select 1");
      if (erro) throw erro;
    };
    const resultado = await executar({ conferir, signal: abort.signal, db });
    await conferir();
    return { ocupado: false, resultado };
  } catch (e) {
    erro = e instanceof Error ? e : new Error(String(e));
    throw e;
  } finally {
    try {
      if (travado) await db.query("select pg_advisory_unlock(hashtextextended($1,0))", [chave]);
    } catch (e) {
      erro ??= e instanceof Error ? e : new Error(String(e));
    }
    db.removeListener("error", caiu);
    // Unlock incerto descarta a conexão; nunca devolve um lock preso ao pool.
    db.release(erro);
  }
}
