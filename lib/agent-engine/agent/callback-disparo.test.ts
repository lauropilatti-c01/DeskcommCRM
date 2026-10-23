import { describe, expect, it } from "vitest";
import { conferirCallbackAntesDoTurno } from "./callback-disparo";
import type { Queryable } from "../queue/queue";

const faixa = { start: "08:00", end: "21:00", weekdays: [0, 1, 2, 3, 4, 5, 6] };
const dbDe = (row: Record<string, unknown> | null) => ({
  query: async (_sql: string, ids: string[]) => {
    expect(ids).toEqual(["org", "agente"]);
    return { rows: row ? [row] : [] };
  },
}) as unknown as Queryable;
const linha = { followup: { callback_enabled: true, send_window: faixa }, timezone: "America/Sao_Paulo", paused_at: null, operation_mode: "automatic", archived_at: null };

describe("callback relê o agente antes de rodar", () => {
  it("adiante para 08h quando acorda às 21h, mesmo agendado antes", async () => {
    const r = await conferirCallbackAntesDoTurno(dbDe(linha), "org", "agente", new Date("2026-10-23T00:00:00Z"));
    expect(r).toEqual({ tipo: "adiar", ate: new Date("2026-10-23T11:00:00Z") });
  });
  it("segue às 08h e respeita desligamento publicado depois do agendamento", async () => {
    expect(await conferirCallbackAntesDoTurno(dbDe(linha), "org", "agente", new Date("2026-10-23T11:00:00Z"))).toEqual({ tipo: "seguir" });
    expect(await conferirCallbackAntesDoTurno(dbDe({ ...linha, followup: { callback_enabled: false } }), "org", "agente", new Date())).toMatchObject({ tipo: "impedido" });
  });
  it("agente apagado/pausado/assistido ou faixa inválida não libera envio", async () => {
    for (const row of [null, { ...linha, paused_at: "hoje" }, { ...linha, operation_mode: "assisted" }]) {
      expect(await conferirCallbackAntesDoTurno(dbDe(row), "org", "agente", new Date())).toMatchObject({ tipo: "impedido" });
    }
    await expect(conferirCallbackAntesDoTurno(dbDe({ ...linha, timezone: "invalido" }), "org", "agente", new Date())).rejects.toThrow("callback_send_window_invalid");
  });
  it("retorno legado sem agente pinado não muda nem consulta o banco", async () => {
    const db = { query: async () => { throw new Error("não consultar"); } } as unknown as Queryable;
    expect(await conferirCallbackAntesDoTurno(db, "org", undefined, new Date())).toEqual({ tipo: "seguir" });
  });
});
