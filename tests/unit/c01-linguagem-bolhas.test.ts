import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BEFORE_SEND_GATES, evaluateBeforeSend, type GateContext } from '@/lib/agent-engine/guardrails/before-send';
import { linguagemFormalGate } from '@/lib/agent-engine/guardrails/linguagem-formal';
import { textoLongoGate } from '@/lib/agent-engine/guardrails/texto-longo';
import { interpretarTravasDeEnvio, type TravasArmadas } from '@/lib/agent-engine/guardrails/travas-de-envio';

function contexto(body: string, travasDeEnvio: TravasArmadas = {}): GateContext {
  return { body, optedOut: false, travasDeEnvio } as GateContext;
}

const porBolha: TravasArmadas = {
  textoLongo: { restantes: 3, maxChars: 700, maxTotal: 700, porBolhaSemUrls: 700 },
};
const semDivisor: TravasArmadas = {
  textoLongo: { ...porBolha.textoLongo!, semDivisor: true },
};

describe('G1: somente as expressões decididas, com ativação própria', () => {
  it('nasce desligada; não altera o texto nem registra conteúdo no veto', () => {
    const ctx = contexto('Gostaria de ajudar mediante uma consulta.');
    expect(linguagemFormalGate.evaluate(ctx)).toEqual({ pass: true });
    const v = linguagemFormalGate.evaluate({ ...ctx, travasDeEnvio: { linguagemFormal: true } });
    expect(v).toMatchObject({ pass: false, code: 'linguagem_formal', detail: { expressoes: 2 } });
    expect(JSON.stringify(v)).not.toContain(ctx.body);
    expect(ctx.body).toBe('Gostaria de ajudar mediante uma consulta.');
  });

  it.each(['gostaria', 'veja', 'trabalhar a constância', 'cujo', 'mediante', 'ademais', 'o qual', 'selecione'])(
    'pede reescrita de %s, inclusive em maiúsculas', (palavra) => {
      expect(linguagemFormalGate.evaluate(contexto(`${palavra.toUpperCase()}.`, { linguagemFormal: true })))
        .toMatchObject({ pass: false, code: 'linguagem_formal' });
    },
  );

  it.each([
    'Preveja um intervalo; eu selecionei o conteúdo.',
    'O qualificador já está preenchido. Pode escolher.',
    'Aqui está: https://exemplo.com.br/veja?cujo=mediante&texto=gostaria',
    'Abre www.exemplo.com.br/selecione e exemplo.com.br/ademais.',
    'Tudo bem, não vou mandar mais mensagens.',
    'Vc pode usar o preparatório pra estudar.',
    'Trabalhar a constânciax não é a expressão inteira.',
  ])('evita falsos positivos em palavras vizinhas e URLs: %s', (body) => {
    expect(linguagemFormalGate.evaluate(contexto(body, { linguagemFormal: true }))).toEqual({ pass: true });
  });

  it('não perde a palavra fora do link nem a expressão com espaços e acento decomposto', () => {
    expect(linguagemFormalGate.evaluate(contexto('Veja https://exemplo.com.br/veja', { linguagemFormal: true })))
      .toMatchObject({ pass: false, detail: { expressoes: 1 } });
    expect(linguagemFormalGate.evaluate(contexto('trabalhar\n a  consta\u0302ncia', { linguagemFormal: true })))
      .toMatchObject({ pass: false });
  });
});

describe('G2: caracteres por bolha física, descontando só URLs reconhecidas', () => {
  it('aceita 700 e rejeita 701 caracteres, sem cortar a resposta', () => {
    expect(textoLongoGate.evaluate(contexto('a'.repeat(700), semDivisor))).toEqual({ pass: true });
    const ctx = contexto('a'.repeat(701), semDivisor);
    expect(textoLongoGate.evaluate(ctx)).toMatchObject({ pass: false, code: 'texto_longo' });
    expect(ctx.body).toHaveLength(701);
  });

  it('o link longo não consome a régua e sai inteiro; emoji conta por ponto de código', () => {
    const url = `https://exemplo.com.br/${'a'.repeat(900)}`;
    expect(textoLongoGate.evaluate(contexto(`${'🙂'.repeat(700)}\n${url}`, semDivisor))).toEqual({ pass: true });
    expect(textoLongoGate.evaluate(contexto(url, porBolha))).toEqual({ pass: true });
    expect(textoLongoGate.evaluate(contexto(`${'🙂'.repeat(701)}\n${url}`, semDivisor)))
      .toMatchObject({ pass: false, detail: { maior_bolha_sem_urls: 701 } });
  });

  it('avalia cada mensagem do divisor, sem somar duas bolhas permitidas', () => {
    const body = `${'a'.repeat(500)}\n\n${'b'.repeat(500)}`;
    expect(textoLongoGate.evaluate(contexto(body, porBolha))).toEqual({ pass: true });
    const antiga = { textoLongo: { restantes: 3, maxChars: 700, maxTotal: 700 } };
    expect(textoLongoGate.evaluate(contexto(body, antiga))).toMatchObject({ pass: false, code: 'texto_longo' });
  });

  it('a contagem antiga continua incluindo links quando o novo modo está ausente', () => {
    const antiga: TravasArmadas = { textoLongo: { restantes: 1, maxChars: 700, semDivisor: true } };
    const body = `${'a'.repeat(690)} https://exemplo.com.br/pagina`;
    expect(textoLongoGate.evaluate(contexto(body, antiga))).toMatchObject({ pass: false });
    expect(textoLongoGate.evaluate(contexto(body, semDivisor))).toEqual({ pass: true });
  });

  it('não desconta texto entre sinais, e-mail nem domínio inventado; desconta URLs em Markdown', () => {
    expect(textoLongoGate.evaluate(contexto(`${'a'.repeat(690)} [explicação bem comprida]`, semDivisor)))
      .toMatchObject({ pass: false });
    expect(textoLongoGate.evaluate(contexto(`${'a'.repeat(690)} pessoa@exemplo.com`, semDivisor)))
      .toMatchObject({ pass: false });
    expect(textoLongoGate.evaluate(contexto(`${'a'.repeat(690)} texto.extensaoinventada`, semDivisor)))
      .toMatchObject({ pass: false });
    expect(textoLongoGate.evaluate(contexto(`${'a'.repeat(680)} [página](https://exemplo.com.br/${'b'.repeat(900)})`, semDivisor)))
      .toEqual({ pass: true });
  });

  it('preserva a proteção do teto de mensagens e não envia texto automaticamente', () => {
    const armada: TravasArmadas = { textoLongo: { ...porBolha.textoLongo!, restantes: 1 } };
    expect(textoLongoGate.evaluate(contexto('Uma parte.\n\nOutra parte.', armada)))
      .toMatchObject({ pass: false, code: 'texto_longo' });
    expect(textoLongoGate.evaluate(contexto('a'.repeat(701), { textoLongo: { ...porBolha.textoLongo!, restantes: 0 } })))
      .toEqual({ pass: true });
  });
});

describe('ligação por organização e precedência de recusa', () => {
  it('ambas as opções vêm desligadas e a régua vigente continua 700', () => {
    for (const config of [undefined, {}, { texto_longo: { ligada: true } }]) {
      expect(interpretarTravasDeEnvio(config).travas).toMatchObject({
        linguagemFormal: false, textoLongoPorBolhaSemUrls: false, textoLongoMaxCaracteres: 700,
      });
    }
    expect(interpretarTravasDeEnvio({
      linguagem_formal: { ligada: true }, texto_longo: { ligada: true, por_bolha_sem_urls: true },
    }).travas).toMatchObject({ linguagemFormal: true, textoLongo: true, textoLongoPorBolhaSemUrls: true });
  });

  it('recusa/humano é avaliado antes e a trava de estilo não transforma bloqueio em envio', () => {
    const ctx = { ...contexto('Gostaria de continuar.', { linguagemFormal: true }), optedOut: true };
    const res = evaluateBeforeSend(ctx);
    expect(res.veto?.gate).toBe('stop');
    expect(res.trace.find((t) => t.gate === 'linguagem_formal')?.verdict).toBe('skipped');
    expect(BEFORE_SEND_GATES.findIndex((g) => g.name === 'linguagem_formal'))
      .toBeGreaterThan(BEFORE_SEND_GATES.findIndex((g) => g.name === 'valor_em_dinheiro'));
  });

  it('usa o contador e a saída de estilo existentes, nunca o fail-safe de conteúdo', () => {
    // Contrato de ligação no turno: sem chamar IA ou fingir uma conversa E2E.
    const turno = readFileSync('lib/agent-engine/agent/inbound-turn.ts', 'utf8');
    expect(turno).toContain("linguagem_formal: 'linguagemFormal'");
    expect(turno).toMatch(/linguagemFormal && !estiloDesarmado\('linguagem_formal'\)/);
    expect(turno).toContain('porBolhaSemUrls: travasDaOrg.travas.textoLongoMaxCaracteres');
    expect(turno).toContain('export const MAX_VETOS_DE_ESTILO = 2');
    const conteudo = turno.slice(turno.indexOf('export const TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE'), turno.indexOf('export const MAX_VETOS_DE_CONTEUDO'));
    expect(conteudo).not.toContain('linguagem_formal');
    expect(turno).toMatch(/vetos < MAX_VETOS_DE_ESTILO/);
    expect(turno).toMatch(/chain = await cadeiaDeEnvio\(\(\) =>\s*runBeforeSend\(/);
    expect(turno).toContain('const { trava, entrada } = envioVetadoPorEstilo');
  });
});
