/**
 * (C01, -c01.15, P3) ORÇAMENTO DE IA ESGOTADO COM A PASSAGEM DESLIGADA.
 *
 * Com a passagem ligada, a escolta do orçamento (`comHandoffSeOrcamentoAcabar`) avisa o
 * lead de que uma pessoa vai assumir e grava a passagem (`performHumanHandoff`:
 * `force_human`, `bot_silenced_until = 'infinity'`). Com a passagem desligada na versão
 * publicada do agente, a IA para do mesmo jeito (o erro sobe e o job é cancelado), mas a
 * conversa não cala: abre um caso para a equipe (origem de fail-safe, título próprio) e,
 * só quando o caso é novo, manda "Vou verificar pra você e já te retorno." pela cadeia de
 * envio. Sem passagem gravada, sem silêncio.
 *
 * O caminho da escolta é exercitado com um pool falso, como em
 * `tests/unit/handoff-por-orcamento.test.ts`; a ligação no `runAgentTurn` (o turno
 * inteiro não é alcançável por unidade) é medida no texto.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/leads/handoff-stage-move", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/handoff-stage-move")>()),
  moverLeadParaEtapaDeHandoff: vi.fn(async () => undefined),
}));
vi.mock("@/lib/supabase/admin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase/admin")>()),
  createAdminClient: vi.fn(() => ({})),
}));

import { comHandoffSeOrcamentoAcabar } from "@/lib/agent-engine/agent/inbound-turn";
import type { DesfechoDoAviso } from "@/lib/agent-engine/agent/aviso-de-escalacao";
import { LlmBudgetExceededError } from "@/lib/agent-engine/edge/llm/run-model-call";
import { moverLeadParaEtapaDeHandoff } from "@/lib/leads/handoff-stage-move";
import {
  BLOQUEIO_DO_CASO_POR_ORCAMENTO,
  FRASE_DE_VERIFICACAO,
  TITULO_DO_CASO_POR_ORCAMENTO,
} from "@/lib/c01/passagem-desligada";
import { montarBriefingDaPassagem } from "@/lib/escalacao/briefing-da-passagem";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const CASO = "44444444-4444-4444-8444-444444444444";

interface Chamada {
  sql: string;
  params: unknown[];
}

/** Pool falso: guarda o que a escolta escreve; o `insert into agent_cases` devolve o caso novo ou nada (já havia). */
function poolFalso(opts: { casoJaAberto?: boolean; falhaNoCaso?: boolean } = {}) {
  const chamadas: Chamada[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (sql.includes("insert into agent_cases")) {
      if (opts.falhaNoCaso) throw new Error("banco fora");
      return opts.casoJaAberto ? { rows: [], rowCount: 0 } : { rows: [{ case_id: CASO }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query } as never, chamadas };
}

function logFalso() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function contexto(
  pool: unknown,
  log: unknown,
  opts: {
    avisarLead?: ReturnType<typeof vi.fn>;
    passagemDesligada?: () => Promise<boolean>;
  } = {},
) {
  return {
    pool: pool as never,
    tenantId: ORG,
    leadId: LEAD,
    conversationId: CONVERSA,
    briefingDoCheckpoint: async () =>
      montarBriefingDaPassagem({
        checkpoint: {
          commitments: ["enviar orçamento"],
          objections: [],
          next_action: "ligar amanhã",
          rolling_summary: "",
        },
      }),
    avisarLead: (opts.avisarLead ?? vi.fn(async (): Promise<DesfechoDoAviso> => ({ avisado: true }))) as never,
    ...(opts.passagemDesligada !== undefined ? { passagemDesligada: opts.passagemDesligada } : {}),
    log: log as never,
  };
}

const gravouPassagem = (chamadas: Chamada[]) =>
  chamadas.some(
    (c) =>
      c.sql.includes("force_human = true") ||
      c.sql.includes("bot_silenced_until") ||
      c.sql.includes("insert into passagens_de_atendimento"),
  );
const insertDoCaso = (chamadas: Chamada[]) => chamadas.find((c) => c.sql.includes("insert into agent_cases"));

/** O `moverLeadParaEtapaDeHandoff` roda numa promessa adiada (best-effort): espera ela assentar. */
const assentar = () => new Promise((r) => setTimeout(r, 0));

describe("(C01, -c01.15) a escolta do orçamento com a passagem desligada", () => {
  it("o erro sobe, nada de passagem: sem `force_human`, sem silêncio, sem linha de passagem", async () => {
    const { pool, chamadas } = poolFalso();
    const erro = new LlmBudgetExceededError();

    await expect(
      comHandoffSeOrcamentoAcabar(contexto(pool, logFalso(), { passagemDesligada: async () => true }), async () => {
        throw erro;
      }),
    ).rejects.toBe(erro);

    expect(gravouPassagem(chamadas), chamadas.map((c) => c.sql).join(" | ")).toBe(false);
    expect(chamadas.some((c) => c.sql.includes("update cron_jobs"))).toBe(false);
    expect(chamadas.some((c) => c.sql.includes("agent_inbox_items"))).toBe(false);
  });

  it("abre um caso de fail-safe para a equipe, com título e bloqueio próprios e o contexto do checkpoint", async () => {
    vi.mocked(moverLeadParaEtapaDeHandoff).mockClear();
    const { pool, chamadas } = poolFalso();

    await expect(
      comHandoffSeOrcamentoAcabar(contexto(pool, logFalso(), { passagemDesligada: async () => true }), async () => {
        throw new LlmBudgetExceededError();
      }),
    ).rejects.toThrow();

    const caso = insertDoCaso(chamadas);
    expect(caso, "nenhum caso aberto").toBeDefined();
    const p = caso!.params;
    expect(p[0]).toBe(ORG);
    expect(p[1]).toBe(CONVERSA);
    expect(p[2]).toBeNull();
    expect(p[3]).toBe(TITULO_DO_CASO_POR_ORCAMENTO);
    expect(String(p[4])).toContain("enviar orçamento");
    expect(p[5]).toBe(BLOQUEIO_DO_CASO_POR_ORCAMENTO);
    expect(p[7]).toBe("guardrail_autofallback");
    // O card vai à etapa de passagem, em best-effort, com o motivo deste caminho.
    await assentar();
    expect(moverLeadParaEtapaDeHandoff).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: ORG, leadId: LEAD, reason: "orcamento_sem_passagem" }),
    );
  });

  it("caso novo: manda a frase de verificação, uma vez, pela mesma porta do aviso", async () => {
    const { pool } = poolFalso();
    const avisarLead = vi.fn(async (): Promise<DesfechoDoAviso> => ({ avisado: true }));

    await expect(
      comHandoffSeOrcamentoAcabar(
        contexto(pool, logFalso(), { avisarLead, passagemDesligada: async () => true }),
        async () => {
          throw new LlmBudgetExceededError();
        },
      ),
    ).rejects.toThrow();

    expect(avisarLead).toHaveBeenCalledTimes(1);
    expect(avisarLead).toHaveBeenCalledWith(FRASE_DE_VERIFICACAO);
    expect(FRASE_DE_VERIFICACAO).toBe("Vou verificar pra você e já te retorno.");
  });

  it("caso já aberto (`case_already_open`): nada sai ao lead — a frase não se repete a cada mensagem", async () => {
    const { pool, chamadas } = poolFalso({ casoJaAberto: true });
    const avisarLead = vi.fn(async (): Promise<DesfechoDoAviso> => ({ avisado: true }));
    const erro = new LlmBudgetExceededError();

    await expect(
      comHandoffSeOrcamentoAcabar(
        contexto(pool, logFalso(), { avisarLead, passagemDesligada: async () => true }),
        async () => {
          throw erro;
        },
      ),
    ).rejects.toBe(erro);

    expect(insertDoCaso(chamadas)).toBeDefined();
    expect(avisarLead).not.toHaveBeenCalled();
    expect(gravouPassagem(chamadas)).toBe(false);
  });

  it("frase que falha não impede o erro de subir nem grava passagem", async () => {
    const { pool, chamadas } = poolFalso();
    const log = logFalso();
    const avisarLead = vi.fn(async (): Promise<DesfechoDoAviso> => {
      throw new Error("canal fora");
    });
    const erro = new LlmBudgetExceededError();

    await expect(
      comHandoffSeOrcamentoAcabar(contexto(pool, log, { avisarLead, passagemDesligada: async () => true }), async () => {
        throw erro;
      }),
    ).rejects.toBe(erro);

    expect(avisarLead).toHaveBeenCalledTimes(1);
    expect(gravouPassagem(chamadas)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("frase de verificação falhou"),
      expect.objectContaining({ error: "canal fora" }),
    );
  });

  it("caso que não abre (banco fora): o erro do banco sobe (o job re-tenta), e nada sai ao lead", async () => {
    const { pool, chamadas } = poolFalso({ falhaNoCaso: true });
    const avisarLead = vi.fn(async (): Promise<DesfechoDoAviso> => ({ avisado: true }));

    await expect(
      comHandoffSeOrcamentoAcabar(
        contexto(pool, logFalso(), { avisarLead, passagemDesligada: async () => true }),
        async () => {
          throw new LlmBudgetExceededError();
        },
      ),
    ).rejects.toThrow("banco fora");

    expect(avisarLead).not.toHaveBeenCalled();
    expect(gravouPassagem(chamadas)).toBe(false);
  });

  it("caminho feliz: a passagem não é nem consultada", async () => {
    const { pool, chamadas } = poolFalso();
    const passagemDesligada = vi.fn(async () => true);

    await expect(
      comHandoffSeOrcamentoAcabar(contexto(pool, logFalso(), { passagemDesligada }), async () => "turno ok"),
    ).resolves.toBe("turno ok");

    expect(passagemDesligada).not.toHaveBeenCalled();
    expect(chamadas).toEqual([]);
  });
});

describe("(C01, -c01.15) com a passagem ligada, nada muda", () => {
  for (const [nome, passagemDesligada] of [
    ["passagem ligada (`false`)", async () => false],
    ["sem a pergunta (o de hoje)", undefined],
  ] as const) {
    it(`${nome}: aviso sem corpo próprio, passagem gravada e nenhum caso`, async () => {
      const { pool, chamadas } = poolFalso();
      const avisarLead = vi.fn(async (): Promise<DesfechoDoAviso> => ({ avisado: true }));
      const erro = new LlmBudgetExceededError();

      await expect(
        comHandoffSeOrcamentoAcabar(
          contexto(pool, logFalso(), {
            avisarLead,
            ...(passagemDesligada !== undefined ? { passagemDesligada } : {}),
          }),
          async () => {
            throw erro;
          },
        ),
      ).rejects.toBe(erro);

      expect(avisarLead).toHaveBeenCalledTimes(1);
      expect(avisarLead.mock.calls[0]).toEqual([]);
      expect(chamadas.some((c) => c.sql.includes("set force_human = true"))).toBe(true);
      expect(chamadas.some((c) => c.sql.includes("insert into passagens_de_atendimento"))).toBe(true);
      expect(insertDoCaso(chamadas)).toBeUndefined();
    });
  }
});

describe("(C01, -c01.15) a ligação no `runAgentTurn`, pelo código", () => {
  const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const inicio = FONTE.indexOf("export async function runAgentTurn(");
  const fim = FONTE.indexOf("() => executarTurnoDoAgente(deps, job, pool, ctx, input),", inicio);
  const escolta = FONTE.slice(inicio, fim);

  it("a escolta recebe a pergunta da passagem: primeiro a marca do turno, depois a versão publicada da conversa", () => {
    expect(inicio).toBeGreaterThan(-1);
    expect(fim).toBeGreaterThan(inicio);
    expect(escolta).toMatch(
      /passagemDesligada: async \(\) => \{\s*if \(marca\.passagemDesligada !== undefined\) return marca\.passagemDesligada;/,
    );
    const marca = escolta.indexOf("return marca.passagemDesligada;");
    const conversa = escolta.indexOf("passagemDesligadaNaConversa(");
    expect(conversa).toBeGreaterThan(marca);
    // A leitura que falha cai na passagem de hoje (nunca lança).
    expect(escolta.slice(conversa)).toMatch(/\} catch \{\s*return false;\s*\}/);
  });

  it("o aviso leva o corpo quando a escolta o passa (a frase de verificação), e só então", () => {
    expect(escolta).toMatch(/avisarLead: \(corpo\) =>\s*avisarLeadLendoOContato\(/);
    expect(escolta).toMatch(/\.\.\.\(corpo !== undefined \? \{ corpo \} : \{\}\),/);
  });

  it("a marca é preenchida no turno com a versão publicada do agente", () => {
    expect(FONTE).toMatch(/marca\.passagemDesligada = passagemDesligada\(agentConfig\);/);
  });
});
