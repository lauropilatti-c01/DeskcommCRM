/**
 * (C01, -c01.3, item 1d) A PROMESSA SEMÂNTICA TEM CONTADOR E FAIL-SAFE, COMO O VOCABULÁRIO.
 *
 * O defeito: o veto da trava semântica de promessa (`promise_semantic`) só ensinava, sem
 * limite. O modelo podia reescrever a mesma promessa a cada etapa até o teto de etapas,
 * com o lead esperando — e, sem nenhum envio, o turno acabava mudo.
 *
 * A correção: as travas de CONTEÚDO (`TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE`) seguem a régua
 * da de vocabulário interno — 1º veto ensina; 2º ensina e avisa que é a última tentativa;
 * 3º: o texto vetado não sai e o turno passa à equipe pelo caminho comum
 * (`passarAoHumanoSemResposta`: caso com o texto vetado, frase de espera pelo `send`
 * exclusivo, passagem gravada). Um contador por trava, por turno.
 *
 * Os textos e a régua se provam por comportamento; a ligação no `send_message`, por
 * leitura do código (o `execute` é closure do turno, sem harness em unidade — a mesma
 * técnica de `send-message-corpo-vazio.test.ts`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as turno from "@/lib/agent-engine/agent/inbound-turn";
import { AVISO_DE_ULTIMA_TENTATIVA } from "@/lib/agent-engine/guardrails/vazamento-interno";

const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
const sendMessage = (() => {
  const i = FONTE.indexOf("send_message: tool({");
  const j = FONTE.indexOf("update_lead_state: tool({", i);
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(i);
  return FONTE.slice(i, j);
})();
const blocoDeConteudo = (): string => {
  const i = sendMessage.indexOf("Object.hasOwn(TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE, chain.code)");
  expect(i).toBeGreaterThan(-1);
  return sendMessage.slice(i, sendMessage.indexOf("if (chain.status === 'vetoed') {", i));
};

describe("(C01) a régua das travas de conteúdo", () => {
  it("a promessa semântica é trava de conteúdo, com nome legível, e o limite é o do vocabulário interno (3)", () => {
    expect(turno.TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE).toHaveProperty("promise_semantic");
    expect(turno.TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE.promise_semantic).not.toMatch(/_/);
    expect(turno.MAX_VETOS_DE_CONTEUDO).toBe(3);
    expect(turno.MAX_VETOS_DE_CONTEUDO).toBe(turno.MAX_VETOS_DE_VOCABULARIO_INTERNO);
  });

  it("o caso leva o texto vetado (é o que a pessoa precisa ler); título, motivo e passagem legíveis, sem prazo", () => {
    const t = turno.textosDoFimSemResposta({
      motivo: "veto_de_conteudo",
      trava: "promise_semantic",
      vetos: 3,
      texto: "Garanto que você passa no concurso.",
    } as never);
    expect(t.resumo).toBe("Garanto que você passa no concurso.");
    expect(t.tituloDoCaso).toBe("Resposta travada pela revisão automática (promessa sem respaldo)");
    expect(t.tituloDaPassagem).toBe(`${t.tituloDoCaso} — assumir a conversa`);
    expect(t.motivoDaPassagem).toMatch(/uma pessoa precisa responder/);
    expect(t.bloqueio).toMatch(/tentou 3 vezes responder/);
    // O caso é aberto antes da frase: o bloqueio não afirma que o cliente a recebeu.
    expect(t.bloqueio).not.toMatch(/cliente recebeu/);
    for (const v of [t.tituloDoCaso, t.motivoDaPassagem, t.tituloDaPassagem, t.bloqueio]) {
      expect(v).not.toMatch(/promise_semantic|_/);
      expect(v).not.toMatch(/\b(minutos?|horas?|em breve|logo)\b/i);
    }
  });

  it("um código que não é trava de conteúdo não ganha nome (nem herda do protótipo)", () => {
    expect(Object.hasOwn(turno.TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE, "toString")).toBe(false);
    expect(Object.hasOwn(turno.TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE, "promise_out_of_table")).toBe(false);
  });
});

describe("(C01) a ligação no `send_message`, pelo código", () => {
  it("o contador é por trava e por turno (closure), ao lado dos outros", () => {
    expect(FONTE).toMatch(/const vetosDeConteudo = new Map<string, number>\(\);/);
    expect(FONTE.indexOf("const vetosDeConteudo")).toBeLessThan(FONTE.indexOf("send_message: tool({"));
  });

  it("1º e 2º vetos ensinam (o 2º com o aviso de última tentativa); no 3º, o caminho comum com o texto vetado", () => {
    const bloco = blocoDeConteudo();
    expect(bloco).toMatch(
      /const vetos = \(vetosDeConteudo\.get\(chain\.code\) \?\? 0\) \+ 1;\s*vetosDeConteudo\.set\(chain\.code, vetos\);\s*if \(vetos < MAX_VETOS_DE_CONTEUDO\) \{\s*const ultima = vetos === MAX_VETOS_DE_CONTEUDO - 1;/,
    );
    expect(bloco).toMatch(/message: ultima \? `\$\{chain\.message\} \$\{AVISO_DE_ULTIMA_TENTATIVA\}` : chain\.message,/);
    expect(bloco).toMatch(
      /desfecho = await passarAoHumanoSemResposta\(\{\s*motivo: 'veto_de_conteudo',\s*trava: chain\.code,\s*vetos,\s*texto: body,\s*\}\);/,
    );
    // O modelo é avisado de que nada saiu e de como ficou a frase; e para.
    expect(bloco).toMatch(/code: `\$\{chain\.code\}_handoff`,/);
    expect(bloco).toMatch(/AVISO_AO_MODELO_POR_DESFECHO\[desfecho\]/);
    expect(bloco).toMatch(/NÃO escreva mais nada neste turno — encerre agora\./);
    // Falha do caminho comum (sem caso): o erro não some e nada sai.
    expect(bloco).toMatch(/\} catch \(err\) \{\s*[\s\S]*?noteRunError\(/);
    expect(AVISO_DE_ULTIMA_TENTATIVA).toMatch(/ÚLTIMA tentativa/);
  });

  it("o bloco vem depois da cadeia e do caso, e ANTES do veto genérico (que só ensinava, sem limite)", () => {
    const cadeia = sendMessage.indexOf("let chain = await cadeiaDeEnvio(() => runBeforeSend(beforeSendArgs));");
    const vocabulario = sendMessage.indexOf("chain.code === 'internal_vocabulary_leak'");
    const conteudo = sendMessage.indexOf("Object.hasOwn(TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE, chain.code)");
    const generico = sendMessage.indexOf("if (chain.status === 'vetoed') {", conteudo);
    expect(cadeia).toBeGreaterThan(-1);
    expect(conteudo).toBeGreaterThan(cadeia);
    expect(conteudo).toBeGreaterThan(vocabulario);
    expect(generico).toBeGreaterThan(conteudo);
  });

  it("o caminho comum devolve o desfecho da frase, para o aviso ao modelo", () => {
    expect(FONTE).toMatch(
      /const passarAoHumanoSemResposta = async \(fim: FimSemResposta\): Promise<DesfechoDaFraseDeEspera> => \{/,
    );
    const ini = FONTE.indexOf("const passarAoHumanoSemResposta = async (");
    const corpo = FONTE.slice(ini, FONTE.indexOf("\n  };\n", ini));
    expect(corpo).toMatch(/return desfecho;\s*$/);
    // O texto vetado vai ao caso (resumo), nunca ao log.
    expect(corpo).toMatch(/fim\.motivo === 'veto_de_conteudo'\s*\?\s*\{ motivo: fim\.motivo, trava: fim\.trava, vetos: fim\.vetos \}/);
  });
});
