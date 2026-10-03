/**
 * (C01) A TRAVA DO FAIL-SAFE VALE PARA TODO ENVIO, E O LAÇO DO MODELO PARA — achado 2
 * da revisão adversarial do Codex (03/10/2026) sobre a trava 4b.
 *
 * No 3º veto de vocabulário interno, o fail-safe abre o caso, manda a frase de
 * espera e liga `passadoAoHumano`. A trava recusava `send_message` e a pergunta do
 * roteiro, mas o `send_template.execute` não a consultava — e o laço do modelo não
 * parava por ela: um template chamado na etapa seguinte chegaria ao cliente,
 * contrariando o encerramento (e o texto do template não passa pelo gate de
 * vocabulário, de propósito).
 *
 * Agora: (1) toda ferramenta de envio recusa com o mesmo erro de ensino
 * (`recusaPorPassagemAoHumano`), o `send_template` antes de qualquer consulta; (2) a
 * chamada principal do modelo recebe `pararQuando: () => passadoAoHumano || …`, e o
 * laço encerra ao fim da etapa em que o fail-safe agiu — o modelo não ganha outra
 * etapa para tentar outra ferramenta.
 *
 * O primeiro bloco prova a PEÇA com o seam real (`runModelCall` + modelo falso que
 * nunca para sozinho): com o predicado, uma etapa; sem ele, o laço vai até o teto.
 * O segundo bloco prende a LIGAÇÃO no turno pelo código que roda (não há harness de
 * turno inteiro na suíte unitária; ver `tests/invariants/c01-*` para o turno
 * completo contra Postgres).
 */
import { readFileSync } from "node:fs";
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";

function poolDoModelo() {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [
          {
            llm: {
              provider: "anthropic",
              default_model: "claude-padrao",
              params: {},
              enabled_models: [],
              monthly_budget_cents: null,
            },
          },
        ],
      };
    }
    if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
    if (sql.includes("from ai_provider_credentials")) return { rows: [] };
    if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-1" }] };
    return { rows: [] };
  });
  return { query } as never;
}

const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/**
 * Um modelo que, a cada etapa, chama `send_template` de novo — como um modelo que
 * ignora o erro de ensino. Ele nunca encerra por conta própria: quem para o laço
 * é o `stopWhen`.
 */
function modeloQueInsisteNoTemplate() {
  let etapas = 0;
  const doGenerate = async () => {
    etapas += 1;
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${etapas}`,
          toolName: "send_template",
          input: JSON.stringify({ template_name: "retomada", language: "pt_BR", values: { "1": "Ana" } }),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
  return { registry: createFakeRegistry(doGenerate as never), etapas: () => etapas };
}

/** A ferramenta de envio como fica depois do fail-safe: a 1ª chamada "passa ao humano", as seguintes são recusadas. */
function ferramentasDoTurno() {
  let passadoAoHumano = false;
  let execucoes = 0;
  const send_template = tool({
    description: "envia template",
    inputSchema: z.object({
      template_name: z.string(),
      language: z.string(),
      values: z.record(z.string(), z.string()),
    }),
    execute: async () => {
      execucoes += 1;
      if (passadoAoHumano) return { ok: false, error: { code: "turno_passado_ao_humano" } };
      passadoAoHumano = true;
      return { ok: false, error: { code: "internal_vocabulary_leak_handoff" } };
    },
  });
  return { tools: { send_template }, passado: () => passadoAoHumano, execucoes: () => execucoes };
}

const cfg = { anthropicApiKey: "sk-ant-x", cacheTtl: "1h" } as const;
const entrada = {
  tenantId: ORG,
  leadId: LEAD,
  jobId: JOB,
  purpose: "agent_turn",
  messages: [{ role: "user" as const, content: "oi" }],
  maxSteps: 5,
};

describe("(C01) o laço do modelo para quando o turno passa a uma pessoa", () => {
  it("com `pararQuando` ligado à passagem, o laço encerra ao fim da etapa do fail-safe: uma etapa, uma execução", async () => {
    const modelo = modeloQueInsisteNoTemplate();
    const turno = ferramentasDoTurno();
    await runModelCall(
      poolDoModelo(),
      cfg,
      { ...entrada, tools: turno.tools, pararQuando: () => turno.passado() },
      { registry: modelo.registry },
    );
    expect(turno.passado()).toBe(true);
    expect(modelo.etapas()).toBe(1);
    expect(turno.execucoes()).toBe(1);
  });

  it("sem o predicado, o mesmo modelo segue até o teto de etapas — e cada etapa é outra tentativa de envio", async () => {
    const modelo = modeloQueInsisteNoTemplate();
    const turno = ferramentasDoTurno();
    await runModelCall(poolDoModelo(), cfg, { ...entrada, tools: turno.tools }, { registry: modelo.registry });
    expect(modelo.etapas()).toBe(5);
    // Cinco tentativas: a 1ª "passou ao humano", as outras 4 bateram na trava da
    // ferramenta. É a trava na ferramenta que as segura; o predicado evita que existam.
    expect(turno.execucoes()).toBe(5);
  });
});

describe("(C01) a ligação no turno: toda ferramenta de envio recusa, e a chamada do modelo para", () => {
  const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const corpo = (inicio: string, fim: string) => {
    const i = FONTE.indexOf(inicio);
    expect(i, `âncora ${inicio} sumiu do turno`).toBeGreaterThan(-1);
    const j = FONTE.indexOf(fim, i);
    expect(j, `âncora ${fim} sumiu do turno`).toBeGreaterThan(i);
    return FONTE.slice(i, j);
  };

  it("a recusa é uma só, com o código `turno_passado_ao_humano`, e manda encerrar o turno", () => {
    expect(FONTE).toMatch(
      /const recusaPorPassagemAoHumano = \(\) => \(\{\s*ok: false as const,\s*error: \{\s*code: 'turno_passado_ao_humano' as const,[\s\S]*?encerre o turno agora\.'/,
    );
  });

  it("send_template recusa ANTES de consultar o template, de renderizar e de entrar na cadeia", () => {
    const template = corpo("send_template: tool({", "search_knowledge: tool({");
    const trava = template.indexOf("if (passadoAoHumano) return recusaPorPassagemAoHumano();");
    expect(trava).toBeGreaterThan(-1);
    expect(trava).toBeLessThan(template.indexOf("definicaoNaConexao"));
    expect(trava).toBeLessThan(template.indexOf("renderTemplateBody("));
    expect(trava).toBeLessThan(template.indexOf("runBeforeSend("));
    // (rodada 3) e a cadeia roda dentro de `cadeiaDeEnvio`, que traduz a reconferência
    // do ponto comum em veto `turno_passado_ao_humano`.
    expect(template).toMatch(/cadeiaDeEnvio\(\(\) =>\s*runBeforeSend\(\{/);
  });

  it("send_message recusa antes da cadeia; a pergunta do roteiro também não sai", () => {
    const mensagem = corpo("send_message: tool({", "update_lead_state: tool({");
    const trava = mensagem.indexOf("if (passadoAoHumano) return recusaPorPassagemAoHumano();");
    expect(trava).toBeGreaterThan(-1);
    expect(trava).toBeLessThan(mensagem.indexOf("runBeforeSend("));
    expect(FONTE).toMatch(/turnoDescartado: turnoDescartado \|\| passadoAoHumano/);
  });

  it("todo caminho ao canal está atrás de uma trava: o canal é chamado por um lugar só e os três chamadores dele a consultam", () => {
    // `enviarPeloCanal` é o único caminho ao canal; quem o chama: send_template,
    // send_message, a frase de espera (rodada 7: o `send` exclusivo dela, que é o único
    // a passar a marca `fraseDeEspera: true` fixa) e a pergunta do roteiro. Um 5º
    // chamador sem trava reprova aqui.
    expect(FONTE.match(/liveChannel\(\)\.send\(/g)).toHaveLength(1);
    expect(FONTE.match(/enviarPeloCanal\(\s*\{/g)).toHaveLength(4);
    expect(FONTE.match(/\{ fraseDeEspera: true \},/g)).toHaveLength(1);
    expect(FONTE.match(/if \(passadoAoHumano\) return recusaPorPassagemAoHumano\(\);/g)).toHaveLength(2);
  });

  it("a chamada principal do modelo para quando o turno passou a uma pessoa (e, no rascunho assistido, quando há resposta aceita)", () => {
    const chamada = corpo("const turn = await runModelCall(", "// F4-04: correlação dos dois sinais");
    expect(chamada).toMatch(
      /pararQuando: \(\) =>\s*passadoAoHumano \|\|\s*\(preview\?\.kind === 'assisted' && preview\.result\.candidates\.length > 0\)/,
    );
    // E o seam leva o predicado ao `stopWhen` do laço (junto do teto de etapas).
    const seam = readFileSync("lib/agent-engine/edge/llm/run-model-call.ts", "utf8");
    expect(seam).toMatch(/stepCountIs\(input\.maxSteps\),\s*\.\.\.\(input\.pararQuando === undefined \? \[\] : \[input\.pararQuando\]\)/);
  });
});
