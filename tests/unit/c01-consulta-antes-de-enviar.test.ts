/**
 * (C01, -c01.14) CONSULTE ANTES DE ENVIAR E MARCADOR ENTRE COLCHETES.
 *
 * O defeito: um modelo sem raciocínio escrevia a resposta sem consultar a base (ou
 * consultava e enviava no mesmo passo) e copiava do exemplo de formato o marcador
 * "[link do vídeo]" no lugar do link.
 *
 * Aqui, as partes puras: a configuração (por agente), a leitura do que o modelo leu (as
 * mensagens no formato do AI SDK), as duas travas e a ligação no turno e na cadeia. O
 * turno inteiro, com o AI SDK de verdade, está em
 * `tests/invariants/c01-consulta-antes-de-enviar.test.ts`. Nomes e links são fictícios
 * (regra do C01.md: nada da C01 no código).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  consultaAntesDeEnviarGate,
  interpretarConsultaAntesDeEnviar,
  leuConsultaDaTabela,
  normalizarTabela,
} from "@/lib/agent-engine/guardrails/consulta-antes-de-enviar";
import { marcadorEntreColchetesGate, marcadoresNoTexto } from "@/lib/agent-engine/guardrails/marcador-entre-colchetes";
import { interpretarTravasDeEnvio } from "@/lib/agent-engine/guardrails/travas-de-envio";

const TABELA = "tabela_de_videos";
const PEDIDO = { role: "user", content: [{ type: "text", text: "Novo turno de atendimento: qual curso faço?" }] };

function consulta(id: string, tabela: string) {
  return { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "crm_query_external_data", input: { tabela } }] };
}
function resultado(id: string, output: unknown) {
  return { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "crm_query_external_data", output }] };
}
const LINHAS = { type: "json", value: { content: [{ type: "text", text: JSON.stringify({ rows: [{ url: "https://videos.exemplo.com.br/v/1" }] }) }] } };

describe("(C01) o que o modelo leu ao escrever", () => {
  it("sem consulta nenhuma: não leu", () => {
    expect(leuConsultaDaTabela([PEDIDO], TABELA)).toBe(false);
    expect(leuConsultaDaTabela(undefined, TABELA)).toBe(false);
  });

  it("consulta e envio no mesmo passo: a consulta não está nas mensagens, então não leu", () => {
    // O AI SDK entrega ao `execute` as mensagens que ABRIRAM o passo: a chamada da consulta
    // feita junto com o envio não está nelas.
    expect(leuConsultaDaTabela([PEDIDO], TABELA)).toBe(false);
    // E a chamada sem o resultado também não conta.
    expect(leuConsultaDaTabela([PEDIDO, consulta("c1", TABELA)], TABELA)).toBe(false);
  });

  it("consulta lida num passo anterior: leu (também com o agrupamento e com o resultado em texto)", () => {
    expect(leuConsultaDaTabela([PEDIDO, consulta("c1", TABELA), resultado("c1", LINHAS)], TABELA)).toBe(true);
    expect(leuConsultaDaTabela([PEDIDO, consulta("c1", `c01."${TABELA.toUpperCase()}"`), resultado("c1", LINHAS)], TABELA)).toBe(true);
    const emTexto = { type: "text", value: JSON.stringify({ rows: [] }) };
    expect(leuConsultaDaTabela([PEDIDO, consulta("c1", TABELA), resultado("c1", emTexto)], TABELA)).toBe(true);
  });

  it("a consulta de outra tabela ou com erro não conta", () => {
    expect(leuConsultaDaTabela([PEDIDO, consulta("c1", "outra"), resultado("c1", LINHAS)], TABELA)).toBe(false);
    const erro = { type: "json", value: { erro: "pedido_invalido", detalhe: "coluna_inexistente:x" } };
    expect(leuConsultaDaTabela([PEDIDO, consulta("c1", TABELA), resultado("c1", erro)], TABELA)).toBe(false);
    const erroDoSdk = { type: "error-text", value: "falhou" };
    expect(leuConsultaDaTabela([PEDIDO, consulta("c1", TABELA), resultado("c1", erroDoSdk)], TABELA)).toBe(false);
  });

  it("normaliza o nome da tabela", () => {
    expect(normalizarTabela(' c01."Tabela_De_Videos" ')).toBe("tabela_de_videos");
  });
});

describe("(C01) a trava 'consulte antes de enviar'", () => {
  const avaliar = (travasDeEnvio?: unknown) =>
    consultaAntesDeEnviarGate.evaluate({ body: "Oi", travasDeEnvio } as never) as {
      pass: boolean;
      code?: string;
      reason?: string;
    };

  it("mandar sem ter lido a consulta volta ao modelo, com o que fazer", () => {
    const v = avaliar({ consultaAntesDeEnviar: { tabela: TABELA, leu: false } });
    expect(v.pass).toBe(false);
    expect(v.code).toBe("consulta_antes_de_enviar");
    expect(v.reason).toMatch(/NÃO foi enviada/);
    expect(v.reason).toMatch(/ESPERE o resultado/);
    expect(v.reason).toMatch(/tabela_de_videos/);
  });

  it("com a consulta lida, passa; desarmada, passa", () => {
    expect(avaliar({ consultaAntesDeEnviar: { tabela: TABELA, leu: true } }).pass).toBe(true);
    expect(avaliar({}).pass).toBe(true);
    expect(avaliar(undefined).pass).toBe(true);
  });

  it("liga por agente e com tabela; sem um dos dois, ou com a forma errada, fica desligada", () => {
    expect(interpretarConsultaAntesDeEnviar({ agentes: ["a1"], tabela: "c01.T" }).consulta).toEqual({ agentes: ["a1"], tabela: "t" });
    expect(interpretarConsultaAntesDeEnviar(undefined)).toEqual({ consulta: null, invalida: false });
    expect(interpretarConsultaAntesDeEnviar({ agentes: [], tabela: "t" }).consulta).toBeNull();
    expect(interpretarConsultaAntesDeEnviar({ agentes: ["a1"] }).consulta).toBeNull();
    expect(interpretarConsultaAntesDeEnviar({ agentes: "a1", tabela: "t" })).toEqual({ consulta: null, invalida: true });
  });

  it("o valor errado dela desliga só ela: as outras travas da organização seguem valendo", () => {
    const { travas, invalida } = interpretarTravasDeEnvio({
      uma_pergunta: { ligada: true },
      consulta_antes_de_enviar: { agentes: "a1" },
    });
    expect(invalida).toBe(true);
    expect(travas.umaPergunta).toBe(true);
    expect(travas.consultaAntesDeEnviar).toBeNull();
    expect(interpretarTravasDeEnvio({}).travas.consultaAntesDeEnviar).toBeNull();
    expect(
      interpretarTravasDeEnvio({ consulta_antes_de_enviar: { agentes: ["a1"], tabela: TABELA } }).travas.consultaAntesDeEnviar,
    ).toEqual({ agentes: ["a1"], tabela: TABELA });
  });
});

describe("(C01) a trava 'marcador entre colchetes'", () => {
  const avaliar = (body: string, ligada = true) =>
    marcadorEntreColchetesGate.evaluate({ body, ...(ligada ? { travasDeEnvio: { marcadorEntreColchetes: true } } : {}) } as never) as {
      pass: boolean;
      code?: string;
      reason?: string;
    };

  it("'[link do vídeo]' é barrado, com o marcador no erro", () => {
    const v = avaliar("O vídeo explica 👇\n\n[link do vídeo]\n\nPode ser?");
    expect(v.pass).toBe(false);
    expect(v.code).toBe("marcador_entre_colchetes");
    expect(v.reason).toMatch(/\(\[link do vídeo\]\)/);
  });

  it("o link em markdown também (o WhatsApp não o mostra como link)", () => {
    expect(marcadoresNoTexto("Veja [aqui](https://videos.exemplo.com.br/v/1)")).toEqual(["[aqui]"]);
  });

  it("texto sem colchete e link com colchete dentro passam; desligada, passa", () => {
    expect(avaliar("O vídeo explica:\n\nhttps://videos.exemplo.com.br/v/1").pass).toBe(true);
    expect(avaliar("Veja https://exemplo.com.br/busca?f[]=1 ok").pass).toBe(true);
    expect(avaliar("[link do vídeo]", false).pass).toBe(true);
  });

  it("liga com `marcador_entre_colchetes.ligada`; ausente = desligada", () => {
    expect(interpretarTravasDeEnvio({}).travas.marcadorEntreColchetes).toBe(false);
    expect(interpretarTravasDeEnvio({ marcador_entre_colchetes: { ligada: true } }).travas.marcadorEntreColchetes).toBe(true);
  });
});

describe("(C01) a ligação no turno e na cadeia, pelo código", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const CADEIA = readFileSync("lib/agent-engine/guardrails/before-send.ts", "utf8");

  it("as duas rodam depois da agenda e antes da de link e valor (v13)", () => {
    expect(CADEIA).toMatch(
      /agendaStallGate,\s*consultaAntesDeEnviarGate,\s*marcadorEntreColchetesGate,\s*linkEValorDeFerramentaGate,/,
    );
    expect(CADEIA).toMatch(/export const BEFORE_SEND_CHAIN_VERSION = 13;/);
  });

  it("consulte antes é de estilo (a 2ª tentativa passa); marcador é de conteúdo (nunca sai)", () => {
    const iEstilo = TURNO.indexOf("export const TRAVAS_DE_ESTILO");
    const estilo = TURNO.slice(iEstilo, TURNO.indexOf("};", iEstilo));
    const iConteudo = TURNO.indexOf("export const TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE");
    const conteudo = TURNO.slice(iConteudo, TURNO.indexOf("};", iConteudo));
    expect(estilo).toMatch(/consulta_antes_de_enviar: 'consultaAntesDeEnviar',/);
    expect(conteudo).not.toMatch(/consulta_antes_de_enviar/);
    expect(conteudo).toMatch(/marcador_entre_colchetes: /);
    expect(estilo).not.toMatch(/marcador_entre_colchetes/);
  });

  it("o send_message confere o que o modelo leu (as mensagens do passo) e arma só no agente ligado", () => {
    expect(TURNO).toMatch(/execute: async \(\{ body, produto_codigo \}, opcoes\) => \{/);
    expect(TURNO).toMatch(/leuConsultaDaTabela\(opcoes\?\.messages, consultaAntes\.tabela\)/);
    expect(TURNO).toMatch(/consultaAntes\.agentes\.includes\(agentConfig\.agentId\)/);
    expect(TURNO).toMatch(/travasArmadas\(\{ consultaLida \}\)/);
  });
});
