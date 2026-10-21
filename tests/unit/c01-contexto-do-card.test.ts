/**
 * (C01, -c01.16) O CONTEXTO DO CARD que o modelo lê: os campos definidos no funil
 * entram primeiro, na ordem do funil, com tetos de 30 campos e 1.400 caracteres.
 * Antes, o corte seguia a ordem do `jsonb` (chave curta primeiro) com 20 campos e 800
 * caracteres, e o lead antigo perdia `plano_oferecido`, `inscrito_tp2026` e
 * `objecao_principal`. Card sem definição no funil continua como antes.
 * Ver `lib/agent-engine/edge/crm/card-do-contato.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { projetarRetornoDeTool } from "@/lib/agent-engine/agent/projecao";
import {
  camposCompactosDoCard,
  lerCardDoContato,
  TETO_DE_CAMPOS_COM_FUNIL,
  TETO_DE_CAMPOS_NO_CONTEXTO,
  TETO_DO_BLOCO_COM_FUNIL,
  TETO_DO_BLOCO_NO_CONTEXTO,
} from "@/lib/agent-engine/edge/crm/card-do-contato";

/** A ordem em que o Postgres devolve um `jsonb`: chave mais curta primeiro, depois a ordem dos bytes. */
function comoJsonb(o: Record<string, unknown>): Record<string, unknown> {
  const chaves = Object.keys(o).sort((a, b) => {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length !== bb.length ? ba.length - bb.length : Buffer.compare(ba, bb);
  });
  return Object.fromEntries(chaves.map((k) => [k, o[k]]));
}

// Os cenários de `lab/operador/contexto_do_card.py` (crm-agentico), fictícios.
const T = "2026-10-20T18:41:50+00:00";
const A = {
  escolaridade: "Engenharia", formacao_texto: "engenharia mecanica", formacao_chave: "Engenharia Mecânica",
  empresa_alvo: "Petrobras", enfase_nome: "ENGENHARIA DE EQUIPAMENTOS – MECÂNICA", enfase_chave: "PB-NS-2021#12",
  produto_chave: "mecanica", elegibilidade: "Entra direto",
  formacao_em: T, empresa_em: T, enfase_em: T, formulario_curto_concluido_em: T, formulario_respondido_em: T,
  formulario_versao: "qualificacao_curta_v1", formulario_lembretes: 0, formulario_enviado_em: T,
  formulario_enviado_versao: "qualificacao_curta_v1",
  qualificacao_datas: JSON.stringify({ escolaridade: "2026-10-20", empresa_alvo: "2026-10-20" }),
  qualificacao_pendente: "decisao,conhece_preparacao,momento,aluno",
  campanha_entrada: "grupo-will", campanha_em: T, politica_oferta: "lado-a-lado",
  _campanha_decisao: "reconhecida", cronograma_status: "enviado", _cronograma_em: T,
  acesso_status: "pendente", _acesso_em: T,
  _exp_formulario: "curto", _exp_espera: "15min", _exp_versao: "h1h2-v1", _exp_em: T,
};
const B = {
  ...A, decisao_concurso: "considerando", conhece_preparacao: "não",
  consciencia: "Sabe que pode e não escolheu a ênfase", situacao_estudo: "Ainda não começou",
  tempo_por_dia: "1 a 2 horas", aluno_zero1: false, acesso_status: "cancelado:respondeu", qualificacao_pendente: "",
  o_que_trava: "trabalho em turno e não sei por onde começar a estudar para a prova",
  objetivo: "sair do emprego atual e entrar na Petrobras como engenheiro",
  next_action: "Mostrar a rotina do cargo e o salário antes de falar de preço; perguntar o tempo até a prova.",
  need: "organizar os estudos", timeline: "próximo edital",
};
const C = {
  ...B, codigo_origem: "fb-ep-b", codigo_teste: "S1207142", inscrito_tp2026: "Não",
  marina_status: "respondida", marina_em: "2026-10-08T00:20:16+00:00",
  plano_oferecido: "pb-12m-superior", objecao_principal: "Preço", sem_preparacao: "",
};

// Os campos definidos no funil padrão do laboratório (`vendas-petrobras-laboratorio`), na ordem dele.
const FUNIL = [
  "escolaridade", "formacao_texto", "formacao_chave", "inscrito_tp2026", "enfase_inscrita_tp2026", "quer_curso_tecnico",
  "aluno_zero1", "consciencia", "codigo_teste", "codigo_origem", "empresa_alvo", "enfase_chave", "enfase_nome",
  "elegibilidade", "produto_chave", "situacao_estudo", "tempo_por_dia", "marina_status", "marina_em", "o_que_trava",
  "custo_de_esperar", "objetivo", "plano_oferecido", "plano_abaixo_motivo", "forma_pagamento", "objecao_principal",
  "retorno_combinado", "pagamento_confirmado", "perda_anotada", "campanha_entrada", "campanha_em", "politica_oferta",
  "cronograma_status", "acesso_status", "formulario_curto_concluido_em", "qualificacao_pendente", "sem_preparacao",
  "decisao_concurso", "conhece_preparacao",
];
const DO_ATENDIMENTO = ["plano_oferecido", "inscrito_tp2026", "objecao_principal"];

describe("camposCompactosDoCard com a ordem do funil", () => {
  it("lead antigo (cenário C, na ordem do jsonb): sem o funil perde campo de atendimento; com o funil, não", () => {
    const card = comoJsonb(C);
    const semFunil = camposCompactosDoCard(card);
    expect(DO_ATENDIMENTO.some((k) => !(k in semFunil))).toBe(true); // o defeito de hoje
    const comFunil = camposCompactosDoCard(card, FUNIL);
    for (const k of DO_ATENDIMENTO) expect(comFunil).toHaveProperty(k);
  });

  it("os campos do funil vêm primeiro, na ordem do funil; os demais depois, na ordem de antes", () => {
    const card = comoJsonb(B);
    const chaves = Object.keys(camposCompactosDoCard(card, FUNIL));
    const doFunil = FUNIL.filter((k) => chaves.includes(k));
    expect(chaves.slice(0, doFunil.length)).toEqual(doFunil);
    const resto = Object.keys(card).filter((k) => chaves.includes(k) && !FUNIL.includes(k));
    expect(chaves.slice(doFunil.length)).toEqual(resto);
  });

  it("funil do laboratório: A cabe inteiro; em B e C entram todos os campos do funil, e o corte cai nos de fora dele", () => {
    const elegiveis = (card: Record<string, unknown>) =>
      Object.keys(card).filter((k) => k in camposCompactosDoCard({ [k]: card[k] }, FUNIL));
    for (const cenario of [A, B, C]) {
      const card = comoJsonb(cenario);
      const r = camposCompactosDoCard(card, FUNIL);
      for (const k of elegiveis(card).filter((k) => FUNIL.includes(k))) expect(r).toHaveProperty(k);
      expect(JSON.stringify(r).length).toBeLessThanOrEqual(TETO_DO_BLOCO_COM_FUNIL);
    }
    const a = comoJsonb(A);
    expect(Object.keys(camposCompactosDoCard(a, FUNIL)).sort()).toEqual(elegiveis(a).sort());
  });

  it("tetos: com o funil, 30 campos e 1.400 caracteres; sem o funil, 20 e 800 como antes", () => {
    expect([TETO_DE_CAMPOS_COM_FUNIL, TETO_DO_BLOCO_COM_FUNIL]).toEqual([30, 1400]);
    const muitos = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`campo_${i}`, "v"]));
    expect(Object.keys(camposCompactosDoCard(muitos, ["campo_49"]))).toHaveLength(30);
    expect(Object.keys(camposCompactosDoCard(muitos))).toHaveLength(TETO_DE_CAMPOS_NO_CONTEXTO);
    const grandes = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`c${i}`, "z".repeat(119)]));
    const comFunil = JSON.stringify(camposCompactosDoCard(grandes, ["c0"]));
    expect(comFunil.length).toBeLessThanOrEqual(1400);
    expect(comFunil.length).toBeGreaterThan(800);
    expect(JSON.stringify(camposCompactosDoCard(grandes)).length).toBeLessThanOrEqual(TETO_DO_BLOCO_NO_CONTEXTO);
  });

  it("campo `_`, dado pessoal e chave do funil ausente no card continuam fora", () => {
    const r = camposCompactosDoCard(
      { _exp_versao: "h1", telefone: "+5511999990000", plano_oferecido: "pb", outro: "x" },
      ["_exp_versao", "telefone", "nao_existe", "plano_oferecido"],
    );
    expect(r).toEqual({ plano_oferecido: "pb", outro: "x" });
  });

  it("sem definição no funil: idêntico ao de antes (mesma saída, mesma ordem)", () => {
    for (const cenario of [A, B, C]) {
      const card = comoJsonb(cenario);
      expect(Object.entries(camposCompactosDoCard(card, []))).toEqual(Object.entries(camposCompactosDoCard(card)));
    }
  });

  it("a projeção do prompt continua depois do teto: a chave `*_id` gasta a vaga e some só na projeção", () => {
    const card = { curso_id: "abc", plano_oferecido: "pb" };
    const compacto = camposCompactosDoCard(card, ["curso_id", "plano_oferecido"]);
    expect(compacto).toEqual({ curso_id: "abc", plano_oferecido: "pb" });
    expect(projetarRetornoDeTool(compacto)).toEqual({ plano_oferecido: "pb" });
  });
});

describe("lerCardDoContato traz a ordem do funil na mesma consulta", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  function banco(camposDoFunil: unknown) {
    const sqls: string[] = [];
    return {
      sqls,
      query: async (sql: string) => {
        sqls.push(sql);
        if (sql.includes("from crm_leads")) {
          return {
            rows: [{
              id: "L1", organization_id: ORG, pipeline_id: "p1", status: "open", last_activity_at: null,
              created_at: "2026-10-01T00:00:00Z", custom_fields: { b: 1 }, tags: [], etapa: "novo",
              campos_do_funil: camposDoFunil,
            }],
          };
        }
        return { rows: [] };
      },
    };
  }

  it("junta o funil do card e devolve as chaves válidas na ordem; sem definição = []", async () => {
    const db = banco([
      { key: "plano_oferecido", label: "Plano", type: "text" },
      { label: "sem chave", type: "text" },
      { key: "objecao_principal", label: "Objeção", type: "select" },
    ]);
    const card = await lerCardDoContato(db as never, ORG, "k1");
    expect(card?.ordemDoFunil).toEqual(["plano_oferecido", "objecao_principal"]);
    expect(db.sqls[0]).toMatch(/left join crm_pipelines p on p\.id = l\.pipeline_id/);
    // Nenhuma leitura nova: o funil vem na consulta do card; a outra é a do funil padrão, que já existia.
    expect(db.sqls.filter((s) => s.includes("settings"))).toHaveLength(1);
    expect(db.sqls).toHaveLength(2);
    expect((await lerCardDoContato(banco(null) as never, ORG, "k1"))?.ordemDoFunil).toEqual([]);
  });
});

describe("as duas montagens do contexto passam a ordem do funil", () => {
  it("o contexto do turno e o card relido depois do gancho", () => {
    const leitura = readFileSync("lib/agent-engine/edge/crm/get-lead-context.ts", "utf8");
    expect(leitura).toContain("camposCompactosDoCard(card.campos, card.ordemDoFunil)");
    const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    expect(turno).toContain("camposCompactosDoCard(desfechoDoGancho.camposDoCard, desfechoDoGancho.ordemDoFunil)");
    const gancho = readFileSync("lib/agent-engine/agent/gancho-antes-do-turno.ts", "utf8");
    expect(gancho).toContain("ordemDoFunil: relido.ordemDoFunil");
  });
});
