import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelSendInput } from '@/lib/agent-engine/channel-adapter';
import type { JobRow } from '@/lib/agent-engine/queue/queue';
vi.mock('@/lib/agent-engine/guardrails/before-send', () => ({ runBeforeSend: vi.fn() }));
import { runBeforeSend } from '@/lib/agent-engine/guardrails/before-send';
import { CHAVE_NO_JOB, respostaDoGanchoSchema, rodarGanchoAntesDoTurno } from '@/lib/agent-engine/agent/gancho-antes-do-turno';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const LEAD = '44444444-4444-4444-8444-444444444444';
const OTHER_LEAD = '55555555-5555-4555-8555-555555555555';
const mark = { kind: 'cronograma', product_key: 'produto-ficticio' };
const item = { tipo: 'texto', texto: 'Seu material: https://exemplo.invalid/material', c01_origin: mark };

beforeEach(() => {
  vi.mocked(runBeforeSend).mockImplementation((async (opts: { body: string; send: (body: string) => Promise<unknown> }) =>
    ({ status: 'sent', outcome: await opts.send(opts.body) })) as never);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function run(response: unknown, saved?: Record<string, unknown>, cardId = LEAD) {
  const query = vi.fn(async (sql: string, _args: unknown[] = []) => {
    if (sql.includes('max(created_at)::text')) return { rows: [{ em: '2026-10-23 12:00:00+00' }] };
    if (sql.includes('from conversations c')) return { rows: [{ provider: 'meta' }] };
    if (sql.includes('select provider from channel_sessions')) return { rows: [{ provider: 'meta' }] };
    if (sql.includes('from crm_leads')) return { rows: [{ id: cardId, status: 'open', etapa: 'novo', custom_fields: {}, tags: [] }] };
    return { rows: [], rowCount: 0 };
  });
  const fetch = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const send = vi.fn(async (_input: ChannelSendInput) => ({ kind: 'sent' as const }));
  await rodarGanchoAntesDoTurno({
    pool: { query } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { url: 'http://gancho.invalid/turno', segredo: 'teste', prazoMs: 100 },
    job: { id: 'job', organization_id: ORG, kind: 'inbound_turn', payload: saved ? { [CHAVE_NO_JOB]: saved } : {} } as JobRow,
    tenantId: ORG, contactId: CONTACT, conversationId: CONV, channelSessionId: 'sessao', inboundMessageId: null,
    agentId: null, etiquetasDoContato: [], channel: { send } as never, optedOutThisTurn: false,
    now: () => new Date('2026-10-23T12:01:00Z'),
  });
  return { send, query, fetch };
}

describe('Origem do material no gancho confiável', () => {
  it('conserva o marcador válido, mas descarta marcador inválido sem perder a mensagem', () => {
    const valid = respostaDoGanchoSchema.parse({ acao: 'segurar', enviar: [item] });
    expect(valid.enviar?.[0]).toMatchObject({ c01_origin: mark });
    const invalid = respostaDoGanchoSchema.parse({ acao: 'segurar', enviar: [{ ...item, c01_origin: { kind: 'qualquer', product_key: '' } }] });
    expect(invalid.enviar?.[0]).not.toHaveProperty('c01_origin', expect.anything());
  });

  it.each(['segurar', 'seguir'])('liga só o item marcado ao negócio do pedido, em %s', async (acao) => {
    const response = { acao, [acao === 'seguir' ? 'enviar_antes' : 'enviar']: [item, { tipo: 'texto', texto: 'Outra resposta.' }] };
    const { send, query } = await run(response);
    expect(send.mock.calls).toHaveLength(2);
    expect(send.mock.calls[0]?.[0]).toMatchObject({ leadId: CONTACT, c01Origin: { kind: 'cronograma', leadId: LEAD, productKey: 'produto-ficticio' } });
    expect(send.mock.calls[1]?.[0]).not.toHaveProperty('c01Origin');
    const saved = query.mock.calls.filter(([sql]) => sql.includes('update job_queue'))
      .map(([, args]) => JSON.parse(String(args[3]))).find(x => x.situacao === 'decidido');
    expect(saved.origem_lead_id).toBe(LEAD);
  });

  it('reexecução preserva o negócio original mesmo que o card atual tenha mudado', async () => {
    const response = { acao: 'segurar', enviar: [item] };
    const { send, fetch } = await run(response, { situacao: 'decidido', resposta: response, formulario: null, ate: null, origem_lead_id: LEAD }, OTHER_LEAD);
    expect(fetch).not.toHaveBeenCalled();
    expect(send.mock.calls[0]?.[0]).toMatchObject({ c01Origin: { leadId: LEAD } });
  });

  it('decisão antiga sem identidade de origem não vira inscrição retroativa', async () => {
    const response = { acao: 'segurar', enviar: [item] };
    const { send } = await run(response, { situacao: 'decidido', resposta: response, formulario: null, ate: null });
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('c01Origin');
  });
});
