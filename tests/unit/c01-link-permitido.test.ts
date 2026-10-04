/**
 * (C01, -c01.3, item 3a) SÓ SAI O LINK QUE TEM DE ONDE VIR.
 *
 * O defeito: nada conferia o link que o modelo escrevia. Ele trocava o `?nivel=` da
 * página de matrícula, inventava caminho ou colava o endereço de outra ênfase, e o
 * lead ia parar na página errada.
 *
 * A trava `link_permitido` (ligada por organização) libera o link que a base devolveu
 * no turno, o que já foi mandado na conversa e o de domínio da lista da organização;
 * o resto volta ao modelo com "consulte a base e use o link exato". É trava de
 * conteúdo: contador e fail-safe da promessa semântica.
 *
 * A trava e a leitura dos links já enviados se provam por comportamento; a ligação no
 * turno, por leitura do código. O módulo novo entra por import dinâmico. Domínios e
 * links são fictícios, na forma dos reais (regra do C01.md: nada da C01 no código).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CAMINHO_DA_TRAVA = "@/lib/agent-engine/guardrails/link-permitido";
const CAMINHO_DA_CONFIGURACAO = "@/lib/agent-engine/guardrails/travas-de-envio";

type Veredito = { pass: boolean; code?: string; reason?: string; detail?: Record<string, unknown> };
interface Modulo {
  linkPermitidoGate: { name: string; evaluate: (ctx: unknown) => Veredito };
  linksNoTexto: (texto: string) => string[];
  normalizarLink: (link: string) => string;
  lerLinksJaEnviados: (
    db: unknown,
    input: { tenantId: string; conversationId: string },
  ) => Promise<Set<string> | null>;
}
async function modulo(): Promise<Modulo> {
  return (await import(/* @vite-ignore */ CAMINHO_DA_TRAVA)) as Modulo;
}

const DA_BASE = "https://lp.exemplo.com.br/plano-completo/?nivel=superior";
const PANDA =
  "https://player-vz-5f18b79a-58d.tv.pandavideo.com.br/embed/?v=dd8b6425-0048-4707-bb7b-9f6fece1187b";

async function avaliar(
  body: string,
  trava?: { liberados?: string[]; dominios?: string[] },
): Promise<Veredito> {
  const m = await modulo();
  expect(m.linkPermitidoGate.name).toBe("link_permitido");
  const ctx =
    trava === undefined
      ? { body }
      : {
          body,
          travasDeEnvio: {
            linkPermitido: {
              liberados: new Set((trava.liberados ?? []).map(m.normalizarLink)),
              dominios: trava.dominios ?? [],
            },
          },
        };
  return m.linkPermitidoGate.evaluate(ctx);
}

describe("(C01) a trava 'link permitido'", () => {
  it("desarmada (sem a chave), passa qualquer link", async () => {
    expect((await avaliar("Entra em https://golpe.example/pagar")).pass).toBe(true);
  });

  it("o link exato da base passa — também sem esquema, com ponto final e domínio em maiúsculas", async () => {
    const trava = { liberados: [DA_BASE, PANDA] };
    expect((await avaliar(`A matrícula é por aqui: ${DA_BASE}.`, trava)).pass).toBe(true);
    expect((await avaliar("Vê em lp.exemplo.com.br/plano-completo/?nivel=superior, tá?", trava)).pass).toBe(true);
    expect((await avaliar("Link: HTTPS://LP.EXEMPLO.COM.BR/plano-completo/?nivel=superior", trava)).pass).toBe(true);
    expect((await avaliar(`Assiste aqui (${PANDA})`, trava)).pass).toBe(true);
  });

  it("o link montado volta: outro `nivel`, outro caminho, domínio parecido", async () => {
    const trava = { liberados: [DA_BASE] };
    for (const inventado of [
      "https://lp.exemplo.com.br/plano-completo/?nivel=tecnico",
      "https://lp.exemplo.com.br/plano-completo-engenharia",
      "https://lp.exemplo.com.br.pagamento.io/plano-completo",
      "https://matricula.escolaexemplo.com.br/pay/concurso-completo-18x",
      "lp.exemplo.com.br/plano-completo/?nivel=tecnico",
    ]) {
      const v = await avaliar(`A matrícula é por aqui: ${inventado}.`, trava);
      expect(v.pass, inventado).toBe(false);
      expect(v.code).toBe("link_nao_permitido");
      expect(v.reason).toContain(inventado);
      expect(v.reason).toMatch(/consulte a base e use o link exato/);
    }
  });

  it("domínio liberado pela organização passa (o domínio e os subdomínios dele), e só ele", async () => {
    const trava = { dominios: ["exemplo.com.br", "escolaexemplo.com.br"] };
    expect((await avaliar("https://lp.exemplo.com.br/qualquer-pagina", trava)).pass).toBe(true);
    expect((await avaliar("https://exemplo.com.br", trava)).pass).toBe(true);
    expect((await avaliar("https://matricula.escolaexemplo.com.br/pay/x", trava)).pass).toBe(true);
    expect((await avaliar("https://outroexemplo.com.br/x", trava)).pass).toBe(false);
    expect((await avaliar("https://exemplo.com.br.golpe.io/x", trava)).pass).toBe(false);
  });

  it("e-mail, valor e frase comum não são link", async () => {
    const trava = { liberados: [] };
    expect((await avaliar("Escreva para contato@exemplo.com.br e a equipe responde.", trava)).pass).toBe(true);
    expect((await avaliar("Fica com. Brasil inteiro tem isso. No Pix, R$ 1.690.", trava)).pass).toBe(true);
    expect((await avaliar("São 18x de R$ 104,20 e 1,67% ao mês.", trava)).pass).toBe(true);
  });

  it("o trace leva só a contagem e o domínio, nunca o caminho", async () => {
    const v = await avaliar("Pague em https://boleto.exemplo.com.br/concurso-xyz?cpf=123", { liberados: [] });
    expect(v.detail).toEqual({ links: 1, dominios: "boleto.exemplo.com.br" });
  });

  it("(rodada 2) link sem barra depois do domínio: parâmetro e fragmento contam, e a trava compara o endereço inteiro", async () => {
    // Achado 4 da 1ª revisão da -c01.3: o reconhecedor pegava só o domínio, e a raiz
    // liberada pela base liberava o parâmetro inventado.
    const m = await modulo();
    expect(m.linksNoTexto("A página é lp.exemplo.com.br?nivel=errado, tá?")).toEqual([
      "lp.exemplo.com.br?nivel=errado",
    ]);
    expect(m.linksNoTexto("Veja lp.exemplo.com.br#planos.")).toEqual(["lp.exemplo.com.br#planos"]);
    const raiz = { liberados: ["https://lp.exemplo.com.br"] };
    for (const inventado of ["lp.exemplo.com.br?nivel=errado", "lp.exemplo.com.br#planos-baratos"]) {
      const v = await avaliar(`A página é ${inventado}.`, raiz);
      expect(v.pass, inventado).toBe(false);
      expect(v.reason).toContain(`"${inventado}"`);
    }
    expect((await avaliar("A página é lp.exemplo.com.br.", raiz)).pass).toBe(true);
    // A barra da raiz antes de `?` ou `#` é o mesmo endereço: com ou sem ela, passa.
    const comParametro = { liberados: ["https://lp.exemplo.com.br/?nivel=superior"] };
    expect((await avaliar("A página é lp.exemplo.com.br?nivel=superior.", comParametro)).pass).toBe(true);
    expect((await avaliar("A página é https://lp.exemplo.com.br?nivel=superior", comParametro)).pass).toBe(true);
    expect((await avaliar("A página é lp.exemplo.com.br?nivel=tecnico.", comParametro)).pass).toBe(false);
  });

  it("acha cada link uma vez só (o domínio dentro do link não conta de novo)", async () => {
    const m = await modulo();
    expect(m.linksNoTexto(`Veja ${DA_BASE}. E também www.exemplo.com.br/blog e lp.exemplo.com.br.`)).toEqual([
      DA_BASE,
      "www.exemplo.com.br/blog",
      "lp.exemplo.com.br",
    ]);
  });
});

describe("(C01) os links já mandados na conversa", () => {
  it("lê as mensagens enviadas desta conversa, desta organização, e devolve os links normalizados", async () => {
    const m = await modulo();
    const consultas: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params: unknown[]) => {
        consultas.push({ sql, params });
        return { rows: [{ body: `Segue: ${DA_BASE}.` }, { body: null }, { body: "Sem link aqui." }] };
      },
    };
    const links = await m.lerLinksJaEnviados(db, { tenantId: "org-1", conversationId: "conv-1" });
    expect(links).toEqual(new Set([m.normalizarLink(DA_BASE)]));
    expect(consultas[0]?.params).toEqual(["org-1", "conv-1"]);
    expect(consultas[0]?.sql).toMatch(/organization_id = \$1/);
    expect(consultas[0]?.sql).toMatch(/conversation_id = \$2/);
    expect(consultas[0]?.sql).toMatch(/direction = 'outbound'/);
  });

  it("leitura que falha devolve null (o turno desarma a trava, não cala o agente)", async () => {
    const m = await modulo();
    const db = { query: async () => Promise.reject(new Error("conexão caiu")) };
    expect(await m.lerLinksJaEnviados(db, { tenantId: "o", conversationId: "c" })).toBeNull();
  });

  it("o link já mandado passa; o vizinho dele, não", async () => {
    const trava = { liberados: ["https://boleto.exemplo.com.br/concurso-premium-engenharia-civil-12-meses"] };
    expect(
      (await avaliar("De novo: https://boleto.exemplo.com.br/concurso-premium-engenharia-civil-12-meses", trava)).pass,
    ).toBe(true);
    expect(
      (await avaliar("De novo: https://boleto.exemplo.com.br/concurso-premium-engenharia-civil-6-meses", trava)).pass,
    ).toBe(false);
  });
});

describe("(C01) a configuração (`settings.travas_de_envio.link_permitido`)", () => {
  it("liga com `ligada: true`; os domínios vêm normalizados; tipo errado = tudo desligado, com aviso", async () => {
    const { interpretarTravasDeEnvio } = (await import(/* @vite-ignore */ CAMINHO_DA_CONFIGURACAO)) as {
      interpretarTravasDeEnvio: (v: unknown) => {
        travas: { linkPermitido: boolean; dominiosLiberados: string[] };
        invalida: boolean;
      };
    };
    expect(interpretarTravasDeEnvio({}).travas.linkPermitido).toBe(false);
    const lido = interpretarTravasDeEnvio({
      link_permitido: { ligada: true, dominios: ["Exemplo.com.br", "https://www.escolaexemplo.com.br/", " "] },
    });
    expect(lido.travas.linkPermitido).toBe(true);
    expect(lido.travas.dominiosLiberados).toEqual(["exemplo.com.br", "escolaexemplo.com.br"]);
    const errado = interpretarTravasDeEnvio({ link_permitido: { ligada: true, dominios: "exemplo.com.br" } });
    expect(errado.invalida).toBe(true);
    expect(errado.travas.linkPermitido).toBe(false);
  });
});

describe("(C01) a ligação no turno e na cadeia, pelo código", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const CADEIA = readFileSync("lib/agent-engine/guardrails/before-send.ts", "utf8");

  it("a cadeia roda a trava de link depois da agenda e antes do texto longo", () => {
    expect(CADEIA).toMatch(/agendaStallGate,\s*linkPermitidoGate,/);
  });

  it("é trava de conteúdo: contador e fail-safe da promessa semântica", () => {
    expect(TURNO).toMatch(/link_nao_permitido: 'link que não veio da base',/);
  });

  it("os links já enviados são lidos uma vez, só com a trava ligada; leitura que falha desarma", () => {
    expect(TURNO.match(/await lerLinksJaEnviados\(/g)).toHaveLength(1);
    expect(TURNO).toMatch(
      /const linksJaEnviados = travasDaOrg\.travas\.linkPermitido\s*\?\s*await lerLinksJaEnviados\(pool, \{ tenantId, conversationId: input\.conversationId \}\)\s*:\s*null;/,
    );
    expect(TURNO).toMatch(/travasDaOrg\.travas\.linkPermitido && linksJaEnviados !== null/);
  });

  it("liberados = já enviados + base do turno + o que saiu neste turno, recalculados a cada envio", () => {
    expect(TURNO).toMatch(/const liberados = new Set\(linksJaEnviados \?\? \[\]\);/);
    expect(TURNO).toMatch(/for \(const url of urlsDaBase\) liberados\.add\(normalizarLink\(url\)\);/);
    expect(TURNO).toMatch(/for \(const corpo of corposEnviados\) for \(const l of linksNoTexto\(corpo\)\)/);
    expect(TURNO).toMatch(/liberados: linksLiberados\(\),\s*dominios: travasDaOrg\.travas\.dominiosLiberados,/);
  });
});
