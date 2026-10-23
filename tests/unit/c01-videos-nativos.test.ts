import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { classificarMidiaComLegenda } from '@/lib/messaging/media/midia-com-legenda';
import { corpoDoEnvio } from '@/lib/agent-engine/edge/crm/send-message';
import { hashDoConteudo, sendWithLedger } from '@/lib/agent-engine/edge/crm/send-ledger';
import { copiarVideoNoStorage, enviarVideoComLegenda, IDENTIDADE_DA_LEGENDA_DO_VIDEO, lerPoliticaDeVideo, lerPoliticaDeVideoSupabase, prepararVideoNativo, validarVideoMp4 } from '@/lib/agent-engine/agent/videos-nativos';
import { AGENT_TOOL_DEFS } from '@/lib/agent-engine/agent/inbound-turn';
import { applyPreviewPolicy, newPreviewResult, type TurnPreview } from '@/lib/agent-engine/agent/preview';
import type { GateContext } from '@/lib/agent-engine/guardrails/before-send';
const { storage } = vi.hoisted(() => ({ storage: { download: vi.fn(), upload: vi.fn() } }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ storage: { from: () => storage } }) }));

const bytesMp4 = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 1, 109, 112, 52, 50]);
const shaMp4 = createHash('sha256').update(bytesMp4).digest('hex');
const blob = (bytes = bytesMp4, type = 'video/mp4') => ({ size: bytes.length, type, arrayBuffer: async () => Uint8Array.from(bytes).buffer });

const org = '11111111-1111-4111-8111-111111111111';
const conv = '22222222-2222-4222-8222-222222222222';
const digest = 'a'.repeat(64);
const config = { enabled: true, flow_mp4: false, catalog: [{ key: 'fixture', sha256: digest }] };
const banco = (policy: unknown) => ({ query: vi.fn(async () => ({ rows: [{ policy }] })) });
const fakeDb = (policy: unknown) => banco(policy) as unknown as Parameters<typeof lerPoliticaDeVideo>[0];

describe('vídeo nativo: autorização e preparo sem efeito de envio', () => {
  it('ausente, inválido ou desligado recusa sem copiar', async () => {
    for (const policy of [null, {}, { ...config, enabled: false }, { ...config, enabled: 'true' }]) {
      const copiar = vi.fn();
      const result = await prepararVideoNativo(fakeDb(policy), copiar, { tenantId: org, conversationId: conv, chave: 'fixture' });
      expect(result.ok).toBe(false);
      expect(copiar).not.toHaveBeenCalled();
    }
  });
  it('consulta apenas a organização recebida do turno e falha fechada se a leitura falhar', async () => {
    const db = banco(config);
    await lerPoliticaDeVideo(db as unknown as Parameters<typeof lerPoliticaDeVideo>[0], org);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('where id = $1'), [org]);
    db.query.mockRejectedValueOnce(new Error('offline'));
    expect((await lerPoliticaDeVideo(db as unknown as Parameters<typeof lerPoliticaDeVideo>[0], org)).enabled).toBe(false);
  });
  it('chave desconhecida não aceita URL nem caminho informado pelo modelo', async () => {
    for (const chave of ['outra', 'https://fora.invalid/video.mp4', '../outro/video']) {
      const copiar = vi.fn();
      expect((await prepararVideoNativo(fakeDb(config), copiar, { tenantId: org, conversationId: conv, chave })).ok).toBe(false);
      expect(copiar).not.toHaveBeenCalled();
    }
  });
  it('duas chaves do mesmo arquivo produzem exatamente a mesma identidade de mídia', async () => {
    const db = fakeDb({ ...config, catalog: [...config.catalog, { key: 'alias', sha256: digest }] });
    const copiar = vi.fn(async () => true);
    const results = await Promise.all(['fixture', 'alias'].map(chave => prepararVideoNativo(db, copiar, { tenantId: org, conversationId: conv, chave })));
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({ ok: true, media: { storagePath: `${org}/${conv}/video-${digest}.mp4`, mime: 'video/mp4', type: 'video' } });
    expect(copiar).toHaveBeenCalledWith(`${org}/native-videos/${digest}.mp4`, `${org}/${conv}/video-${digest}.mp4`, digest);
  });
  it('cópia recusada ou indisponível não é sucesso nem autoriza legenda sozinha', async () => {
    for (const copiar of [vi.fn(async () => false), vi.fn(async () => { throw new Error('storage'); })]) {
      expect((await prepararVideoNativo(fakeDb(config), copiar, { tenantId: org, conversationId: conv, chave: 'fixture' })).ok).toBe(false);
    }
  });
  it('configuração com chave repetida ou hash inválido fica OFF', async () => {
    for (const catalog of [[...config.catalog, ...config.catalog], [{ key: 'fixture', sha256: '../outra' }]]) {
      expect((await lerPoliticaDeVideo(fakeDb({ ...config, catalog }), org)).enabled).toBe(false);
    }
  });
  it('recusa traversal, organização como caminho e catálogo com origem estrangeira', async () => {
    const copiar = vi.fn();
    for (const input of [
      { tenantId: `${org}/..`, conversationId: conv, chave: 'fixture' },
      { tenantId: org, conversationId: `${conv}/../../outra`, chave: 'fixture' },
    ]) expect((await prepararVideoNativo(fakeDb(config), copiar, input)).ok).toBe(false);
    expect((await prepararVideoNativo(fakeDb({ ...config, catalog: [{ ...config.catalog[0], storagePath: 'outra-org/video.mp4' }] }), copiar,
      { tenantId: org, conversationId: conv, chave: 'fixture' })).ok).toBe(false);
    expect(copiar).not.toHaveBeenCalled();
  });
  it('mesma chave em outra organização não reutiliza o caminho da primeira', async () => {
    const outra = '33333333-3333-4333-8333-333333333333';
    const copiar = vi.fn(async () => true);
    await prepararVideoNativo(fakeDb(config), copiar, { tenantId: outra, conversationId: conv, chave: 'fixture' });
    expect(copiar).toHaveBeenCalledWith(`${outra}/native-videos/${digest}.mp4`, `${outra}/${conv}/video-${digest}.mp4`, digest);
  });
  it('valida MIME, cabeçalho MP4 e hash: não confia na extensão', () => {
    expect(validarVideoMp4(bytesMp4, 'video/mp4', shaMp4)).toBe(true);
    expect(validarVideoMp4(bytesMp4, 'image/png', shaMp4)).toBe(false);
    expect(validarVideoMp4(bytesMp4, 'video/mp4', digest)).toBe(false);
    const fake = Buffer.from('isto não é um vídeo MP4');
    expect(validarVideoMp4(fake, 'video/mp4', createHash('sha256').update(fake).digest('hex'))).toBe(false);
    const mov = Buffer.from(bytesMp4); mov.write('qt  ', 8, 'ascii');
    expect(validarVideoMp4(mov, 'video/mp4', createHash('sha256').update(mov).digest('hex'))).toBe(false);
  });
  it('cópia real valida bytes antes do upload e confere o destino em conflito', async () => {
    storage.download.mockReset(); storage.upload.mockReset();
    storage.download.mockResolvedValue({ data: blob(), error: null });
    storage.upload.mockResolvedValue({ error: null });
    const copiar = copiarVideoNoStorage();
    expect(await copiar('origem', 'destino', shaMp4)).toBe(true);
    expect(storage.upload).toHaveBeenCalledWith('destino', expect.any(Uint8Array), { contentType: 'video/mp4', upsert: false });
    storage.upload.mockClear();
    expect(await copiar('origem', 'destino', digest)).toBe(false);
    expect(storage.upload).not.toHaveBeenCalled();
    storage.upload.mockResolvedValue({ error: { statusCode: '409', message: 'Duplicate' } });
    storage.download.mockResolvedValueOnce({ data: blob(), error: null }).mockResolvedValueOnce({ data: blob(Buffer.from('arquivo alterado')), error: null });
    expect(await copiar('origem', 'destino', shaMp4)).toBe(false);
    storage.download.mockResolvedValue({ data: blob(), error: null });
    expect(await copiar('origem', 'destino', shaMp4)).toBe(true);
  });
});

describe('vídeo e legenda: uma única mensagem pelo caminho comum', () => {
  const media = { storagePath: `${org}/${conv}/video-${digest}.mp4`, mime: 'video/mp4' as const, type: 'video' as const };
  it('o corpo do handler conserva vídeo privado e legenda, sem URL assinada no ledger', () => {
    const input = { tenantId: org, leadId: null, jobId: 'job', seq: 1, conversationId: conv, body: 'Legenda fixture.', media };
    expect(corpoDoEnvio(input, 'receipt')).toMatchObject({ type: 'video', media_storage_path: media.storagePath, body: input.body });
    expect(corpoDoEnvio(input, 'receipt')).not.toHaveProperty('media_url');
    expect(hashDoConteudo(input)).not.toBe(hashDoConteudo({ body: input.body }));
  });
  it('legenda que não cabe recusa sem criar uma mensagem de texto separada', async () => {
    const enviar = vi.fn();
    expect((await enviarVideoComLegenda('x'.repeat(1025), media, enviar)).kind).toBe('unavailable');
    expect(enviar).not.toHaveBeenCalled();
  });
  it('envia uma vez e preserva falha, fila, bloqueio e recibo incerto', async () => {
    for (const kind of ['sent', 'queued', 'failed', 'blocked', 'unavailable'] as const) {
      const outcome = kind === 'unavailable' ? { kind, reason: 'fixture' } : kind === 'blocked' ? { kind, idempotencyKey: 'key' } : { kind, idempotencyKey: 'key', messageId: 'msg' };
      const enviar = vi.fn(async () => outcome);
      expect(await enviarVideoComLegenda('Legenda.', media, enviar)).toEqual(outcome);
      expect(enviar).toHaveBeenCalledExactlyOnceWith('Legenda.', media);
    }
  });
  it('queda depois de o canal aceitar reconcilia o recibo sem reenviar vídeo/legenda', async () => {
    const store: Parameters<typeof sendWithLedger>[0] = {
      create: vi.fn(async () => { throw { code: '23505' }; }),
      find: vi.fn(async () => ({ id: 'receipt', status: 'requested' as const, crm_message_id: null })),
      rotate: vi.fn(async () => 'new'), message: vi.fn(async () => ({ id: 'message', status: 'delivered' })), update: vi.fn(async () => {}),
    };
    const enviar = vi.fn();
    const result = await sendWithLedger(store, { tenantId: org, leadId: null, jobId: 'job', seq: 1, body: 'Legenda.', media }, enviar);
    expect(result.kind).toBe('sent');
    expect(enviar).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith(org, 'receipt', 'accepted', 'message', null);
  });
  it('mesmo arquivo e nova legenda no replay conservam identidade; outro arquivo não', () => {
    const intent = { body: 'Legenda original', media, identidade: IDENTIDADE_DA_LEGENDA_DO_VIDEO };
    expect(hashDoConteudo(intent)).toBe(hashDoConteudo({ ...intent, body: 'Legenda regenerada' }));
    expect(hashDoConteudo(intent)).not.toBe(hashDoConteudo({ ...intent, media: { ...media, storagePath: media.storagePath.replace(digest, 'b'.repeat(64)) } }));
  });
  it('recibo aceito do arquivo impede novo transporte mesmo com legenda e posição diferentes', async () => {
    const original = { tenantId: org, leadId: null, jobId: 'job', seq: 1, body: 'Legenda original.', media, identidade: IDENTIDADE_DA_LEGENDA_DO_VIDEO };
    const hash = hashDoConteudo(original);
    const store: Parameters<typeof sendWithLedger>[0] = {
      create: vi.fn(async () => 'new'), find: vi.fn(async () => null), rotate: vi.fn(async () => 'new'),
      message: vi.fn(async () => null), update: vi.fn(async () => {}),
      findAccepted: vi.fn(async (_input: unknown, requestedHash: string) => requestedHash === hash
        ? { id: 'receipt', status: 'accepted' as const, crm_message_id: 'message', body_hash: hash } : null),
    };
    const enviar = vi.fn();
    const result = await sendWithLedger(store, { ...original, seq: 9, body: 'Legenda refeita no retry.' }, enviar);
    expect(result.kind).toBe('already_sent');
    expect(enviar).not.toHaveBeenCalled();
    expect(store.create).not.toHaveBeenCalled();
  });
  it('MP4 no nó continua recusado por padrão e depende da opção explícita', () => {
    expect(classificarMidiaComLegenda('https://fixture.invalid/clip.mp4').ok).toBe(false);
    expect(classificarMidiaComLegenda('https://fixture.invalid/clip.mp4', undefined, { videoMp4: true })).toMatchObject({ ok: true, type: 'video', mime: 'video/mp4' });
    expect(classificarMidiaComLegenda('https://fixture.invalid/clip.mov', undefined, { videoMp4: true }).ok).toBe(false);
  });
});

describe('fiação V1: ferramenta e prévia', () => {
  it('a ferramenta expõe só chave; URL e traversal não passam no contrato', () => {
    const schema = AGENT_TOOL_DEFS.send_message.inputSchema;
    expect(schema.safeParse({ body: 'Texto.' }).success).toBe(true);
    expect(schema.safeParse({ body: 'Legenda.', video_chave: 'fixture' }).success).toBe(true);
    for (const video_chave of ['../outra', 'https://fora.invalid/a.mp4', '']) {
      expect(schema.safeParse({ body: 'Legenda.', video_chave }).success).toBe(false);
    }
  });
  it('prévia marca impedimento sem chamar a ferramenta real nem aprovar a legenda', async () => {
    const result = newPreviewResult();
    const p = { result, contactId: null } as TurnPreview;
    const execute = vi.fn();
    const tools = applyPreviewPolicy({ send_message: { ...AGENT_TOOL_DEFS.send_message, execute } }, p, {} as GateContext, () => []);
    const output = await tools.send_message!.execute!({ body: 'Legenda.', video_chave: 'fixture' }, { toolCallId: 'fixture', messages: [], context: undefined });
    expect(output).toMatchObject({ ok: false, error: { code: 'video_preview_indisponivel' } });
    expect(result.impediments).toContainEqual(expect.objectContaining({ code: 'video_preview_indisponivel' }));
    expect(result.candidates).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });
  it('o vídeo usa apenas o callback da cadeia, o mesmo canal protegido e o mesmo recibo', () => {
    const source = readFileSync('lib/agent-engine/agent/inbound-turn.ts', 'utf8');
    const start = source.indexOf('send_message: tool({');
    const end = source.indexOf('update_lead_state: tool({', start);
    const send = source.slice(start, end);
    const callback = send.indexOf('send: (finalBody: string) =>');
    expect(callback).toBeGreaterThan(0);
    expect(send.indexOf('enviarVideoComLegenda(finalBody, videoNativo, enviar)')).toBeGreaterThan(callback);
    expect(send).toContain('cadeiaDeEnvio(() => runBeforeSend(beforeSendArgs))');
    expect(send).toContain('prepararVideoNativo(pool, deps.copiarVideo ?? copiarVideoNoStorage()');
    expect(send).toContain('identidade: IDENTIDADE_DA_LEGENDA_DO_VIDEO');
  });
});


it('V3: leitor inline usa a mesma política por organização e falha fechado', async () => {
  const eq = vi.fn();
  const reply = vi.fn(async () => ({ data: { settings: { c01_native_videos: { ...config, flow_mp4: true } } }, error: null as unknown }));
  const chain = { select: () => chain, eq: (...args: unknown[]) => { eq(...args); return chain; }, maybeSingle: reply };
  const db = { from: vi.fn(() => chain) } as unknown as Parameters<typeof lerPoliticaDeVideoSupabase>[0];
  expect(await lerPoliticaDeVideoSupabase(db, org)).toMatchObject({ enabled: true, flow_mp4: true });
  expect(eq).toHaveBeenCalledWith('id', org);
  reply.mockResolvedValueOnce({ data: { settings: { c01_native_videos: config } }, error: new Error('offline') });
  expect((await lerPoliticaDeVideoSupabase(db, org)).enabled).toBe(false);
});
