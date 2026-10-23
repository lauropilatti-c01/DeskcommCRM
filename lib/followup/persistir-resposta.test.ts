import { describe, expect, it, vi } from "vitest";

import { interpolarDestino, recorteDaResposta } from "./persistir-resposta";

describe("recorteDaResposta", () => {
  it("trims and keeps short text", () => {
    expect(recorteDaResposta("  Ana  ")).toBe("Ana");
  });
});

describe("interpolarDestino", () => {
  it("substitui {{volta}} pela última volta do repeat", () => {
    const out = interpolarDestino({ kind: "lead_custom", key: "filho_{{volta}}_nome" }, [
      { node_id: "rp", idempotency_key: "rp:0", payload: { repeat_index: 2, repeat_total: 3 } },
    ]);
    expect(out).toEqual({ kind: "lead_custom", key: "filho_2_nome" });
  });

  it("nome do contato não muda", () => {
    expect(interpolarDestino({ kind: "contact_name" }, [])).toEqual({ kind: "contact_name" });
  });
});

it("resposta de acompanhamento não confirma pagamento por nenhum cliente", async () => {
  const { persistirRespostaFollowupPg, persistirRespostaFollowupSupabase } =
    await import("./persistir-resposta");
  const query = vi.fn();
  const from = vi.fn();
  const input = {
    organization_id: "org",
    contact_id: "contact",
    save_to: { kind: "lead_custom" as const, key: "PAGAMENTO_CONFIRMADO" },
    value: "sim",
  };
  await expect(persistirRespostaFollowupPg(query, input)).rejects.toMatchObject({
    code: "financial_field_read_only",
  });
  await expect(persistirRespostaFollowupSupabase({ from } as never, input)).rejects.toMatchObject({
    code: "financial_field_read_only",
  });
  expect(query).not.toHaveBeenCalled();
  expect(from).not.toHaveBeenCalled();
});
