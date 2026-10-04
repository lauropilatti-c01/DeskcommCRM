/**
 * (C01) A PASSAGEM AO HUMANO DO FAIL-SAFE GANHA UMA NOVA TENTATIVA IMEDIATA — achado 2
 * (alto) da quinta revisão adversarial do Codex (03/10/2026), rodada 6, correção 3.
 *
 * O achado: `performHumanHandoff` é at-least-once com escritas separadas, e
 * `force_human` é a PRIMEIRA de propósito (fail-closed). Uma falha entre as escritas
 * deixa a passagem incompleta — `force_human` gravado sem o silêncio da conversa, os
 * crons cancelados ou o aviso na Central — e o retry do job NÃO a refaz: o turno
 * seguinte (e a re-execução deste job) é pulado em `isLeadInHandoff`. O nosso
 * comentário dizia "o retry refaz tudo", e isso não é verdade.
 *
 * A decisão (não é mexer no mecanismo do autor): (a) o texto passa a dizer o que
 * acontece de fato; (b) UMA nova tentativa imediata, no próprio turno, antes de
 * registrar o erro — a ação é idempotente pelo contrato do autor; (c) o que fica
 * quando as duas falham é limite herdado, documentado em `C01.md`, com a nota ao
 * autor (transação única, ou "passagem pendente concluída antes da guarda"). Neste
 * caminho "ninguém avisado" não é o cenário: o caso `guardrail_autofallback` é aberto
 * ANTES da frase de espera e é o registro que uma pessoa lê.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { gravarPassagemComNovaTentativa } from "@/lib/agent-engine/agent/inbound-turn";

function efeitos() {
  return {
    noteRunError: vi.fn<(err: Error) => void>(),
    log: {
      warn: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>(),
      error: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>(),
    },
  };
}

describe("(C01) `gravarPassagemComNovaTentativa`", () => {
  it("a primeira tentativa grava: uma chamada, nenhum log, nenhum erro registrado", async () => {
    const e = efeitos();
    const gravar = vi.fn(async () => {});
    await expect(gravarPassagemComNovaTentativa(gravar, e)).resolves.toBe("gravada");
    expect(gravar).toHaveBeenCalledTimes(1);
    expect(e.log.warn).not.toHaveBeenCalled();
    expect(e.log.error).not.toHaveBeenCalled();
    expect(e.noteRunError).not.toHaveBeenCalled();
  });

  it("a primeira falha e a segunda grava: duas chamadas, um aviso com o detalhe da primeira falha, nenhum erro registrado — o job segue", async () => {
    const e = efeitos();
    const gravar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("connection terminated unexpectedly"))
      .mockResolvedValueOnce(undefined);
    await expect(gravarPassagemComNovaTentativa(gravar, e)).resolves.toBe("gravada_na_segunda");
    expect(gravar).toHaveBeenCalledTimes(2);
    expect(e.log.warn).toHaveBeenCalledTimes(1);
    expect(e.log.warn.mock.calls[0]![0]).toMatch(/nova tentativa imediata/);
    expect(e.log.warn.mock.calls[0]![1]).toEqual({ error: "connection terminated unexpectedly" });
    expect(e.log.error).not.toHaveBeenCalled();
    expect(e.noteRunError).not.toHaveBeenCalled();
  });

  it("as duas falham: o erro da segunda vai a `noteRunError` e o log diz o que pode ter ficado pela metade e que o retry não refaz", async () => {
    const e = efeitos();
    const segunda = new Error("deadlock detected");
    const gravar = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("connection terminated unexpectedly"))
      .mockRejectedValueOnce(segunda);
    await expect(gravarPassagemComNovaTentativa(gravar, e)).resolves.toBe("falhou");
    expect(gravar).toHaveBeenCalledTimes(2);
    expect(e.log.warn).toHaveBeenCalledTimes(1);
    expect(e.log.error).toHaveBeenCalledTimes(1);
    const [mensagem, campos] = e.log.error.mock.calls[0]!;
    expect(mensagem).toMatch(/falhou duas vezes/);
    expect(mensagem).toMatch(/pode ter ficado incompleta/);
    expect(mensagem).toMatch(/force_human gravado sem o silêncio da conversa/);
    expect(mensagem).toMatch(/o retry do job não a refaz/);
    expect(mensagem).toMatch(/o caso aberto é o registro/);
    expect(mensagem).not.toMatch(/job re-tentado/);
    expect(campos).toEqual({ error: "deadlock detected" });
    expect(e.noteRunError).toHaveBeenCalledTimes(1);
    expect(e.noteRunError).toHaveBeenCalledWith(segunda);
  });

  it("não há terceira tentativa: a nova tentativa é UMA", async () => {
    const e = efeitos();
    const gravar = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("x"));
    await gravarPassagemComNovaTentativa(gravar, e);
    expect(gravar).toHaveBeenCalledTimes(2);
  });

  it("o que não é `Error` vira `Error` em `noteRunError`, e o detalhe no log é 'erro desconhecido' (sem vazar o valor)", async () => {
    const e = efeitos();
    const gravar = vi.fn<() => Promise<void>>().mockRejectedValue("string solta");
    await expect(gravarPassagemComNovaTentativa(gravar, e)).resolves.toBe("falhou");
    expect(e.log.warn.mock.calls[0]![1]).toEqual({ error: "erro desconhecido" });
    expect(e.log.error.mock.calls[0]![1]).toEqual({ error: "erro desconhecido" });
    const registrado = e.noteRunError.mock.calls[0]![0];
    expect(registrado).toBeInstanceOf(Error);
    expect(registrado.message).toBe("string solta");
  });

  it("o detalhe no log é curto: a mensagem do erro cortada em 200 caracteres", async () => {
    const e = efeitos();
    const gravar = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("e".repeat(500)));
    await gravarPassagemComNovaTentativa(gravar, e);
    expect((e.log.error.mock.calls[0]![1] as { error: string }).error).toHaveLength(200);
  });
});

describe("(C01) a ligação no fail-safe e os fatos do autor que fazem a nova tentativa valer a pena", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const PASSAGEM = readFileSync("lib/agent-engine/agent/human-handoff.ts", "utf8");

  it("o fail-safe grava a passagem por `gravarPassagemComNovaTentativa`, com o `runLog` e o `noteRunError` do turno — sem `try` solto em volta de `performHumanHandoff`", () => {
    const frase = TURNO.indexOf("body: deps.knobs.fraseDeEspera ?? FRASE_DE_ESPERA_PADRAO");
    const retorno = TURNO.indexOf("code: 'internal_vocabulary_leak_handoff'", frase);
    expect(frase).toBeGreaterThan(-1);
    expect(retorno).toBeGreaterThan(frase);
    const bloco = TURNO.slice(frase, retorno);
    expect(bloco).toMatch(
      /await gravarPassagemComNovaTentativa\(\s*\(\) =>\s*performHumanHandoff\(\s*pool,\s*\{ tenantId, leadId, conversationId: input\.conversationId \},/,
    );
    expect(bloco).toMatch(/\{ log: runLog, noteRunError \},\s*\);/);
    expect(bloco).not.toMatch(/try \{\s*await performHumanHandoff\(/);
    // O texto antigo, que afirmava o que não acontece, saiu.
    expect(TURNO).not.toMatch(/o retry refaz tudo/);
    expect(TURNO).not.toMatch(/a passagem ao humano não foi gravada — job re-tentado/);
  });

  it("`performHumanHandoff` do autor: `force_human` é a primeira escrita, as demais vêm depois, e nada em transação — o que faz a falha no meio deixar a passagem incompleta", () => {
    const inicio = PASSAGEM.indexOf("export async function performHumanHandoff(");
    expect(inicio).toBeGreaterThan(-1);
    const corpo = PASSAGEM.slice(inicio);
    const forceHuman = corpo.indexOf("update contacts set force_human = true");
    const conversa = corpo.indexOf("update conversations");
    const crons = corpo.indexOf("cancelPendingCronsForLead(db, ids.tenantId, ids.leadId)");
    const central = corpo.indexOf("insert into agent_inbox_items");
    expect(forceHuman).toBeGreaterThan(-1);
    expect(conversa).toBeGreaterThan(forceHuman);
    expect(crons).toBeGreaterThan(conversa);
    expect(central).toBeGreaterThan(crons);
    expect(corpo.slice(0, central)).not.toMatch(/query\(\s*['"`]begin/i);
    // E o contrato que torna a nova tentativa segura: idempotente, at-least-once.
    expect(PASSAGEM).toMatch(/idempotente, at-least-once/);
  });

  it("`isLeadInHandoff` lê `force_human` (e o silêncio da conversa): é por isso que o retry do job pula o turno quando só a primeira escrita pegou", () => {
    const inicio = PASSAGEM.indexOf("export async function isLeadInHandoff(");
    expect(inicio).toBeGreaterThan(-1);
    const corpo = PASSAGEM.slice(inicio, PASSAGEM.indexOf("export interface HandoffIds", inicio));
    expect(corpo).toMatch(/c\.force_human\s*or exists \(/);
    expect(corpo).toMatch(/v\.bot_silenced_until is not null and v\.bot_silenced_until > now\(\)/);
  });

  it("neste caminho 'ninguém avisado' não é o cenário: o caso `guardrail_autofallback` é aberto antes da frase de espera e da passagem", () => {
    // Dentro do turno: a escolta da preparação (rodada 3 da -c01.3), antes dele no
    // arquivo, tem a mesma ordem e é conferida em `c01-fim-sem-resposta-passa-ao-humano`.
    const turno = TURNO.indexOf("async function executarTurnoDoAgente(");
    expect(turno).toBeGreaterThan(-1);
    const caso = TURNO.indexOf("source: 'guardrail_autofallback'", turno);
    const frase = TURNO.indexOf("body: deps.knobs.fraseDeEspera ?? FRASE_DE_ESPERA_PADRAO", turno);
    const passagem = TURNO.indexOf("await gravarPassagemComNovaTentativa(", turno);
    expect(caso).toBeGreaterThan(-1);
    expect(frase).toBeGreaterThan(caso);
    expect(passagem).toBeGreaterThan(frase);
    // Sem caso aberto, a frase não sai e a passagem não acontece: o erro sobe antes.
    const entre = TURNO.slice(caso, frase);
    expect(entre).toMatch(/if \(!caso\.ok && caso\.error\.code !== 'case_already_open'\) \{/);
    expect(entre).toMatch(/noteRunError\(falha\);/);
  });
});
