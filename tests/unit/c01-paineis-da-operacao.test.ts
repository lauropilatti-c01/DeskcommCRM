/**
 * (C01, -c01.7) PAINÉIS DA OPERAÇÃO: a busca no serviço do gancho e a leitura tolerante.
 *
 * O que se prova aqui:
 *   - o GET vai a `<URL do gancho>/paineis` com a MESMA assinatura do POST do gancho
 *     (`t=<unix>,v1=HMAC-SHA256(segredo, "<t>." + corpo)`, corpo vazio), conferida como
 *     o serviço confere;
 *   - a configuração segue a regra do turno (URL http(s) válida e segredo juntos);
 *   - a leitura é tolerante: campo que falta vira vazio, tipo errado vira vazio, seção
 *     de tipo desconhecido é marcada (a tela a ignora com aviso);
 *   - toda falha vira um estado que a tela explica, nunca exceção.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { assinaturaDoGancho } from "@/lib/agent-engine/agent/gancho-antes-do-turno";
import {
  buscarPaineis,
  configDosPaineis,
  TETO_DA_RESPOSTA_DOS_PAINEIS,
  urlDosPaineis,
} from "@/lib/ai/paineis/buscar";
import { dataDoPainel, lerPaineis } from "@/lib/ai/paineis/contrato";

const CONFIG = { url: "http://172.17.0.1:8796/porteiro/paineis", segredo: "segredo-de-teste" };
const AGORA = 1_791_400_000;

const EXEMPLO = {
  contrato: 1,
  paineis: [
    {
      id: "mensagens-prontas",
      titulo: "Mensagens prontas",
      descricao: "O que sai antes de a IA falar, sempre com o mesmo texto.",
      atualizado_em: "2026-10-07T19:40:00Z",
      secoes: [
        {
          titulo: "1. Logo depois do oi",
          texto: "Quem chega sem nada recebe o link do teste.",
          tipo: "mensagens",
          mensagens: [
            { rotulo: "Link do teste", quando: "logo depois do oi", texto: "Oi, tudo bem?\nFaz esse teste.", botao: "Ver minhas ênfases" },
          ],
        },
        {
          titulo: "Fatos que ela pode citar",
          texto: "",
          tipo: "tabela",
          colunas: ["Assunto", "O que ela diz", "Pode afirmar?"],
          linhas: [["Concurso", "O caminho é o concurso público.", "sim"]],
        },
      ],
    },
  ],
};

/** Resposta falsa do serviço, com corpo e status escolhidos. */
function resposta(corpo: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(corpo, { status, headers: { "Content-Type": "application/json", ...headers } });
}

/** Como o serviço confere a assinatura (o mesmo do POST do gancho). */
function servicoAceita(cabecalho: string, segredo: string, corpo: string): boolean {
  const partes = Object.fromEntries(cabecalho.split(",").map((p) => p.split("=") as [string, string]));
  const esperado = createHmac("sha256", segredo).update(`${partes.t}.${corpo}`, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(esperado), Buffer.from(partes.v1 ?? ""));
}

describe("a chamada aos painéis", () => {
  it("é um GET a <URL do gancho>/paineis, assinado como o POST do gancho, com corpo vazio", async () => {
    const fetchImpl = vi.fn(async () => resposta(JSON.stringify(EXEMPLO)));
    const r = await buscarPaineis(CONFIG, { fetchImpl, agoraUnix: () => AGORA });

    expect(r.estado).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CONFIG.url);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("error");
    const assinatura = (init.headers as Record<string, string>)["X-Hook-Signature"] ?? "";
    // Mesmo resultado da função que assina o POST do turno, com corpo vazio…
    expect(assinatura).toBe(assinaturaDoGancho(CONFIG.segredo, "", AGORA));
    // …e o serviço a aceita pela conferência de sempre.
    expect(assinatura.startsWith(`t=${AGORA},v1=`)).toBe(true);
    expect(servicoAceita(assinatura, CONFIG.segredo, "")).toBe(true);
    expect(servicoAceita(assinatura, "outro-segredo", "")).toBe(false);
  });

  it("monta o endereço sem barra dobrada e sem perder parâmetros", () => {
    expect(urlDosPaineis("http://172.17.0.1:8796/porteiro")).toBe("http://172.17.0.1:8796/porteiro/paineis");
    expect(urlDosPaineis("http://172.17.0.1:8796/porteiro/")).toBe("http://172.17.0.1:8796/porteiro/paineis");
    expect(urlDosPaineis("http://porteiro:8090")).toBe("http://porteiro:8090/paineis");
    expect(urlDosPaineis("https://x.exemplo/gancho?v=1")).toBe("https://x.exemplo/gancho/paineis?v=1");
  });

  it("segue a regra do turno: sem URL válida ou sem segredo, desligado", () => {
    expect(configDosPaineis({})).toBeNull();
    expect(configDosPaineis({ AGENT_PRE_TURN_HOOK_URL: "", AGENT_PRE_TURN_HOOK_SECRET: "x" })).toBeNull();
    expect(configDosPaineis({ AGENT_PRE_TURN_HOOK_URL: "http://p:1/porteiro" })).toBeNull();
    expect(configDosPaineis({ AGENT_PRE_TURN_HOOK_URL: "http://p:1/porteiro", AGENT_PRE_TURN_HOOK_SECRET: "  " })).toBeNull();
    expect(configDosPaineis({ AGENT_PRE_TURN_HOOK_URL: "nao-e-url", AGENT_PRE_TURN_HOOK_SECRET: "x" })).toBeNull();
    expect(configDosPaineis({ AGENT_PRE_TURN_HOOK_URL: "ftp://p/porteiro", AGENT_PRE_TURN_HOOK_SECRET: "x" })).toBeNull();
    expect(
      configDosPaineis({ AGENT_PRE_TURN_HOOK_URL: " http://172.17.0.1:8796/porteiro ", AGENT_PRE_TURN_HOOK_SECRET: "s" }),
    ).toEqual({ url: "http://172.17.0.1:8796/porteiro/paineis", segredo: "s" });
  });
});

describe("toda falha vira um estado da tela, nunca exceção", () => {
  const casos: [string, () => Promise<Response>, string][] = [
    ["404: o serviço não oferece painéis", async () => resposta("", 404), "sem_paineis"],
    ["401: assinatura recusada", async () => resposta('{"erro":"assinatura"}', 401), "recusado"],
    ["403: assinatura recusada", async () => resposta("", 403), "recusado"],
    ["500", async () => resposta("falhou", 500), "indisponivel"],
    ["rede", async () => Promise.reject(new TypeError("fetch failed")), "indisponivel"],
    [
      "prazo",
      async () => Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })),
      "indisponivel",
    ],
    ["JSON inválido", async () => resposta("<html>oi</html>"), "formato"],
    ["raiz que não é objeto", async () => resposta("[1,2,3]"), "formato"],
    ["raiz nula", async () => resposta("null"), "formato"],
    [
      "tamanho declarado acima do teto",
      async () => resposta("{}", 200, { "Content-Length": String(TETO_DA_RESPOSTA_DOS_PAINEIS + 1) }),
      "grande_demais",
    ],
  ];

  for (const [nome, fazer, estado] of casos) {
    it(nome, async () => {
      const r = await buscarPaineis(CONFIG, { fetchImpl: vi.fn(fazer) });
      expect(r).toEqual({ estado });
    });
  }

  it("corpo que passa do teto lido aos pedaços (sem Content-Length)", async () => {
    const grande = JSON.stringify({ paineis: [{ titulo: "x".repeat(5_000) }] });
    const fluxo = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(grande));
        c.close();
      },
    });
    const r = await buscarPaineis(CONFIG, { fetchImpl: vi.fn(async () => new Response(fluxo)), tetoBytes: 1_000 });
    expect(r).toEqual({ estado: "grande_demais" });
  });

  it("o log leva o motivo, nunca o endereço nem o segredo", async () => {
    const aviso = vi.spyOn(console, "warn").mockImplementation(() => {});
    await buscarPaineis(CONFIG, { fetchImpl: vi.fn(async () => resposta("", 401)) });
    const escrito = aviso.mock.calls.flat().join(" ");
    aviso.mockRestore();
    expect(escrito).toContain("recusado");
    expect(escrito).not.toContain("172.17.0.1");
    expect(escrito).not.toContain(CONFIG.segredo);
  });
});

describe("a leitura é tolerante", () => {
  it("lê o exemplo do contrato inteiro", () => {
    const lido = lerPaineis(EXEMPLO);
    expect(lido?.contrato).toBe(1);
    expect(lido?.paineis).toHaveLength(1);
    const [mensagens, tabela] = lido!.paineis[0]!.secoes;
    expect(mensagens).toEqual({
      tipo: "mensagens",
      titulo: "1. Logo depois do oi",
      texto: "Quem chega sem nada recebe o link do teste.",
      mensagens: [
        { rotulo: "Link do teste", quando: "logo depois do oi", texto: "Oi, tudo bem?\nFaz esse teste.", botao: "Ver minhas ênfases" },
      ],
    });
    expect(tabela).toEqual({
      tipo: "tabela",
      titulo: "Fatos que ela pode citar",
      texto: "",
      colunas: ["Assunto", "O que ela diz", "Pode afirmar?"],
      linhas: [["Concurso", "O caminho é o concurso público.", "sim"]],
    });
  });

  it("campo que falta vira vazio, não erro", () => {
    const lido = lerPaineis({ paineis: [{ secoes: [{ tipo: "mensagens", mensagens: [{ texto: "só o texto" }] }] }] });
    expect(lido?.contrato).toBeNull();
    expect(lido?.paineis[0]).toEqual({
      id: "",
      titulo: "",
      descricao: "",
      atualizado_em: "",
      secoes: [
        { tipo: "mensagens", titulo: "", texto: "", mensagens: [{ rotulo: "", quando: "", texto: "só o texto", botao: "" }] },
      ],
    });
    expect(lerPaineis({})).toEqual({ contrato: null, paineis: [] });
  });

  it("tipo errado vira vazio; número e sim/não viram texto", () => {
    const lido = lerPaineis({
      contrato: "1",
      paineis: [
        {
          titulo: 42,
          descricao: { html: "<b>x</b>" },
          secoes: [
            { tipo: "tabela", colunas: "Assunto", linhas: [["a", 1, true, null], "linha que não é lista"] },
            "seção que não é objeto",
          ],
        },
        "painel que não é objeto",
      ],
    });
    expect(lido?.contrato).toBeNull();
    const [painel, vazio] = lido!.paineis;
    expect(painel!.titulo).toBe("42");
    expect(painel!.descricao).toBe("");
    expect(painel!.secoes[0]).toEqual({ tipo: "tabela", titulo: "", texto: "", colunas: [], linhas: [["a", "1", "true", ""], []] });
    expect(painel!.secoes[1]).toEqual({ tipo: "desconhecido", titulo: "", texto: "", tipoRecebido: "" });
    expect(vazio).toEqual({ id: "", titulo: "", descricao: "", atualizado_em: "", secoes: [] });
  });

  it("seção de tipo desconhecido fica marcada, com o tipo como veio", () => {
    const lido = lerPaineis({ paineis: [{ secoes: [{ titulo: "Gráfico", tipo: "grafico", pontos: [1, 2] }] }] });
    expect(lido?.paineis[0]?.secoes).toEqual([{ tipo: "desconhecido", titulo: "Gráfico", texto: "", tipoRecebido: "grafico" }]);
  });

  it("HTML e markdown vêm como texto, sem nenhuma interpretação", () => {
    const lido = lerPaineis({ paineis: [{ titulo: "<script>x</script>", descricao: "**negrito**" }] });
    expect(lido?.paineis[0]?.titulo).toBe("<script>x</script>");
    expect(lido?.paineis[0]?.descricao).toBe("**negrito**");
  });

  it("a resposta 200 do exemplo chega à tela como painéis", async () => {
    const r = await buscarPaineis(CONFIG, { fetchImpl: vi.fn(async () => resposta(JSON.stringify(EXEMPLO))) });
    expect(r.estado === "ok" && r.paineis[0]?.titulo).toBe("Mensagens prontas");
  });
});

describe("a data do painel", () => {
  it("sai no idioma e no fuso de quem olha", () => {
    const texto = dataDoPainel("2026-10-07T19:40:00Z", "pt-BR", "America/Sao_Paulo");
    expect(texto).toContain("07/10/2026");
    expect(texto).toContain("16:40");
  });

  it("data que não se lê não aparece (nem o texto cru)", () => {
    expect(dataDoPainel("", "pt-BR", "America/Sao_Paulo")).toBeNull();
    expect(dataDoPainel("ontem", "pt-BR", "America/Sao_Paulo")).toBeNull();
  });
});
