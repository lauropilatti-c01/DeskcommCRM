/**
 * (C01, -c01.12) Lauro, 28/10: "digitando…" entre as bolhas, o vídeo sem o texto do turno como legenda (os
 * parágrafos antes, a pergunta final depois) e a arte da página antes da bolha que tem o link.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { enviarComVideo, ordemComVideo } from '@/lib/agent-engine/agent/videos-nativos';
import { sendInBubbles } from '@/lib/agent-engine/agent/split-message';
import { arteAntesDoLink, politicaDeImagens, politicaValida, type ImagemPreparada } from '@/lib/agent-engine/agent/c01-imagens';

const ok = (id: string) => ({ kind: 'sent', messageId: id });

describe('vídeo entre as bolhas', () => {
  it('todas as bolhas menos a última, o vídeo e a última; com uma só, ela vai antes', () => {
    expect(ordemComVideo(['P1', 'P2', 'pergunta'])).toEqual(['P1', 'P2', null, 'pergunta']);
    expect(ordemComVideo(['só'])).toEqual(['só', null]);
    expect(ordemComVideo([])).toEqual([null]);
  });
  it('manda na ordem, com pausa antes de cada uma menos a primeira, e o vídeo sem legenda', async () => {
    const saida: string[] = [];
    const pausas: Array<string | null> = [];
    await enviarComVideo(['P1', 'P2', 'pergunta'], {
      enviarTexto: async (b) => { saida.push(b); return ok(b); },
      enviarVideo: async () => { saida.push('[vídeo]'); return ok('v'); },
      pausa: async (p) => { pausas.push(p); },
    });
    expect(saida).toEqual(['P1', 'P2', '[vídeo]', 'pergunta']);
    expect(pausas).toEqual(['P2', null, 'pergunta']);
  });
  it('para no primeiro desfecho que não é de sucesso', async () => {
    const saida: string[] = [];
    const r = await enviarComVideo(['P1', 'pergunta'], {
      enviarTexto: async (b) => { saida.push(b); return ok(b); },
      enviarVideo: async () => ({ kind: 'blocked' }),
      pausa: async () => {},
    });
    expect(r.kind).toBe('blocked');
    expect(saida).toEqual(['P1']);
  });
});

describe('pausa e gancho entre as bolhas', () => {
  it('`entreBolhas` substitui o jitter e recebe a próxima bolha; `antesDaBolha` manda antes dela', async () => {
    const eventos: string[] = [];
    const sleep = vi.fn(async () => {});
    await sendInBubbles('A\n\nB com https://pay.exemplo/x\n\nC', {
      enabled: true, maxChars: 600, sleep, jitter: () => 1,
      send: async (b) => { eventos.push(`texto:${b.slice(0, 1)}`); return ok(b); },
      entreBolhas: async (p) => { eventos.push(`digitando:${p.slice(0, 1)}`); },
      antesDaBolha: async (b) => {
        if (!b.includes('https://')) return null;
        eventos.push('arte');
        return ok('arte');
      },
    });
    expect(eventos).toEqual(['texto:A', 'digitando:B', 'arte', 'texto:B', 'digitando:C', 'texto:C']);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('sem os ganchos, o jitter de sempre entre as bolhas', async () => {
    const sleep = vi.fn(async () => {});
    await sendInBubbles('A\n\nB', { enabled: true, maxChars: 600, sleep, jitter: () => 7, send: async (b) => ok(b) });
    expect(sleep).toHaveBeenCalledWith(7);
  });
  it('a arte bloqueada para a resposta antes da bolha do link', async () => {
    const enviadas: string[] = [];
    const r = await sendInBubbles('A\n\nlink https://pay.exemplo/x', {
      enabled: true, maxChars: 600, sleep: async () => {}, jitter: () => 0,
      send: async (b) => { enviadas.push(b); return ok(b); },
      antesDaBolha: async (b) => (b.includes('https://') ? { kind: 'blocked' } : null),
    });
    expect(r.kind).toBe('blocked');
    expect(enviadas).toEqual(['A']);
  });
});

describe('arte antes do link', () => {
  const item = {
    key: 'vitalicio-pagina', version: 1, sha256: 'a'.repeat(64), mime: 'image/png', bytes: 10, width: 941, height: 1672,
    triggers: ['pagina_de_pagamento'], frequency: 'primeira_vez',
    plans: ['pb-tp-vitalicio-tecnico'], description: 'Arte do Vitalício, sem preço.',
  };
  const politica = (position: string) => ({
    enabled: true, audience: 'todos', connectionId: '00000000-0000-4000-8000-000000000001', testPhones: [],
    items: [{ ...item, position }],
  });
  it('a política aceita `antes_do_link` e continua recusando posição desconhecida', () => {
    expect(politicaValida(politica('antes_do_link'))).toBe(true);
    expect(politicaValida(politica('antes_do_texto'))).toBe(true);
    expect(politicaValida(politica('depois_do_texto'))).toBe(false);
    expect(politicaDeImagens(politica('antes_do_link')).items[0]!.position).toBe('antes_do_link');
  });
  const preparada = (position?: 'antes_do_texto' | 'antes_do_link'): ImagemPreparada => ({
    imagem: { key: 'k', version: 1, sha256: 'a'.repeat(64), description: 'd', media: { storagePath: 'o/c/imagem-k.png', mime: 'image/png' }, ...(position ? { position } : {}) },
    links: ['https://pay.exemplo/x'],
  });
  it('só com a posição nova e o link no texto final', () => {
    expect(arteAntesDoLink(preparada('antes_do_link'), 'preço\n\nhttps://pay.exemplo/x')).toBe(true);
    expect(arteAntesDoLink(preparada('antes_do_link'), 'preço sem link')).toBe(false);
    expect(arteAntesDoLink(preparada('antes_do_texto'), 'https://pay.exemplo/x')).toBe(false);
    expect(arteAntesDoLink(preparada(), 'https://pay.exemplo/x')).toBe(false);
    expect(arteAntesDoLink(null, 'https://pay.exemplo/x')).toBe(false);
  });
});

describe('ligação no turno (âncoras de código)', () => {
  const TURNO = readFileSync('lib/agent-engine/agent/inbound-turn.ts', 'utf8');
  it('as bolhas comuns usam o "digitando" e a arte no link guarda a vaga dela no teto', () => {
    expect(TURNO).toContain('entreBolhas,\n');
    expect(TURNO).toContain("maxBubbles: Math.max(1, maxSendsPerTurn - seq - (arteNoLink ? 1 : 0)),");
    // a pausa entre as bolhas roda com a trava do número presa: fica no jitter (#654)
    expect(TURNO).toContain('await sleep(jitter());\n              };');
    expect(TURNO).not.toMatch(/entreBolhas[\s\S]{0,400}calcularAtrasoHumano/);
  });
  it('o vídeo novo ocupa uma vaga e o teto vale só para as bolhas novas', () => {
    expect(TURNO).toContain('aplicarTetoAsNovas(bolhasNaturais, registradas, Math.max(1, maxSendsPerTurn - seq - (videoConhecido ? 0 : 1)))');
  });
});
