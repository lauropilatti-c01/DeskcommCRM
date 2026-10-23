import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MAX_VETOS_DE_ESTILO, TRAVAS_DE_ESTILO } from '@/lib/agent-engine/agent/inbound-turn';
import { formatarParaWhatsApp } from '@/lib/agent-engine/agent/formato-whatsapp';
import { MAX_LEGENDA_VIDEO } from '@/lib/agent-engine/agent/videos-nativos';
import { estiloViraConteudo } from '@/lib/c01/passagem-desligada';
import { BEFORE_SEND_GATES, evaluateBeforeSend, type GateContext } from '@/lib/agent-engine/guardrails/before-send';

type Entrada = { body: string; produto_codigo?: string; video_chave?: string };

/**
 * Executa os três blocos REAIS do turno, sem duplicar a lógica no teste. O laço do
 * modelo e o transporte são seams locais. Prova a vida da pendência e o retorno
 * pelos gates, não uma conversa E2E, banco, cópia de mídia ou envio ao canal.
 */
function turnoDosBlocosReais(opts: { bloqueado?: boolean } = {}) {
  const fonte = readFileSync('lib/agent-engine/agent/inbound-turn.ts', 'utf8');
  const ini = fonte.indexOf('execute: async ({ body: corpoDoModelo, produto_codigo, video_chave }, opcoes) => {');
  expect(ini).toBeGreaterThan(0);
  const preambulo = fonte.slice(fonte.indexOf('{\n', ini) + 2, fonte.indexOf('const consultasFaltando =', ini));
  const inicioEstilo = fonte.indexOf("while (chain.status === 'vetoed' && Object.hasOwn(TRAVAS_DE_ESTILO, chain.code))");
  const estilo = fonte.slice(inicioEstilo, fonte.indexOf("if (chain.status === 'vetoed' && chain.code === 'internal_vocabulary_leak')", inicioEstilo));
  const inicioFim = fonte.indexOf('TRAVA DE ESTILO SEM ETAPA PARA REESCREVER');
  const fim = fonte.slice(fonte.indexOf('    if (', inicioFim), fonte.lastIndexOf('// ═══', fonte.indexOf('SEM PASSAGEM, O VETO DE CONTEÚDO SEM NOVA TENTATIVA')));
  expect(estilo).toContain('envioVetadoPorEstilo =');
  expect(fim).toContain('rawTools.send_message');
  const gates = BEFORE_SEND_GATES.filter((g) => ['stop', 'linguagem_formal'].includes(g.name));
  const avaliar = (body: string, armada: boolean) => {
    const res = evaluateBeforeSend({ body, optedOut: opts.bloqueado === true, travasDeEnvio: armada ? { linguagemFormal: true } : {} } as GateContext, gates);
    return res.veto === null
      ? { status: 'sent' }
      : { status: 'vetoed', code: res.veto.code, message: res.veto.message };
  };
  const criar = new Function('formatarParaWhatsApp', 'MAX_LEGENDA_VIDEO', 'MAX_VETOS_DE_ESTILO', 'TRAVAS_DE_ESTILO', 'estiloViraConteudo', 'avaliar', `
    let envioVetadoPorEstilo = null;
    let tentativasDeEnvio = 0;
    const vetosDeEstilo = new Map();
    const preview = false, semPassagem = false, openedCaseThisTurn = false;
    const runLog = { info() {} };
    const cadeiaDeEnvio = (fn) => fn();
    const enviados = [], retomados = [];
    const runBeforeSend = async ({ body }) => avaliar(body, (vetosDeEstilo.get('linguagem_formal') ?? 0) < MAX_VETOS_DE_ESTILO);
    const executar = async ({ body: corpoDoModelo, produto_codigo, video_chave }) => {
      ${preambulo}
      const beforeSendArgs = { body };
      let chain = await runBeforeSend(beforeSendArgs);
      ${estilo}
      if (chain.status === 'sent') enviados.push({ body, ...(video_chave === undefined ? {} : { video_chave }) });
      return chain;
    };
    const encerrar = async () => {
      const leadTemResposta = enviados.length > 0, corposEnviados = enviados;
      const runError = null, outcomes = [], passadoAoHumano = false, turnoDescartado = false;
      const turnoVaiFalarComOLead = () => true, liveJob = () => null;
      const rawTools = { send_message: { execute: async (entrada) => { retomados.push(entrada); return executar(entrada); } } };
      ${fim}
    };
    return { executar, encerrar, enviados, retomados };
  `);
  return criar(formatarParaWhatsApp, MAX_LEGENDA_VIDEO, MAX_VETOS_DE_ESTILO, TRAVAS_DE_ESTILO, estiloViraConteudo, avaliar) as {
    executar: (entrada: Entrada) => Promise<unknown>;
    encerrar: () => Promise<void>;
    enviados: Entrada[];
    retomados: Entrada[];
  };
}

describe('pendência de estilo na integração com vídeo', () => {
  it('texto vetado → vídeo inválido → fim não solta o texto antigo nem a legenda', async () => {
    const t = turnoDosBlocosReais();
    expect(await t.executar({ body: 'Gostaria de continuar.' })).toMatchObject({ ok: false, error: { code: 'linguagem_formal' } });
    expect(await t.executar({ body: 'Legenda.', produto_codigo: 'fixture', video_chave: 'fixture' }))
      .toMatchObject({ ok: false, error: { code: 'video_configuracao_invalida' } });
    await t.encerrar();
    expect(t.retomados).toEqual([]);
    expect(t.enviados).toEqual([]);
  });

  it('vídeo retido por estilo conserva a chave no fallback; não vira só legenda', async () => {
    const t = turnoDosBlocosReais();
    await t.executar({ body: 'Gostaria de mostrar este vídeo.', video_chave: 'fixture' });
    await t.encerrar();
    expect(t.retomados).toEqual([{ body: 'Gostaria de mostrar este vídeo.', video_chave: 'fixture' }]);
    expect(t.enviados).toEqual(t.retomados);
  });

  it('texto comum preserva a saída útil no fim e na segunda tentativa', async () => {
    const noFim = turnoDosBlocosReais();
    await noFim.executar({ body: 'Gostaria de ajudar.' });
    await noFim.encerrar();
    expect(noFim.enviados).toEqual([{ body: 'Gostaria de ajudar.' }]);
    const naSegunda = turnoDosBlocosReais();
    await naSegunda.executar({ body: 'Gostaria de ajudar.' });
    await naSegunda.executar({ body: 'Gostaria de continuar.' });
    await naSegunda.encerrar();
    expect(naSegunda.enviados).toEqual([{ body: 'Gostaria de continuar.' }]);
    expect(naSegunda.retomados).toEqual([]);
  });

  it('o bloqueio continua vencendo, mesmo com tentativas de estilo repetidas', async () => {
    const estado = { bloqueado: false };
    const t = turnoDosBlocosReais(estado);
    await t.executar({ body: 'Gostaria de ajudar.' });
    estado.bloqueado = true;
    await t.executar({ body: 'Gostaria de continuar.' });
    await t.encerrar();
    expect(t.retomados).toEqual([]);
    expect(t.enviados).toEqual([]);
  });
});
