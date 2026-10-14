/**
 * (C01, -c01.7) LINK E VALOR EM REAIS SÓ SAEM SE VIERAM DE UMA CONSULTA.
 *
 * O defeito: o modelo trocava parâmetro de link e arredondava ou inventava valor
 * ("salário de R$ 6.700" com a base dizendo R$ 6.638,64). A tabela de promessas do
 * motor só compara preço com piso e teto, e nada comparava o link e o valor da
 * mensagem com o que as ferramentas devolveram.
 *
 * A trava `link_e_valor_de_ferramenta` (ligada pela tela, por organização) libera o
 * que voltou das consultas do turno, o que já saiu numa mensagem nossa da conversa
 * (inclusive o botão de uma interativa) e as URLs fixas da configuração; o resto
 * volta ao modelo com um erro de ensino que não repete o trecho. É trava de conteúdo:
 * no 3º veto o texto não sai e a conversa passa à equipe (o turno inteiro se prova em
 * `tests/invariants/c01-link-e-valor-de-ferramenta.test.ts`).
 *
 * As peças se provam por comportamento; a ligação no turno, por leitura do código. O
 * módulo novo entra por import dinâmico (sem a mudança, cada caso reprova sozinho).
 * Domínios, links e valores são fictícios, na forma dos reais (regra do C01.md).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CAMINHO_DA_TRAVA = "@/lib/agent-engine/guardrails/link-e-valor-de-ferramenta";
const CAMINHO_DOS_VALORES = "@/lib/agent-engine/guardrails/valor-de-ferramenta";
const CAMINHO_DA_CONFIGURACAO = "@/lib/agent-engine/guardrails/travas-de-envio";

type Veredito = { pass: boolean; code?: string; reason?: string; detail?: Record<string, unknown> };
interface Trava {
  linkEValorDeFerramentaGate: { name: string; evaluate: (ctx: unknown) => Veredito };
  linksEValoresDosTextos: (textos: Iterable<string>) => { links: Set<string>; valores: Set<number> };
  INTERRUPTOR_DA_TRAVA: string;
  CODIGO_DO_VETO_DE_LINK_OU_VALOR: string;
}
interface Valores {
  valoresEmDinheiro: (texto: string) => number[];
  lerValoresEmDinheiro: (texto: string) => { valores: number[]; emDuvida: number };
  valoresNoResultado: (valor: unknown) => Set<number>;
}
const trava = async (): Promise<Trava> => (await import(/* @vite-ignore */ CAMINHO_DA_TRAVA)) as Trava;
const valores = async (): Promise<Valores> => (await import(/* @vite-ignore */ CAMINHO_DOS_VALORES)) as Valores;

const LINK_DA_BASE = "https://lp.exemplo.com.br/plano-completo/?nivel=superior";
const LINK_DO_BOTAO = "https://lp.exemplo.com.br/enfases/?canal=crm&sid=dc-ab12cd34&utm_source=crm";
/** O resultado de uma consulta à base, na forma do MCP: o fato em texto, dentro de JSON. */
const RESULTADO_DA_CONSULTA = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        rows: [
          { chave: "salario", texto: "O salário inicial é de R$ 6.638,64 (nível superior)." },
          { chave: "pagina", url: LINK_DA_BASE },
          { chave: "plano", preco: 1997, parcela: "166.42" },
        ],
      }),
    },
  ],
};

/** O que o turno arma: as URLs e os valores do resultado, mais os textos já enviados. */
async function armado(opcoes: { resultado?: unknown; jaEnviados?: string[]; urlsFixas?: string[] }) {
  const t = await trava();
  const v = await valores();
  const { normalizarLink } = await import("@/lib/agent-engine/guardrails/link-permitido");
  const { urlsNoResultado } = await import("@/lib/agent-engine/agent/inbound-turn");
  const daConversa = t.linksEValoresDosTextos(opcoes.jaEnviados ?? []);
  const links = new Set([...daConversa.links, ...(opcoes.urlsFixas ?? []).map(normalizarLink)]);
  for (const url of urlsNoResultado(opcoes.resultado)) links.add(normalizarLink(url));
  const valoresLiberados = new Set([...daConversa.valores, ...v.valoresNoResultado(opcoes.resultado)]);
  return { links, valores: valoresLiberados };
}

async function avaliar(body: string, liberado?: { links: Set<string>; valores: Set<number> }): Promise<Veredito> {
  const t = await trava();
  expect(t.linkEValorDeFerramentaGate.name).toBe("link_e_valor_de_ferramenta");
  const ctx = liberado === undefined ? { body } : { body, travasDeEnvio: { linkEValorDeFerramenta: liberado } };
  return t.linkEValorDeFerramentaGate.evaluate(ctx);
}

describe("(C01) os valores em dinheiro da mensagem", () => {
  it("as formas do real viram o mesmo valor em centavos", async () => {
    const { valoresEmDinheiro } = await valores();
    expect(valoresEmDinheiro("R$ 1.997")).toEqual([199700]);
    expect(valoresEmDinheiro("R$ 1.997,00")).toEqual([199700]);
    expect(valoresEmDinheiro("R$1997")).toEqual([199700]);
    expect(valoresEmDinheiro("1.997 reais")).toEqual([199700]);
    expect(valoresEmDinheiro("12x de R$ 166,42.")).toEqual([16642]);
    expect(valoresEmDinheiro("salário de R$ 6.638,64, fora benefícios")).toEqual([663864]);
    expect(valoresEmDinheiro("uns R$ 6 mil")).toEqual([600000]);
    expect(valoresEmDinheiro("R$ 10 reais")).toEqual([1000]);
  });

  it("(-c01.8, 3ª revisão) a expressão inteira: centavos à parte, milhar com espaço e 'mil'", async () => {
    const { valoresEmDinheiro } = await valores();
    expect(valoresEmDinheiro("R$ 5 e 50 centavos")).toEqual([550]);
    expect(valoresEmDinheiro("5 reais e 50")).toEqual([550]);
    expect(valoresEmDinheiro("R$ 5 000")).toEqual([500000]);
    expect(valoresEmDinheiro("R$ 5 000 e R$ 5 000,00")).toEqual([500000, 500000]);
    expect(valoresEmDinheiro("R$ 5 mil")).toEqual([500000]);
    // A forma em dúvida não vira valor (e a trava a barra).
    expect(valoresEmDinheiro("R$ 5 e meio")).toEqual([]);
    expect(valoresEmDinheiro("R$ 5 milhões")).toEqual([]);
  });

  it("(-c01.9, 4ª revisão) formatação, emoji, sinal e 'BRL': lidos; o menos e a continuação ficam em dúvida", async () => {
    const { lerValoresEmDinheiro } = await valores();
    // 1. A formatação do WhatsApp e o emoji não contam.
    expect(lerValoresEmDinheiro("*R$ 5*")).toEqual({ valores: [500], emDuvida: 0 });
    expect(lerValoresEmDinheiro("R$ *997*")).toEqual({ valores: [99700], emDuvida: 0 });
    expect(lerValoresEmDinheiro("R$*997*")).toEqual({ valores: [99700], emDuvida: 0 });
    expect(lerValoresEmDinheiro("R$ 💰997")).toEqual({ valores: [99700], emDuvida: 0 });
    expect(lerValoresEmDinheiro("R$ 5,*50*")).toEqual({ valores: [550], emDuvida: 0 });
    // 2. O "+" é lido; o "-" (e o "−") deixa o valor em dúvida.
    expect(lerValoresEmDinheiro("R$ +997")).toEqual({ valores: [99700], emDuvida: 0 });
    expect(lerValoresEmDinheiro("R$ +5,50")).toEqual({ valores: [550], emDuvida: 0 });
    for (const frase of ["R$ -997", "R$ −5", "R$ - 5", "-R$ 5", "−R$ 5", "-5 reais", "R$ 5-10"]) {
      expect(lerValoresEmDinheiro(frase).valores, frase).toEqual([]);
      expect(lerValoresEmDinheiro(frase).emDuvida, frase).toBeGreaterThan(0);
    }
    // 3. A moeda depois do número ou em sigla.
    expect(lerValoresEmDinheiro("997 BRL")).toEqual({ valores: [99700], emDuvida: 0 });
    expect(lerValoresEmDinheiro("BRL 997")).toEqual({ valores: [99700], emDuvida: 0 });
    expect(lerValoresEmDinheiro("997 R$")).toEqual({ valores: [99700], emDuvida: 0 });
    expect(lerValoresEmDinheiro("BRL 5,5").emDuvida).toBeGreaterThan(0);
    // 5. "+ N", "mais N" e centavos por extenso logo depois do valor: em dúvida.
    for (const frase of ["R$ 5,00 + 50", "R$ 5,00+50", "R$ 5 mais 50", "R$ 5 e cinquenta centavos", "5 reais e cinquenta centavos", "R$ 5 e vinte e cinco centavos"]) {
      expect(lerValoresEmDinheiro(frase).valores, frase).toEqual([]);
      expect(lerValoresEmDinheiro(frase).emDuvida, frase).toBeGreaterThan(0);
    }
    // O que não continua o valor fica como estava.
    expect(lerValoresEmDinheiro("R$ 5 e você ganha um bônus")).toEqual({ valores: [500], emDuvida: 0 });
  });

  it("número sem R$ nem 'reais' não é dinheiro: 12x, metas, dias, vagas, o número dentro do link", async () => {
    const { valoresEmDinheiro } = await valores();
    for (const texto of [
      "Dá para dividir em 12x no cartão.",
      "São 60 metas em 67 dias.",
      "O edital tem 1.997 vagas.",
      `Veja em https://lp.exemplo.com.br/plano?valor=1997 sem pressa.`,
    ]) {
      expect(valoresEmDinheiro(texto), texto).toEqual([]);
    }
  });

  it("do resultado da ferramenta: número JSON, '1997.00' e texto em formato brasileiro, dentro de JSON em string", async () => {
    const { valoresNoResultado } = await valores();
    const achados = valoresNoResultado(RESULTADO_DA_CONSULTA);
    expect(achados.has(663864)).toBe(true); // "R$ 6.638,64" no texto do fato
    expect(achados.has(199700)).toBe(true); // `"preco": 1997`
    expect(achados.has(16642)).toBe(true); // `"parcela": "166.42"`
    expect(valoresNoResultado({ preco_centavos: 199700 }).has(199700)).toBe(true);
    expect(valoresNoResultado("Plano anual: 6.638,64").has(663864)).toBe(true);
  });

  it("(revisão, N1) na fonte, número colado em letra, '_', ponto, vírgula ou hífen de id não é valor", async () => {
    const { valoresNoResultado } = await valores();
    const colado = valoresNoResultado({
      detalhe: "coluna_inexistente:salario_6700",
      id: "a7a7a7a7-0000-4000-8000-000000006700",
      codigo: "x6700",
      versao: "v1.6700",
      data: "2026-10-07",
    });
    for (const centavos of [670000, 400000, 800000, 202600, 700, 1000]) {
      expect(colado.has(centavos), String(centavos)).toBe(false);
    }
    // O que é valor solto continua valendo: em texto, em string-número, em JSON e com "mil".
    const solto = valoresNoResultado({
      fato: "O salário é de R$6.638,64; o piso, 6.638,64 (nível superior).",
      parcela: "1997.00",
      texto: JSON.stringify({ preco: 1997, faixa: "uns 6 mil" }),
    });
    for (const centavos of [663864, 199700, 600000]) expect(solto.has(centavos), String(centavos)).toBe(true);
  });
});

describe("(C01, revisão B1) o resultado de ERRO da base externa não é fonte", () => {
  /** O erro como a base externa o devolve (sem `isError`), no formato do MCP. */
  const ERRO = {
    erro: "pedido_invalido",
    mensagem: "algum campo ou operador não existe nessa tabela. Confira com crm_describe_external_data.",
    detalhe: "coluna_inexistente:salario R$ 6.700 https://lp.exemplo.com.br/salario-inventado",
  };
  const ERRO_DO_MCP = { content: [{ type: "text", text: JSON.stringify(ERRO) }], structuredContent: ERRO };

  it("o erro é reconhecido no `structuredContent`, no JSON do `content`, no próprio objeto e por `isError`", async () => {
    const { resultadoComErro } = (await import(/* @vite-ignore */ CAMINHO_DA_TRAVA)) as {
      resultadoComErro: (r: unknown) => boolean;
    };
    expect(resultadoComErro(ERRO_DO_MCP)).toBe(true);
    expect(resultadoComErro({ content: ERRO_DO_MCP.content })).toBe(true);
    expect(resultadoComErro({ structuredContent: ERRO })).toBe(true);
    expect(resultadoComErro(ERRO)).toBe(true);
    expect(resultadoComErro({ isError: true, content: [{ type: "text", text: "falhou" }] })).toBe(true);
    // A consulta que deu certo é fonte.
    const certo = { linhas: [{ produto: "Plano anual", preco: 1997 }], aviso: "dados de terceiros" };
    expect(resultadoComErro({ content: [{ type: "text", text: JSON.stringify(certo) }], structuredContent: certo })).toBe(
      false,
    );
    expect(resultadoComErro(RESULTADO_DA_CONSULTA)).toBe(false);
    expect(resultadoComErro([{ content: "trecho da base" }])).toBe(false);
    expect(resultadoComErro({ content: [{ type: "text", text: "{não é json" }] })).toBe(false);
  });

  it("sem a correção, o erro liberaria o valor e o link que o modelo inventou", async () => {
    // O defeito, medido: lido como consulta, o erro traz o "R$ 6.700" e o link de volta.
    const liberado = await armado({ resultado: ERRO_DO_MCP });
    expect(liberado.valores.has(670000)).toBe(true);
    expect([...liberado.links].some((l) => l.includes("salario-inventado"))).toBe(true);
  });
});

describe("(C01) a trava 'link e valor de ferramenta'", () => {
  it("desligada (sem a chave armada) não faz nada: passa link e valor inventados", async () => {
    expect((await avaliar("Entra em https://golpe.example/pagar e paga R$ 6.700")).pass).toBe(true);
  });

  it("o link que voltou da consulta deste turno passa — também com ponto final depois", async () => {
    const liberado = await armado({ resultado: RESULTADO_DA_CONSULTA });
    expect((await avaliar(`A matrícula é por aqui: ${LINK_DA_BASE}`, liberado)).pass).toBe(true);
    expect((await avaliar(`A matrícula é por aqui: ${LINK_DA_BASE}.`, liberado)).pass).toBe(true);
    expect((await avaliar(`Link (${LINK_DA_BASE}), tá?`, liberado)).pass).toBe(true);
  });

  it("o link inventado ou alterado é vetado: outro parâmetro, outro caminho, sem consulta", async () => {
    const liberado = await armado({ resultado: RESULTADO_DA_CONSULTA });
    for (const inventado of [
      "https://lp.exemplo.com.br/plano-completo/?nivel=tecnico",
      "https://lp.exemplo.com.br/plano-completo-engenharia",
      "https://pagamento.exemplo.io/plano",
    ]) {
      const v = await avaliar(`Segue: ${inventado}`, liberado);
      expect(v.pass, inventado).toBe(false);
      expect(v.code).toBe("link_ou_valor_sem_consulta");
      expect(v.detail).toEqual({ links: 1, valores: 0 });
    }
    // Sem a consulta no turno, o mesmo link da base é vetado: a liberação vem do resultado.
    expect((await avaliar(`Segue: ${LINK_DA_BASE}`, await armado({}))).pass).toBe(false);
  });

  it("o link de uma mensagem nossa anterior passa — o botão do gancho com `?sid=`, lido do objeto interativo", async () => {
    const { lerTextosJaEnviados } = await import("@/lib/agent-engine/guardrails/link-permitido");
    const consultas: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: unknown[]) => {
        consultas.push({ sql, params });
        return {
          rows: [
            {
              body: "Oi! Confere as ênfases na página.",
              interativo: {
                type: "cta_url",
                body: { text: "Oi! Confere as ênfases na página." },
                action: { name: "cta_url", parameters: { display_text: "Abrir", url: LINK_DO_BOTAO } },
              },
            },
            { body: "O salário inicial é de R$ 6.638,64.", interativo: null },
          ],
        };
      },
    };
    const textos = await lerTextosJaEnviados(db as never, { tenantId: "org-1", conversationId: "conv-1" });
    expect(consultas[0]?.sql).toMatch(/metadata->'interactive'/);
    expect(consultas[0]?.sql).toMatch(/direction = 'outbound'/);
    expect(consultas[0]?.params).toEqual(["org-1", "conv-1"]);
    const liberado = await armado({ jaEnviados: textos ?? [] });
    expect((await avaliar(`Pode abrir de novo: ${LINK_DO_BOTAO}`, liberado)).pass).toBe(true);
    // O valor que já saiu numa mensagem nossa também passa; o vizinho do link, não.
    expect((await avaliar("Como falei, o salário é de R$ 6.638,64.", liberado)).pass).toBe(true);
    const vizinho = LINK_DO_BOTAO.replace("dc-ab12cd34", "dc-zz99zz99");
    expect((await avaliar(`Abre aqui: ${vizinho}`, liberado)).pass).toBe(false);
  });

  it("a URL fixa da configuração passa sem consulta", async () => {
    const liberado = await armado({ urlsFixas: ["https://ajuda.exemplo.com.br/duvidas/"] });
    expect((await avaliar("Dúvidas: https://ajuda.exemplo.com.br/duvidas", liberado)).pass).toBe(true);
    expect((await avaliar("Dúvidas: https://ajuda.exemplo.com.br/outra", liberado)).pass).toBe(false);
  });

  it("'R$ 6.638,64' do texto de um fato do resultado passa; 'R$ 6.700' inventado é vetado", async () => {
    const liberado = await armado({ resultado: RESULTADO_DA_CONSULTA });
    expect((await avaliar("O salário inicial é de R$ 6.638,64.", liberado)).pass).toBe(true);
    expect((await avaliar("O plano sai por R$ 1.997,00 ou 12x de R$ 166,42.", liberado)).pass).toBe(true);
    for (const inventado of ["O salário é de R$ 6.700.", "Fica em R$ 6.700,00.", "São uns 6.700 reais."]) {
      const v = await avaliar(inventado, liberado);
      expect(v.pass, inventado).toBe(false);
      expect(v.code).toBe("link_ou_valor_sem_consulta");
      expect(v.detail).toEqual({ links: 0, valores: 1 });
    }
  });

  it("o valor é a expressão monetária inteira: com 5 devolvido, 'R$ 5 e 50 centavos', 'R$ 5 000' e 'R$ 5 e meio' são barrados (-c01.8, 3ª revisão)", async () => {
    const liberado = await armado({ resultado: { desconto: 5 } });
    for (const frase of ["O cupom abate R$ 5.", "O cupom abate R$5,00.", "O cupom abate 5 reais.", "Abate R$ 5,00, no cartão."]) {
      expect((await avaliar(frase, liberado)).pass, frase).toBe(true);
    }
    for (const frase of [
      "O cupom abate R$ 5 e 50 centavos.",
      "O cupom abate R$ 5 000.",
      "O cupom abate R$ 5 000.",
      "O cupom abate R$ 5 000.",
      "O cupom abate R$ 5 000.",
      "O cupom abate R$ 5 milhões.",
      "O cupom abate 5 milhões de reais.",
      "O cupom abate R$ 5 e meio.",
      "O cupom abate 5 reais e 50.",
      "O cupom abate 5 reais e 50 centavos.",
      "O cupom abate R$ 5 e 500 centavos.",
      "O cupom abate R$ 5, e mais 50 centavos.",
      "O cupom abate R$ 5 mil.",
      "O cupom abate R$ 5,50.",
      "O cupom abate R$ 5.999.",
    ]) {
      const v = await avaliar(frase, liberado);
      expect(v.pass, frase).toBe(false);
      expect(v.code).toBe("link_ou_valor_sem_consulta");
    }
  });

  it("o valor inteiro igual ao devolvido passa em qualquer escrita; a forma ambígua é barrada (3ª revisão)", async () => {
    const mil = await armado({ resultado: { desconto: 5000 } });
    for (const frase of [
      "Abate R$ 5.000.",
      "Abate R$ 5 000.",
      "Abate R$ 5 000.",
      "Abate R$ 5 000,00.",
      "Abate R$ 5 mil.",
      "Abate 5 mil reais.",
      "Abate R$ 5.000,00.",
    ]) {
      expect((await avaliar(frase, mil)).pass, frase).toBe(true);
    }
    for (const frase of ["Abate R$ 5.000,50.", "Abate R$ 5 mil e 500.", "Abate R$ 5 000 000."]) {
      expect((await avaliar(frase, mil)).pass, frase).toBe(false);
    }
    const cincoECinquenta = await armado({ resultado: { desconto: 5.5 } });
    for (const frase of ["Abate R$ 5,50.", "Abate R$ 5 e 50 centavos.", "Abate 5 reais e 50."]) {
      expect((await avaliar(frase, cincoECinquenta)).pass, frase).toBe(true);
    }
    // A forma em dúvida não vira valor nenhum: barrada mesmo com todos os candidatos devolvidos.
    const todos = await armado({ resultado: { a: 5, b: 5.5, c: 5000, d: 0.5, e: 500 } });
    for (const frase of ["Abate R$ 5,5.", "Abate R$ 5,000.", "Abate R$ 5 00.", "Abate R$ 5,00 000.", "Abate R$ 5 k."]) {
      expect((await avaliar(frase, todos)).pass, frase).toBe(false);
    }
    // O texto da fonte também é lido inteiro: "R$ 5 e 50 centavos" no fato libera 5,50.
    const fato = await armado({ resultado: { texto: "O cupom abate R$ 5 e 50 centavos." } });
    expect((await avaliar("O cupom abate R$ 5,50.", fato)).pass).toBe(true);
  });

  it("a mensagem nossa já enviada libera o valor inteiro dela, não o pedaço (3ª revisão)", async () => {
    const liberado = await armado({ jaEnviados: ["O cupom abate R$ 5 e 50 centavos."] });
    expect((await avaliar("Como falei, o cupom abate R$ 5,50.", liberado)).pass).toBe(true);
    expect((await avaliar("Como falei, o cupom abate R$ 5.", liberado)).pass).toBe(false);
    const ambigua = await armado({ jaEnviados: ["O cupom abate R$ 5 e meio."] });
    expect((await avaliar("O cupom abate R$ 5.", ambigua)).pass).toBe(false);
  });

  it("formatação, emoji, sinal, 'BRL' e continuação: o valor diferente e a forma em dúvida são barrados (-c01.9, 4ª revisão)", async () => {
    const cinco = await armado({ resultado: { desconto: 5 } });
    for (const frase of ["O cupom abate *R$ 5*.", "O cupom abate **R$ 5**.", "🔥 O cupom abate R$ 5.", "O cupom abate R$ +5.", "O cupom abate 5 R$.", "O cupom abate 5,00 BRL."]) {
      expect((await avaliar(frase, cinco)).pass, frase).toBe(true);
    }
    for (const frase of [
      "O cupom abate R$ *997*.",
      "O cupom abate R$*997*.",
      "O cupom abate R$ **997**.",
      "O cupom abate R$ 💰997.",
      "O cupom abate R$ +997.",
      "O cupom abate R$ +5,50.",
      "O cupom abate 997 BRL.",
      "O cupom abate BRL 997.",
      "O cupom abate 997 R$.",
    ]) {
      const v = await avaliar(frase, cinco);
      expect(v.pass, frase).toBe(false);
      expect(v.code).toBe("link_ou_valor_sem_consulta");
    }
    // Em dúvida: barrada mesmo com cada pedaço devolvido pela ferramenta.
    const pedacos = await armado({ resultado: { a: 5, b: 50, c: 5.5, d: 55, e: 997, f: 10 } });
    for (const frase of [
      "O cupom abate R$ -997.",
      "O cupom abate R$ -5.",
      "O cupom abate R$ −5.",
      "O cupom abate -R$ 5.",
      "O cupom abate −R$ 5.",
      "O cupom abate -5 reais.",
      "O cupom abate R$ 5-10.",
      "O cupom abate BRL 5,5.",
      "O cupom abate R$ 5,00 + 50.",
      "O cupom abate R$ 5,00 mais 50.",
      "O cupom abate R$ 5 e cinquenta centavos.",
      "O cupom abate 5 reais e cinquenta centavos.",
    ]) {
      expect((await avaliar(frase, pedacos)).pass, frase).toBe(false);
    }
  });

  it("valor sem R$ não é dinheiro: '12x' passa mesmo sem nada liberado", async () => {
    const vazio = { links: new Set<string>(), valores: new Set<number>() };
    expect((await avaliar("Dá para dividir em 12x, e são 60 metas.", vazio)).pass).toBe(true);
  });

  it("o veto ensina sem repetir o trecho: nem o link nem o valor no texto ao modelo ou no trace", async () => {
    const { evaluateBeforeSend } = await import("@/lib/agent-engine/guardrails/before-send");
    const t = await trava();
    const LINK_INVENTADO = "https://lp.exemplo.com.br/plano-inventado/?cupom=SEGREDO";
    const corpo = `O salário é de R$ 6.700. Matrícula: ${LINK_INVENTADO}`;
    const { veto, trace } = evaluateBeforeSend(
      { body: corpo, travasDeEnvio: { linkEValorDeFerramenta: await armado({}) } } as never,
      [t.linkEValorDeFerramentaGate as never],
    );
    expect(veto?.code).toBe(t.CODIGO_DO_VETO_DE_LINK_OU_VALOR);
    expect(veto?.message).toMatch(/NÃO foi enviada/);
    expect(veto?.message).toMatch(/link e valor em reais que não vieram de uma consulta neste turno/);
    expect(veto?.message).toMatch(/use exatamente o que voltou, ou tire o trecho\. Nunca comente isso com o cliente\./);
    const tudo = JSON.stringify({ veto, trace });
    for (const trecho of ["6.700", "6700", "plano-inventado", "SEGREDO", "lp.exemplo.com.br"]) {
      expect(tudo, trecho).not.toContain(trecho);
    }
    expect(trace).toEqual([
      { gate: "link_e_valor_de_ferramenta", verdict: "veto", code: "link_ou_valor_sem_consulta", detail: { links: 1, valores: 1 } },
    ]);
  });
});

describe("(C01) a configuração: interruptor na tela, URLs fixas no JSON", () => {
  it("vem desligada; liga só pelo interruptor (`org_guardrail_layers`), mesmo com o JSON inválido; as URLs fixas vêm normalizadas", async () => {
    const { interpretarTravasDeEnvio } = (await import(/* @vite-ignore */ CAMINHO_DA_CONFIGURACAO)) as {
      interpretarTravasDeEnvio: (
        v: unknown,
        i?: { linkEValorDeFerramenta?: boolean },
      ) => { travas: { linkEValorDeFerramenta: boolean; urlsFixas: string[] }; invalida: boolean };
    };
    expect(interpretarTravasDeEnvio(undefined).travas.linkEValorDeFerramenta).toBe(false);
    // `ligada` no JSON não liga esta trava: o interruptor é o da tela.
    expect(
      interpretarTravasDeEnvio({ link_e_valor_de_ferramenta: { ligada: true } }).travas.linkEValorDeFerramenta,
    ).toBe(false);
    const ligada = interpretarTravasDeEnvio(
      { link_e_valor_de_ferramenta: { urls: ["HTTPS://WWW.Ajuda.Exemplo.com.br/duvidas/", " "] } },
      { linkEValorDeFerramenta: true },
    );
    expect(ligada.travas.linkEValorDeFerramenta).toBe(true);
    expect(ligada.travas.urlsFixas).toEqual(["ajuda.exemplo.com.br/duvidas"]);
    // JSON inválido: as outras travas desligam; esta segue ligada, sem URL fixa (mais estrita).
    const invalido = interpretarTravasDeEnvio({ texto_longo: { ligada: "sim" } }, { linkEValorDeFerramenta: true });
    expect(invalido.invalida).toBe(true);
    expect(invalido.travas).toMatchObject({ linkEValorDeFerramenta: true, urlsFixas: [] });
  });

  it("o turno lê o interruptor na mesma consulta das travas, pela chave constante", async () => {
    const { lerTravasDeEnvioDaOrg } = (await import(/* @vite-ignore */ CAMINHO_DA_CONFIGURACAO)) as {
      lerTravasDeEnvioDaOrg: (
        db: unknown,
        org: string,
      ) => Promise<{ travas: { linkEValorDeFerramenta: boolean }; leituraFalhou: boolean }>;
    };
    const t = await trava();
    expect(t.INTERRUPTOR_DA_TRAVA).toBe("trava:link_e_valor_de_ferramenta");
    const consultas: string[] = [];
    const ligado = {
      query: async (sql: string) => {
        consultas.push(sql);
        return { rows: [{ travas: null, link_e_valor: true }] };
      },
    };
    expect(await lerTravasDeEnvioDaOrg(ligado, "org-1")).toMatchObject({
      travas: { linkEValorDeFerramenta: true },
      leituraFalhou: false,
    });
    expect(consultas[0]).toMatch(/from org_guardrail_layers l/);
    expect(consultas[0]).toContain("l.layer = 'trava:link_e_valor_de_ferramenta'");
    const semLinha = { query: async () => ({ rows: [{ travas: null, link_e_valor: null }] }) };
    expect((await lerTravasDeEnvioDaOrg(semLinha, "org-1")).travas.linkEValorDeFerramenta).toBe(false);
  });

  it("`valor_em_dinheiro`: a linha da tela, se existe, manda; sem linha, vale o JSON de antes", async () => {
    const { interpretarTravasDeEnvio, lerTravasDeEnvioDaOrg } = (await import(
      /* @vite-ignore */ CAMINHO_DA_CONFIGURACAO
    )) as {
      interpretarTravasDeEnvio: (
        v: unknown,
        i?: { valorEmDinheiro?: boolean | null },
      ) => { travas: { valorEmDinheiro: boolean }; invalida: boolean };
      lerTravasDeEnvioDaOrg: (db: unknown, org: string) => Promise<{ travas: { valorEmDinheiro: boolean } }>;
    };
    const noJson = { valor_em_dinheiro: { ligada: true } };
    const casos: Array<[unknown, boolean | null, boolean]> = [
      [null, null, false], // nada liga sozinho
      [noJson, null, true], // sem linha: o JSON de antes (o laboratório continua como está)
      [noJson, false, false], // a linha desliga o que o JSON liga
      [null, true, true], // a linha liga sem JSON
      [{ valor_em_dinheiro: { ligada: false } }, true, true],
      [{ texto_longo: { ligada: "sim" } }, true, true], // JSON inválido: a linha ainda manda
      [{ texto_longo: { ligada: "sim" } }, null, false],
    ];
    for (const [json, linha, esperado] of casos) {
      expect(
        interpretarTravasDeEnvio(json, { valorEmDinheiro: linha }).travas.valorEmDinheiro,
        JSON.stringify({ json, linha }),
      ).toBe(esperado);
    }
    const consultas: string[] = [];
    const db = {
      query: async (sql: string) => {
        consultas.push(sql);
        return { rows: [{ travas: noJson, link_e_valor: null, valor_em_dinheiro: false }] };
      },
    };
    expect((await lerTravasDeEnvioDaOrg(db, "org-1")).travas.valorEmDinheiro).toBe(false);
    expect(consultas[0]).toContain("l.layer = 'trava:valor_em_dinheiro') as valor_em_dinheiro");
  });
});

describe("(C01) convivência com a `valor_em_dinheiro` (CRM-060), na ordem da cadeia", () => {
  /** O resultado da consulta às ofertas (base externa): o preço do curso, que a trava nova libera. */
  const RESULTADO_DAS_OFERTAS = {
    content: [{ type: "text", text: JSON.stringify({ rows: [{ produto: "Plano anual", preco: 1997, parcela: "166.42" }] }) }],
  };

  async function cadeia(body: string, opcoes: { valorEmDinheiro: boolean; linkEValor: boolean }) {
    const { BEFORE_SEND_GATES, evaluateBeforeSend } = await import("@/lib/agent-engine/guardrails/before-send");
    const gates = BEFORE_SEND_GATES.filter((g) =>
      ["link_e_valor_de_ferramenta", "valor_em_dinheiro"].includes(g.name),
    );
    expect(gates.map((g) => g.name)).toEqual(["link_e_valor_de_ferramenta", "valor_em_dinheiro"]);
    const liberado = await armado({ resultado: [RESULTADO_DAS_OFERTAS, RESULTADO_DA_CONSULTA] });
    return evaluateBeforeSend(
      {
        body,
        travasDeEnvio: {
          ...(opcoes.linkEValor ? { linkEValorDeFerramenta: liberado } : {}),
          ...(opcoes.valorEmDinheiro ? { valorEmDinheiro: true } : {}),
        },
      } as never,
      gates as never,
    );
  }

  it("o preço do curso que veio das ofertas neste turno é barrado pela `valor_em_dinheiro`, mesmo com a nova ligada", async () => {
    const { veto, trace } = await cadeia("O plano anual sai por R$ 1.997,00 ou 12x de R$ 166,42.", {
      valorEmDinheiro: true,
      linkEValor: true,
    });
    expect(veto?.code).toBe("valor_em_dinheiro");
    expect(trace.map((e) => [e.gate, e.verdict])).toEqual([
      ["link_e_valor_de_ferramenta", "pass"],
      ["valor_em_dinheiro", "veto"],
    ]);
    // Por isso a `valor_em_dinheiro` ganhou interruptor: sem ela, a nova soltaria o preço.
    expect((await cadeia("O plano anual sai por R$ 1.997,00.", { valorEmDinheiro: false, linkEValor: true })).veto).toBeNull();
  });

  it("o salário da base passa nas duas", async () => {
    const { veto, trace } = await cadeia("O salário inicial é de R$ 6.638,64.", { valorEmDinheiro: true, linkEValor: true });
    expect(veto).toBeNull();
    expect(trace.map((e) => e.verdict)).toEqual(["pass", "pass"]);
  });

  it("o salário inventado é barrado pela nova (a `valor_em_dinheiro` o deixaria passar)", async () => {
    const ambas = await cadeia("O salário inicial é de R$ 6.700.", { valorEmDinheiro: true, linkEValor: true });
    expect(ambas.veto?.code).toBe("link_ou_valor_sem_consulta");
    const soAAntiga = await cadeia("O salário inicial é de R$ 6.700.", { valorEmDinheiro: true, linkEValor: false });
    expect(soAAntiga.veto).toBeNull();
  });
});

describe("(C01) a ligação no turno e na cadeia, pelo código", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const CADEIA = readFileSync("lib/agent-engine/guardrails/before-send.ts", "utf8");

  it("a cadeia roda a trava antes da de link, depois das de consulta e marcador (v12; v13 na -c01.14)", () => {
    expect(CADEIA).toMatch(/marcadorEntreColchetesGate,\s*linkEValorDeFerramentaGate,\s*linkPermitidoGate,/);
    expect(CADEIA).toMatch(/export const BEFORE_SEND_CHAIN_VERSION = 1[2-9];/);
  });

  it("é trava de conteúdo: contador e fail-safe (no 3º veto o texto não sai e a conversa passa à equipe)", async () => {
    const turno = await import("@/lib/agent-engine/agent/inbound-turn");
    expect(turno.TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE).toHaveProperty("link_ou_valor_sem_consulta");
    expect(turno.TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE.link_ou_valor_sem_consulta).not.toMatch(/_/);
    expect(turno.MAX_VETOS_DE_CONTEUDO).toBe(3);
    const t = turno.textosDoFimSemResposta({
      motivo: "veto_de_conteudo",
      trava: "link_ou_valor_sem_consulta",
      vetos: 3,
      texto: "O salário é de R$ 6.700.",
    } as never);
    expect(t.tituloDoCaso).toBe("Resposta travada pela revisão automática (link ou valor que não veio de consulta)");
    // O texto vetado vai ao caso (é o que a pessoa da equipe precisa ler), não ao log.
    expect(t.resumo).toBe("O salário é de R$ 6.700.");
  });

  it("as fontes são as ferramentas de CONSULTA: a base externa (sem o erro), a base RAG e a referência de skill", () => {
    expect(TURNO).toMatch(/if \(out\.ok\) registrarConsulta\(out\.results\);/);
    // (Revisão B1) O erro da base externa não tem `isError`: quem o reconhece é `resultadoComErro`.
    expect(TURNO).toMatch(/if \(!resultadoComErro\(resultado\)\) registrarConsulta\(resultado\);/);
    expect(TURNO).toMatch(/if \(referencia\.ok\) registrarConsulta\(referencia\.content\);/);
    expect(TURNO.match(/registrarConsulta\(/g)).toHaveLength(3); // as três fontes, e só elas
    // O histórico e as notas não são fonte: o número que o cliente citou não sai como se viesse da base.
    const contexto = TURNO.slice(TURNO.indexOf("get_lead_context: tool({"), TURNO.indexOf("send_template: tool({"));
    expect(contexto).not.toContain("registrarConsulta");
  });

  it("as mensagens já enviadas são lidas uma vez, só com a trava ligada; a leitura que falha NÃO desarma", () => {
    expect(TURNO.match(/await lerTextosJaEnviados\(/g)).toHaveLength(1);
    expect(TURNO).toMatch(
      /const textosJaEnviados = travasDaOrg\.travas\.linkEValorDeFerramenta\s*\?\s*await lerTextosJaEnviados\(pool, \{ tenantId, conversationId: input\.conversationId \}\)\s*:\s*null;/,
    );
    // Arma pelo interruptor, sem depender de a leitura ter dado certo.
    expect(TURNO).toMatch(
      /\.\.\.\(travasDaOrg\.travas\.linkEValorDeFerramenta \? \{ linkEValorDeFerramenta: linkEValorLiberado\(\) \} : \{\}\),/,
    );
  });

  it("liberado = conversa + o que saiu neste turno + URLs fixas + consultas do turno, recalculado a cada envio", () => {
    expect(TURNO).toMatch(/const doTurno = linksEValoresDosTextos\(corposEnviados\);/);
    // (Revisão B1) Sem `urlsDaBase`: ele guarda também o erro da base externa.
    const liberacao = TURNO.slice(
      TURNO.indexOf("const linkEValorLiberado = (): LinkEValorArmado => {"),
      TURNO.indexOf("const linksLiberados = (): Set<string> => {"),
    );
    expect(liberacao.length).toBeGreaterThan(100);
    expect(liberacao).not.toMatch(/for \(const url of urlsDaBase\)/);
    expect(TURNO).toMatch(/\.\.\.travasDaOrg\.travas\.urlsFixas\]/);
    expect(TURNO).toMatch(/for \(const url of urlsDaConsulta\) links\.add\(normalizarLink\(url\)\);/);
    expect(TURNO).toMatch(/\.\.\.valoresDaConsulta\]\);/);
  });
});
