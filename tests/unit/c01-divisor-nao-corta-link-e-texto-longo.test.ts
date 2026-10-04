/**
 * (C01, -c01.3, item 2) MENSAGEM CURTA SEM CORTAR LINK.
 *
 * O defeito: o divisor de bolhas tratava todo "." e todo "?" como fim de frase — os
 * de dentro de um link também. Com `split_max_chars` 300–350, a página de matrícula da
 * C10 e da C41 (volta 19) saía como "https://lp. exemplo. com. br/plano-completo/? nivel=…",
 * espalhada por bolhas e com espaços no meio: link quebrado. O laboratório teve de
 * subir o teto por bolha para 2.000, e as respostas passaram a sair em blocos enormes.
 *
 * A correção, em duas partes:
 * 1. o divisor não parte dentro de link, e-mail ou domínio (`trechosIndivisiveis`); o
 *    ponto final logo depois do link continua partindo;
 * 2. com o teto por bolha baixo, a resposta que viraria mais mensagens do que cabem no
 *    turno volta ao modelo para ficar mais curta (trava `texto_longo`, ligada por
 *    organização); é trava de estilo: no 2º veto se desarma e a mensagem sai dividida
 *    como hoje.
 *
 * O divisor e a trava se provam por comportamento (links na forma dos da base e os
 * textos da C10 e da C41, com nomes, links e valores fictícios: regra do C01.md, nada
 * da C01 no código); a ligação no turno, por leitura do código. Os módulos novos entram
 * por import dinâmico: sem a mudança, só os casos deles falham, e os do divisor medem
 * o defeito de verdade.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { splitIntoBubbles } from "@/lib/agent-engine/agent/split-message";

const LINKS_DA_BASE = [
  "https://lp.exemplo.com.br/plano-completo/?nivel=superior",
  "https://lp.exemplo.com.br/plano-completo-pix-parcelado?nivel=tecnico",
  "https://player-vz-5f18b79a-58d.tv.pandavideo.com.br/embed/?v=dd8b6425-0048-4707-bb7b-9f6fece1187b",
  "https://matricula.escolaexemplo.com.br/pay/concurso-estatal-premium-administracao-completo-18x",
  "https://boleto.exemplo.com.br/concurso-premium-engenharia-civil-12-meses",
];

const C10 =
  "Pra Manutenção – Mecânica, eu iria no Plano Completo porque o acesso não expira. " +
  "No cartão fica em 18x de R$ 104,20, com juros de 1,67% ao mês; no Pix à vista, R$ 1.690, sem juros. " +
  "Também existe parcelado sem cartão, caso precise. " +
  "A página de matrícula é https://lp.exemplo.com.br/plano-completo/?nivel=tecnico.";

const C41 =
  "Pra vc eu iria no Plano Completo, porque o acesso não expira. " +
  "No cartão fica em 18 parcelas de R$ 157,30, com juros de 1,67% ao mês. " +
  "No Pix à vista, R$ 2.490, sem juros. " +
  "A matrícula pra Engenharia de Equipamentos – Elétrica é por aqui https://lp.exemplo.com.br/plano-completo/?nivel=superior .";

/** Nenhuma bolha passa do limite — salvo a que é um link sozinho, que não se parte. */
function semBolhaAcimaDoLimite(bolhas: string[], limite: number): void {
  for (const b of bolhas) {
    if (b.length <= limite) continue;
    expect(b, `bolha de ${b.length} > ${limite} que não é um link sozinho`).not.toMatch(/\s/);
    expect(b).toMatch(/^https?:\/\//);
  }
}

describe("(C01) o divisor não parte link, e-mail nem domínio", () => {
  it.each(LINKS_DA_BASE)("o link da base sai inteiro numa bolha: %s", (link) => {
    for (const limite of [30, 60, 120, 300]) {
      const bolhas = splitIntoBubbles(`Segue o link: ${link}. Qualquer dúvida, me chama.`, limite);
      expect(bolhas.some((b) => b.includes(link)), `limite ${limite}: ${JSON.stringify(bolhas)}`).toBe(
        true,
      );
      semBolhaAcimaDoLimite(bolhas, limite);
    }
  });

  it.each([
    ["C10", C10, "https://lp.exemplo.com.br/plano-completo/?nivel=tecnico"],
    ["C41", C41, "https://lp.exemplo.com.br/plano-completo/?nivel=superior"],
  ])("%s (volta 19) com 300 e 350 por bolha: o link de matrícula chega inteiro", (_, texto, link) => {
    for (const limite of [200, 300, 350]) {
      const bolhas = splitIntoBubbles(texto, limite);
      expect(bolhas.join(" ")).toContain(link);
      expect(bolhas.join(" ")).not.toMatch(/https:\/\/lp\. exemplo\./);
      semBolhaAcimaDoLimite(bolhas, limite);
    }
  });

  it("domínio sem esquema e e-mail também não se partem", () => {
    const dominio = splitIntoBubbles(
      "A página é lp.exemplo.com.br/plano-completo/?nivel=superior e lá tem tudo. Qualquer coisa, me chama.",
      40,
    );
    expect(dominio.join(" | ")).toContain("lp.exemplo.com.br/plano-completo/?nivel=superior");
    const email = splitIntoBubbles("Escreva para contato@exemplo.com.br. Respondo por lá mesmo, tá?", 30);
    expect(email.join(" | ")).toContain("contato@exemplo.com.br.");
    expect(email.some((b) => b.includes("contato@exemplo.com.br"))).toBe(true);
  });

  it("(rodada 2) domínio sem barra com parâmetro não se parte: o parágrafo acima de 300 sai com o endereço inteiro", () => {
    // Achado 4 da 1ª revisão da -c01.3: o divisor protegia só o domínio e partia no "?",
    // e a bolha saía com "lp.exemplo.com.br? nivel=superior".
    const link = "lp.exemplo.com.br?nivel=superior";
    const texto =
      "Pra Engenharia de Equipamentos eu iria no Plano Completo, porque o acesso não expira e dá pra " +
      "estudar no seu ritmo, com as metas da semana e o simulado do fim do mês. " +
      `A página de matrícula é ${link} e lá estão as formas de pagamento. ` +
      "Qualquer dúvida sobre o edital ou sobre a rotina de estudo, me chama por aqui que eu te explico.";
    expect(texto.length).toBeGreaterThan(300);
    for (const limite of [80, 120, 300]) {
      const bolhas = splitIntoBubbles(texto, limite);
      expect(bolhas.some((b) => b.includes(link)), `limite ${limite}: ${JSON.stringify(bolhas)}`).toBe(true);
      expect(bolhas.join(" | ")).not.toMatch(/lp\.exemplo\.com\.br\?(?: | \| )nivel/);
    }
  });

  it("(rodada 2) um reconhecedor de link só: o divisor protege cada link que a trava vê, com a mesma extensão", async () => {
    const { linksNoTexto } = await import("@/lib/agent-engine/guardrails/link-permitido");
    const { trechosIndivisiveis } = await import("@/lib/agent-engine/agent/split-message");
    const texto =
      "Veja https://lp.exemplo.com.br/plano-completo/?nivel=superior, www.exemplo.com.br/blog e " +
      "lp.exemplo.com.br?nivel=tecnico#planos. Link:boleto.exemplo.com.br/x. Escreva para contato@exemplo.com.br.";
    const protegidos = trechosIndivisiveis(texto).map(([ini, fim]) => texto.slice(ini, fim));
    const links = linksNoTexto(texto);
    expect(links).toEqual([
      "https://lp.exemplo.com.br/plano-completo/?nivel=superior",
      "www.exemplo.com.br/blog",
      "lp.exemplo.com.br?nivel=tecnico#planos",
      "boleto.exemplo.com.br/x",
    ]);
    for (const link of links) expect(protegidos).toContain(link);
    // O e-mail não é link (a trava não o confere), mas o divisor também não o parte.
    expect(protegidos).toContain("contato@exemplo.com.br");
    // E o divisor não tem reconhecedor de link próprio.
    const divisor = readFileSync("lib/agent-engine/agent/split-message.ts", "utf8");
    expect(divisor).toMatch(/import \{ trechosDeLink \} from ["']\.\.\/guardrails\/link-permitido["'];/);
    expect(divisor).not.toMatch(/https\?:/);
  });

  it.each(["lp.exemplo.com.br.fake.xyz/pagamento", "lp.exemplo.com.br:8080/?nivel=inventado"])(
    "(rodada 3) a autoridade inteira não se parte, e a trava vê o endereço inteiro em cada bolha: %s",
    async (link) => {
      // Achado 4 da 2ª revisão da -c01.3: o divisor protegia só `lp.exemplo.com.br` e
      // partia no ponto do domínio falso ou no `?` depois da porta.
      const { linkPermitidoGate, normalizarLink } = await import("@/lib/agent-engine/guardrails/link-permitido");
      const texto =
        "Pra Engenharia de Equipamentos eu iria no Plano Completo, porque o acesso não expira e dá pra " +
        "estudar no seu ritmo, com as metas da semana e o simulado do fim do mês. " +
        `A página de matrícula é ${link} e lá estão as formas de pagamento. ` +
        "Qualquer dúvida sobre o edital ou sobre a rotina de estudo, me chama por aqui que eu te explico.";
      const trava = {
        liberados: new Set([normalizarLink("https://lp.exemplo.com.br")]),
        dominios: ["exemplo.com.br"],
      };
      // Sem divisor: o texto inteiro volta.
      const inteiro = linkPermitidoGate.evaluate({ body: texto, travasDeEnvio: { linkPermitido: trava } } as never);
      expect(inteiro.pass).toBe(false);
      for (const limite of [80, 120, 300]) {
        const bolhas = splitIntoBubbles(texto, limite);
        expect(bolhas.some((b) => b.includes(link)), `limite ${limite}: ${JSON.stringify(bolhas)}`).toBe(true);
        // Com divisor: a bolha do link volta, com o endereço inteiro no erro de ensino.
        const vetadas = bolhas
          .map((b) => linkPermitidoGate.evaluate({ body: b, travasDeEnvio: { linkPermitido: trava } } as never))
          .filter((v) => !v.pass);
        expect(vetadas, `limite ${limite}`).toHaveLength(1);
        expect(vetadas[0]!.reason).toContain(`"${link}"`);
      }
    },
  );

  it("controle: o ponto final logo depois do link ainda encerra a frase", () => {
    const bolhas = splitIntoBubbles(
      "Veja em https://lp.exemplo.com.br/plano-completo/?nivel=superior. Depois me conta o que achou.",
      70,
    );
    expect(bolhas).toEqual([
      "Veja em https://lp.exemplo.com.br/plano-completo/?nivel=superior.",
      "Depois me conta o que achou.",
    ]);
  });

  it("controle: frase comum continua partindo como antes (sem domínio inventado)", () => {
    expect(splitIntoBubbles("Fica com. Brasil inteiro tem isso.", 25)).toEqual([
      "Fica com.",
      "Brasil inteiro tem isso.",
    ]);
    expect(splitIntoBubbles("Oi. Tudo bem? Beleza.", 10)).toEqual(["Oi.", "Tudo bem?", "Beleza."]);
  });
});

const CAMINHO_DA_TRAVA = "@/lib/agent-engine/guardrails/texto-longo";
const CAMINHO_DA_CONFIGURACAO = "@/lib/agent-engine/guardrails/travas-de-envio";

type Veredito = { pass: boolean; code?: string; reason?: string; detail?: Record<string, unknown> };
async function trava(): Promise<(body: string, armada?: { maxChars: number; restantes: number }) => Veredito> {
  const m = (await import(/* @vite-ignore */ CAMINHO_DA_TRAVA)) as {
    textoLongoGate: { name: string; evaluate: (ctx: unknown) => Veredito };
  };
  expect(m.textoLongoGate.name).toBe("texto_longo");
  return (body, armada) =>
    m.textoLongoGate.evaluate({ body, ...(armada ? { travasDeEnvio: { textoLongo: armada } } : {}) });
}

const QUATRO_PARAGRAFOS = [
  "Pra Manutenção – Mecânica, eu iria no Plano Completo porque o acesso não expira.",
  "No cartão fica em 18x de R$ 104,20, com juros de 1,67% ao mês; no Pix à vista, R$ 1.690, sem juros.",
  "Também existe parcelado sem cartão, caso precise.",
  "A página de matrícula é https://lp.exemplo.com.br/plano-completo/?nivel=tecnico.",
].join("\n\n");

describe("(C01) a trava 'texto longo'", () => {
  it("desarmada (sem a chave), passa qualquer tamanho", async () => {
    const avaliar = await trava();
    expect(avaliar("x ".repeat(5000)).pass).toBe(true);
  });

  it("a resposta que viraria mais mensagens do que cabem volta, com números e sem o texto", async () => {
    const avaliar = await trava();
    const v = avaliar(QUATRO_PARAGRAFOS, { maxChars: 300, restantes: 3 });
    expect(v.pass).toBe(false);
    expect(v.code).toBe("texto_longo");
    expect(v.reason).toMatch(/viraria 4 mensagens/);
    expect(v.reason).toMatch(/só cabem 3 mensagens de até 300 caracteres/);
    expect(v.reason).toMatch(/Reescreva mais curta/);
    expect(v.reason).toMatch(/sem mudar nenhum link/);
    expect(v.detail).toEqual({ bolhas: 4, restantes: 3, max_chars: 300 });
    expect(JSON.stringify(v.detail)).not.toMatch(/Plano Completo/);
  });

  it("cabe → passa; o link longo não infla a conta (vira uma bolha só)", async () => {
    const avaliar = await trava();
    expect(avaliar(QUATRO_PARAGRAFOS, { maxChars: 300, restantes: 4 }).pass).toBe(true);
    const comLink = `A matrícula é por aqui: ${LINKS_DA_BASE[3]}.`;
    expect(avaliar(comLink, { maxChars: 300, restantes: 1 }).pass).toBe(true);
  });

  it("sem mensagem restante no turno não julga (o teto de envios recusa por outro caminho)", async () => {
    const avaliar = await trava();
    expect(avaliar(QUATRO_PARAGRAFOS, { maxChars: 300, restantes: 0 }).pass).toBe(true);
  });
});

describe("(C01) a configuração por organização (`settings.travas_de_envio`)", () => {
  type Leitura = { travas: { textoLongo: boolean }; leituraFalhou?: boolean; invalida?: boolean };
  async function modulo(): Promise<{
    interpretarTravasDeEnvio: (v: unknown) => Leitura;
    lerTravasDeEnvioDaOrg: (db: unknown, org: string) => Promise<Leitura>;
  }> {
    return (await import(/* @vite-ignore */ CAMINHO_DA_CONFIGURACAO)) as never;
  }

  it("ausente = desligada; ligada só com `ligada: true`; JSON inválido = tudo desligado, com aviso", async () => {
    const { interpretarTravasDeEnvio } = await modulo();
    expect(interpretarTravasDeEnvio(undefined)).toMatchObject({ travas: { textoLongo: false }, invalida: false });
    expect(interpretarTravasDeEnvio({})).toMatchObject({ travas: { textoLongo: false }, invalida: false });
    expect(interpretarTravasDeEnvio({ texto_longo: { ligada: true } }).travas.textoLongo).toBe(true);
    expect(interpretarTravasDeEnvio({ texto_longo: { ligada: false } }).travas.textoLongo).toBe(false);
    expect(interpretarTravasDeEnvio({ texto_longo: { ligada: "sim" } })).toMatchObject({
      travas: { textoLongo: false },
      invalida: true,
    });
    expect(interpretarTravasDeEnvio("ligado").invalida).toBe(true);
  });

  it("lê `organizations.settings` da organização; leitura que falha = desligada, com aviso", async () => {
    const { lerTravasDeEnvioDaOrg } = await modulo();
    const consultas: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: unknown[]) => {
        consultas.push({ sql, params });
        return { rows: [{ travas: { texto_longo: { ligada: true } } }] };
      },
    };
    expect(await lerTravasDeEnvioDaOrg(db, "org-1")).toMatchObject({
      travas: { textoLongo: true },
      leituraFalhou: false,
    });
    expect(consultas[0]?.sql).toMatch(/settings->'travas_de_envio'/);
    expect(consultas[0]?.params).toEqual(["org-1"]);
    const quebrado = { query: async () => Promise.reject(new Error("conexão caiu")) };
    expect(await lerTravasDeEnvioDaOrg(quebrado, "org-1")).toMatchObject({
      travas: { textoLongo: false },
      leituraFalhou: true,
    });
  });
});

describe("(C01) a ligação no turno e na cadeia, pelo código", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const CADEIA = readFileSync("lib/agent-engine/guardrails/before-send.ts", "utf8");
  const sendMessage = TURNO.slice(
    TURNO.indexOf("send_message: tool({"),
    TURNO.indexOf("update_lead_state: tool({"),
  );

  it("a cadeia arma a trava pelo contexto, lido na hora de cada execução", () => {
    expect(CADEIA).toMatch(/travasDeEnvio: args\.travasDeEnvio\(\)/);
    expect(CADEIA).toMatch(/textoLongoGate,\s*disclosureGate,/);
  });

  it("o turno lê a configuração uma vez, antes das ferramentas; arma só com o divisor ligado", () => {
    expect(TURNO.match(/await lerTravasDeEnvioDaOrg\(pool, tenantId\)/g)).toHaveLength(1);
    expect(TURNO.indexOf("await lerTravasDeEnvioDaOrg(")).toBeLessThan(TURNO.indexOf("send_message: tool({"));
    expect(TURNO).toMatch(
      /travasDaOrg\.travas\.textoLongo &&\s*\(agentConfig\?\.splitMessages \?\? false\) &&\s*!estiloDesarmado\('texto_longo'\)/,
    );
    expect(TURNO).toMatch(/restantes: maxSendsPerTurn - seq,/);
  });

  it("só o `send_message` arma, e a frase de espera (texto do sistema) sai sem as travas", () => {
    expect(TURNO.match(/travasDeEnvio:/g)).toHaveLength(1);
    expect(sendMessage).toMatch(
      /travasDeEnvio: \(\): TravasArmadas => \(enviandoFraseDeEspera \? \{\} : travasArmadas\(\)\),/,
    );
  });

  it("1º veto ensina; no 2º a trava se desarma no turno e a cadeia roda de novo, sem perder o caso aberto", () => {
    const i = sendMessage.indexOf("while (chain.status === 'vetoed' && Object.hasOwn(TRAVAS_DE_ESTILO, chain.code))");
    expect(i).toBeGreaterThan(sendMessage.indexOf("chain.code === 'case_promise_without_case'"));
    expect(i).toBeLessThan(sendMessage.indexOf("chain.code === 'internal_vocabulary_leak'"));
    const bloco = sendMessage.slice(i, sendMessage.indexOf("chain.code === 'internal_vocabulary_leak'"));
    expect(bloco).toMatch(
      /const vetos = \(vetosDeEstilo\.get\(chain\.code\) \?\? 0\) \+ 1;\s*vetosDeEstilo\.set\(chain\.code, vetos\);\s*if \(vetos < MAX_VETOS_DE_ESTILO\) \{\s*return \{ ok: false, error: \{ code: chain\.code, message: chain\.message \} \};/,
    );
    expect(bloco).toMatch(
      /chain = await cadeiaDeEnvio\(\(\) =>\s*runBeforeSend\(\{\s*\.\.\.beforeSendArgs,\s*\.\.\.\(openedCaseThisTurn \? \{ hasOpenCase: true, openedCaseThisTurn: true \} : \{\}\),\s*\}\),\s*\);/,
    );
    expect(TURNO).toMatch(/export const MAX_VETOS_DE_ESTILO = 2;/);
    expect(TURNO).toMatch(/texto_longo: 'textoLongo',/);
    expect(TURNO).toMatch(
      /const estiloDesarmado = \(codigo: string\): boolean => \(vetosDeEstilo\.get\(codigo\) \?\? 0\) >= MAX_VETOS_DE_ESTILO;/,
    );
  });
});
