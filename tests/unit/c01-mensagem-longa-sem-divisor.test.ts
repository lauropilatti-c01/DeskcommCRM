/**
 * (C01, -c01.8) "1 BOLHA POR RESPOSTA, ATÉ 700 CARACTERES" TAMBÉM COM O DIVISOR DESLIGADO.
 *
 * O defeito: a trava `texto_longo` (-c01.3) só agia com o divisor de bolhas ligado, e a
 * produção da C01 manda uma mensagem por resposta (`split_messages` falso). O limite de
 * 700 caracteres (CRM-085 da C01, item 1) era só regra do texto do agente.
 *
 * Agora, com o divisor desligado, a mensagem acima do limite (`texto_longo.max_caracteres`,
 * padrão 700) volta com o erro de ensino. É trava de ESTILO: o 1º veto ensina; no 2º ela
 * se desarma no turno e a mensagem sai inteira (nunca cortada: o link não sai partido),
 * com o aviso no log; nunca passa a conversa a uma pessoa. Com a trava desligada, nada muda.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CAMINHO_DA_TRAVA = "@/lib/agent-engine/guardrails/texto-longo";
const CAMINHO_DA_CONFIGURACAO = "@/lib/agent-engine/guardrails/travas-de-envio";

type Veredito = { pass: boolean; code?: string; reason?: string; detail?: Record<string, unknown> };
type Armada = { maxChars: number; restantes: number; semDivisor?: true };
async function trava(): Promise<(body: string, armada?: Armada) => Veredito> {
  const m = (await import(/* @vite-ignore */ CAMINHO_DA_TRAVA)) as {
    textoLongoGate: { name: string; evaluate: (ctx: unknown) => Veredito };
  };
  expect(m.textoLongoGate.name).toBe("texto_longo");
  return (body, armada) =>
    m.textoLongoGate.evaluate({ body, ...(armada ? { travasDeEnvio: { textoLongo: armada } } : {}) });
}

const LINK = "https://lp.exemplo.com.br/plano-completo/?nivel=tecnico&origem=whatsapp";
/** Um texto de `n` caracteres que termina com o link (o link conta inteiro). */
const comTamanho = (n: number): string => {
  const fim = ` A página é ${LINK}`;
  return "a".repeat(n - fim.length) + fim;
};
const SEM_DIVISOR: Armada = { maxChars: 700, restantes: 3, semDivisor: true };

describe("(C01, -c01.8) a trava 'texto longo' com o divisor desligado", () => {
  it("701 caracteres → veto de ensino, com números e sem o texto", async () => {
    const avaliar = await trava();
    const v = avaliar(comTamanho(701), SEM_DIVISOR);
    expect(v.pass).toBe(false);
    expect(v.code).toBe("texto_longo");
    expect(v.reason).toMatch(/NÃO foi enviada: ela tem 701 caracteres/);
    expect(v.reason).toMatch(/Reescreva em até 700 caracteres, numa mensagem só/);
    expect(v.reason).toMatch(/sem mudar nenhum link/);
    expect(v.detail).toEqual({ caracteres: 701, max_chars: 700 });
    expect(JSON.stringify(v.detail)).not.toMatch(/exemplo/);
  });

  it("700 passa; espaço nas pontas não conta; emoji conta como um", async () => {
    const avaliar = await trava();
    expect(avaliar(comTamanho(700), SEM_DIVISOR).pass).toBe(true);
    expect(avaliar(`\n ${comTamanho(700)} \n`, SEM_DIVISOR).pass).toBe(true);
    expect(avaliar(`🙂${comTamanho(699)}`, SEM_DIVISOR).pass).toBe(true);
    expect(avaliar(`🙂${comTamanho(700)}`, SEM_DIVISOR).pass).toBe(false);
  });

  it("o limite é o da configuração", async () => {
    const avaliar = await trava();
    expect(avaliar(comTamanho(501), { ...SEM_DIVISOR, maxChars: 500 }).pass).toBe(false);
    expect(avaliar(comTamanho(500), { ...SEM_DIVISOR, maxChars: 500 }).pass).toBe(true);
  });

  it("com a trava desligada (sem a chave), nada muda", async () => {
    const avaliar = await trava();
    expect(avaliar(comTamanho(5000)).pass).toBe(true);
  });

  it("sem mensagem restante no turno não julga (o teto de envios recusa por outro caminho)", async () => {
    const avaliar = await trava();
    expect(avaliar(comTamanho(701), { ...SEM_DIVISOR, restantes: 0 }).pass).toBe(true);
  });

  it("com o divisor ligado, continua contando bolhas (como na -c01.3)", async () => {
    const avaliar = await trava();
    // Um parágrafo de 701 caracteres com teto de 600 por bolha vira 2 bolhas, e cabem 3.
    expect(avaliar(comTamanho(701), { maxChars: 600, restantes: 3 }).pass).toBe(true);
  });
});

describe("(C01, -c01.8) a configuração (`texto_longo.max_caracteres`)", () => {
  type Leitura = { travas: { textoLongo: boolean; textoLongoMaxCaracteres: number }; invalida: boolean };
  async function interpretar(v: unknown): Promise<Leitura> {
    const m = (await import(/* @vite-ignore */ CAMINHO_DA_CONFIGURACAO)) as {
      interpretarTravasDeEnvio: (v: unknown) => Leitura;
    };
    return m.interpretarTravasDeEnvio(v);
  }

  it("padrão 700; o número da configuração vale; fora do formato = JSON inválido", async () => {
    expect((await interpretar({})).travas).toMatchObject({ textoLongo: false, textoLongoMaxCaracteres: 700 });
    expect((await interpretar({ texto_longo: { ligada: true } })).travas.textoLongoMaxCaracteres).toBe(700);
    expect((await interpretar({ texto_longo: { ligada: true, max_caracteres: 500 } })).travas).toMatchObject({
      textoLongo: true,
      textoLongoMaxCaracteres: 500,
    });
    for (const errado of [0, -1, 700.5, "700"]) {
      expect((await interpretar({ texto_longo: { ligada: true, max_caracteres: errado } })).invalida, String(errado)).toBe(
        true,
      );
    }
  });
});

describe("(C01, -c01.8) a ligação no turno, pelo código", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("arma sem o divisor com o limite da configuração; com o divisor, como antes", () => {
    expect(TURNO).toMatch(
      /\.\.\.\(travasDaOrg\.travas\.textoLongo && !estiloDesarmado\('texto_longo'\)\s*\?\s*\{\s*textoLongo: \{\s*restantes: maxSendsPerTurn - seq,\s*\.\.\.\(\(agentConfig\?\.splitMessages \?\? false\)\s*\?\s*\{ maxChars: agentConfig\?\.splitMaxChars \?\? 600 \}\s*:\s*\{ maxChars: travasDaOrg\.travas\.textoLongoMaxCaracteres, semDivisor: true as const \}\),/,
    );
  });

  it("é trava de estilo (1º veto ensina, 2º desarma e a mensagem sai), nunca de conteúdo (sem passagem à equipe)", () => {
    expect(TURNO).toMatch(/texto_longo: 'textoLongo',/);
    const conteudo = TURNO.slice(
      TURNO.indexOf("export const TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE"),
      TURNO.indexOf("export const MAX_VETOS_DE_CONTEUDO"),
    );
    expect(conteudo).not.toMatch(/texto_longo/);
    expect(TURNO).toMatch(/export const MAX_VETOS_DE_ESTILO = 2;/);
    expect(TURNO).toMatch(/runLog\.info\('trava de estilo no limite: desarmada no turno, a mensagem sai sem ela'/);
  });
});
