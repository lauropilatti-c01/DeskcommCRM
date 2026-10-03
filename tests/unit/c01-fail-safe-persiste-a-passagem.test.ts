/**
 * (C01) O FAIL-SAFE DE VOCABULÁRIO INTERNO PERSISTE A PASSAGEM AO HUMANO — achado 2
 * da quarta revisão adversarial do Codex (03/10/2026, rodada 5).
 *
 * No 3º veto, o fail-safe abria um caso (`openCase`), movia o lead de etapa em
 * best-effort e ligava `passadoAoHumano` — só na closure. `openCase` não grava
 * `force_human` nem `bot_silenced_until`, que é o que `isLeadInHandoff` lê no início
 * de cada turno; a etapa de passagem é opt-in do tenant. Num pipeline sem essa etapa, a
 * próxima mensagem do cliente (ou o retry do job) voltava ao modelo, que respondia
 * normalmente — depois de o cliente ler "Uma pessoa continua a conversa com você por
 * aqui".
 *
 * Agora o fail-safe chama o mecanismo canônico (`performHumanHandoff`: `force_human`,
 * silêncio durável, crons cancelados, aviso na Central) DEPOIS da frase de espera — a
 * ordem é obrigação, não estilo: `force_human` arma o `stopGate` que vetaria a frase.
 * O desfecho da frase vai junto, traduzido para o vocabulário que a Central já lê
 * ("essa pessoa sabe que estou vindo?"), e nunca diz "avisado" sem entrega.
 *
 * Sem `passagem` (a linha de `passagens_de_atendimento`): as listas de origem e de
 * motivo são fechadas no código E no banco (CHECK da migration 0291), e nenhuma
 * descreve "a revisão automática travou a resposta da IA" sem mentir na tela —
 * `caso_escalado` é "Uma pessoa da equipe escalou um atendimento". Valor novo é
 * migration, fora do alcance desta branch. O caso `guardrail_autofallback` é o
 * registro: ele carrega o texto vetado, que é o que a pessoa precisa ler.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  AVISO_AO_MODELO_POR_DESFECHO,
  MOTIVO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO,
  TITULO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO,
  avisoAoLeadPelaFraseDeEspera,
  desfechoDaFraseDeEspera,
} from "@/lib/agent-engine/agent/inbound-turn";
import type { ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import type { BeforeSendResult } from "@/lib/agent-engine/guardrails/before-send";

const enviado = (outcome: ChannelSendResult): BeforeSendResult => ({
  status: "sent",
  outcome,
  trace: [],
});
const vetado = (code: string): BeforeSendResult => ({
  status: "vetoed",
  gate: "stop",
  code,
  message: "vetado",
  trace: [],
});

describe("(C01) o desfecho da frase de espera vira o aviso da Central, no vocabulário de `avisarLeadDaEscalacao`", () => {
  it("`sent` e `already_sent` são as ÚNICAS entregas: só elas dizem 'avisado'", () => {
    for (const kind of ["sent", "already_sent"] as const) {
      expect(
        avisoAoLeadPelaFraseDeEspera(enviado({ kind, idempotencyKey: "k", messageId: "m" })),
      ).toEqual({
        avisado: true,
      });
    }
  });

  it("`queued`: ficou na fila com o canal fora — o cliente ainda não recebeu", () => {
    expect(
      avisoAoLeadPelaFraseDeEspera(
        enviado({ kind: "queued", idempotencyKey: "k", messageId: null }),
      ),
    ).toEqual({
      avisado: false,
      porque: "na_fila_canal_fora",
      motivoCodigo: "na_fila_canal_fora",
    });
  });

  it("`failed` e `unavailable`: falhou no envio (o par fechado que a tela traduz)", () => {
    expect(
      avisoAoLeadPelaFraseDeEspera(
        enviado({ kind: "failed", idempotencyKey: "k", messageId: null }),
      ),
    ).toEqual({
      avisado: false,
      porque: "canal_falhou",
      motivoCodigo: "falhou_no_envio",
    });
    expect(
      avisoAoLeadPelaFraseDeEspera(enviado({ kind: "unavailable", reason: "CrmTransportError" })),
    ).toEqual({
      avisado: false,
      porque: "canal_indisponivel",
      motivoCodigo: "falhou_no_envio",
    });
  });

  it("`blocked`: sem par no vocabulário fechado, como em `avisarLeadDaEscalacao` — não se inventa motivo", () => {
    expect(avisoAoLeadPelaFraseDeEspera(enviado({ kind: "blocked", idempotencyKey: "k" }))).toEqual(
      {
        avisado: false,
        porque: "contato_bloqueado",
      },
    );
  });

  it("veto da cadeia: leva o código do gate e o par fechado quando há (os mesmos cinco de `CODIGO_DO_VETO`)", () => {
    expect(avisoAoLeadPelaFraseDeEspera(vetado("messaging_window_closed"))).toEqual({
      avisado: false,
      porque: "messaging_window_closed",
      motivoCodigo: "fora_da_janela",
    });
    expect(avisoAoLeadPelaFraseDeEspera(vetado("missing_phone_number"))).toEqual({
      avisado: false,
      porque: "missing_phone_number",
      motivoCodigo: "sem_telefone",
    });
    // Veto sem par: a tela diz "motivo desconhecido", que é a verdade disponível.
    expect(avisoAoLeadPelaFraseDeEspera(vetado("daily_cap"))).toEqual({
      avisado: false,
      porque: "daily_cap",
    });
  });
});

describe("(C01) os textos param de prometer um reenvio que a passagem gravada impede", () => {
  it("o motivo gravado em `last_handoff_reason` e o título da Central são frases legíveis, sem jargão", () => {
    for (const texto of [
      MOTIVO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO,
      TITULO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO,
    ]) {
      expect(texto).toMatch(/revisão automática/);
      expect(texto).not.toMatch(/_/);
    }
    // Sem `passagem`, o corpo da Central é `Motivo: <reason>.` — o motivo tem de
    // dizer, sozinho, por que a conversa está com a pessoa e quem fala em seguida.
    expect(MOTIVO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO).toMatch(/vocabulário interno/);
    expect(MOTIVO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO).toMatch(/uma pessoa precisa responder/);
    expect(TITULO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO).toMatch(/assumir a conversa/);
  });

  it("o que o modelo lê quando a frase ficou pendente: a passagem aconteceu, a equipe sabe que o cliente não foi avisado", () => {
    expect(AVISO_AO_MODELO_POR_DESFECHO.pendente).toMatch(/passou a uma pessoa da equipe/);
    expect(AVISO_AO_MODELO_POR_DESFECHO.pendente).toMatch(/não saiu/);
    expect(AVISO_AO_MODELO_POR_DESFECHO.pendente).toMatch(/equipe (lê|sabe)/);
    expect(AVISO_AO_MODELO_POR_DESFECHO.pendente).not.toMatch(
      /vai tentar de novo|re-tenta|recebeu/,
    );
  });

  it("`unavailable` continua registrando o erro, mas o erro diz o que o retry faz de verdade: nada sai para quem já está com uma pessoa", () => {
    const outcomes: ChannelSendResult[] = [];
    const erros: Error[] = [];
    const log = { error: vi.fn() };
    const desfecho = desfechoDaFraseDeEspera(
      enviado({ kind: "unavailable", reason: "CrmTransportError" }),
      {
        outcomes,
        noteRunError: (e) => erros.push(e),
        log,
      },
    );
    expect(desfecho).toBe("pendente");
    expect(erros).toHaveLength(1);
    expect(erros[0]!.message).toMatch(/canal indisponível \(CrmTransportError\)/);
    expect(erros[0]!.message).toMatch(/passagem (ao humano )?fica gravada/);
    expect(erros[0]!.message).not.toMatch(/re-tentado pela fila/);
    expect(log.error).toHaveBeenCalledTimes(1);
    const [mensagem] = log.error.mock.calls[0]!;
    expect(mensagem).not.toMatch(/re-tentado pela fila/);
    expect(mensagem).toMatch(/Central/);
  });
});

describe("(C01) a ligação no fail-safe, pelo código", () => {
  const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const frase = FONTE.indexOf("body: deps.knobs.fraseDeEspera ?? FRASE_DE_ESPERA_PADRAO");
  const desfecho = FONTE.indexOf(
    "const desfecho = desfechoDaFraseDeEspera(espera, { outcomes, noteRunError, log: runLog });",
    frase,
  );
  const retorno = FONTE.indexOf("code: 'internal_vocabulary_leak_handoff'", desfecho);
  const passagem = FONTE.slice(desfecho, retorno);

  it("`performHumanHandoff` entra no fail-safe DEPOIS da frase de espera e do seu desfecho, ANTES do retorno ao modelo", () => {
    expect(frase).toBeGreaterThan(-1);
    expect(desfecho).toBeGreaterThan(frase);
    expect(retorno).toBeGreaterThan(desfecho);
    expect(passagem).toMatch(
      /performHumanHandoff\(\s*pool,\s*\{ tenantId, leadId, conversationId: input\.conversationId \},/,
    );
    // A frase sai antes porque `force_human` arma o `stopGate` (ordem do autor nos
    // outros gatilhos): nenhuma passagem entre `openCase` e a frase.
    const caso = FONTE.lastIndexOf("source: 'guardrail_autofallback'", frase);
    expect(caso).toBeGreaterThan(-1);
    expect(FONTE.slice(caso, frase)).not.toMatch(/performHumanHandoff/);
  });

  it("vai com motivo legível, título próprio, resumo do checkpoint e o desfecho da frase — e SEM `passagem` (não há origem no vocabulário fechado)", () => {
    expect(passagem).toMatch(/reason: MOTIVO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO,/);
    expect(passagem).toMatch(/inboxTitle: TITULO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO,/);
    expect(passagem).toMatch(/conversationSummary: buildHandoffSummary\(previous\),/);
    expect(passagem).toMatch(/avisoAoLead: avisoAoLeadPelaFraseDeEspera\(espera\),/);
    expect(passagem).toMatch(/log: runLog,/);
    expect(passagem).not.toMatch(/passagem:/);
  });

  it("falha na passagem não some: uma nova tentativa imediata e, falhando de novo, `noteRunError` — o modelo é mandado encerrar do mesmo jeito", () => {
    // (Rodada 6) A passagem é at-least-once com `force_human` primeiro: o retry do job
    // não a refaz. Por isso a nova tentativa fica aqui, em `gravarPassagemComNovaTentativa`
    // (teste próprio: `c01-passagem-com-nova-tentativa`), e não num `try` solto.
    expect(passagem).toMatch(
      /await gravarPassagemComNovaTentativa\(\s*\(\) =>\s*performHumanHandoff\(/,
    );
    expect(passagem).toMatch(/\{ log: runLog, noteRunError \},\s*\);/);
    expect(passagem).not.toMatch(/try \{\s*await performHumanHandoff\(/);
  });

  it("o que já havia continua: caso aberto antes, etapa de passagem em best-effort, `passadoAoHumano` na closure", () => {
    const antes = FONTE.slice(FONTE.lastIndexOf("source: 'guardrail_autofallback'", frase), frase);
    expect(antes).toMatch(/openedCaseThisTurn = true;/);
    expect(antes).toMatch(/moverParaHandoffBestEffort\('vocabulario_interno_autofallback'\);/);
    expect(antes).toMatch(/passadoAoHumano = true;/);
  });
});
