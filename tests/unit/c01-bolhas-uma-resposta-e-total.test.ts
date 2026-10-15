/**
 * (C01, -c01.15) BOLHAS: O TOTAL DA RESPOSTA E UMA RESPOSTA POR TURNO.
 *
 * Com o divisor ligado (`split_messages`), dois defeitos:
 * (a) a trava `texto_longo` só contava bolhas: três parágrafos de 340 caracteres (mais de
 *     mil no total) passavam, e o que passava do teto de mensagens do turno saía
 *     emendado na última bolha sem aviso;
 * (b) a instrução pedia uma chamada de `send_message` por turno, e nada impedia a
 *     segunda: o modelo respondia, consultava e respondia de novo.
 *
 * Agora (a) a trava barra também o total (com os links, como o cliente vê), com o erro
 * "reescreva em até N parágrafos e até X caracteres no total", e a emenda do teto avisa
 * no log; (b) depois de um `send_message` que saiu, o seguinte no turno é recusado.
 *
 * Por comportamento (a trava, o divisor e o envoltório da ferramenta) e, a ligação no
 * turno, pela leitura do código. Os módulos entram por import dinâmico: sem a mudança,
 * só os casos dela falham. Textos e links fictícios (regra do C01.md).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { sendInBubbles, splitIntoBubbles } from "@/lib/agent-engine/agent/split-message";

type Veredito = { pass: boolean; code?: string; reason?: string; detail?: Record<string, unknown> };
type Armada = { maxChars: number; restantes: number; maxTotal?: number };

async function trava(): Promise<(body: string, armada: Armada) => Veredito> {
  const m = (await import("@/lib/agent-engine/guardrails/texto-longo")) as unknown as {
    textoLongoGate: { evaluate: (ctx: unknown) => Veredito };
  };
  return (body, armada) => m.textoLongoGate.evaluate({ body, travasDeEnvio: { textoLongo: armada } });
}

const LINK = "https://lp.exemplo.com.br/plano-completo/?nivel=superior&origem=whatsapp&campanha=outubro";

/** Um parágrafo de `n` caracteres, sem ponto no meio (o divisor não o parte abaixo de `n`). */
const paragrafo = (n: number, letra = "a"): string => `${letra.repeat(n - 1)}.`;

describe("(a) com o divisor, a trava barra também o total da resposta", () => {
  it("3 parágrafos que cabem no turno, mas com mais de 700 caracteres no total, voltam", async () => {
    const avaliar = await trava();
    const corpo = [paragrafo(300, "a"), paragrafo(300, "b"), paragrafo(300, "c")].join("\n\n");
    expect(splitIntoBubbles(corpo, 350)).toHaveLength(3);
    const v = avaliar(corpo, { maxChars: 350, restantes: 3, maxTotal: 700 });
    expect(v.pass).toBe(false);
    expect(v.code).toBe("texto_longo");
    expect(v.reason).toMatch(/NÃO foi enviada: ela tem 904 caracteres no total, contando os links, e o limite é 700\./);
    expect(v.reason).toMatch(/Reescreva em até 3 parágrafos e até 700 caracteres no total/);
    expect(v.reason).toMatch(/sem mudar nenhum link/);
    expect(v.detail).toEqual({ bolhas: 3, restantes: 3, max_chars: 350, caracteres: 904, max_total: 700 });
  });

  it("parágrafos além do que cabe no turno voltam com os dois limites, mesmo curtos", async () => {
    const avaliar = await trava();
    const corpo = ["Oi!", "Tudo bem?", "Vi seu formulário.", "Posso te mandar a página?"].join("\n\n");
    const v = avaliar(corpo, { maxChars: 350, restantes: 3, maxTotal: 700 });
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/ela viraria 4 mensagens no WhatsApp e neste turno só cabem 3 mensagens\./);
    expect(v.reason).toMatch(/Reescreva em até 3 parágrafos e até 700 caracteres no total/);
    expect(v.detail).toMatchObject({ bolhas: 4, restantes: 3 });
  });

  it("os dois motivos juntos aparecem juntos", async () => {
    const avaliar = await trava();
    const corpo = [paragrafo(300), paragrafo(300), paragrafo(300), paragrafo(300)].join("\n\n");
    const v = avaliar(corpo, { maxChars: 350, restantes: 3, maxTotal: 700 });
    expect(v.reason).toMatch(/viraria 4 mensagens[^;]*; e ela tem 1206 caracteres no total/);
  });

  it("o link conta inteiro no total (e não infla a conta de bolhas)", async () => {
    const avaliar = await trava();
    const texto = `${paragrafo(330)}\n\n${paragrafo(300)}\n\nA página é ${LINK}`;
    const comLink = avaliar(texto, { maxChars: 350, restantes: 3, maxTotal: 700 });
    expect(comLink.pass).toBe(false);
    expect(comLink.detail).toMatchObject({ bolhas: 3, caracteres: [...texto].length });
    // O mesmo texto com um link curto cabe.
    const curto = texto.replace(LINK, "https://lp.exemplo.com.br/x");
    expect([...curto].length).toBeLessThanOrEqual(700);
    expect(avaliar(curto, { maxChars: 350, restantes: 3, maxTotal: 700 }).pass).toBe(true);
  });

  it("conta caractere como o cliente vê: um emoji é um", async () => {
    const avaliar = await trava();
    const corpo = `${"😀".repeat(700)}`;
    expect(corpo.length).toBe(1400);
    expect(avaliar(corpo, { maxChars: 2000, restantes: 3, maxTotal: 700 }).pass).toBe(true);
    expect(avaliar(`${corpo}!`, { maxChars: 2000, restantes: 3, maxTotal: 700 }).pass).toBe(false);
  });

  it("dentro dos dois limites, passa; sem `maxTotal`, a conta é só a de bolhas (o comportamento de antes)", async () => {
    const avaliar = await trava();
    const corpo = [paragrafo(200), paragrafo(200), paragrafo(200)].join("\n\n");
    expect(avaliar(corpo, { maxChars: 350, restantes: 3, maxTotal: 700 }).pass).toBe(true);
    const longo = [paragrafo(300), paragrafo(300), paragrafo(300)].join("\n\n");
    expect(avaliar(longo, { maxChars: 350, restantes: 3 }).pass).toBe(true);
  });
});

describe("(a) a emenda do teto nunca é silenciosa", () => {
  it("o excedente emendado na última bolha é avisado, só com números", async () => {
    const enviados: string[] = [];
    const aoEmendar = vi.fn();
    await sendInBubbles(["Um.", "Dois.", "Três."].join("\n\n"), {
      enabled: true,
      maxChars: 300,
      maxBubbles: 2,
      send: async (b: string) => {
        enviados.push(b);
        return { kind: "sent" };
      },
      sleep: async () => undefined,
      jitter: () => 0,
      aoEmendar,
    } as never);
    expect(enviados).toEqual(["Um.", "Dois.\n\nTrês."]);
    expect(aoEmendar).toHaveBeenCalledTimes(1);
    expect(aoEmendar).toHaveBeenCalledWith({ bolhas: 3, enviadas: 2 });
  });

  it("controle: cabendo no teto, nada é avisado", async () => {
    const aoEmendar = vi.fn();
    await sendInBubbles(["Um.", "Dois."].join("\n\n"), {
      enabled: true,
      maxChars: 300,
      maxBubbles: 2,
      send: async () => ({ kind: "sent" }),
      sleep: async () => undefined,
      jitter: () => 0,
      aoEmendar,
    } as never);
    expect(aoEmendar).not.toHaveBeenCalled();
  });
});

describe("(a) o link não é partido: a bolha que o cliente recebe leva o link inteiro", () => {
  it("parágrafo acima do teto por bolha, com link longo: o link sai inteiro, e a trava conta as bolhas que saem", async () => {
    const corpo =
      "Pra Engenharia de Equipamentos eu iria no Plano Completo, porque o acesso não expira. " +
      `A página de matrícula é ${LINK}. Lá estão as formas de pagamento.\n\nQualquer dúvida, me chama.`;
    const enviados: string[] = [];
    await sendInBubbles(corpo, {
      enabled: true,
      maxChars: 80,
      maxBubbles: 10,
      send: async (b) => {
        enviados.push(b);
        return { kind: "sent" };
      },
      sleep: async () => undefined,
      jitter: () => 0,
    });
    expect(enviados).toContain(`${LINK}.`);
    expect(enviados.filter((b) => b.includes("lp.exemplo"))).toHaveLength(1);
    const avaliar = await trava();
    const v = avaliar(corpo, { maxChars: 80, restantes: 1, maxTotal: 700 });
    expect(v.pass).toBe(false);
    expect(v.detail).toMatchObject({ bolhas: enviados.length, caracteres: [...corpo].length });
  });
});

/**
 * (2ª rodada da revisão) A trava julga a SAÍDA REAL: as mensagens físicas que o envio
 * mandaria (a mesma divisão do `sendInBubbles`, com o parágrafo longo partido pelo
 * `split_max_chars`), sem emenda do teto, o total com os links e cada link inteiro.
 */
type Saida = { naturais: number; fisicas: string[]; emendou: boolean; paragrafos: number; linksPartidos: number };
async function saidaReal(): Promise<(body: string, maxChars: number, restantes: number) => Saida> {
  const m = (await import("@/lib/agent-engine/guardrails/texto-longo")) as unknown as {
    saidaEmBolhas: (body: string, maxChars: number, restantes: number) => Saida;
  };
  return m.saidaEmBolhas;
}

/** O que o `sendInBubbles` de verdade manda, com o teto do turno. */
async function enviadoDeVerdade(body: string, maxChars: number, maxBubbles: number) {
  const enviados: string[] = [];
  const aoEmendar = vi.fn();
  await sendInBubbles(body, {
    enabled: true,
    maxChars,
    maxBubbles,
    send: async (b: string) => {
      enviados.push(b);
      return { kind: "sent" };
    },
    sleep: async () => undefined,
    jitter: () => 0,
    aoEmendar,
  });
  return { enviados, emendou: aoEmendar.mock.calls.length > 0 };
}

describe("(a, 2ª rodada) a trava julga a saída real do divisor, não a conta de parágrafos", () => {
  // 3 parágrafos; o 1º, com 2 frases de 100, passa do split_max_chars (120) e vira 2 mensagens.
  const LONGO_E_DOIS_CURTOS = [`${paragrafo(100, "a")} ${paragrafo(100, "b")}`, "Tudo bem?", "Posso te mandar a página?"].join("\n\n");

  it("3 parágrafos, um maior que split_max_chars: são 4 mensagens físicas, o envio emendaria, e a trava veta", async () => {
    const real = await enviadoDeVerdade(LONGO_E_DOIS_CURTOS, 120, 3);
    expect(real.emendou).toBe(true);
    const saida = (await saidaReal())(LONGO_E_DOIS_CURTOS, 120, 3);
    expect(saida).toMatchObject({ naturais: 4, paragrafos: 3, emendou: true });
    expect(saida.fisicas).toEqual(real.enviados);

    const v = (await trava())(LONGO_E_DOIS_CURTOS, { maxChars: 120, restantes: 3, maxTotal: 700 });
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/viraria 4 mensagens no WhatsApp e neste turno só cabem 3 mensagens \(parágrafo com mais de 120 caracteres é partido em mais de uma mensagem\)/);
    expect(v.detail).toMatchObject({ bolhas: 4, paragrafos: 3, restantes: 3 });
  });

  it("um parágrafo só, abaixo de 700, mas que o divisor parte em 4: veta", async () => {
    const corpo = [paragrafo(100, "a"), paragrafo(100, "b"), paragrafo(100, "c"), paragrafo(100, "d"), paragrafo(100, "e"), paragrafo(100, "f"), paragrafo(100, "g")].join(" ");
    expect([...corpo].length).toBeLessThan(710);
    const saida = (await saidaReal())(corpo, 210, 3);
    expect(saida).toMatchObject({ naturais: 4, paragrafos: 1, emendou: true });
    const v = (await trava())(corpo, { maxChars: 210, restantes: 3, maxTotal: 710 });
    expect(v.pass).toBe(false);
    expect(v.detail).toMatchObject({ bolhas: 4, paragrafos: 1 });
  });

  it("4 parágrafos curtos: o envio emendaria a 4ª na 3ª; a trava veta", async () => {
    const corpo = ["Oi!", "Tudo bem?", "Vi seu formulário.", "Posso te mandar a página?"].join("\n\n");
    const real = await enviadoDeVerdade(corpo, 350, 3);
    expect(real.enviados).toEqual(["Oi!", "Tudo bem?", "Vi seu formulário.\n\nPosso te mandar a página?"]);
    expect((await saidaReal())(corpo, 350, 3).fisicas).toEqual(real.enviados);
    expect((await trava())(corpo, { maxChars: 350, restantes: 3, maxTotal: 700 }).pass).toBe(false);
  });

  it("o que a trava deixa passar sai exatamente como ela contou, sem emenda", async () => {
    const corpo = [`${paragrafo(100, "a")} ${paragrafo(100, "b")}`, "Posso te mandar a página?"].join("\n\n");
    const v = (await trava())(corpo, { maxChars: 120, restantes: 3, maxTotal: 700 });
    expect(v.pass).toBe(true);
    const real = await enviadoDeVerdade(corpo, 120, 3);
    expect(real.emendou).toBe(false);
    expect(real.enviados).toEqual((await saidaReal())(corpo, 120, 3).fisicas);
    expect(real.enviados).toHaveLength(3);
  });

  it("URLs inteiras: link maior que split_max_chars, dentro de parágrafo longo, sai inteiro numa mensagem", async () => {
    const corpo = `${paragrafo(60, "a")} A página é ${LINK} e lá está tudo.\n\nQualquer dúvida, me chama.`;
    const saida = (await saidaReal())(corpo, 50, 5);
    expect(saida.linksPartidos).toBe(0);
    expect(saida.fisicas.filter((b) => b.includes(LINK))).toHaveLength(1);
    expect(saida.fisicas.some((b) => b.length > 50 && b.includes(LINK))).toBe(true);
    const real = await enviadoDeVerdade(corpo, 50, 5);
    expect(real.enviados).toEqual(saida.fisicas);
    expect((await trava())(corpo, { maxChars: 50, restantes: 5, maxTotal: 700 }).pass).toBe(true);
  });

  it("o erro de ensino diz quando um link sairia partido", async () => {
    const m = (await import("@/lib/agent-engine/guardrails/texto-longo")) as unknown as {
      renderVetoDeRespostaEmBolhas: (c: Record<string, number>) => string;
    };
    const r = m.renderVetoDeRespostaEmBolhas({ bolhas: 2, restantes: 3, maxChars: 300, caracteres: 400, maxTotal: 700, linksPartidos: 1 });
    expect(r).toMatch(/NÃO foi enviada: um link sairia partido entre mensagens\./);
    expect(r).toMatch(/sem mudar nenhum link/);
  });
});

const CAMINHO_DO_ENVOLTORIO = "@/lib/agent-engine/agent/c01-uma-resposta-por-turno";

type Resultado = { ok: boolean; error?: { code: string; message: string } };

async function envoltorio(): Promise<
  <T extends { execute?: unknown }>(ferramenta: T) => T
> {
  const m = (await import(/* @vite-ignore */ CAMINHO_DO_ENVOLTORIO)) as {
    umaRespostaPorTurno: <T extends { execute?: unknown }>(ferramenta: T) => T;
  };
  return m.umaRespostaPorTurno;
}

function ferramenta(resultados: Resultado[], atrasoMs = 0) {
  const chamadas: unknown[] = [];
  const execute = vi.fn(async (entrada: unknown) => {
    chamadas.push(entrada);
    if (atrasoMs > 0) await new Promise((r) => setTimeout(r, atrasoMs));
    return resultados.shift() ?? { ok: true };
  });
  return { tool: { description: "envia", execute }, chamadas, execute };
}

const exec = (t: { execute?: unknown }, body: string) =>
  (t.execute as (e: unknown, o: unknown) => Promise<Resultado>)({ body }, { toolCallId: "x", messages: [] });

describe("(b) uma resposta por turno", () => {
  it("depois de um envio que saiu, o seguinte é recusado sem chegar ao canal", async () => {
    const umaResposta = await envoltorio();
    const f = ferramenta([{ ok: true }]);
    const t = umaResposta(f.tool);
    expect((await exec(t, "Oi! Tudo bem?")).ok).toBe(true);
    const segunda = await exec(t, "Esqueci de dizer: a página é esta.");
    expect(segunda.ok).toBe(false);
    expect(segunda.error?.code).toBe("uma_resposta_por_turno");
    expect(segunda.error?.message).toMatch(/NÃO foi enviada/);
    expect(segunda.error?.message).toMatch(/numa única chamada de send_message/);
    expect(segunda.error?.message).toMatch(/encerre o turno agora/);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("o envio que não saiu (veto, teto, falha) não conta: a nova tentativa segue", async () => {
    const umaResposta = await envoltorio();
    const f = ferramenta([
      { ok: false, error: { code: "texto_longo", message: "reescreva" } },
      { ok: false, error: { code: "envio_falhou", message: "falhou" } },
      { ok: true },
      { ok: true },
    ]);
    const t = umaResposta(f.tool);
    expect((await exec(t, "longa")).ok).toBe(false);
    expect((await exec(t, "de novo")).ok).toBe(false);
    expect((await exec(t, "curta")).ok).toBe(true);
    expect((await exec(t, "mais uma")).error?.code).toBe("uma_resposta_por_turno");
    expect(f.chamadas).toEqual([{ body: "longa" }, { body: "de novo" }, { body: "curta" }]);
  });

  it("chamadas em paralelo na mesma etapa: uma de cada vez, na ordem; a segunda não sai", async () => {
    const umaResposta = await envoltorio();
    const f = ferramenta([{ ok: true }, { ok: true }], 20);
    const t = umaResposta(f.tool);
    const [a, b] = await Promise.all([exec(t, "primeira"), exec(t, "segunda")]);
    expect(a.ok).toBe(true);
    expect(b.error?.code).toBe("uma_resposta_por_turno");
    expect(f.chamadas).toEqual([{ body: "primeira" }]);
  });

  it("em paralelo, se a primeira não sai, a segunda sai", async () => {
    const umaResposta = await envoltorio();
    const f = ferramenta([{ ok: false, error: { code: "texto_longo", message: "x" } }, { ok: true }], 10);
    const t = umaResposta(f.tool);
    const [a, b] = await Promise.all([exec(t, "longa"), exec(t, "curta")]);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(true);
    expect(f.chamadas).toEqual([{ body: "longa" }, { body: "curta" }]);
  });

  it("uma chamada que lança não trava a fila nem conta como resposta", async () => {
    const umaResposta = await envoltorio();
    let primeira = true;
    const execute = vi.fn(async () => {
      if (primeira) {
        primeira = false;
        throw new Error("bug no adapter");
      }
      return { ok: true };
    });
    const t = umaResposta({ execute });
    await expect(exec(t, "a")).rejects.toThrow("bug no adapter");
    expect((await exec(t, "b")).ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("cada envoltório é de um turno: o seguinte começa do zero", async () => {
    const umaResposta = await envoltorio();
    const f = ferramenta([{ ok: true }, { ok: true }]);
    expect((await exec(umaResposta(f.tool), "turno 1")).ok).toBe(true);
    expect((await exec(umaResposta(f.tool), "turno 2")).ok).toBe(true);
  });
});

describe("(C01, -c01.15) a ligação no turno, pelo código", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("a trava recebe o limite do total da configuração (`texto_longo.max_caracteres`)", () => {
    expect(TURNO).toMatch(
      /semDivisor: true as const \}\),\s*\/\/[^\n]*\n\s*maxTotal: travasDaOrg\.travas\.textoLongoMaxCaracteres,/,
    );
  });

  it("a emenda do teto vai ao log", () => {
    expect(TURNO).toMatch(/aoEmendar: \(conta\) =>\s*runLog\.warn\('bolhas além do teto do turno emendadas na última'/);
  });

  it("com o divisor ligado, o `send_message` do turno é envolvido logo depois de montado, antes da prévia e do breaker", () => {
    const envolve = TURNO.indexOf("rawTools.send_message = umaRespostaPorTurno(rawTools.send_message);");
    expect(envolve).toBeGreaterThan(TURNO.indexOf("const rawTools: ToolSet = {"));
    expect(envolve).toBeGreaterThan(TURNO.indexOf("request_human_handoff: tool({"));
    expect(envolve).toBeLessThan(TURNO.indexOf("const tools = wrapToolsWithBreaker(previewTools"));
    expect(TURNO.slice(envolve - 200, envolve)).toMatch(
      /if \(\(agentConfig\?\.splitMessages \?\? false\) && rawTools\.send_message !== undefined\) \{\s*$/,
    );
    // O envio pendente da trava de estilo (depois do laço) passa pelo mesmo envoltório.
    expect(TURNO).toMatch(/await rawTools\.send_message\?\.execute\?\.\(entrada, \{/);
  });

  it("as mensagens fixas do gancho antes do turno não passam pelo `send_message` (não contam)", () => {
    const GANCHO = readFileSync("lib/agent-engine/agent/gancho-antes-do-turno.ts", "utf8");
    expect(GANCHO).not.toMatch(/send_message\??\.execute/);
    expect(GANCHO).toMatch(/runBeforeSend\(/);
  });
});
