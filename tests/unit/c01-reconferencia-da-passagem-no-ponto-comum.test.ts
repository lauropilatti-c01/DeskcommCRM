/**
 * (C01) A PASSAGEM AO HUMANO É RECONFERIDA NO PONTO COMUM, SOB A SERIALIZAÇÃO —
 * achado 3 da segunda revisão adversarial do Codex (03/10/2026) sobre a trava 4b.
 *
 * O SDK executa as ferramentas de uma MESMA etapa em paralelo. Depois de dois vetos,
 * o modelo pode pedir, na mesma etapa, o 3º `send_message` (vetado → fail-safe) e um
 * `send_template`. O template conferia `passadoAoHumano` (ainda falso), esperava a
 * consulta do template e entrava na cadeia; nesse meio-tempo o fail-safe ligava a
 * trava e mandava a frase de espera; o template seguia ao canal sem reconferir, e
 * `pararQuando` só vale depois das ferramentas da etapa. Era o "limite" aceito na
 * rodada 2; agora está fechado.
 *
 * Como: `enviarPeloCanal` — o único caminho ao canal, chamado pela cadeia DENTRO da
 * transação com o lock do número — reconfere a trava imediatamente antes do envio
 * físico e lança `EnvioAposPassagemAoHumano`; `cadeiaDeEnvio` traduz isso num veto
 * `turno_passado_ao_humano` (a cadeia já desfez a transação). Só a frase de espera
 * passa, marcada por quem a manda (`fraseDeEspera: true`), e sai sem as fotos do
 * produto da mensagem vetada. A prova de comportamento, com as duas ferramentas na
 * mesma etapa e a consulta do template segurada até a frase sair, está em
 * `tests/invariants/c01-fail-safe-turno-completo.test.ts` (Postgres real).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { EnvioAposPassagemAoHumano } from "@/lib/agent-engine/agent/inbound-turn";

const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
const corpo = (inicio: string, fim: string) => {
  const i = FONTE.indexOf(inicio);
  expect(i, `âncora ${inicio} sumiu do turno`).toBeGreaterThan(-1);
  const j = FONTE.indexOf(fim, i);
  expect(j, `âncora ${fim} sumiu do turno`).toBeGreaterThan(i);
  return FONTE.slice(i, j);
};

describe("(C01) o erro da reconferência", () => {
  it("é um Error com nome próprio, para a cadeia distinguir de falha de infraestrutura", () => {
    const e = new EnvioAposPassagemAoHumano();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("EnvioAposPassagemAoHumano");
    expect(e.message).toMatch(/nada saiu/);
  });
});

describe("(C01) a reconferência no ponto comum e a tradução em veto", () => {
  it("`enviarPeloCanal` reconfere a passagem ANTES de avançar `seq` e de chamar o canal; só a frase marcada passa", () => {
    const envio = corpo("const enviarPeloCanal = async (", "const cadeiaDeEnvio = async (");
    const trava = envio.indexOf(
      "if (passadoAoHumano && opcoes?.fraseDeEspera !== true) throw new EnvioAposPassagemAoHumano();",
    );
    expect(trava).toBeGreaterThan(-1);
    expect(trava).toBeLessThan(envio.indexOf("seq += 1;"));
    expect(trava).toBeLessThan(envio.indexOf("liveChannel().send("));
    expect(envio).toMatch(/opcoes\?: \{ fraseDeEspera\?: boolean \}/);
  });

  it("`cadeiaDeEnvio` devolve o veto `turno_passado_ao_humano` só para esse erro; qualquer outro sobe", () => {
    const cadeia = corpo("const cadeiaDeEnvio = async (", "const corposEnviados: string[] = [];");
    expect(cadeia).toMatch(/if \(err instanceof EnvioAposPassagemAoHumano\) \{/);
    expect(cadeia).toMatch(
      /status: 'vetoed',\s*gate: 'turno_passado_ao_humano',\s*code: 'turno_passado_ao_humano',\s*message: recusaPorPassagemAoHumano\(\)\.error\.message,/,
    );
    expect(cadeia).toMatch(/\}\s*throw err;/);
  });

  it("toda cadeia de ferramenta roda por `cadeiaDeEnvio`: template, send_message, re-run do caso e pergunta do roteiro; só a frase de espera vai direto", () => {
    // Cinco chamadas à cadeia no turno: quatro traduzidas por `cadeiaDeEnvio`…
    expect(FONTE.match(/runBeforeSend\(/g)).toHaveLength(5);
    expect(FONTE.match(/cadeiaDeEnvio\(\(\) =>\s*runBeforeSend\(/g)).toHaveLength(4);
    // …e a frase de espera é a ÚNICA direta (marcada imediatamente antes de sair).
    expect(FONTE.match(/^\s*const espera = await runBeforeSend\(\{/gm)).toHaveLength(1);
    const failSafe = corpo("fotosDoProduto = [];", "const desfecho = desfechoDaFraseDeEspera(");
    expect(failSafe).toMatch(
      /enviandoFraseDeEspera = true;\s*const espera = await runBeforeSend\(\{/,
    );
    // Quem traduz: template, send_message, re-run do caso (case_promise) e pergunta do roteiro.
    expect(corpo("send_template: tool({", "send_message: tool({")).toMatch(
      /cadeiaDeEnvio\(\(\) =>/,
    );
    expect(corpo("send_message: tool({", "update_lead_state: tool({")).toMatch(
      /let chain = await cadeiaDeEnvio\(\(\) => runBeforeSend\(beforeSendArgs\)\);/,
    );
    expect(
      corpo("send_message: tool({", "update_lead_state: tool({").match(/cadeiaDeEnvio\(\(\) =>/g),
    ).toHaveLength(2);
    const depoisDoModelo = FONTE.slice(FONTE.indexOf("pararQuando: () =>"));
    expect(depoisDoModelo.match(/cadeiaDeEnvio\(\(\) =>/g)).toHaveLength(1);
  });

  it("o envio do send_message leva a marca da frase ao ponto comum; a frase sai sem as fotos do produto vetado", () => {
    const sendMessage = corpo("send_message: tool({", "update_lead_state: tool({");
    expect(sendMessage).toMatch(/let enviandoFraseDeEspera = false;/);
    expect(sendMessage).toMatch(
      /enviarPeloCanal\(\s*\{[\s\S]*?\},\s*\{ fraseDeEspera: enviandoFraseDeEspera \},\s*\)/,
    );
    // A chamada do autor continua literal (o teste dele a prende): as fotos são zeradas antes da frase.
    expect(sendMessage).toMatch(/return enviarComFotos\(finalBody, fotosDoProduto, \{/);
    const antesDaFrase = sendMessage.slice(
      sendMessage.indexOf("passadoAoHumano = true;"),
      sendMessage.indexOf("const espera = await runBeforeSend({"),
    );
    expect(antesDaFrase).toMatch(/fotosDoProduto = \[\];/);
    expect(antesDaFrase).toMatch(/enviandoFraseDeEspera = true;/);
  });

  it("as travas de início de ferramenta e a parada do laço continuam (a reconferência soma, não substitui)", () => {
    expect(
      FONTE.match(/if \(passadoAoHumano\) return recusaPorPassagemAoHumano\(\);/g),
    ).toHaveLength(2);
    expect(FONTE).toMatch(/pararQuando: \(\) =>\s*passadoAoHumano \|\|/);
    expect(FONTE.match(/liveChannel\(\)\.send\(/g)).toHaveLength(1);
  });
});
