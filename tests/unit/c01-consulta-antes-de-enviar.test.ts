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
    const v = avaliar({ consultaAntesDeEnviar: { faltando: [TABELA] } });
    expect(v.pass).toBe(false);
    expect(v.code).toBe("consulta_antes_de_enviar");
    expect(v.reason).toMatch(/NÃO foi enviada/);
    expect(v.reason).toMatch(/ESPERE o resultado/);
    expect(v.reason).toMatch(/à tabela tabela_de_videos\. Chame crm_query_external_data nessa tabela/);
  });

  it("com duas faltando, o erro pede as duas", () => {
    const v = avaliar({ consultaAntesDeEnviar: { faltando: ["agente_fatos", TABELA] } });
    expect(v.reason).toMatch(/às tabelas agente_fatos e tabela_de_videos\. Chame crm_query_external_data em cada uma/);
  });

  it("nada faltando, passa; desarmada, passa", () => {
    expect(avaliar({ consultaAntesDeEnviar: { faltando: [] } }).pass).toBe(true);
    expect(avaliar({}).pass).toBe(true);
    expect(avaliar(undefined).pass).toBe(true);
  });

  it("liga por agente e com tabelas, cada uma com o jeito de cobrar; sem um dos dois, ou com a forma errada, fica desligada", () => {
    expect(
      interpretarConsultaAntesDeEnviar({
        agentes: ["a1"],
        tabelas: [
          { tabela: "c01.Fatos", cobrar: "todo_turno" },
          { tabela: "videos", cobrar: "uma_vez_por_contato" },
        ],
      }).consulta,
    ).toEqual({
      agentes: ["a1"],
      tabelas: [
        { tabela: "fatos", cobrar: "todo_turno" },
        { tabela: "videos", cobrar: "uma_vez_por_contato" },
      ],
    });
    expect(interpretarConsultaAntesDeEnviar(undefined)).toEqual({ consulta: null, invalida: false });
    expect(interpretarConsultaAntesDeEnviar({ agentes: [], tabelas: [{ tabela: "t", cobrar: "todo_turno" }] }).consulta).toBeNull();
    expect(interpretarConsultaAntesDeEnviar({ agentes: ["a1"] }).consulta).toBeNull();
    expect(interpretarConsultaAntesDeEnviar({ agentes: ["a1"], tabelas: [] }).consulta).toBeNull();
    expect(interpretarConsultaAntesDeEnviar({ agentes: "a1", tabelas: [] })).toEqual({ consulta: null, invalida: true });
    // Sem o jeito de cobrar, ou com um que não existe: forma errada (não se adivinha).
    expect(interpretarConsultaAntesDeEnviar({ agentes: ["a1"], tabelas: [{ tabela: "t" }] }).invalida).toBe(true);
    expect(interpretarConsultaAntesDeEnviar({ agentes: ["a1"], tabelas: [{ tabela: "t", cobrar: "sempre" }] }).invalida).toBe(true);
    // A forma antiga, com uma tabela só, não liga nada.
    expect(interpretarConsultaAntesDeEnviar({ agentes: ["a1"], tabela: "t" }).consulta).toBeNull();
  });

  it("a mesma tabela repetida vale uma vez, com a cobrança mais forte", () => {
    expect(
      interpretarConsultaAntesDeEnviar({
        agentes: ["a1"],
        tabelas: [
          { tabela: "t", cobrar: "uma_vez_por_contato" },
          { tabela: "c01.t", cobrar: "todo_turno" },
          { tabela: "T", cobrar: "uma_vez_por_contato" },
        ],
      }).consulta?.tabelas,
    ).toEqual([{ tabela: "t", cobrar: "todo_turno" }]);
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
      interpretarTravasDeEnvio({
        consulta_antes_de_enviar: { agentes: ["a1"], tabelas: [{ tabela: TABELA, cobrar: "todo_turno" }] },
      }).travas.consultaAntesDeEnviar,
    ).toEqual({ agentes: ["a1"], tabelas: [{ tabela: TABELA, cobrar: "todo_turno" }] });
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
    expect(TURNO).toMatch(/tabelasCobradas\.filter\(\(tabela\) => !leuConsultaDaTabela\(opcoes\?\.messages, tabela\)\)/);
    expect(TURNO).toMatch(/consultaAntes\.agentes\.includes\(agentConfig\.agentId\)/);
    expect(TURNO).toMatch(/travasArmadas\(\{ consultasFaltando \}\)/);
  });

  it("'todo_turno' é cobrada sem ler o banco; 'uma_vez_por_contato' lê os turnos anteriores do contato", () => {
    const i = TURNO.indexOf("const tabelasCobradas: string[] = [];");
    const trecho = TURNO.slice(i, TURNO.indexOf("const linksJaEnviados", i));
    expect(trecho).toMatch(/if \(cobrar === 'todo_turno'\) \{\s*tabelasCobradas\.push\(tabela\);\s*continue;\s*\}/);
    expect(trecho).toMatch(/consultaJaFeitaComOContato\(pool, \{/);
    expect(trecho).toMatch(/if \(!feita\) tabelasCobradas\.push\(tabela\);/);
  });
});
