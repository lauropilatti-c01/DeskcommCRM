import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import { corpoDoEnvio } from '@/lib/agent-engine/edge/crm/send-message';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import { criarDubleDoHandler } from '@/tests/helpers/duble-do-handler';

const { assinar } = vi.hoisted(() => ({ assinar: vi.fn(async () => ({ data: { signedUrl: 'https://fixture.invalid/signed.mp4' }, error: null })) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: assinar }) } }) }));
// Apenas DNS e transporte são simulados; a guarda anti-SSRF continua real.
vi.mock('node:dns/promises', async original => {
  const actual = await original<Record<string, unknown>>();
  const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  return { ...actual, lookup, default: { ...(actual.default as object), lookup } };
});
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));
const org = '11111111-1111-4111-8111-111111111111';
const conv = '22222222-2222-4222-8222-222222222222';
const contact = '33333333-3333-4333-8333-333333333333';
const session = '44444444-4444-4444-8444-444444444444';
const path = `${org}/${conv}/video-${'a'.repeat(64)}.mp4`;
const ctx: HandlerCtx = { organization_id: org, actor: { type: 'ai_agent', id: 'agent-engine', role: 'manager' }, requestId: 'fixture' };
const body = () => corpoDoEnvio({ tenantId: org, leadId: contact, jobId: 'job', seq: 1, conversationId: conv, body: 'Legenda fixture.', media: { storagePath: path, mime: 'video/mp4', type: 'video' } }, 'receipt');
const conversation = (hours = 1, blocked = false) => ({
  id: conv, organization_id: org, contact_id: contact, channel_session_id: session,
  is_group: false, group_chat_id: null, bot_silenced_until: null, provider_conversation_id: null,
  last_inbound_at: new Date(Date.now() - hours * 3_600_000).toISOString(),
  contacts: { phone_number: '+5511999990000', wa_identity: null, wa_lid: null, is_blocked: blocked },
  channel_sessions: { id: session, organization_id: org, provider: 'meta_cloud', waha_session_name: null, status: 'WORKING', archived_at: null },
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); assinar.mockClear(); });

describe('vídeo nativo passa pelo handler real com transporte simulado', () => {
  it.each([{ hours: 25, blocked: false, code: 'janela_fechada' }, { hours: 1, blocked: true, code: 'forbidden' }])('recusa $code sem linha, assinatura ou transporte', async ({ hours, blocked, code }) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversation(hours, blocked) });
    await expect(sendMessageHandler(supabase, ctx, body())).rejects.toMatchObject({ code });
    expect(capturas.inserts.messages).toHaveLength(0);
    expect(assinar).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('recusa objeto de outra organização antes de assinar ou enviar', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversation() });
    await expect(sendMessageHandler(supabase, ctx, { ...body(), media_storage_path: `${contact}/${conv}/clip.mp4` })).rejects.toMatchObject({ status: 422, code: 'invalid_media_path' });
    expect(capturas.inserts.messages).toHaveLength(0);
    expect(assinar).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('troca de responsável torna a fronteira antiga inválida e impede o vídeo', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const boundary = { organization_id: org, contact_id: contact, conversation_id: conv, service_revision: 1, demanda_id: null, demanda_revision: null };
    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversation(), rpcData: { ...boundary, service_revision: 2, status: 'open', demanda_fechada_em: null } });
    await expect(sendMessageHandler(supabase, { ...ctx, serviceBoundary: boundary }, body())).rejects.toThrow();
    expect(capturas.inserts.messages).toHaveLength(0);
    expect(assinar).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('dentro da janela envia um vídeo com legenda e assinatura de 600 segundos', async () => {
    vi.stubEnv('META_PHONE_NUMBER_ID', '0000000000000000');
    vi.stubEnv('META_SYSTEM_USER_TOKEN', 'fixture-token');
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fixture' }] }) }));
    vi.stubGlobal('fetch', fetch);
    const { supabase, capturas } = criarDubleDoHandler({ conversation: conversation() });
    const result = await sendMessageHandler(supabase, ctx, body());
    expect(result.status).toBe('sent');
    expect(assinar).toHaveBeenCalledExactlyOnceWith(path, 600);
    expect(capturas.inserts.messages).toHaveLength(1);
    expect(capturas.inserts.messages![0]).toMatchObject({ type: 'video', body: 'Legenda fixture.', media_storage_path: path });
    expect(fetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(payload).toMatchObject({ type: 'video', video: { link: 'https://fixture.invalid/signed.mp4', caption: 'Legenda fixture.' } });
  });
});

it.each([{ hours: 25, blocked: false, code: 'janela_fechada' }, { hours: 1, blocked: true, code: 'forbidden' }])('V3: URL MP4 também respeita $code no handler real', async ({ hours, blocked, code }) => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const { supabase, capturas } = criarDubleDoHandler({ conversation: conversation(hours, blocked) });
  const media = { ...body(), media_storage_path: undefined, media_url: 'https://fixture.invalid/curso.mp4' };
  await expect(sendMessageHandler(supabase, ctx, media)).rejects.toMatchObject({ code });
  expect(capturas.inserts.messages).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});

it('V3: URL MP4 sai pelo handler como vídeo com legenda, não como link textual', async () => {
  vi.stubEnv('META_PHONE_NUMBER_ID', '0000000000000000');
  vi.stubEnv('META_SYSTEM_USER_TOKEN', 'fixture-token');
  const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.fixture' }] }) }));
  vi.stubGlobal('fetch', fetch);
  const { supabase } = criarDubleDoHandler({ conversation: conversation() });
  const result = await sendMessageHandler(supabase, ctx, { ...body(), media_storage_path: undefined, media_url: 'https://fixture.invalid/curso.mp4' });
  expect(result.status).toBe('sent');
  expect(fetch).toHaveBeenCalledOnce();
  const payload = JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body);
  expect(payload).toMatchObject({ type: 'video', video: { link: 'https://fixture.invalid/curso.mp4', caption: 'Legenda fixture.' } });
  expect(assinar).not.toHaveBeenCalled();
});


it('V3: URL de rede interna continua recusada pela guarda real, sem transporte', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const { supabase, capturas } = criarDubleDoHandler({ conversation: conversation() });
  await expect(sendMessageHandler(supabase, ctx, { ...body(), media_storage_path: undefined, media_url: 'http://127.0.0.1/curso.mp4' })).rejects.toMatchObject({ code: 'unsafe_media_url' });
  expect(capturas.inserts.messages).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});
