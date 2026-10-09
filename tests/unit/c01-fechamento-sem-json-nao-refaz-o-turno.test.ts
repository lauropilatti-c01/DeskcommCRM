/**
 * (C01) O FECHAMENTO SEM JSON NÃO REFAZ O TURNO QUE JÁ FALOU COM O LEAD.
 *
 * Achado do laboratório (rodadas piloto-1 e geral-1, 07 e 08/10/2026): na chamada de
 * fechamento ("Feche o turno AGORA"), o modelo às vezes para sem devolver o JSON — texto
 * vazio ou uma mensagem de WhatsApp. `parseCheckpointText` lançava, o job inteiro voltava
 * à fila DEPOIS de as mensagens terem saído, e a nova tentativa refazia o turno: o lead
 * recebia outra mensagem, com outras palavras (o recibo do ledger só barra conteúdo igual).
 * 7 de 116 fechamentos da geral-1; no piloto-1, duas vezes seguidas no mesmo turno.
 *
 * As regras, por comportamento, com a chamada de fechamento falsa:
 *   - com resposta ao lead: UMA nova chamada de fechamento; sem JSON de novo, o checkpoint
 *     mínimo (o do turno anterior, com a promessa sintética e a próxima ação da equipe:
 *     `c01-fechamento-falho-deixa-pendencia`) e nada sobe;
 *   - sem resposta ao lead: o erro de sempre, com a mesma mensagem, e uma chamada só;
 *   - a chamada que LANÇA (provedor, prazo, lease, fronteira) sobe como antes.
 * O turno inteiro, contra Postgres, em `tests/invariants/c01-fechamento-sem-json-nao-refaz-o-turno`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { StaleServiceBoundaryError } from "@/lib/atendimento/fronteira";
import {
  PROMESSA_DO_FECHAMENTO_FALHO,
  PROXIMA_ACAO_DO_FECHAMENTO_FALHO,
} from "@/lib/agent-engine/agent/abertura/checkpoint";

/** Importado na hora: sem a mudança a função não existe e cada caso reprova por si. */
const CAMINHO = "@/lib/agent-engine/agent/abertura/checkpoint";
type Fechamento = {
  content: {
    commitments: string[];
    objections: string[];
    next_action: string | null;
    rolling_summary: string;
    declaracao?: unknown;
  };
  chamada: string;
  minimo: boolean;
};
async function conteudoDoFechamento(opcoes: {
  fechar: () => Promise<{ texto: string; chamada: string }>;
  leadTemResposta: boolean;
  anterior: () => Promise<unknown>;
}): Promise<Fechamento> {
  const m = (await import(/* @vite-ignore */ CAMINHO)) as {
    conteudoDoFechamento?: (o: typeof opcoes) => Promise<Fechamento>;
  };
  if (typeof m.conteudoDoFechamento !== "function") {
    throw new Error("conteudoDoFechamento não existe em abertura/checkpoint");
  }
  return m.conteudoDoFechamento(opcoes);
}

/** O que o mínimo põe de seu: a pendência do turno cujo fechamento falhou. */
const PENDENCIA = {
  next_action: PROXIMA_ACAO_DO_FECHAMENTO_FALHO,
  declaracao: {
    intencoes: [],
    promessas: [{ o_que: PROMESSA_DO_FECHAMENTO_FALHO, prazo: null }],
    nada_a_declarar: false,
  },
};

const JSON_OK = JSON.stringify({
  commitments: ["mandar o link"],
  objections: [],
  next_action: "conferir se o pagamento entrou",
  rolling_summary: "resumo novo",
  declaracao: { intencoes: [], promessas: [], nada_a_declarar: true },
});

/** O checkpoint do turno anterior, como o Postgres devolve (`select *`). */
const ANTERIOR = {
  id: "1",
  seq: "7",
  organization_id: "o",
  contact_id: "c",
  job_id: null,
  created_at: new Date(),
  commitments: ["retornar amanhã"],
  objections: ["acha caro"],
  next_action: "perguntar a área",
  rolling_summary: "o lead quer a turma da Petrobras",
  declaracao: { intencoes: [], promessas: [], nada_a_declarar: true },
};

/** A chamada de fechamento falsa: devolve os textos na ordem e conta as chamadas. */
function fechamentos(...textos: string[]) {
  let n = 0;
  const fechar = vi.fn(async () => {
    const texto = textos[n] ?? JSON_OK;
    n += 1;
    return { texto, chamada: `chamada-${n}` };
  });
  return fechar;
}

describe("(C01) fechamento sem JSON depois de resposta ao lead", () => {
  it("texto vazio duas vezes → checkpoint mínimo herdado do anterior, sem erro, duas chamadas", async () => {
    const fechar = fechamentos("", "");
    const anterior = vi.fn(async () => ANTERIOR);
    const r = await conteudoDoFechamento({ fechar, leadTemResposta: true, anterior });
    expect(fechar).toHaveBeenCalledTimes(2);
    expect(anterior).toHaveBeenCalledTimes(1);
    expect(r.minimo).toBe(true);
    expect(r.chamada).toBe("chamada-2");
    expect(r.content).toEqual({
      commitments: ["retornar amanhã"],
      objections: ["acha caro"],
      rolling_summary: "o lead quer a turma da Petrobras",
      ...PENDENCIA,
    });
  });

  it("uma mensagem de WhatsApp no lugar do JSON e depois JSON quebrado → checkpoint mínimo", async () => {
    const fechar = fechamentos(
      "Perfeito, Odete! Qualquer dúvida é só me chamar por aqui.",
      '{"commitments": [',
    );
    const r = await conteudoDoFechamento({ fechar, leadTemResposta: true, anterior: async () => ANTERIOR });
    expect(fechar).toHaveBeenCalledTimes(2);
    expect(r.minimo).toBe(true);
    expect(r.content.rolling_summary).toBe("o lead quer a turma da Petrobras");
  });

  it("JSON com o shape errado conta como sem JSON", async () => {
    const fechar = fechamentos('{"commitments": "não é lista"}', '{"objections": 3}');
    const r = await conteudoDoFechamento({ fechar, leadTemResposta: true, anterior: async () => ANTERIOR });
    expect(fechar).toHaveBeenCalledTimes(2);
    expect(r.minimo).toBe(true);
  });

  it("sem JSON e depois JSON → o checkpoint do modelo, da segunda chamada", async () => {
    const fechar = fechamentos("");
    const anterior = vi.fn(async () => ANTERIOR);
    const r = await conteudoDoFechamento({ fechar, leadTemResposta: true, anterior });
    expect(fechar).toHaveBeenCalledTimes(2);
    expect(anterior).not.toHaveBeenCalled();
    expect(r.minimo).toBe(false);
    expect(r.chamada).toBe("chamada-2");
    expect(r.content.rolling_summary).toBe("resumo novo");
    expect(r.content.declaracao).toEqual({ intencoes: [], promessas: [], nada_a_declarar: true });
  });

  it("sem checkpoint anterior → mínimo vazio", async () => {
    const r = await conteudoDoFechamento({
      fechar: fechamentos("", ""),
      leadTemResposta: true,
      anterior: async () => null,
    });
    expect(r.minimo).toBe(true);
    expect(r.content).toEqual({ commitments: [], objections: [], rolling_summary: "", ...PENDENCIA });
  });

  it("checkpoint anterior com coluna quebrada → herda só o que valida", async () => {
    const r = await conteudoDoFechamento({
      fechar: fechamentos("", ""),
      leadTemResposta: true,
      anterior: async () => ({ ...ANTERIOR, commitments: "não é lista", rolling_summary: null }),
    });
    expect(r.content).toEqual({ commitments: [], objections: ["acha caro"], rolling_summary: "", ...PENDENCIA });
  });
});

describe("(C01) o que não muda", () => {
  it("JSON na primeira chamada → uma chamada só, sem ler o anterior", async () => {
    const fechar = fechamentos(JSON_OK);
    const anterior = vi.fn(async () => ANTERIOR);
    const r = await conteudoDoFechamento({ fechar, leadTemResposta: true, anterior });
    expect(fechar).toHaveBeenCalledTimes(1);
    expect(anterior).not.toHaveBeenCalled();
    expect(r.minimo).toBe(false);
    expect(r.content.next_action).toBe("conferir se o pagamento entrou");
  });

  it("sem resposta ao lead → o erro de sempre, uma chamada só (a fila refaz o turno, que ainda não falou)", async () => {
    const fechar = fechamentos("", "");
    const anterior = vi.fn(async () => ANTERIOR);
    await expect(conteudoDoFechamento({ fechar, leadTemResposta: false, anterior })).rejects.toThrow(
      "fechamento do turno sem JSON de checkpoint — run re-tentado pela fila",
    );
    expect(fechar).toHaveBeenCalledTimes(1);
    expect(anterior).not.toHaveBeenCalled();
  });

  it("a chamada de fechamento que lança sobe como antes, na primeira e na nova tentativa", async () => {
    const naPrimeira = vi.fn(async (): Promise<{ texto: string; chamada: string }> => {
      throw new StaleServiceBoundaryError();
    });
    await expect(
      conteudoDoFechamento({ fechar: naPrimeira, leadTemResposta: true, anterior: async () => ANTERIOR }),
    ).rejects.toBeInstanceOf(StaleServiceBoundaryError);
    expect(naPrimeira).toHaveBeenCalledTimes(1);

    let n = 0;
    const naSegunda = vi.fn(async () => {
      n += 1;
      if (n === 2) throw new Error("provedor fora do ar");
      return { texto: "", chamada: `chamada-${n}` };
    });
    await expect(
      conteudoDoFechamento({ fechar: naSegunda, leadTemResposta: true, anterior: async () => ANTERIOR }),
    ).rejects.toThrow("provedor fora do ar");
    expect(naSegunda).toHaveBeenCalledTimes(2);
  });

  it("`service_boundary_stale` não refaz o turno: o worker cancela o job (terminal), nunca o devolve à fila", () => {
    // O piloto-1 (07/10) terminou com `attempts = 3` e `last_error = service_boundary_stale`,
    // o que parecia repetição POR esse erro. Não foi: as tentativas 1 e 2 caíram no
    // fechamento sem JSON (gravador: texto vazio às 22:12:36 e 22:13:12) e voltaram pelo
    // `failJob`; só a 3ª lançou `StaleServiceBoundaryError` — a cópia do agente foi pausada
    // às 22:13:53 (`ai_agent.paused` no `api_audit_log`), e o `insertCheckpoint` →
    // `guardServiceEffect` → `assertAgentOperationPg` a recusou — e o worker a cancelou.
    // O `last_error` guarda só a última. Esta é a regra que mantém isso verdade.
    const fonte = readFileSync(join(process.cwd(), "workers/agent-worker/main.ts"), "utf8").replace(/\s+/gu, " ");
    expect(fonte).toContain(
      "const terminal = err instanceof StaleServiceBoundaryError || ehVetoPermanenteDeNegocio(err);",
    );
    expect(fonte).toContain(
      "if (terminal) { await cancelJob(pool, job.id, workerId, errMsg(err), claimOfJob(job)?.acquired_at); }",
    );
  });

  it("parseCheckpointText mantém as mensagens de erro (o last_error da fila e os logs as leem)", async () => {
    const { parseCheckpointText } = await import("@/lib/agent-engine/agent/abertura/checkpoint");
    expect(() => parseCheckpointText("")).toThrow("fechamento do turno sem JSON de checkpoint — run re-tentado pela fila");
    expect(() => parseCheckpointText("{x")).toThrow("fechamento do turno sem JSON de checkpoint — run re-tentado pela fila");
    expect(() => parseCheckpointText("{x}")).toThrow("JSON de checkpoint inválido no fechamento do turno — run re-tentado pela fila");
    expect(() => parseCheckpointText('{"commitments": 1}')).toThrow(/^checkpoint do fechamento com shape inválido/);
  });
});
