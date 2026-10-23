import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assinarOrigemC01,
  configOrigemC01,
  conferirOrigemC01,
  tokenDaOrigemValido,
  type ConfigOrigemC01,
} from "./c01-origem";
import { createHash } from "node:crypto";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cfg: ConfigOrigemC01 = {
  enabled: false,
  organizationId: id(1),
  signingKey: "segredo-de-teste-sem-valor-em-producao",
  tokenSha256: createHash("sha256").update("token-interno").digest("hex"),
  allowedKinds: ["cronograma", "oferta"],
};
afterEach(() => vi.unstubAllEnvs());
describe("origem autenticada do acompanhamento", () => {
  it.each([undefined, "", "   ", "inválido"])("configuração ausente/vazia/inválida mantém OFF (%s)", (value) => {
    vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", value);
    expect(configOrigemC01()).toBeNull();
  });
  it("assina o vínculo inteiro e recusa troca de mensagem, negócio ou organização", () => {
    const proof = assinarOrigemC01(cfg, {
      organizationId: id(1),
      contactId: id(2),
      conversationId: id(3),
      messageId: id(4),
      leadId: id(5),
      kind: "cronograma",
      productKey: "produto-teste",
      createdAt: "2026-10-23T12:00:00.000Z",
      contentHash: "a".repeat(64),
    });
    expect(conferirOrigemC01(cfg, proof)).toEqual(proof);
    for (const change of [
      { messageId: id(9) },
      { leadId: id(9) },
      { organizationId: id(9) },
      { productKey: "outro" },
      { kind: "oferta" },
    ])
      expect(conferirOrigemC01(cfg, { ...proof, ...change })).toBeNull();
  });
  it("não aceita token comum nem marcação enviada como metadata sem assinatura", () => {
    expect(tokenDaOrigemValido(cfg, "token-interno")).toBe(true);
    expect(tokenDaOrigemValido(cfg, "token-mcp")).toBe(false);
    expect(
      conferirOrigemC01(cfg, { kind: "cronograma", leadId: id(5), productKey: "produto-teste" }),
    ).toBeNull();
  });
});
