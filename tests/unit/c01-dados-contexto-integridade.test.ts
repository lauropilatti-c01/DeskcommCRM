import { describe, expect, it } from "vitest";
import {
  camposCompactosDoCard,
  projetarCamposDoCard,
} from "@/lib/agent-engine/edge/crm/card-do-contato";
import { getLeadContext } from "@/lib/agent-engine/edge/crm/get-lead-context";
import { projetarContexto } from "@/lib/agent-engine/agent/projecao";

const INPUT = {
  tenantId: "org-a",
  leadId: "contato-a",
  conversationId: null,
  fuso: "America/Sao_Paulo",
  camposDoCard: true,
};
const KNOBS = { historyLimit: 20, maxTokens: 4000 };
function banco(campos: Record<string, unknown>, falha = false) {
  const consultas: { sql: string; params: unknown[] }[] = [];
  return {
    consultas,
    async query(sql: string, params: unknown[] = []) {
      consultas.push({ sql, params });
      if (sql.includes("from contacts"))
        return {
          rows: [
            {
              name: "Pessoa fictícia",
              display_name: null,
              phone_number: null,
              email: null,
              tags: [],
              is_blocked: false,
              is_personal: false,
              source: "whatsapp",
              consent: null,
              is_anonymized: false,
            },
          ],
        };
      if (sql.includes("from crm_leads l")) {
        if (falha) throw new Error("consulta indisponível");
        return {
          rows: [
            {
              id: "card-a",
              organization_id: "org-a",
              pipeline_id: "funil-a",
              status: "open",
              last_activity_at: null,
              created_at: "2026-10-01",
              custom_fields: campos,
              tags: [],
              etapa: "novo",
              campos_do_funil: Object.keys(campos).map((key) => ({
                key,
                label: key,
                type: "text",
              })),
            },
          ],
        };
      }
      if (sql.includes("from crm_pipelines")) return { rows: [{ id: "funil-a" }] };
      return { rows: [] };
    },
  };
}

describe("dados do card chegam completos ao próximo turno", () => {
  it("41 campos preenchidos: decisão, resposta negativa, tempo e pendências no fim não desaparecem", async () => {
    const campos = {
      ...Object.fromEntries(
        Array.from({ length: 37 }, (_, i) => [`campo_${i}`, `Informação ${i}`]),
      ),
      decisao_concurso: "decidido",
      conhece_preparacao: "não",
      tempo_por_dia: "Mais de 4 horas",
      qualificacao_pendente: "aluno",
    };
    const db = banco(campos);
    const r = await getLeadContext(db as never, {} as never, INPUT, KNOBS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.campos_do_card).toEqual(campos);
    expect(projetarContexto(r.context).campos_do_card).toEqual(campos);
    for (const c of db.consultas.filter((c) => c.sql.includes("from crm_leads l"))) {
      expect(c.sql).toContain("l.organization_id = $1 and l.contact_id = $2");
      expect(c.params).toEqual(["org-a", "contato-a"]);
    }
  });
  it("falha ao ler campos não vira qualificação vazia", async () => {
    const r = await getLeadContext(banco({}, true) as never, {} as never, INPUT, KNOBS);
    expect(r).toMatchObject({ ok: false, error: { code: "crm_unavailable" } });
  });
  it("campos declarados de 180 caracteres não perdem sua conclusão", () => {
    const valor = "a".repeat(160) + " — Não quero comprar.";
    expect(camposCompactosDoCard({ observacao: valor }, ["observacao"]).observacao).toBe(valor);
  });
  it("resumo parcial avisa limites em vez de esconder o corte", async () => {
    const campos = { observacao: "x".repeat(600) };
    const r = await getLeadContext(banco(campos) as never, {} as never, INPUT, KNOBS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.context.campos_do_card?.observacao).toMatch(/…$/);
    expect(projetarContexto(r.context).campos_do_card_limites).toMatchObject({
      truncados: ["observacao"],
    });
    const muitos = Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`c${i}`, i]));
    expect(projetarCamposDoCard(muitos, Object.keys(muitos)).omitidos).toHaveLength(20);
  });
  it("contexto maior que o orçamento recusa sem fingir histórico completo", async () => {
    const campos = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`c${i}`, "Informação longa ".repeat(30)]),
    );
    const r = await getLeadContext(banco(campos) as never, {} as never, INPUT, {
      ...KNOBS,
      maxTokens: 1000,
    });
    expect(r).toMatchObject({ ok: false, error: { code: "crm_unavailable" } });
  });
  it("pendências limpas são campo vazio conhecido, não omitido por corte", async () => {
    const r = await getLeadContext(
      banco({ qualificacao_pendente: "", aluno_zero1: false }) as never,
      {} as never,
      INPUT,
      KNOBS,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(projetarContexto(r.context)).toMatchObject({
      campos_do_card_leitura: "lido",
      campos_do_card_vazios: ["qualificacao_pendente"],
      campos_do_card: { aluno_zero1: false },
    });
  });
  it("resposta false e número zero continuam como valores", () => {
    expect(
      camposCompactosDoCard({ aluno_zero1: false, horas: 0 }, ["aluno_zero1", "horas"]),
    ).toEqual({ aluno_zero1: false, horas: 0 });
  });
});

import { validaCamposExigidos } from "@/lib/leads/campos-exigidos";
const FINANCEIRO = {
  fields: [
    {
      key: "pagamento_confirmado",
      label: "Pagamento confirmado",
      type: "boolean",
      obrigatorio_em: { ao_ganhar: true },
    },
  ],
};
describe("ganho exige origem financeira confiável", () => {
  it.each([true, false, "sim", { _fonte: "guru", confirmado: true }])(
    "valor %j não serve como prova",
    (valor) => {
      expect(
        validaCamposExigidos({
          lead: { custom_fields: { pagamento_confirmado: valor } },
          settingsDoFunil: FINANCEIRO,
          destino: { desfecho: "won" },
        }).faltando,
      ).toContainEqual(expect.objectContaining({ chave: "pagamento_confirmado" }));
    },
  );
  it("definição financeira legada malformada não perde sua proteção", () => {
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { pagamento_confirmado: true } },
        settingsDoFunil: { fields: [{ ...FINANCEIRO.fields[0], type: "tipo_antigo" }] },
        destino: { desfecho: "won" },
      }).faltando,
    ).not.toEqual([]);
  });
  it("valor proposto pelo diálogo também não serve", () => {
    expect(
      validaCamposExigidos({
        lead: { custom_fields: {} },
        settingsDoFunil: FINANCEIRO,
        destino: { desfecho: "won" },
        customFieldsPropostos: { pagamento_confirmado: true },
      }).faltando,
    ).not.toEqual([]);
  });
  it("falha de leitura das regras não libera ganho", () => {
    expect(
      validaCamposExigidos({ lead: {}, settingsDoFunil: null, destino: { desfecho: "won" } })
        .faltando,
    ).not.toEqual([]);
  });
  it("ocultar o campo financeiro ou marcá-lo como contato não libera Ganho", () => {
    const campo = {
      ...FINANCEIRO.fields[0],
      escopo: "contato",
      mostrar_quando: { campo: "tipo", igual: "outro" },
    };
    expect(
      validaCamposExigidos({
        lead: { custom_fields: { pagamento_confirmado: true } },
        settingsDoFunil: { fields: [campo] },
        destino: { desfecho: "won" },
      }).faltando,
    ).not.toEqual([]);
  });
  it("movimento comum e funil não financeiro continuam disponíveis", () => {
    expect(
      validaCamposExigidos({ lead: {}, settingsDoFunil: FINANCEIRO, destino: { desfecho: null } })
        .faltando,
    ).toEqual([]);
    expect(
      validaCamposExigidos({ lead: {}, settingsDoFunil: {}, destino: { desfecho: "won" } })
        .faltando,
    ).toEqual([]);
  });
});
