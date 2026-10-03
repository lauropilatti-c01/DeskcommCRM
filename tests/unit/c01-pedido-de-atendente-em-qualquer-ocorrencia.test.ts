/**
 * (C01) O PEDIDO DE ATENDENTE VALE EM QUALQUER OCORRÊNCIA — achado 4 (médio) da sexta
 * revisão adversarial do Codex (03/10/2026), rodada 7, correção 3.
 *
 * O achado: `detectHumanHandoffRequest` olhava só a PRIMEIRA ocorrência de cada padrão
 * (`re.exec`) e perguntava se ela vinha negada. "Não quero falar com atendente
 * virtual. Quero falar com uma pessoa." tem duas: a primeira negada, a segunda não — e
 * a função devolvia `false`, deixando com o bot um lead que pediu uma pessoa. A
 * detecção por palavra configurada (`matchesHandoffKeyword`) já percorria todas as
 * ocorrências; os padrões fixos não.
 *
 * A correção: percorrer todas as ocorrências (`matchAll`, com cópias globais dos
 * padrões) e aceitar qualquer pedido não negado — a mesma regra das duas detecções.
 * Os três casos pedidos: negada seguida de afirmativa → pedido; só negada → não;
 * "trabalho como atendente" continua não sendo pedido.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { matchesHandoffKeyword, palavrasDePassagem } from "@/lib/agent-engine/agent/agent-config";
import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";

/** A lista padrão do código (validation.ts, AgentForm, HandoffKeywordsInput). */
const PADRAO = ["falar com humano", "falar com atendente", "pessoa real"];

describe("(C01) os três casos do achado", () => {
  it("a ocorrência negada seguida da afirmativa é pedido: «Não quero falar com atendente virtual. Quero falar com uma pessoa.»", () => {
    expect(
      detectHumanHandoffRequest(
        "Não quero falar com atendente virtual. Quero falar com uma pessoa.",
      ),
    ).toBe(true);
    // O mesmo padrão duas vezes, só a segunda vale.
    expect(
      detectHumanHandoffRequest(
        "não quero falar com atendente virtual, quero falar com atendente de verdade",
      ),
    ).toBe(true);
    // Padrões diferentes: a negada é de um, a afirmativa é de outro.
    expect(
      detectHumanHandoffRequest("nao quero falar com humano por telefone, me passa pro comercial"),
    ).toBe(true);
  });

  it("só negada continua não sendo pedido", () => {
    expect(detectHumanHandoffRequest("Não quero falar com atendente virtual.")).toBe(false);
    expect(
      detectHumanHandoffRequest("não quero falar com atendente, nem preciso falar com um humano"),
    ).toBe(false);
  });

  it("«trabalho como atendente» continua não sendo pedido (nenhum padrão casa)", () => {
    expect(detectHumanHandoffRequest("trabalho como atendente")).toBe(false);
    expect(detectHumanHandoffRequest("sou atendente de loja e quero saber do curso")).toBe(false);
  });
});

describe("(C01) paridade com a detecção por palavra configurada", () => {
  it("`matchesHandoffKeyword` já percorria todas as ocorrências: os dois detectores concordam nos três casos", () => {
    const lista = palavrasDePassagem(PADRAO);
    for (const [texto, esperado] of [
      ["Não quero falar com atendente virtual. Quero falar com atendente.", true],
      ["Não quero falar com atendente virtual.", false],
      ["trabalho como atendente", false],
    ] as const) {
      expect(detectHumanHandoffRequest(texto), texto).toBe(esperado);
      expect(matchesHandoffKeyword(texto, lista), texto).toBe(esperado);
    }
  });

  it("a mensagem vazia e a mensagem sem pedido continuam `false`; o pedido simples continua `true`", () => {
    expect(detectHumanHandoffRequest("")).toBe(false);
    expect(detectHumanHandoffRequest("   ")).toBe(false);
    expect(detectHumanHandoffRequest("oi, queria saber do plano")).toBe(false);
    expect(detectHumanHandoffRequest("quero falar com um atendente")).toBe(true);
    expect(detectHumanHandoffRequest("ATENDIMENTO HUMANO, por favor")).toBe(true);
  });
});

describe("(C01) a ligação pelo código", () => {
  const FONTE = readFileSync("lib/agent-engine/agent/human-handoff.ts", "utf8");

  it("cópias globais dos padrões (só a flag `g` a mais), percorridas com `matchAll`; qualquer ocorrência não negada é pedido", () => {
    expect(FONTE).toMatch(
      /const HUMAN_HANDOFF_PATTERNS_GLOBAIS: readonly RegExp\[\] = HUMAN_HANDOFF_PATTERNS\.map\(\s*\(re\) => new RegExp\(re\.source, `\$\{re\.flags\}g`\),?\s*\);/,
    );
    const funcao = FONTE.slice(
      FONTE.indexOf("export function detectHumanHandoffRequest(message: string): boolean {"),
      FONTE.indexOf(
        "\n}\n",
        FONTE.indexOf("export function detectHumanHandoffRequest(message: string): boolean {"),
      ),
    );
    expect(funcao).toMatch(
      /return HUMAN_HANDOFF_PATTERNS_GLOBAIS\.some\(\(re\) => \{\s*for \(const m of normalized\.matchAll\(re\)\) \{\s*if \(!negadoLogoAntes\(normalized, m\.index\)\) return true;\s*\}\s*return false;\s*\}\);/,
    );
    expect(funcao).not.toMatch(/\.exec\(/);
  });

  it("os padrões originais não mudaram (sem flag, os mesmos quatro)", () => {
    const padroes = FONTE.slice(
      FONTE.indexOf("const HUMAN_HANDOFF_PATTERNS: readonly RegExp[] = ["),
      FONTE.indexOf("];", FONTE.indexOf("const HUMAN_HANDOFF_PATTERNS: readonly RegExp[] = [")),
    );
    expect(padroes.match(/^\s*\/.*\/,$/gm)).toHaveLength(4);
    expect(padroes).toMatch(/\\batendimento\\s\+humano\\b\/,/);
  });
});
