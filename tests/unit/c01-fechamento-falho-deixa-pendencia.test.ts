/**
 * (C01) O FECHAMENTO QUE FALHOU DEPOIS DA RESPOSTA DEIXA A PENDÊNCIA COM DONO.
 *
 * Bloqueio da revisão independente (08/10/2026) do "fechamento sem JSON não refaz o
 * turno": a resposta ao lead foi "Combinado, te chamo amanhã às 10h", o agendamento é
 * do Operador, e os dois fechamentos vieram vazios. O checkpoint mínimo guardava só o
 * do turno anterior, com `next_action` nulo e a declaração ausente — e declaração nula
 * vira zero promessas em `promessasEmAberto`, o que dispensa a apuração de responsável
 * (`apurarComRetorno` devolve `null` sem consultar nada). O Operador recebia o briefing
 * genérico, sem a promessa, e o job terminava verde sem agendamento nem aviso.
 *
 * O conserto, pelo caminho que o Operador já percorre: o mínimo leva uma promessa
 * sintética ("conferir na conversa se ela prometeu…") e uma próxima ação com a equipe
 * como responsável. Aqui, o mínimo é lido como o Operador o leria do banco, e a
 * apuração é chamada de verdade (com as buscas de retorno e de caso falsas). O turno
 * inteiro contra Postgres, com o aviso na Central quando não há Operador, está em
 * `tests/invariants/c01-fechamento-sem-json-nao-refaz-o-turno`.
 */
import { describe, expect, it, vi } from "vitest";

import { checkpointContentSchema, conteudoDoFechamento } from "@/lib/agent-engine/agent/abertura/checkpoint";
import { promessasEmAberto, renderDeclaracaoParaHumano } from "@/lib/agent-engine/agent/declaracao";
import {
  apurarComRetorno,
  decidirSeRoda,
  lerDeclaracaoDoTurno,
  renderBriefingDoOperador,
} from "@/lib/agent-engine/agent/operator-turn";

/** O checkpoint do turno anterior, como o Postgres devolve: nada prometido ainda. */
const ANTERIOR = {
  commitments: ["mandar o link da turma"],
  objections: [],
  next_action: "perguntar a área",
  rolling_summary: "o lead quer saber quando abre a próxima turma",
  declaracao: { intencoes: [], promessas: [], nada_a_declarar: true },
};

/**
 * O turno da revisão: a resposta "Combinado, te chamo amanhã às 10h" já saiu (por isso
 * `leadTemResposta`) e os dois fechamentos vêm vazios.
 */
async function fechamentoQueFalhou() {
  const fechar = vi.fn(async () => ({ texto: "", chamada: "fechamento" }));
  const r = await conteudoDoFechamento({ fechar, leadTemResposta: true, anterior: async () => ANTERIOR });
  expect(fechar).toHaveBeenCalledTimes(2);
  expect(r.minimo).toBe(true);
  return r.content;
}

/**
 * O checkpoint gravado e lido pelo Operador: `insertCheckpoint` grava a declaração em
 * jsonb (`null` quando ausente) e `lerDeclaracaoDoTurno` a lê pela chave do turno.
 */
async function comoOOperadorLe(content: Awaited<ReturnType<typeof fechamentoQueFalhou>>) {
  const row = {
    ...content,
    declaracao: content.declaracao === undefined ? null : JSON.parse(JSON.stringify(content.declaracao)),
  };
  const db = { query: async () => ({ rows: [row] }) };
  return lerDeclaracaoDoTurno(db as never, "org", "contato", "job-do-turno");
}

describe("(C01) fechamento vazio duas vezes depois da resposta: a pendência não morre", () => {
  it("o mínimo leva uma promessa sintética que manda conferir a conversa", async () => {
    const content = await fechamentoQueFalhou();
    // Mesmo contrato do JSON do modelo: o mínimo passa pelo schema do checkpoint.
    expect(checkpointContentSchema.parse(content)).toEqual(content);
    expect(content.declaracao?.nada_a_declarar).toBe(false);
    expect(content.declaracao?.promessas).toHaveLength(1);
    expect(content.declaracao?.promessas[0]?.o_que).toMatch(
      /fechamento do turno falhou depois da resposta ao lead: conferir na conversa se ela prometeu retorno, horário ou verificação/,
    );
    // O que vem do anterior continua vindo.
    expect(content.commitments).toEqual(["mandar o link da turma"]);
    expect(content.rolling_summary).toBe("o lead quer saber quando abre a próxima turma");
  });

  it("a próxima ação não é nula, nem a do anterior: é a conferência, com a equipe como responsável", async () => {
    const content = await fechamentoQueFalhou();
    expect(content.next_action).not.toBeNull();
    expect(content.next_action).not.toBe(ANTERIOR.next_action);
    expect(content.next_action).toMatch(/Equipe: conferir na conversa/);
  });

  it("o Operador lê a promessa, roda com ela no briefing e a apuração de responsável acontece", async () => {
    const { declaracao, houveCheckpoint } = await comoOOperadorLe(await fechamentoQueFalhou());
    expect(houveCheckpoint).toBe(true);
    const promessas = promessasEmAberto(declaracao);
    expect(promessas).toHaveLength(1);

    expect(decidirSeRoda({ papelLigado: true, declaracao })).toEqual({ roda: true });
    const briefing = renderBriefingDoOperador(declaracao, promessas);
    expect(briefing).toContain("O que foi prometido a ela (precisa existir no sistema):");
    expect(briefing).toContain("conferir na conversa se ela prometeu retorno, horário ou verificação");

    // A apuração: sem retorno vivo, sem caso aberto e sem ferramenta chamada, ninguém
    // ficou responsável — é o que abre a promessa sem dono na timeline e na Central.
    const buscaRetorno = vi.fn(async () => null);
    const buscaCaso = vi.fn(async () => false);
    const dono = await apurarComRetorno(
      {} as never,
      "org",
      "contato",
      promessas.length,
      { ferramentasChamadas: [], operadorRodou: true, operadorTemFerramentas: true, conversationId: "conversa" },
      buscaRetorno,
      buscaCaso,
    );
    expect(buscaRetorno).toHaveBeenCalledWith("org", "contato");
    expect(buscaCaso).toHaveBeenCalledWith("org", "conversa");
    expect(dono).toEqual({ assumida: false, porque: "operador_nao_agiu" });
  });

  it("com retorno já agendado, a apuração reconhece o dono e não acusa", async () => {
    const { declaracao } = await comoOOperadorLe(await fechamentoQueFalhou());
    const dono = await apurarComRetorno(
      {} as never,
      "org",
      "contato",
      promessasEmAberto(declaracao).length,
      { ferramentasChamadas: [], operadorRodou: true, operadorTemFerramentas: true, conversationId: "conversa" },
      async () => ({ id: "retorno" }),
      async () => false,
    );
    expect(dono).toEqual({ assumida: true, por: "retorno_agendado" });
  });

  it("quem recebe a passagem para pessoa vê a pendência no resumo do turno", async () => {
    const { declaracao } = await comoOOperadorLe(await fechamentoQueFalhou());
    expect(renderDeclaracaoParaHumano(declaracao)).toContain(
      "Prometido a ela: (C01) o fechamento do turno falhou depois da resposta ao lead",
    );
  });
});
