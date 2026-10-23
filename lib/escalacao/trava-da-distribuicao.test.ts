import { EventEmitter } from "node:events";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { comTravaDaDistribuicao } from "./trava-da-distribuicao";

function conexao() {
  const db = Object.assign(new EventEmitter(), {
    query: vi.fn(async (_sql: string, _args?: unknown[]) => ({ rows: [{ locked: true }] })),
    release: vi.fn(),
  });
  return { db, pool: { connect: vi.fn(async () => db) } as unknown as pg.Pool };
}

describe("conexão retida na distribuição", () => {
  it("queda da conexão aborta HTTP e impede o efeito seguinte", async () => {
    const { db, pool } = conexao();
    const efeito = vi.fn();
    const erro = new Error("conexão perdida");
    await expect(comTravaDaDistribuicao(pool, "org", async (trava) => {
      db.emit("error", erro);
      expect(trava.signal.aborted).toBe(true);
      await trava.conferir();
      efeito();
    })).rejects.toThrow("conexão perdida");
    expect(efeito).not.toHaveBeenCalled();
    expect(db.release).toHaveBeenCalledWith(erro);
    expect(db.listenerCount("error")).toBe(0);
  });

  it("efeito falhou: solta a trava na mesma conexão e descarta a conexão", async () => {
    const { db, pool } = conexao();
    const erro = new Error("API falhou");
    await expect(comTravaDaDistribuicao(pool, "org", async () => { throw erro; })).rejects.toThrow("API falhou");
    expect(db.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_unlock"))).toBe(true);
    expect(db.release).toHaveBeenCalledWith(erro);
  });

  it("unlock incerto nunca devolve a conexão ao pool", async () => {
    const { db, pool } = conexao();
    const erro = new Error("unlock indisponível");
    db.query.mockImplementation(async (sql) => {
      if (sql.includes("pg_advisory_unlock")) throw erro;
      return { rows: [{ locked: true }] };
    });
    expect(await comTravaDaDistribuicao(pool, "org", async () => "gravado")).toEqual({ ocupado: false, resultado: "gravado" });
    expect(db.release).toHaveBeenCalledWith(erro);
  });
});
