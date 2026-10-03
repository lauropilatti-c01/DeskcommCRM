/**
 * (C01) A FRASE DE ESPERA QUE NÃO SAIU NÃO FECHA O TURNO COMO SE TIVESSE SAÍDO — achado
 * 3 da revisão adversarial do Codex (03/10/2026) sobre a trava 4b.
 *
 * No 3º veto de vocabulário interno, o fail-safe manda a frase de espera pela cadeia
 * (`runBeforeSend`). A cadeia pode voltar `status: 'sent'` com um `outcome` que NÃO
 * é entrega: `unavailable` (transporte do CRM fora), `queued` (sessão fora),
 * `failed`, `blocked`. O código tratava só o veto; qualquer outro resultado entrava
 * em `outcomes` e o turno fechava normal — com o CRM fora durante o aviso, o
 * cliente ficava sem a frase, o recibo ficava 'requested' e ninguém voltava para
 * mandá-lo, enquanto o envio normal registra o erro e o job re-tenta.
 *
 * Agora `desfechoDaFraseDeEspera` trata cada desfecho: só `sent`/`already_sent` é
 * cliente avisado; `unavailable` registra o erro (`noteRunError`) para o job
 * re-tentar com a MESMA identidade no ledger (sem duplicar); `queued` é o canal
 * entregando quando a sessão voltar; `failed` e `blocked` seguem para o fim do
 * turno como todo envio. E o que o modelo lê acompanha o desfecho: nunca "o cliente
 * recebeu" sem ter recebido.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  AVISO_AO_MODELO_POR_DESFECHO,
  desfechoDaFraseDeEspera,
} from "@/lib/agent-engine/agent/inbound-turn";
import type { ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import type { BeforeSendResult } from "@/lib/agent-engine/guardrails/before-send";

const enviado = (outcome: ChannelSendResult): BeforeSendResult => ({ status: "sent", outcome, trace: [] });
const vetado = (code: string): BeforeSendResult => ({ status: "vetoed", gate: "stop", code, message: "vetado", trace: [] });

function efeitos() {
  const outcomes: ChannelSendResult[] = [];
  const erros: Error[] = [];
  const log = { error: vi.fn() };
  return {
    outcomes,
    erros,
    log,
    args: { outcomes, noteRunError: (e: Error) => erros.push(e), log },
  };
}

describe("(C01) os desfechos da frase de espera, um a um", () => {
  it("`unavailable`: registra erro (o job re-tenta pela fila) e NÃO conta como cliente avisado", () => {
    const e = efeitos();
    const desfecho = desfechoDaFraseDeEspera(enviado({ kind: "unavailable", reason: "CrmTransportError" }), e.args);
    expect(desfecho).toBe("pendente");
    expect(e.erros).toHaveLength(1);
    expect(e.erros[0]!.message).toMatch(/canal indisponível \(CrmTransportError\)/);
    expect(e.erros[0]!.message).toMatch(/re-tentado pela fila/);
    expect(e.log.error).toHaveBeenCalledTimes(1);
    // O desfecho fica registrado como todo envio (telemetria do turno).
    expect(e.outcomes.map((o) => o.kind)).toEqual(["unavailable"]);
  });

  it("`sent` e `already_sent` são as ÚNICAS confirmações de entrega — sem erro, turno segue", () => {
    for (const kind of ["sent", "already_sent"] as const) {
      const e = efeitos();
      const desfecho = desfechoDaFraseDeEspera(enviado({ kind, idempotencyKey: "k", messageId: "m" }), e.args);
      expect(desfecho).toBe("entregue");
      expect(e.erros).toEqual([]);
      expect(e.log.error).not.toHaveBeenCalled();
      expect(e.outcomes.map((o) => o.kind)).toEqual([kind]);
    }
  });

  it("`queued`: o canal segurou e entrega quando a sessão voltar — não é erro, não se reenvia", () => {
    const e = efeitos();
    expect(desfechoDaFraseDeEspera(enviado({ kind: "queued", idempotencyKey: "k", messageId: null }), e.args)).toBe("a_caminho");
    expect(e.erros).toEqual([]);
    expect(e.outcomes.map((o) => o.kind)).toEqual(["queued"]);
  });

  it("`failed`: fica em `outcomes` para o fim do turno re-tentar o job, como todo envio", () => {
    const e = efeitos();
    expect(desfechoDaFraseDeEspera(enviado({ kind: "failed", idempotencyKey: "k", messageId: null }), e.args)).toBe("pendente");
    expect(e.outcomes.map((o) => o.kind)).toEqual(["failed"]);
  });

  it("`blocked`: o contato não recebe mensagens; a frase não sai e o fim do turno cancela o job", () => {
    const e = efeitos();
    expect(desfechoDaFraseDeEspera(enviado({ kind: "blocked", idempotencyKey: "k" }), e.args)).toBe("nao_sai");
    expect(e.erros).toEqual([]);
    expect(e.outcomes.map((o) => o.kind)).toEqual(["blocked"]);
  });

  it("veto da cadeia: erro registrado (o job re-tenta), nada em `outcomes`", () => {
    const e = efeitos();
    expect(desfechoDaFraseDeEspera(vetado("daily_cap"), e.args)).toBe("pendente");
    expect(e.erros.map((x) => x.message)).toEqual(["frase de espera vetada: daily_cap"]);
    expect(e.log.error).toHaveBeenCalledWith(expect.stringMatching(/frase de espera vetada/), { code: "daily_cap" });
    expect(e.outcomes).toEqual([]);
  });

  it("o que o modelo lê só diz 'o cliente recebeu' quando recebeu", () => {
    expect(AVISO_AO_MODELO_POR_DESFECHO.entregue).toMatch(/O cliente recebeu uma frase de espera/);
    for (const desfecho of ["a_caminho", "pendente", "nao_sai"] as const) {
      expect(AVISO_AO_MODELO_POR_DESFECHO[desfecho]).not.toMatch(/recebeu/);
      expect(AVISO_AO_MODELO_POR_DESFECHO[desfecho]).toMatch(/passou a uma pessoa da equipe/);
    }
    expect(AVISO_AO_MODELO_POR_DESFECHO.pendente).toMatch(/ainda não saiu e o sistema vai tentar de novo/);
  });
});

describe("(C01) a ligação no fail-safe e o fim do turno", () => {
  const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const i = FONTE.indexOf("body: deps.knobs.fraseDeEspera ?? FRASE_DE_ESPERA_PADRAO");
  const failSafe = FONTE.slice(i, FONTE.indexOf("code: 'internal_vocabulary_leak_handoff'", i));

  it("o fail-safe trata a frase por `desfechoDaFraseDeEspera` e fala ao modelo conforme o desfecho", () => {
    expect(i).toBeGreaterThan(-1);
    expect(failSafe).toMatch(/const desfecho = desfechoDaFraseDeEspera\(espera, \{ outcomes, noteRunError, log: runLog \}\);/);
    const retorno = FONTE.slice(i, FONTE.indexOf("encerre agora.',", i));
    expect(retorno).toMatch(/\$\{AVISO_AO_MODELO_POR_DESFECHO\[desfecho\]\}/);
    // Sem o atalho antigo: nenhum `outcomes.push` da frase fora da função que decide.
    expect(failSafe).not.toMatch(/outcomes\.push\(espera\.outcome\)/);
    expect(failSafe).not.toMatch(/espera\.status === 'vetoed'/);
  });

  it("o `blocker` do caso, escrito ANTES da frase sair, não afirma que o cliente a recebeu", () => {
    const titulo = FONTE.indexOf("title: 'Resposta travada pela revisão automática'");
    expect(titulo).toBeGreaterThan(-1);
    expect(titulo).toBeLessThan(i); // o caso vem antes da frase
    const blocker = FONTE.slice(FONTE.indexOf("blocker:", titulo), FONTE.indexOf("source: 'guardrail_autofallback'", titulo));
    expect(blocker).not.toMatch(/recebeu/);
    expect(blocker).toMatch(/O sistema manda uma frase de espera ' \+\s*'ao cliente \(a entrega aparece na conversa\)/);
  });

  it("o fim do turno honra o registro: `runError` derruba o job (retry pela fila) e `failed` em `outcomes` também", () => {
    expect(FONTE).toMatch(/if \(runError !== null\) \{\s*throw runError;/);
    expect(FONTE).toMatch(/if \(outcomes\.some\(\(o\) => o\.kind === 'failed'\)\) \{[\s\S]*?throw new Error\(/);
  });
});
