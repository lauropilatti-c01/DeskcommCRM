/**
 * (C01) PEDIDO DE ATENDENTE POR EXPRESSÃO, NÃO POR PALAVRA SOLTA — a correção 4c.
 *
 * `matchesHandoffKeyword` era substring simples: com "atendente" na lista (o
 * padrão da tela), "trabalho como atendente" e "não quero falar com atendente"
 * transferiam o lead para uma pessoa que ele não pediu. E os padrões fixos de
 * `detectHumanHandoffRequest` casavam "falar com atendente" sem olhar a negação
 * logo antes.
 *
 * Os três casos pedidos: "quero falar com um atendente" transfere; "trabalho
 * como atendente" não; "não quero falar com atendente" não. E os limites,
 * medidos aqui: "não consigo falar com atendente" CONTINUA transferindo
 * (é pedido de ajuda, não recusa); a palavra solta configurada na tela continua
 * casando como palavra — a lista é da tela, e só o padrão do código mudou.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { matchesHandoffKeyword, palavrasDePassagem } from "@/lib/agent-engine/agent/agent-config";
import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";
import { negadoLogoAntes, normalizarParaPedido } from "@/lib/agent-engine/agent/negacao-de-pedido";

/** A lista padrão do código (validation.ts, AgentForm, HandoffKeywordsInput). */
const PADRAO = ["falar com humano", "falar com atendente", "pessoa real"];
/** A lista como estava: a palavra solta que causava o defeito. */
const ANTIGA = ["falar com humano", "atendente", "pessoa real"];

const pedido = (texto: string, lista: readonly string[] = PADRAO) =>
  detectHumanHandoffRequest(texto) || matchesHandoffKeyword(texto, palavrasDePassagem(lista));

describe("(C01) os três casos", () => {
  it("«quero falar com um atendente» transfere", () => {
    expect(pedido("quero falar com um atendente")).toBe(true);
    expect(pedido("Quero falar com um ATENDENTE, por favor")).toBe(true);
    expect(matchesHandoffKeyword("quero falar com atendente agora", palavrasDePassagem(PADRAO))).toBe(true);
  });

  it("«trabalho como atendente» não transfere (com a lista padrão nova)", () => {
    expect(pedido("trabalho como atendente")).toBe(false);
    expect(pedido("sou atendente de loja e quero saber do curso")).toBe(false);
  });

  it("«não quero falar com atendente» não transfere — nos dois detectores", () => {
    expect(detectHumanHandoffRequest("não quero falar com atendente")).toBe(false);
    expect(matchesHandoffKeyword("não quero falar com atendente", palavrasDePassagem(PADRAO))).toBe(false);
    expect(pedido("nao quero falar com atendente, prefiro resolver aqui")).toBe(false);
    expect(pedido("nem preciso falar com um atendente")).toBe(false);
  });
});

describe("(C01) o que mudou no casamento", () => {
  it("fronteira de palavra: a expressão só casa inteira", () => {
    const lista = palavrasDePassagem(["pessoa real"]);
    expect(matchesHandoffKeyword("quero uma pessoa real", lista)).toBe(true);
    expect(matchesHandoffKeyword("quero uma pessoa realmente boa", lista)).toBe(false);
    expect(matchesHandoffKeyword("a pessoarealista disse", lista)).toBe(false);
  });

  it("sem diacríticos nos dois lados: «atendimento humano» casa «Atendimento HUMANO»; «não» casa «nao»", () => {
    expect(matchesHandoffKeyword("Quero ATENDIMENTO HUMANO já", palavrasDePassagem(["atendimento humano"]))).toBe(true);
    expect(matchesHandoffKeyword("Não quero atendimento humano", palavrasDePassagem(["atendimento humano"]))).toBe(false);
    expect(matchesHandoffKeyword("nao quero atendimento humano", palavrasDePassagem(["atendimento humano"]))).toBe(false);
  });

  it("a negação só vale na mesma oração e perto: «não, quero falar com atendente» transfere", () => {
    expect(pedido("não, quero falar com atendente")).toBe(true);
    expect(pedido("não entendi. quero falar com um atendente")).toBe(true);
    const t = normalizarParaPedido("não gostei de nada disso que vocês fizeram comigo e quero falar com atendente");
    expect(negadoLogoAntes(t, t.indexOf("falar com atendente"))).toBe(false);
  });

  it("limite registrado: «não consigo falar com atendente» continua transferindo (é pedido de ajuda)", () => {
    expect(pedido("não consigo falar com atendente")).toBe(true);
    expect(pedido("nunca quis falar com atendente")).toBe(true); // "quis" fica fora da lista de vontade — aceito
  });

  it("limite registrado: palavra solta configurada NA TELA continua casando como palavra", () => {
    // A lista é configuração: quem deixar "atendente" sozinho na tela ainda transfere
    // "trabalho como atendente" — mas não "não quero atendente".
    expect(matchesHandoffKeyword("trabalho como atendente", palavrasDePassagem(ANTIGA))).toBe(true);
    expect(matchesHandoffKeyword("não quero atendente", palavrasDePassagem(ANTIGA))).toBe(false);
    expect(matchesHandoffKeyword("atendentes são ótimos", palavrasDePassagem(ANTIGA))).toBe(false);
  });

  it("o padrão do código traz a expressão de pedido, não a palavra solta", () => {
    for (const arquivo of [
      "lib/ai/agents/validation.ts",
      "app/app/ai/agents/[id]/_components/AgentForm.tsx",
      "app/app/ai/agents/[id]/_components/HandoffKeywordsInput.tsx",
    ]) {
      const fonte = readFileSync(arquivo, "utf8");
      expect(fonte, arquivo).toContain('"falar com atendente"');
      expect(fonte, arquivo).not.toMatch(/"falar com humano",\s*(?:\/\/[^\n]*\n\s*)*"atendente",/);
    }
  });
});
