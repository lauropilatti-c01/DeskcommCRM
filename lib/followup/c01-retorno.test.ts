import { describe, expect, it } from "vitest";
import { horarioConfirmadoC01 } from "./c01-retorno";
const at = "2026-10-23T15:00:00.000Z";
describe("retorno C01 combinado", () => {
  it("um sim só vale com a oferta de horário imediatamente anterior", () => {
    expect(horarioConfirmadoC01("Sim!", at, "Posso voltar amanhã às 10h?", at)).toBe(
      "2026-10-24T13:00:00.000Z",
    );
    expect(horarioConfirmadoC01("Sim!", at)).toBeNull();
  });
  it("aceita pedido explícito com horário e recusa silêncio/recusa/vagueza", () => {
    expect(horarioConfirmadoC01("Pode me chamar amanhã às 10h.", at)).toBe(
      "2026-10-24T13:00:00.000Z",
    );
    for (const text of [
      "",
      "Não vamos continuar",
      "Não, obrigado",
      "Pode ser à noite",
      "Vou pensar",
      "Sim, mas não quero mensagens",
    ])
      expect(horarioConfirmadoC01(text, at, "Posso voltar amanhã às 10h?", at)).toBeNull();
  });
  it("recusa alternativas, condição e pergunta que não confirma", () => {
    for (const text of [
      "Pode me chamar amanhã às 9h ou às 10h",
      "Pode me chamar amanhã às 9h se eu conseguir",
      "Pode me chamar amanhã às 9h? Ainda preciso confirmar.",
      "Pode me chamar hoje às 18h ou amanhã às 9h",
    ])
      expect(horarioConfirmadoC01(text, at)).toBeNull();
    for (const offer of [
      "Não posso te chamar amanhã às 9h.",
      "Você disse que alguém ia te chamar amanhã às 9h?",
    ])
      expect(horarioConfirmadoC01("Sim!", at, offer, at)).toBeNull();
  });
  it("não inventa dia, não aceita hora impossível e não muda a hora combinada", () => {
    expect(horarioConfirmadoC01("Pode me chamar às 10h.", at)).toBeNull();
    expect(horarioConfirmadoC01("Pode me chamar amanhã às 29h.", at)).toBeNull();
    expect(horarioConfirmadoC01("Pode me chamar amanhã às 21h.", at)).toBe(
      "2026-10-25T00:00:00.000Z",
    );
  });
});
