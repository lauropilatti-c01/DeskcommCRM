/**
 * (C01, -c01.15, P2 e P3) COM A PASSAGEM DESLIGADA, CASO E "VOU VERIFICAR", NUNCA SILÊNCIO.
 *
 * O defeito: num agente com a ferramenta de passagem desligada na tela
 * (`handoff_tool_enabled = false`), o `open_human_case` devolvia ao modelo a expectativa
 * da equipe ("ficou registrado" e a disponibilidade), e os fail-safes das travas de
 * conteúdo, do turno sem resposta e da falha na preparação mandavam a frase de espera
 * ("uma pessoa continua a conversa") e gravavam a passagem (`performHumanHandoff`:
 * `force_human`, `bot_silenced_until = 'infinity'`). A IA calava para sempre numa
 * conversa que ninguém ia assumir.
 *
 * A correção: com a passagem desligada, o retorno do caso manda "vou verificar e já te
 * retorno"; os fail-safes abrem o caso (com o texto retido), mandam
 * `FRASE_DE_VERIFICACAO` pela cadeia de envio e não gravam passagem; a trava "consulte
 * antes de enviar" vale como de conteúdo. Com a passagem ligada, nada muda. Os textos
 * se provam pelo conteúdo; a ligação no turno, pelo código (o turno inteiro é caro
 * demais para se provar aqui).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AVISO_AO_MODELO_SEM_FRASE_SEM_PASSAGEM,
  estiloViraConteudo,
  FRASE_DE_VERIFICACAO,
  notaDaDuvidaNova,
  passagemDesligada,
  RETORNO_DO_CASO_JA_ABERTO_SEM_PASSAGEM,
  RETORNO_DO_CASO_SEM_PASSAGEM,
} from "@/lib/c01/passagem-desligada";
import {
  textosDoFimSemResposta,
  TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE,
  TRAVAS_DE_ESTILO,
  type FimSemResposta,
} from "@/lib/agent-engine/agent/inbound-turn";

const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

function trecho(inicio: string, fim: string, de = 0): string {
  const i = FONTE.indexOf(inicio, de);
  const f = FONTE.indexOf(fim, i);
  expect(i, inicio).toBeGreaterThan(-1);
  expect(f, fim).toBeGreaterThan(i);
  return FONTE.slice(i, f);
}

describe("(C01, -c01.15) quando a passagem está desligada", () => {
  it("só a versão publicada com `handoffToolEnabled === false`; sem agente, a passagem de hoje", () => {
    expect(passagemDesligada({ handoffToolEnabled: false })).toBe(true);
    expect(passagemDesligada({ handoffToolEnabled: true })).toBe(false);
    expect(passagemDesligada(null)).toBe(false);
    expect(passagemDesligada(undefined)).toBe(false);
  });

  it("a frase dos fail-safes diz que vai verificar e retornar, sem pessoa, prazo nem \"ficou registrado\"", () => {
    expect(FRASE_DE_VERIFICACAO).toBe("Vou verificar pra você e já te retorno.");
    expect(FRASE_DE_VERIFICACAO).not.toMatch(/pessoa|equipe|atendente|registrad|anotad|minutos?|horas?|hoje|amanh/i);
  });
});

describe("(C01, -c01.15, P2) o retorno do `open_human_case` ao modelo", () => {
  it("manda \"vou verificar e já te retorno\", sem prazo, resultado nem \"ficou registrado\"", () => {
    for (const texto of [RETORNO_DO_CASO_SEM_PASSAGEM, RETORNO_DO_CASO_JA_ABERTO_SEM_PASSAGEM]) {
      expect(texto).toMatch(/vou verificar e já te retorno/);
      expect(texto).toMatch(/sem prometer prazo ou resultado e sem dizer que ficou registrado/);
      expect(texto).toMatch(/continue a conversa normalmente/);
    }
    expect(RETORNO_DO_CASO_JA_ABERTO_SEM_PASSAGEM).toMatch(/não abra outro/);
  });

  it("sem passagem, devolve o retorno ANTES da expectativa da equipe; o caso já aberto também é sucesso", () => {
    const ferramenta = trecho("rawTools.open_human_case = tool({", "rawTools.provide_case_update = tool({");
    const semPassagem = ferramenta.indexOf(
      "if (semPassagem) return { ok: true, case_id: res.caseId, message: RETORNO_DO_CASO_SEM_PASSAGEM };",
    );
    expect(semPassagem).toBeGreaterThan(-1);
    expect(semPassagem).toBeGreaterThan(ferramenta.indexOf("moverParaHandoffBestEffort('open_human_case');"));
    expect(semPassagem).toBeLessThan(ferramenta.indexOf("expectativaDeAtendimento("));
    // (C01, -c01.16) o caso já aberto só vira sucesso DEPOIS de a dúvida entrar nele como nota;
    // sem caso aberto na hora da nota, abre de novo (e o erro dessa nova tentativa volta ao modelo).
    expect(ferramenta).toMatch(
      /if \(!res\.ok && semPassagem && res\.error\.code === 'case_already_open'\) \{\s*const noCaso = await registrarDuvidaNoCasoAberto\(pool, tenantId, input\.conversationId, parsed\.data\);\s*if \(noCaso !== null\) return \{ ok: true, case_id: noCaso, message: RETORNO_DO_CASO_JA_ABERTO_SEM_PASSAGEM \};\s*res = await openCase\(/,
    );
    expect(ferramenta.indexOf("if (!res.ok) return res;")).toBeGreaterThan(ferramenta.indexOf("res = await openCase("));
    expect(ferramenta).toMatch(/let res = await openCase\(/);
  });

  it("(-c01.16) o retorno do caso já aberto diz que a dúvida foi juntada; a nota leva título, resumo e bloqueio", () => {
    expect(RETORNO_DO_CASO_JA_ABERTO_SEM_PASSAGEM).toMatch(/esta dúvida foi juntada a ele/);
    expect(notaDaDuvidaNova({ title: "T", summary: "S", blocker: "B" })).toBe(
      "Dúvida nova do lead (o caso já estava aberto): T\nS\nBloqueio: B",
    );
  });
});

describe("(C01, -c01.15, P3) os textos do caso dos fail-safes", () => {
  const veto: FimSemResposta = {
    motivo: "veto_de_conteudo",
    trava: "valor_em_dinheiro",
    vetos: 3,
    texto: "O texto que a trava reteve",
  };

  it("sem passagem, o bloqueio diz que sai a frase de verificação e que a IA continua; o resumo leva o texto retido", () => {
    const textos = textosDoFimSemResposta(veto, { semPassagem: true });
    expect(textos.resumo).toBe("O texto que a trava reteve");
    expect(textos.bloqueio).toContain(FRASE_DE_VERIFICACAO);
    expect(textos.bloqueio).toMatch(/a IA continua na conversa/);
    expect(textos.bloqueio).not.toMatch(/frase de espera/);
  });

  it("com a passagem ligada, os textos de sempre", () => {
    const ligada = textosDoFimSemResposta(veto);
    expect(textosDoFimSemResposta(veto, { semPassagem: false })).toEqual(ligada);
    expect(ligada.bloqueio).not.toContain(FRASE_DE_VERIFICACAO);
  });

  it("a \"consulte antes de enviar\" ganha nome legível no caso (ela é de conteúdo sem passagem)", () => {
    const textos = textosDoFimSemResposta(
      { ...veto, trava: "consulta_antes_de_enviar" },
      { semPassagem: true },
    );
    expect(textos.tituloDoCaso).toMatch(/resposta sem a consulta à base que vem antes/);
  });
});

describe("(C01, -c01.15, P3) a \"consulte antes de enviar\" vira trava de conteúdo só sem passagem", () => {
  it("só ela, só sem passagem; as outras de estilo e as de conteúdo não mudam", () => {
    expect(Object.hasOwn(TRAVAS_DE_ESTILO, "consulta_antes_de_enviar")).toBe(true);
    expect(Object.hasOwn(TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE, "consulta_antes_de_enviar")).toBe(false);
    expect(estiloViraConteudo("consulta_antes_de_enviar", true)).toBe(true);
    expect(estiloViraConteudo("consulta_antes_de_enviar", false)).toBe(false);
    expect(estiloViraConteudo("texto_longo", true)).toBe(false);
    expect(estiloViraConteudo("uma_pergunta", true)).toBe(false);
  });

  it("no envio, ela sai do laço de estilo e entra no contador e no fail-safe das de conteúdo", () => {
    const envio = trecho("send_message: tool({", "update_lead_state: tool({");
    const laco = envio.indexOf("while (chain.status === 'vetoed' && Object.hasOwn(TRAVAS_DE_ESTILO, chain.code)) {");
    expect(laco).toBeGreaterThan(-1);
    expect(envio.slice(laco)).toMatch(
      /^while \(chain\.status === 'vetoed' && Object\.hasOwn\(TRAVAS_DE_ESTILO, chain\.code\)\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(estiloViraConteudo\(chain\.code, semPassagem\)\) break;/,
    );
    expect(envio).toMatch(
      /chain\.status === 'vetoed' &&\s*\(Object\.hasOwn\(TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE, chain\.code\) \|\|\s*estiloViraConteudo\(chain\.code, semPassagem\)\)/,
    );
  });

  it("na solta da mensagem de estilo depois do laço, ela não se desarma, e a solta não abre caso por conta própria", () => {
    const solta = trecho("const { trava, entrada } = envioVetadoPorEstilo;", "SEM PASSAGEM, O VETO DE CONTEÚDO SEM NOVA TENTATIVA");
    expect(solta).toMatch(/if \(semPassagem\) vetosDeEstilo\.delete\(CONSULTA_ANTES_DE_ENVIAR\);/);
    // (revisão) A solta vetada por pacing (cap diário, warm-up) reagenda o job: abrir caso
    // e mandar a frase ali era caso falso e frase seguida da resposta.
    expect(solta).not.toMatch(/passarAoHumanoSemResposta/);
  });
});

describe("(C01, -c01.15, revisão) o veto de conteúdo sem nova tentativa, sem passagem", () => {
  const depois = () => trecho("SEM PASSAGEM, O VETO DE CONTEÚDO SEM NOVA TENTATIVA", "O LAÇO FOI CORTADO POR NOSSO TETO");

  it("cada veto de conteúdo antes do limite guarda o texto vetado (as de conteúdo, a consulta sem passagem e o vocabulário interno)", () => {
    const envio = trecho("send_message: tool({", "update_lead_state: tool({");
    expect(envio).toMatch(
      /if \(vetos < MAX_VETOS_DE_CONTEUDO\) \{\s*ultimoVetoDeConteudo = \{ trava: chain\.code, vetos, texto: body \};/,
    );
    expect(envio).toMatch(
      /if \(internalVocabularyVetoCount < MAX_VETOS_DE_VOCABULARIO_INTERNO\) \{\s*ultimoVetoDeConteudo = \{ trava: chain\.code, vetos: internalVocabularyVetoCount, texto: body \};/,
    );
    // Só ali: o veto de estilo e o de pacing não guardam.
    expect(FONTE.match(/ultimoVetoDeConteudo = \{/g)).toHaveLength(2);
  });

  it("depois do laço: sem passagem, com veto de conteúdo guardado, sem veto de pacing e nada no lead → caso e frase", () => {
    const bloco = depois();
    for (const guarda of [
      "semPassagem &&",
      "!preview &&",
      "ultimoVetoDeConteudo !== null &&",
      "semVetoDePacing &&",
      "!leadTemResposta &&",
      "corposEnviados.length === 0 &&",
      "runError === null &&",
      "!outcomes.some((o) => o.kind === 'failed') &&",
      "!passadoAoHumano &&",
      "!turnoDescartado &&",
      "turnoVaiFalarComOLead(liveJob())",
    ]) {
      expect(bloco, guarda).toContain(guarda);
    }
    expect(bloco).toMatch(/const semVetoDePacing = pacingCapVeto === null;/);
    expect(bloco).toMatch(/await passarAoHumanoSemResposta\(\{ motivo: 'veto_de_conteudo', \.\.\.ultimoVetoDeConteudo \}\);/);
    // Antes do corte: o corte não abre um segundo caso (`passadoAoHumano`).
    expect(FONTE.indexOf("SEM PASSAGEM, O VETO DE CONTEÚDO SEM NOVA TENTATIVA")).toBeLessThan(
      FONTE.indexOf("O LAÇO FOI CORTADO POR NOSSO TETO"),
    );
  });
});

describe("(C01, -c01.15, revisão) com mensagem do turno já no lead, o fail-safe sem passagem só abre o caso", () => {
  it("o aviso ao modelo diz que o caso abriu e que nada mais sai, sem a frase", () => {
    expect(AVISO_AO_MODELO_SEM_FRASE_SEM_PASSAGEM).toMatch(/caso foi aberto/);
    expect(AVISO_AO_MODELO_SEM_FRASE_SEM_PASSAGEM).toMatch(/já recebeu mensagem deste turno/);
    expect(AVISO_AO_MODELO_SEM_FRASE_SEM_PASSAGEM).not.toContain(FRASE_DE_VERIFICACAO);
  });

  it("o turno sem resposta (a trava de conteúdo no limite): o caso, e volta ANTES da frase quando algo já saiu", () => {
    const fim = trecho(
      "const passarAoHumanoSemResposta = async (fim: FimSemResposta): Promise<DesfechoDaFraseDeEspera | 'sem_frase'> => {",
      "return desfecho;\n  };",
    );
    const caso = fim.indexOf("await openCase(");
    const semFrase = fim.indexOf("if (semPassagem && (leadTemResposta || corposEnviados.length > 0)) {");
    const frase = fim.indexOf("body: fraseDoFailSafe,");
    expect(caso).toBeGreaterThan(-1);
    expect(semFrase).toBeGreaterThan(caso);
    expect(frase).toBeGreaterThan(semFrase);
    expect(fim.slice(semFrase, frase)).toMatch(/return 'sem_frase';/);
    expect(FONTE).toMatch(
      /desfecho === 'sem_frase' \? AVISO_AO_MODELO_SEM_FRASE_SEM_PASSAGEM : avisoAoModeloDoFailSafe\[desfecho\]/,
    );
  });

  it("o vocabulário interno no limite: o caso, e volta ANTES da frase quando algo já saiu", () => {
    const vocab = trecho("moverParaHandoffBestEffort('vocabulario_interno_autofallback');", "body: fraseDoFailSafe,");
    expect(vocab).toMatch(/if \(semPassagem && \(leadTemResposta \|\| corposEnviados\.length > 0\)\) \{[\s\S]*?AVISO_AO_MODELO_SEM_FRASE_SEM_PASSAGEM[\s\S]*?\}/);
  });
});

describe("(C01, -c01.15, P3) os fail-safes sem passagem não gravam a passagem", () => {
  it("a frase dos fail-safes é a de verificação sem passagem, e a de espera com ela", () => {
    expect(FONTE).toMatch(
      /const fraseDoFailSafe = semPassagem \? FRASE_DE_VERIFICACAO : \(deps\.knobs\.fraseDeEspera \?\? FRASE_DE_ESPERA_PADRAO\);/,
    );
    // Nenhum fail-safe do corpo do turno manda a frase de espera por fora dela.
    expect(FONTE).not.toMatch(/body: deps\.knobs\.fraseDeEspera \?\? FRASE_DE_ESPERA_PADRAO/);
  });

  it("o turno sem resposta (travas de conteúdo no limite, cortes): caso e frase, e volta ANTES de `performHumanHandoff`", () => {
    const fim = trecho(
      "const passarAoHumanoSemResposta = async (fim: FimSemResposta): Promise<DesfechoDaFraseDeEspera | 'sem_frase'> => {",
      "return desfecho;\n  };",
    );
    expect(fim).toMatch(/textosDoFimSemResposta\(fim, \{ semPassagem \}\)/);
    const caso = fim.indexOf("await openCase(");
    const frase = fim.indexOf("body: fraseDoFailSafe,");
    const volta = fim.indexOf("if (semPassagem) {");
    const passagem = fim.indexOf("await gravarPassagemComNovaTentativa(");
    expect(caso).toBeGreaterThan(-1);
    expect(frase).toBeGreaterThan(caso);
    expect(volta).toBeGreaterThan(frase);
    expect(passagem).toBeGreaterThan(volta);
    expect(fim.slice(volta, passagem)).toMatch(/return desfecho;/);
  });

  it("a frase vetada pela cadeia (janela de 24 h, bloqueio) não é erro do turno sem passagem: não sai e o job não re-tenta o modelo", () => {
    expect(FONTE).toMatch(
      /const desfechoDoFailSafe = \(espera: BeforeSendResult\): DesfechoDaFraseDeEspera => \{\s*if \(semPassagem && espera\.status === 'vetoed'\) \{[\s\S]*?return 'pendente';\s*\}\s*return desfechoDaFraseDeEspera\(espera, \{ outcomes, noteRunError, log: runLog \}\);/,
    );
  });

  it("o vocabulário interno: o caso e a frase de sempre, sem a passagem gravada", () => {
    expect(FONTE).toMatch(/if \(!semPassagem\) await gravarPassagemComNovaTentativa\(/);
  });

  it("a falha na preparação: caso e frase de verificação, e volta ANTES de `performHumanHandoff`", () => {
    const prep = trecho(
      "const semPassagem = marca.passagemDesligada === true;",
      "await gravarPassagemComNovaTentativa(",
    );
    expect(prep).toMatch(/corpo: semPassagem \? FRASE_DE_VERIFICACAO : ctx\.fraseDeEspera,/);
    expect(prep).toMatch(/if \(semPassagem\) \{[\s\S]*?return;\s*\}/);
    expect(prep).not.toMatch(/performHumanHandoff/);
    expect(FONTE).toMatch(/marca\.passagemDesligada = passagemDesligada\(agentConfig\);/);
  });

  it("depois da frase, as ferramentas de envio recusam com o texto sem passagem", () => {
    expect(FONTE).toMatch(/message: semPassagem\s*\? RECUSA_DEPOIS_DA_VERIFICACAO/);
  });
});
