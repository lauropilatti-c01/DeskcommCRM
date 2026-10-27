import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  citaAlgumLink, completarConsultaDaPagina, copiarImagemNoStorage, destinoNaConversa, enfaseDoCard, enviarImagemAntes,
  enviarImagemDaPagina, escolherComCard, escolherImagem, jaRecebeuNaConversa, lerPoliticaDeImagens, marcaDaImagemEnviada, paginasDaConsulta,
  politicaDeImagens, politicaDoTurno, politicaValida, prepararImagem, prepararImagemDaResposta, retratoDoEnvio, telefoneE164, validarImagem,
  versaoDaTentativa, type ImagemEscolhida, type ImagemParaEnvio,
} from '@/lib/agent-engine/agent/c01-imagens';
import { corpoDoEnvio, type SendMessageInput } from '@/lib/agent-engine/edge/crm/send-message';

const { storage } = vi.hoisted(() => ({ storage: { download: vi.fn(), upload: vi.fn() } }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ storage: { from: () => storage } }) }));

const org = '11111111-1111-4111-8111-111111111111';
const conv = '22222222-2222-4222-8222-222222222222';
const conexao = '33333333-3333-4333-8333-333333333333';
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fixture')]);
const shaPng = createHash('sha256').update(png).digest('hex');
const shaV2 = 'b'.repeat(64);
const item = {
  key: 'vitalicio-pagina', version: 1, sha256: shaPng, mime: 'image/png', bytes: png.length, width: 941, height: 1672,
  triggers: ['pagina_de_pagamento'], position: 'antes_do_texto', frequency: 'sempre',
  plans: ['pb-tp-vitalicio-tecnico', 'pb-tp-vitalicio-superior'], description: 'Arte do Vitalício, sem preço.',
};
const ligada = (mudancas: Record<string, unknown> = {}) => ({
  enabled: true, audience: 'somente_celulares_de_teste', connectionId: conexao, testPhones: ['+5511999990000'], items: [item], ...mudancas,
});
const LINK_TEC = 'https://pay.exemplo/tecnico-vitalicio';
const LINK_12M = 'https://pay.exemplo/tecnico-12m';
const consulta = { tabela: 'agente_pagina', schema: 'c01', colunas: ['texto'], filtros: [{ coluna: 'enfase_id', operador: 'eq', valor: 'pb-tec' }] };
const resultado = (linhas: unknown[], extra: Record<string, unknown> = {}) => ({ structuredContent: { schema: 'c01', tabela: 'agente_pagina', conexao: { id: conexao }, linhas, ...extra } });
const linhas = [
  { enfase_id: 'pb-tec', plano_id: 'pb-tp-vitalicio-tecnico', pode_afirmar: true, link_cartao: LINK_TEC, link_sem_cartao: null },
  { enfase_id: 'pb-tec', plano_id: 'tp-12m-tecnico', pode_afirmar: true, link_cartao: LINK_12M },
];
const paginas = paginasDaConsulta(consulta, resultado(linhas), conexao);
const escolher = (corpo: string, mudancas: Record<string, unknown> = {}, telefone: string | null = '+5511999990000') =>
  escolherImagem({ politica: politicaDeImagens(ligada(mudancas)), paginas, corpo, telefone });

describe('c01_imagens: contrato da configuração', () => {
  it('ausente, inválida ou ligada sem os campos obrigatórios = desligada', () => {
    for (const raw of [null, {}, { ...ligada(), extra: 1 }, ligada({ connectionId: null }), ligada({ testPhones: [] }),
      ligada({ testPhones: ['11999990000'] }), ligada({ items: [{ ...item, plans: [] }] }), ligada({ items: [{ ...item, plans: ['a', 'a'] }] }),
      ligada({ items: [{ ...item, key: 'Com_Maiuscula' }] }), ligada({ items: [{ ...item, width: 4097 }] }), ligada({ items: [{ ...item, bytes: 5 * 1024 * 1024 + 1 }] }),
      ligada({ items: [{ ...item, mime: 'image/gif' }] }), ligada({ items: [{ ...item, description: 'x'.repeat(601) }] }),
      ligada({ items: [item, { ...item, key: 'outra' }] }), ligada({ items: [item, item] }), ligada({ items: [{ ...item, caminho: '/etc' }] }),
      ligada({ previous: [item] }), ligada({ previous: [{ ...item, version: 2, sha256: shaV2 }, { ...item, version: 2, sha256: shaV2 }] }),
      ligada({ items: [{ ...item, triggers: ['pagina_de_pagamento', 'pagina_de_pagamento'] }] }),
      ligada({ items: [{ ...item, plans: Array.from({ length: 101 }, (_, i) => `plano-${i}`) }] })]) {
      expect(politicaDeImagens(raw).enabled).toBe(false);
    }
  });
  it('desligada aceita null e listas vazias; público "todos" dispensa celulares', () => {
    expect(politicaDeImagens({ enabled: false, audience: 'todos', connectionId: null, testPhones: [], items: [] }).items).toEqual([]);
    expect(politicaDeImagens(ligada({ audience: 'todos', testPhones: [] })).enabled).toBe(true);
    // versão anterior pode repetir o plano da atual; nunca vira candidata a envio novo
    const comAnterior = politicaDeImagens(ligada({ items: [{ ...item, version: 2, sha256: shaV2 }], previous: [item] }));
    expect(comAnterior.enabled).toBe(true);
    expect(escolherImagem({ politica: comAnterior, paginas, corpo: LINK_TEC, telefone: '+5511999990000' }).item?.version).toBe(2);
    expect(politicaDeImagens(ligada()).previous).toBeUndefined();
  });
  it('lê só a organização do turno e falha fechada', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ policy: ligada() }] })) };
    expect((await lerPoliticaDeImagens(db as never, org)).enabled).toBe(true);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('where id = $1'), [org]);
    db.query.mockRejectedValueOnce(new Error('offline'));
    expect((await lerPoliticaDeImagens(db as never, org)).enabled).toBe(false);
  });
  const casos = process.env.C01_IMAGENS_CONTRATO_CASOS;
  it.skipIf(!casos || !existsSync(casos))('casos compartilhados do contrato (crm-agentico)', () => {
    const lista = JSON.parse(readFileSync(casos!, 'utf8')) as { name: string; valid: boolean; config: unknown }[];
    expect(lista.length).toBeGreaterThan(0);
    expect(lista.filter((c) => politicaValida(c.config) !== c.valid).map((c) => c.name)).toEqual([]);
  });
});

describe('c01_imagens: a página da consulta desta resposta é o gatilho', () => {
  it('completa as colunas só da agente_pagina', () => {
    expect((completarConsultaDaPagina(consulta) as { colunas: string[] }).colunas).toEqual(
      expect.arrayContaining(['texto', 'plano_id', 'enfase_id', 'pode_afirmar', 'link_cartao', 'link_sem_cartao']));
    const outra = { ...consulta, tabela: 'agente_videos' };
    expect(completarConsultaDaPagina(outra)).toBe(outra);
  });
  it('lê plano e links só da conexão aprovada, com pode_afirmar e uma ênfase', () => {
    expect(paginas).toEqual([
      { planoId: 'pb-tp-vitalicio-tecnico', enfaseId: 'pb-tec', urls: [LINK_TEC] },
      { planoId: 'tp-12m-tecnico', enfaseId: 'pb-tec', urls: [LINK_12M] },
    ]);
    expect(paginasDaConsulta(consulta, resultado(linhas, { conexao: { id: 'outra' } }), conexao)).toEqual([]);
    expect(paginasDaConsulta(consulta, resultado(linhas, { truncado: true }), conexao)).toEqual([]);
    expect(paginasDaConsulta(consulta, resultado([{ ...linhas[0], pode_afirmar: false }]), conexao)).toEqual([]);
    expect(paginasDaConsulta(consulta, resultado(linhas), null)).toEqual([]);
    expect(paginasDaConsulta({ ...consulta, filtros: [] }, resultado(linhas), conexao)).toEqual([]);
    const texto = { content: [{ type: 'text', text: JSON.stringify(resultado(linhas).structuredContent) }] };
    expect(paginasDaConsulta(consulta, texto, conexao)).toHaveLength(2);
  });
  it('casos 1, 3, 4, 6, 10 e 15: só a página de um plano da ficha, para o celular de teste', () => {
    expect(escolher(`Segue o link: ${LINK_TEC}`).item?.key).toBe('vitalicio-pagina');
    expect(escolher(`Segue o link: ${LINK_12M}`)).toEqual({ item: null, motivo: 'plano_sem_imagem' });
    expect(escolher('Veja o vídeo do curso: https://youtu.be/x')).toEqual({ item: null, motivo: 'sem_pagina' });
    expect(escolher('Paga aqui: https://pay.exemplo/inventado')).toEqual({ item: null, motivo: 'sem_pagina' });
    expect(escolher(LINK_TEC, { enabled: false })).toEqual({ item: null, motivo: 'desligada' });
    expect(escolher(LINK_TEC, {}, '+5511888880000')).toEqual({ item: null, motivo: 'fora_dos_celulares_de_teste' });
    expect(escolher(LINK_TEC, {}, null)).toEqual({ item: null, motivo: 'fora_dos_celulares_de_teste' });
    expect(escolher(LINK_TEC, { audience: 'todos', testPhones: [] }, null).item?.key).toBe('vitalicio-pagina');
  });
  it('caso 8: lado a lado com o anual ainda escolhe a do Vitalício; caso 7: card contradiz', () => {
    expect(escolher(`${LINK_TEC}\n${LINK_12M}`).item?.key).toBe('vitalicio-pagina');
    const comCard = (enfase: string | null | false) =>
      escolherImagem({ politica: politicaDeImagens(ligada()), paginas, corpo: LINK_TEC, telefone: '+5511999990000', enfaseDoCard: enfase });
    expect(comCard('pb-sup')).toEqual({ item: null, motivo: 'card_contradiz_consulta' });
    expect(comCard(false)).toEqual({ item: null, motivo: 'card_ilegivel' });
    expect(comCard('pb-tec').item?.key).toBe('vitalicio-pagina');
    expect(comCard(null).item?.key).toBe('vitalicio-pagina');
  });
  it('a ênfase do card vem de `produto_chave`; vazio ou outro tipo não contradiz', () => {
    expect(enfaseDoCard({ campos: { produto_chave: ' pb-sup ' } })).toBe('pb-sup');
    for (const campos of [{}, { produto_chave: '  ' }, { produto_chave: 7 }]) expect(enfaseDoCard({ campos })).toBeNull();
    expect(enfaseDoCard(null)).toBeNull();
  });
  it('link exato: sufixo, caminho a mais ou parâmetro não casam; pontuação final e barra final sim', () => {
    expect(escolher(`${LINK_TEC}-anual`)).toEqual({ item: null, motivo: 'sem_pagina' });
    expect(escolher(`${LINK_TEC}/outra`)).toEqual({ item: null, motivo: 'sem_pagina' });
    expect(escolher(`${LINK_TEC}?cupom=x`)).toEqual({ item: null, motivo: 'sem_pagina' });
    expect(escolher(`Segue: ${LINK_TEC}.`).item?.key).toBe('vitalicio-pagina');
    expect(citaAlgumLink(`${LINK_TEC}/`, [LINK_TEC])).toBe(true);
    expect(citaAlgumLink('sem link nenhum', [LINK_TEC])).toBe(false);
  });
  it('duas imagens diferentes citadas na mesma resposta: só texto', () => {
    const outra = { ...item, key: 'anual', plans: ['tp-12m-tecnico'] };
    expect(escolher(`${LINK_TEC} ${LINK_12M}`, { items: [item, outra] })).toEqual({ item: null, motivo: 'mais_de_uma_imagem' });
  });
  it('normaliza o telefone do contato', () => {
    expect(telefoneE164('55 (11) 99999-0000')).toBe('+5511999990000');
    expect(telefoneE164(null)).toBeNull();
  });
});

describe('c01_imagens: arquivo, versão e frequência', () => {
  const blob = (bytes: Buffer, type = 'image/png') => ({ size: bytes.length, type, arrayBuffer: async () => Uint8Array.from(bytes).buffer });
  const politica = politicaDeImagens(ligada());
  const v1 = () => versaoDaTentativa(politica, politica.items[0]!, { tenantId: org, conversationId: conv }, async () => false).then(r => r.imagem);

  it('valida assinatura, mime e hash; extensão não prova nada', () => {
    expect(validarImagem(png, 'image/png', shaPng)).toBe(true);
    expect(validarImagem(png, 'image/jpeg', shaPng)).toBe(false);
    expect(validarImagem(png, 'image/png', 'c'.repeat(64))).toBe(false);
    expect(validarImagem(Buffer.from('GIF89a-xx'), 'image/png', shaPng)).toBe(false);
  });
  it('caso 11: arquivo ausente ou com outro hash = não prepara (sai só o texto)', async () => {
    const escolhida = await v1();
    expect(escolhida.media.storagePath).toBe(`${org}/${conv}/imagem-vitalicio-pagina-${shaPng}.png`);
    storage.download.mockResolvedValueOnce({ data: null, error: { message: 'not found' } });
    expect(await prepararImagem(copiarImagemNoStorage(), { tenantId: org, conversationId: conv }, escolhida, politica))
      .toEqual({ ok: false, motivo: 'arquivo_indisponivel' });
    storage.download.mockResolvedValueOnce({ data: blob(Buffer.concat([png, Buffer.from('x')])), error: null });
    expect((await prepararImagem(copiarImagemNoStorage(), { tenantId: org, conversationId: conv }, escolhida, politica)).ok).toBe(false);
    expect(storage.upload).not.toHaveBeenCalled();
  });
  it('copia da biblioteca sem sobrescrever; conflito confere os bytes existentes', async () => {
    const escolhida = await v1();
    storage.download.mockResolvedValueOnce({ data: blob(png, 'application/octet-stream'), error: null });
    storage.upload.mockResolvedValueOnce({ error: null });
    expect(await prepararImagem(copiarImagemNoStorage(), { tenantId: org, conversationId: conv }, escolhida, politica)).toEqual({ ok: true });
    expect(storage.download).toHaveBeenLastCalledWith(`${org}/biblioteca-imagens/${shaPng}.png`);
    expect(storage.upload).toHaveBeenLastCalledWith(escolhida.media.storagePath, expect.anything(), { contentType: 'image/png', upsert: false });
    storage.download.mockResolvedValueOnce({ data: blob(png), error: null }).mockResolvedValueOnce({ data: blob(Buffer.from('outra')), error: null });
    storage.upload.mockResolvedValueOnce({ error: { message: 'The resource already exists', statusCode: '409' } });
    expect((await prepararImagem(copiarImagemNoStorage(), { tenantId: org, conversationId: conv }, escolhida, politica)).ok).toBe(false);
  });
  it('recusa ids que não são UUID antes de tocar o Storage', async () => {
    const copiar = vi.fn();
    expect(await prepararImagem(copiar, { tenantId: '../x', conversationId: conv }, await v1(), politica)).toEqual({ ok: false, motivo: 'destino_invalido' });
    expect(copiar).not.toHaveBeenCalled();
  });
  it('caso 13: v2 publicada entre duas tentativas, a retomada manda a v1 que o ledger conhece', async () => {
    const politicaV2 = politicaDeImagens(ligada({ items: [{ ...item, version: 2, sha256: shaV2 }], previous: [item] }));
    const comV2 = politicaV2.items[0]!;
    const caminhoV1 = destinoNaConversa(org, conv, item.key, { sha256: shaPng, mime: 'image/png' });
    const retomada = await versaoDaTentativa(politicaV2, comV2, { tenantId: org, conversationId: conv }, async (m) => m.storagePath === caminhoV1);
    expect([retomada.imagem.version, retomada.imagem.sha256, retomada.conhecida]).toEqual([1, shaPng, true]);
    const nova = await versaoDaTentativa(politicaV2, comV2, { tenantId: org, conversationId: conv }, async () => false);
    expect([nova.imagem.version, nova.conhecida]).toEqual([2, false]);
  });
  it('caso 5 com primeira_vez: procura a imagem em qualquer versão na conversa inteira', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ '?column?': 1 }] })) };
    expect(await jaRecebeuNaConversa(db as never, { tenantId: org, conversationId: conv }, 'vitalicio-pagina')).toBe(true);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("direction = 'outbound'"), [org, conv, `${org}/${conv}/imagem-vitalicio-pagina-%`]);
  });
});

describe('c01_imagens: ordem, teto e desfechos', () => {
  const imagem: ImagemEscolhida = { key: 'vitalicio-pagina', version: 1, sha256: shaPng, description: 'd',
    media: { storagePath: `${org}/${conv}/imagem-vitalicio-pagina-${shaPng}.png`, mime: 'image/png' } };
  const roteiro = async (restantes: number, bolhas: number, kindImagem = 'sent', conhecida = false) => {
    const ordem: string[] = [];
    const registros: string[] = [];
    const parou = await enviarImagemAntes(imagem, {
      restantes: () => restantes, bolhasDoTexto: bolhas, jaRegistrada: async () => conhecida,
      enviarImagem: async () => { ordem.push('imagem'); return { kind: kindImagem }; },
      sleep: async () => { ordem.push('pausa'); }, jitter: () => 1, registrar: (d) => registros.push(d),
    });
    if (!parou) ordem.push('texto'); // o turno segue com o texto, pelo caminho de sempre
    return { r: parou ?? { kind: 'sent' }, ordem, registros };
  };
  it('caso 1: imagem, pausa anti-ban e depois o texto', async () => {
    expect(await roteiro(3, 2)).toEqual({ r: { kind: 'sent' }, ordem: ['imagem', 'pausa', 'texto'], registros: ['enviada'] });
  });
  it('casos 8 e 9: sem vaga para a imagem e todas as bolhas, só o texto, com registro', async () => {
    expect(await roteiro(2, 2)).toEqual({ r: { kind: 'sent' }, ordem: ['texto'], registros: ['sem_vaga'] });
    expect(await roteiro(0, 1)).toMatchObject({ ordem: ['texto'], registros: ['sem_vaga'] });
  });
  it('caso 12: a imagem já registrada no job é retomada mesmo com o teto cheio', async () => {
    expect((await roteiro(1, 1, 'already_sent', true)).ordem).toEqual(['imagem', 'pausa', 'texto']);
  });
  it('bloqueio ou canal fora param tudo; falha registrada da imagem não segura a página', async () => {
    expect(await roteiro(3, 1, 'blocked')).toMatchObject({ r: { kind: 'blocked' }, ordem: ['imagem'] });
    expect(await roteiro(3, 1, 'unavailable')).toMatchObject({ r: { kind: 'unavailable' }, ordem: ['imagem'] });
    expect(await roteiro(3, 1, 'failed')).toMatchObject({ ordem: ['imagem', 'pausa', 'texto'], registros: ['falhou'] });
  });
});

describe('c01_imagens: histórico da Marina', () => {
  const caminho = (sha: string) => `${org}/${conv}/imagem-vitalicio-pagina-${sha}.png`;
  const retrato = (m: Record<string, unknown> = {}) => ({ key: 'vitalicio-pagina', version: 1, sha256: shaPng, description: 'Arte v1', ...m });
  const linha = (sha: string, c01_imagem: unknown, status = 'delivered') =>
    ({ direction: 'outbound', media_storage_path: caminho(sha), status, c01_imagem });
  it('caso 14: descreve a versão gravada no envio, com o estado; nunca como mídia do cliente', () => {
    expect(marcaDaImagemEnviada(linha(shaPng, retrato())))
      .toBe('[Você mandou esta imagem antes do link (imagem vitalicio-pagina, v1, entregue): Arte v1]');
    expect(marcaDaImagemEnviada(linha(shaV2, retrato({ version: 2, sha256: shaV2 }), 'failed'))).toContain('v2, falhou');
    expect(marcaDaImagemEnviada({ direction: 'inbound', media_storage_path: caminho(shaPng), c01_imagem: retrato() })).toBeNull();
    expect(marcaDaImagemEnviada({ direction: 'outbound', media_storage_path: `${org}/${conv}/catalogo-x.png` })).toBeNull();
  });
  it('retrato ausente, malformado ou de outra imagem = sem descrição', () => {
    for (const r of [undefined, null, 'texto', retrato({ sha256: shaV2 }), retrato({ key: 'outra' }), retrato({ description: ' ' }),
      retrato({ description: 'x'.repeat(601) }), { ...retrato(), extra: 1 }]) {
      expect(marcaDaImagemEnviada(linha(shaPng, r, 'sent'))).toBe('[Você mandou a imagem vitalicio-pagina antes do link (aceita); a descrição desta versão não ficou registrada.]');
    }
  });
});

describe('c01_imagens: ligação no histórico da Marina', () => {
  const caminho = `${org}/${conv}/imagem-vitalicio-pagina-${shaPng}.png`;
  const linha = (m: Record<string, unknown>) => ({ direction: 'outbound' as const, type: 'image', body: null, media_url: null,
    media_storage_path: caminho, media_mime: 'image/png', media_derived_text: null, sent_at: new Date('2026-10-27T15:00:00Z'), status: 'delivered', ...m });
  it('a imagem do atendimento vira a marca, mesmo com derivado, e a consulta lê o retrato da mensagem', async () => {
    const { marcarImagensDaBiblioteca, __test_fitToBudget } = await import('@/lib/agent-engine/edge/crm/get-lead-context');
    const marcadas = marcarImagensDaBiblioteca([linha({ media_derived_text: 'descrição automática',
      c01_imagem: { key: 'vitalicio-pagina', version: 1, sha256: shaPng, description: 'Arte do Vitalício, sem preço.' } })]);
    const base = { lead_id: 'l1', contact: { name: 'x', phone: null, email: null, tags: [], is_blocked: false }, conversation_id: 'c1', last_human_decision: null };
    const corpo = __test_fitToBudget(base as never, marcadas as never, 100000, 'UTC').messages[0]!.body;
    expect(corpo).toBe('[Você mandou esta imagem antes do link (imagem vitalicio-pagina, v1, entregue): Arte do Vitalício, sem preço.]');
    expect(corpo).not.toContain('Mídia do cliente');
    expect(readFileSync('lib/agent-engine/edge/crm/get-lead-context.ts', 'utf8')).toContain("metadata -> 'c01_imagem' as c01_imagem");
  });
});

/**
 * Costura da ligação do turno com dublês (consulta, card, Storage, ledger e canal): consulta à base →
 * escolha e preparo → cadeia (simulada: o texto final) → imagem e texto pelo canal → linha gravada
 * com `corpoDoEnvio` → histórico. Não roda `runAgentTurn` (modelo, MCP e Postgres reais ficam de
 * fora: o harness de turno inteiro pede Postgres); prova as duas funções que o turno chama e a
 * passagem do retrato até o histórico. A ordem das chamadas no turno fica nas âncoras abaixo.
 */
describe('c01_imagens: costura do turno com dublês', () => {
  type Linha = { body: string; media_storage_path: string | null; metadata: Record<string, unknown> };
  function mundo(o: { incertaNaImagem?: boolean } = {}) {
    const gravadas: Linha[] = [];
    const ledger = new Map<string, 'requested' | 'sent'>();
    let incerta = o.incertaNaImagem ?? false;
    const id = (corpo: string, media?: ImagemParaEnvio) => `${corpo}|${media?.storagePath ?? ''}`;
    const copias: string[] = [];
    const copiar = async (origem: string, destino: string) => { copias.push(`${origem}>${destino}`); return true; };
    // O canal do turno: o `enviar` do turno junta o retrato (`retratoDoEnvio`) e o handler grava `corpoDoEnvio`.
    const canal = (preparada: Awaited<ReturnType<typeof prepararImagemDaResposta>>) => async (corpo: string, media?: ImagemParaEnvio) => {
      const k = id(corpo, media);
      if (ledger.get(k) === 'sent') return { kind: 'already_sent' as const };
      ledger.set(k, 'requested');
      const envio = { tenantId: org, leadId: 'contato', jobId: 'job', seq: 1, conversationId: conv, body: corpo,
        ...(media ? { media } : {}), ...retratoDoEnvio(preparada, media) } as SendMessageInput;
      const c = corpoDoEnvio(envio, k) as { metadata: Record<string, unknown>; media_storage_path?: string };
      gravadas.push({ body: corpo, media_storage_path: c.media_storage_path ?? null, metadata: c.metadata });
      ledger.set(k, 'sent');
      if (media && incerta) { incerta = false; throw new Error('handler de envio indisponível'); } // aceitou, mas a resposta se perdeu
      return { kind: 'sent' as const };
    };
    return { gravadas, ledger, copias, copiar, canal, conhecido: async (media: ImagemParaEnvio) => ledger.has(id('', media)) };
  }
  const resultadoDaBase = resultado(linhas);
  async function turno(m: ReturnType<typeof mundo>, o: {
    textoFinal?: string; teto?: number; politica?: ReturnType<typeof politicaDeImagens>;
    jaRecebeu?: () => Promise<boolean>; copiar?: typeof m.copiar; lerEnfaseDoCard?: () => Promise<string | null | false>;
  } = {}) {
    const corpo = `Segue a página do Vitalício: ${LINK_TEC}`;
    const politica = o.politica ?? politicaDeImagens(ligada());
    const pags = paginasDaConsulta(completarConsultaDaPagina(consulta), resultadoDaBase, politica.connectionId);
    const logs: string[] = [];
    const preparada = await prepararImagemDaResposta({
      politica, paginas: pags, corpo, telefone: '+5511999990000', lerEnfaseDoCard: o.lerEnfaseDoCard ?? (async () => 'pb-tec'),
      ids: { tenantId: org, conversationId: conv }, jaRecebeu: o.jaRecebeu ?? (async () => false), jaNoJob: m.conhecido,
      copiar: o.copiar ?? m.copiar, log: (msg, e) => logs.push(`${msg}:${String(e.motivo)}`),
    });
    const enviar = m.canal(preparada);
    const textoFinal = o.textoFinal ?? corpo;
    let seq = 0;
    const parou = await enviarImagemDaPagina(preparada, textoFinal, {
      restantes: () => (o.teto ?? 3) - seq, bolhasDoTexto: 1, conhecido: m.conhecido,
      enviar: async (c, media) => { seq++; return enviar(c, media); },
      sleep: async () => {}, jitter: () => 0, registrar: (d) => logs.push(`imagem: ${d}`),
    });
    if (parou) return { parou, logs };
    seq++; await enviar(textoFinal);
    return { parou, logs };
  }

  it('caminho feliz: imagem sem legenda, depois o texto; o retrato vai à linha e o histórico descreve', async () => {
    const m = mundo();
    await turno(m);
    expect(m.copias).toEqual([`${org}/biblioteca-imagens/${shaPng}.png>${destinoNaConversa(org, conv, 'vitalicio-pagina', item as never)}`]);
    expect(m.gravadas.map(l => [l.body, l.media_storage_path])).toEqual([['', destinoNaConversa(org, conv, 'vitalicio-pagina', item as never)], [`Segue a página do Vitalício: ${LINK_TEC}`, null]]);
    expect(m.gravadas[0]!.metadata.c01_imagem).toEqual({ key: 'vitalicio-pagina', version: 1, sha256: shaPng, description: item.description });
    expect(m.gravadas[1]!.metadata).not.toHaveProperty('c01_imagem');
    expect(marcaDaImagemEnviada({ direction: 'outbound', media_storage_path: m.gravadas[0]!.media_storage_path, status: 'sent', c01_imagem: m.gravadas[0]!.metadata.c01_imagem }))
      .toBe(`[Você mandou esta imagem antes do link (imagem vitalicio-pagina, v1, aceita): ${item.description}]`);
  });
  it('a cadeia tirou o link do texto final: sai só o texto, sem imagem', async () => {
    const m = mundo();
    await turno(m, { textoFinal: 'Já te mando a página certinha.' });
    expect(m.gravadas.map(l => l.media_storage_path)).toEqual([null]);
  });
  it('a cadeia trocou o link por um parecido (sufixo): só o texto', async () => {
    const m = mundo();
    await turno(m, { textoFinal: `Segue: ${LINK_TEC}-anual` });
    expect(m.gravadas.map(l => l.media_storage_path)).toEqual([null]);
  });
  it('teto sem vaga para imagem e texto: sai só o texto, o teto não muda', async () => {
    const m = mundo();
    const r = await turno(m, { teto: 1 });
    expect(r.logs).toContain('imagem: sem_vaga');
    expect(m.gravadas.map(l => l.media_storage_path)).toEqual([null]);
  });
  it('retry incerto: a imagem foi aceita e a resposta se perdeu; a re-execução não repete e manda a mesma versão, mesmo com a v2 publicada', async () => {
    const m = mundo({ incertaNaImagem: true });
    await expect(turno(m)).rejects.toThrow('indisponível');
    expect(m.gravadas).toHaveLength(1);
    const v2 = politicaDeImagens(ligada({ items: [{ ...item, version: 2, sha256: shaV2 }], previous: [item] }));
    const r = await turno(m, { teto: 1, politica: v2 });
    expect(r.logs).not.toContain('imagem: sem_vaga');
    // a imagem já conhecida não gasta envio novo nem troca de versão; só o texto é gravado de novo
    expect(m.gravadas.map(l => l.media_storage_path)).toEqual([destinoNaConversa(org, conv, 'vitalicio-pagina', item as never), null]);
    expect(m.copias.at(-1)).toContain(`${shaPng}.png`);
  });
  it('retry com recibo pendente e primeira_vez: a linha da própria tentativa não barra; vai a mesma identidade ao ledger', async () => {
    const m = mundo();
    const primeira = politicaDeImagens(ligada({ items: [{ ...item, frequency: 'primeira_vez' }] }));
    const caminhoV1 = destinoNaConversa(org, conv, 'vitalicio-pagina', item as never);
    m.ledger.set(`|${caminhoV1}`, 'requested'); // a execução anterior registrou a imagem e caiu antes da resposta
    const jaRecebeu = vi.fn(async () => true); // a linha 'queued' daquela tentativa já está na conversa
    const r = await turno(m, { politica: primeira, jaRecebeu });
    expect(jaRecebeu).not.toHaveBeenCalled();
    expect(r.logs.some(l => l.includes('ja_recebeu'))).toBe(false);
    expect(m.gravadas.map(l => l.media_storage_path)).toEqual([caminhoV1, null]);
    // sem tentativa anterior, a mesma conversa barra pela primeira_vez
    const outra = mundo();
    expect((await turno(outra, { politica: primeira, jaRecebeu: async () => true })).logs).toContain('imagem da página não vai:ja_recebeu');
    expect(outra.gravadas.map(l => l.media_storage_path)).toEqual([null]);
  });
  it('retry com a origem sumida do Storage: identidade conhecida não copia de novo e não vira só texto', async () => {
    const m = mundo();
    const caminhoV1 = destinoNaConversa(org, conv, 'vitalicio-pagina', item as never);
    m.ledger.set(`|${caminhoV1}`, 'requested');
    const copiar = vi.fn(async () => false);
    await turno(m, { copiar });
    expect(copiar).not.toHaveBeenCalled();
    expect(m.gravadas.map(l => l.media_storage_path)).toEqual([caminhoV1, null]);
    // sem tentativa anterior, a mesma origem sumida = só texto
    const nova = mundo();
    expect((await turno(nova, { copiar })).logs).toContain('imagem da página não vai:arquivo_indisponivel');
    expect(nova.gravadas.map(l => l.media_storage_path)).toEqual([null]);
  });
  it('card mudado no próprio turno (update_lead_field): a escolha lê o card na hora do preparo', async () => {
    const card = { produto_chave: 'pb-tec' as string };
    const lerEnfaseDoCard = vi.fn(async () => enfaseDoCard({ campos: card }));
    card.produto_chave = 'pb-sup'; // a Marina gravou outra ênfase antes do send_message
    const m = mundo();
    const r = await turno(m, { lerEnfaseDoCard });
    expect(r.logs).toContain('imagem da página não vai:card_contradiz_consulta');
    expect(m.gravadas.map(l => l.media_storage_path)).toEqual([null]);
    // sem página citada, nem lê o card
    const nunca = vi.fn(async () => 'pb-tec');
    expect(await escolherComCard({ politica: politicaDeImagens(ligada()), paginas, corpo: 'sem link', telefone: '+5511999990000', lerEnfaseDoCard: nunca }))
      .toEqual({ item: null, motivo: 'sem_pagina' });
    expect(nunca).not.toHaveBeenCalled();
    expect((await escolherComCard({ politica: politicaDeImagens(ligada()), paginas, corpo: LINK_TEC, telefone: '+5511999990000',
      lerEnfaseDoCard: async () => { throw new Error('banco fora'); } })).item).toBeNull();
  });
  it('acompanhamento automático (followup_turn) com link elegível: o texto sai igual, nenhuma imagem copiada nem enviada', async () => {
    const { eTurnoDeResposta } = await import('@/lib/agent-engine/agent/inbound-turn');
    const ler = vi.fn(async () => politicaDeImagens(ligada()));
    const doTurno = (kind: string, preview = false) => politicaDoTurno({ resposta: eTurnoDeResposta({ kind } as never), preview }, ler);
    const followup = await doTurno('followup_turn');
    expect(followup.enabled).toBe(false);
    expect(ler).not.toHaveBeenCalled();
    const m = mundo();
    await turno(m, { politica: followup });
    expect(m.copias).toEqual([]);
    expect(m.gravadas.map(l => [l.body, l.media_storage_path])).toEqual([[`Segue a página do Vitalício: ${LINK_TEC}`, null]]);
    expect((await doTurno('inbound_turn')).enabled).toBe(true);
    expect((await doTurno('case_reply_turn')).enabled).toBe(true);
    expect((await doTurno('followup_turn', true)).enabled).toBe(true); // a prévia continua simulável
  });
  it('ficha que cai num guarda (card contradiz, desligada): nada copiado, nada enviado além do texto', async () => {
    const m = mundo();
    const p = await prepararImagemDaResposta({
      politica: politicaDeImagens(ligada()), paginas: paginasDaConsulta(consulta, resultadoDaBase, conexao), corpo: LINK_TEC,
      telefone: '+5511999990000', lerEnfaseDoCard: async () => 'pb-sup', ids: { tenantId: org, conversationId: conv },
      jaRecebeu: async () => false, jaNoJob: m.conhecido, copiar: m.copiar, log: () => {},
    });
    expect(p).toBeNull();
    expect(m.copias).toEqual([]);
    expect(await enviarImagemDaPagina(p, LINK_TEC, { restantes: () => 3, bolhasDoTexto: 1, conhecido: m.conhecido,
      enviar: m.canal(p), sleep: async () => {}, jitter: () => 0, registrar: () => {} })).toBeNull();
    expect(m.gravadas).toEqual([]);
  });
});

describe('c01_imagens: ligação no turno (âncoras de código)', () => {
  const TURNO = readFileSync('lib/agent-engine/agent/inbound-turn.ts', 'utf8');
  const PREVIA = readFileSync('lib/agent-engine/agent/preview.ts', 'utf8');
  it('a política só vale no turno de resposta e na prévia (fora o acompanhamento automático)', () => {
    expect(TURNO).toContain(`const imagensDaOrg = await politicaDoTurno(
    { resposta: eTurnoDeResposta(liveJob()), preview: preview !== undefined },
    () => lerPoliticaDeImagens(pool, tenantId),
  );`);
    expect(TURNO.match(/lerPoliticaDeImagens\(/g)).toHaveLength(1);
  });
  it('a consulta à base desta resposta alimenta as páginas, pela conexão do contrato', () => {
    expect(TURNO).toMatch(/if \(imagensDaOrg\.enabled\) args\[0\] = completarConsultaDaPagina\(args\[0\]\)/);
    expect(TURNO).toMatch(/paginasDaResposta\.push\(\.\.\.paginasDaConsulta\(args\[0\], resultado, imagensDaOrg\.connectionId\)\)/);
  });
  it('a escolha e o preparo vêm antes do plano da retomada, fora da prévia, do vídeo e das fotos', () => {
    const escolha = TURNO.indexOf('imagemDaPagina = await prepararImagemDaResposta({');
    expect(escolha).toBeGreaterThan(0);
    expect(TURNO.lastIndexOf('if (imagensDaOrg.enabled && !preview && !videoNativo && fotosDoProduto.length === 0)', escolha)).toBeGreaterThan(0);
    expect(TURNO.indexOf('planejarRetomada(body, fotosDoProduto, videoNativo, imagemDaPagina?.imagem.media)')).toBeGreaterThan(escolha);
  });
  it('no envio, depois da cadeia, a imagem vai antes do texto e só se o link sobreviveu', () => {
    const imagem = TURNO.indexOf('const parou = await enviarImagemDaPagina(imagemDaPagina, finalBody, {');
    const texto = TURNO.indexOf('return enviarComFotos(finalBody, fotosDoProduto, {');
    expect(imagem).toBeGreaterThan(0);
    expect(texto).toBeGreaterThan(imagem);
    expect(TURNO.slice(imagem, texto)).toContain('restantes: () => maxSendsPerTurn - seq');
    expect(TURNO).toContain('...retratoDoEnvio(imagemDaPagina, media),');
  });
  it('a ênfase do card entra na escolha do envio e da prévia; card ilegível fecha', () => {
    expect(TURNO).toContain('lerCardDoContato(pool, tenantId, leadId).then(enfaseDoCard, () => false as const)');
    expect(TURNO).toContain('lerEnfaseDoCard, ids,');
    expect(TURNO).toContain('await escolherComCard({ politica: imagensDaOrg, paginas: paginasDaResposta, corpo, telefone: telefoneDoContato, lerEnfaseDoCard })');
  });
  it('a prévia só informa, sem copiar nem enviar', () => {
    expect(PREVIA).toMatch(/const imagem = await previaDaImagem\?\.\(result\.body\)/);
    expect(TURNO).toMatch(/Nada foi copiado nem enviado/);
  });
});
