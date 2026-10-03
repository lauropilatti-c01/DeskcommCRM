/**
 * (C01) A FRASE DE ESPERA TEM UM `send` SÓ DELA — achado 1 (alto) da sexta revisão
 * adversarial do Codex (03/10/2026), rodada 7, correção 1.
 *
 * O achado: o fail-safe de vocabulário interno mandava a frase de espera pela cadeia
 * com os MESMOS `beforeSendArgs` do envio do modelo — o `send` inclusive. Esse `send`
 * carrega o plano da retomada do teto cheio (rodada 6): com o teto cheio e uma
 * pendência conhecida (o texto vetado `queued` pela versão anterior, ou uma foto), ele
 * ignorava o `finalBody` validado e mandava o plano original marcado como frase de
 * espera. O texto que a trava acabara de vetar chegava ao cliente; a frase não saía; e
 * a Central dizia "cliente avisado".
 *
 * A correção: a frase vai pela cadeia inteira como antes, mas com `send:
 * enviarFraseDeEspera` — UMA mensagem, só o `finalBody`, sem plano, sem fotos, sem
 * nada do corpo do modelo. O `send` do modelo continua como está para os envios dele.
 * A prova de turno completo (Postgres real, cadeia de verdade) está em
 * `tests/invariants/c01-recuperacao-com-falha-na-posicao-1.test.ts` (rodada 7); aqui
 * fica a ligação pelo código.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

function trecho(inicio: string, fim: string): string {
  const i = FONTE.indexOf(inicio);
  const f = FONTE.indexOf(fim, i);
  expect(i, inicio).toBeGreaterThan(-1);
  expect(f, fim).toBeGreaterThan(i);
  return FONTE.slice(i, f);
}

describe("(C01) o `send` exclusivo da frase de espera", () => {
  const sendMessage = trecho("send_message: tool({", "update_lead_state: tool({");
  // Lido dentro de cada caso: sem a correção não existe, e cada caso reprova por si.
  const callback = () =>
    trecho(
      "const enviarFraseDeEspera = (finalBody: string): Promise<ChannelSendResult> => {",
      "if (produto_codigo !== undefined && produto_codigo.trim() !== '' && !preview) {",
    );

  it("existe, dentro do `send_message`, e é definido antes dos `beforeSendArgs` (não depende de nada do envio do modelo)", () => {
    expect(sendMessage).toContain(
      "const enviarFraseDeEspera = (finalBody: string): Promise<ChannelSendResult> => {",
    );
    expect(sendMessage.indexOf("const enviarFraseDeEspera =")).toBeLessThan(
      sendMessage.indexOf("const beforeSendArgs = {"),
    );
  });

  it("manda SÓ o `finalBody` validado, pelo ponto comum, com a marca da frase fixa — e a identidade do envio como a de qualquer mensagem", () => {
    expect(callback()).toMatch(/corposEnviados\.push\(finalBody\);/);
    expect(callback()).toMatch(
      /return enviarPeloCanal\(\s*\{\s*tenantId,\s*leadId,\s*jobId: liveJob\(\)\.id,\s*jobClaim: claimOfJob\(liveJob\(\)\),\s*agentOperation,\s*conversationId: input\.conversationId,\s*body: finalBody,\s*\.\.\.identidadeDoEnvio\(finalBody, finalBody, comoACadeiaComeca\(corpoDaCadeia\(\)\)\),\s*\},\s*\{ fraseDeEspera: true \},\s*\);/,
    );
  });

  it("não reaproveita nada do envio do modelo: nem o plano da retomada, nem as fotos, nem as bolhas", () => {
    for (const proibido of [
      "retomada",
      "fotosDoProduto",
      "enviarComFotos",
      "sendInBubbles",
      "enviarSoAsConhecidas",
      "media",
      "splitForSend",
    ]) {
      expect(callback(), proibido).not.toContain(proibido);
    }
  });

  it("a frase de espera passa pela cadeia com `send: enviarFraseDeEspera`, e é o único `send` do bloco do fail-safe", () => {
    const frase = trecho(
      "enviandoFraseDeEspera = true;",
      "const desfecho = desfechoDaFraseDeEspera(",
    );
    expect(frase).toMatch(
      /const espera = await runBeforeSend\(\{\s*\.\.\.beforeSendArgs,\s*body: deps\.knobs\.fraseDeEspera \?\? FRASE_DE_ESPERA_PADRAO,[\s\S]*?send: enviarFraseDeEspera,\s*\}\);/,
    );
    expect(frase.match(/\bsend:/g)).toHaveLength(1);
  });

  it("o `send` do modelo continua com o plano da retomada do teto cheio (é dos envios DELE), e vem antes do fail-safe", () => {
    const sendDoModelo = trecho(
      "send: (finalBody: string) => {",
      "let chain = await cadeiaDeEnvio(",
    );
    expect(sendDoModelo).toMatch(
      /if \(retomada !== null\) return enviarSoAsConhecidas\(retomada\.conhecidas, \{ enviar, sleep, jitter \}\);/,
    );
    expect(sendDoModelo).toMatch(/return enviarComFotos\(finalBody, fotosDoProduto, \{/);
    expect(sendMessage.indexOf("send: (finalBody: string) => {")).toBeLessThan(
      sendMessage.indexOf("send: enviarFraseDeEspera,"),
    );
  });

  it("`corpoDaCadeia()` é a frase enquanto ela sai: a identidade no ledger parte dela, e a marca é ligada antes de a cadeia rodar", () => {
    expect(sendMessage).toMatch(
      /const corpoDaCadeia = \(\): string =>\s*enviandoFraseDeEspera \? \(deps\.knobs\.fraseDeEspera \?\? FRASE_DE_ESPERA_PADRAO\) : body;/,
    );
    const antes = trecho("fotosDoProduto = [];", "const espera = await runBeforeSend({");
    expect(antes).toMatch(/enviandoFraseDeEspera = true;/);
  });
});
