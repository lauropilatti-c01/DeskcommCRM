import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  completarConsultaDaPagina, copiarImagemNoStorage, destinoNaConversa, enviarImagemAntes, escolherImagem,
  jaRecebeuNaConversa, lerPoliticaDeImagens, marcaDaImagemEnviada, paginasDaConsulta, politicaDeImagens, politicaValida,
  prepararImagem, telefoneE164, validarImagem, versaoDaTentativa, type ImagemEscolhida,
} from '@/lib/agent-engine/agent/c01-imagens';

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
      ligada({ previous: [item] }), ligada({ previous: [{ ...item, version: 2, sha256: shaV2 }, { ...item, version: 2, sha256: shaV2 }] })]) {
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
    expect(escolherImagem({ politica: politicaDeImagens(ligada()), paginas, corpo: LINK_TEC, telefone: '+5511999990000', enfaseDoCard: 'pb-sup' }))
      .toEqual({ item: null, motivo: 'card_contradiz_consulta' });
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
  const v1 = () => versaoDaTentativa(politica, politica.items[0]!, { tenantId: org, conversationId: conv }, async () => false);

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
    expect([retomada.version, retomada.sha256]).toEqual([1, shaPng]);
    const nova = await versaoDaTentativa(politicaV2, comV2, { tenantId: org, conversationId: conv }, async () => false);
    expect(nova.version).toBe(2);
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
  const politica = politicaDeImagens(ligada({ items: [{ ...item, version: 2, sha256: shaV2, description: 'Arte v2' }],
    previous: [{ ...item, description: 'Arte v1' }] }));
  const caminho = (sha: string) => `${org}/${conv}/imagem-vitalicio-pagina-${sha}.png`;
  it('caso 14: descreve a versão que saiu, com o estado; nunca como mídia do cliente', () => {
    expect(marcaDaImagemEnviada({ direction: 'outbound', media_storage_path: caminho(shaPng), status: 'delivered' }, politica))
      .toBe('[Você mandou esta imagem antes do link (imagem vitalicio-pagina, v1, entregue): Arte v1]');
    expect(marcaDaImagemEnviada({ direction: 'outbound', media_storage_path: caminho(shaV2), status: 'failed' }, politica)).toContain('v2, falhou');
    expect(marcaDaImagemEnviada({ direction: 'outbound', media_storage_path: caminho('c'.repeat(64)), status: 'sent' }, politica)).toContain('não está mais na biblioteca');
    expect(marcaDaImagemEnviada({ direction: 'inbound', media_storage_path: caminho(shaPng) }, politica)).toBeNull();
    expect(marcaDaImagemEnviada({ direction: 'outbound', media_storage_path: `${org}/${conv}/catalogo-x.png` }, politica)).toBeNull();
  });
});

describe('c01_imagens: ligação no histórico da Marina', () => {
  const caminho = `${org}/${conv}/imagem-vitalicio-pagina-${shaPng}.png`;
  const linha = (m: Record<string, unknown>) => ({ direction: 'outbound' as const, type: 'image', body: null, media_url: null,
    media_storage_path: caminho, media_mime: 'image/png', media_derived_text: null, sent_at: new Date('2026-10-27T15:00:00Z'), status: 'delivered', ...m });
  it('a imagem do atendimento vira a marca, mesmo com derivado; sem imagem, nem lê a política', async () => {
    const { marcarImagensDaBiblioteca, __test_fitToBudget } = await import('@/lib/agent-engine/edge/crm/get-lead-context');
    const db = { query: vi.fn(async () => ({ rows: [{ policy: ligada() }] })) };
    const marcadas = await marcarImagensDaBiblioteca(db as never, org, [linha({ media_derived_text: 'descrição automática' })]);
    const base = { lead_id: 'l1', contact: { name: 'x', phone: null, email: null, tags: [], is_blocked: false }, conversation_id: 'c1', last_human_decision: null };
    const corpo = __test_fitToBudget(base as never, marcadas as never, 100000, 'UTC').messages[0]!.body;
    expect(corpo).toBe('[Você mandou esta imagem antes do link (imagem vitalicio-pagina, v1, entregue): Arte do Vitalício, sem preço.]');
    expect(corpo).not.toContain('Mídia do cliente');
    const semImagem = { query: vi.fn() };
    await marcarImagensDaBiblioteca(semImagem as never, org, [linha({ direction: 'inbound' })]);
    expect(semImagem.query).not.toHaveBeenCalled();
  });
});

describe('c01_imagens: ligação no turno (âncoras de código)', () => {
  const TURNO = readFileSync('lib/agent-engine/agent/inbound-turn.ts', 'utf8');
  const PREVIA = readFileSync('lib/agent-engine/agent/preview.ts', 'utf8');
  it('a consulta à base desta resposta alimenta as páginas, pela conexão do contrato', () => {
    expect(TURNO).toMatch(/if \(imagensDaOrg\.enabled\) args\[0\] = completarConsultaDaPagina\(args\[0\]\)/);
    expect(TURNO).toMatch(/paginasDaResposta\.push\(\.\.\.paginasDaConsulta\(args\[0\], resultado, imagensDaOrg\.connectionId\)\)/);
  });
  it('a escolha e o preparo vêm antes do plano da retomada, fora da prévia, do vídeo e das fotos', () => {
    const escolha = TURNO.indexOf('const escolha = escolherImagem(');
    expect(escolha).toBeGreaterThan(0);
    expect(TURNO.lastIndexOf('if (imagensDaOrg.enabled && !preview && !videoNativo && fotosDoProduto.length === 0)', escolha)).toBeGreaterThan(0);
    expect(TURNO.indexOf('planejarRetomada(body, fotosDoProduto, videoNativo, imagemDaPagina?.media)')).toBeGreaterThan(escolha);
  });
  it('no envio, depois da cadeia, a imagem vai antes do texto e só se o link sobreviveu', () => {
    const imagem = TURNO.indexOf('const parou = await enviarImagemAntes(imagem, {');
    const texto = TURNO.indexOf('return enviarComFotos(finalBody, fotosDoProduto, {');
    expect(imagem).toBeGreaterThan(0);
    expect(texto).toBeGreaterThan(imagem);
    expect(TURNO.slice(imagem - 200, imagem)).toContain('linksDaImagem.some((u) => finalBody.includes(u))');
    expect(TURNO.slice(imagem, texto)).toContain('restantes: () => maxSendsPerTurn - seq');
  });
  it('a prévia só informa, sem copiar nem enviar', () => {
    expect(PREVIA).toMatch(/const imagem = previaDaImagem\?\.\(result\.body\)/);
    expect(TURNO).toMatch(/Nada foi copiado nem enviado/);
  });
});
