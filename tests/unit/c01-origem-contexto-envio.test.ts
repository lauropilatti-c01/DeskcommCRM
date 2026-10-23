import { afterEach, expect, it, vi } from 'vitest';
const handler = vi.hoisted(() => vi.fn());
vi.mock('@/app/api/v1/messages/_handler', () => ({ sendMessageHandler: handler }));
vi.mock('@/lib/agent-engine/edge/crm/send-ledger', () => ({
  pgSendLedger: () => ({}),
  sendWithLedger: async (_ledger: unknown, _input: unknown, send: (key: string, id: string) => Promise<unknown>) => send('chave-ficticia', 'mensagem-ficticia'),
}));
vi.mock('@/lib/atendimento/fronteira-server', () => ({
  requireCurrentServiceBoundary: vi.fn(), requireCurrentAutonomousTurn: vi.fn(),
}));
import { sendTurnMessage } from '@/lib/agent-engine/edge/crm/send-message';

afterEach(() => vi.clearAllMocks());

it('origem confiável chega pelo contexto interno, sem chave forjável no corpo público', async () => {
  handler.mockResolvedValue({ id: 'mensagem-ficticia', status: 'sent' });
  const db = { query: vi.fn(async () => ({ rows: [] })) };
  const origin = { kind: 'cronograma' as const, leadId: 'negocio-ficticio', productKey: 'produto-ficticio' };
  await sendTurnMessage(db as never, { supabase: {} } as never, {
    tenantId: 'empresa', leadId: 'contato', jobId: 'job', seq: -1,
    conversationId: 'conversa', body: 'Material de estudo', origem: 'pre_turn_hook', c01Origin: origin,
  });
  expect(handler).toHaveBeenCalledTimes(1);
  const [, context, body] = handler.mock.calls[0]!;
  expect(context.c01Origin).toEqual(origin);
  expect(body).not.toHaveProperty('c01Origin');
  expect(body.metadata).toEqual({ idempotency_key: 'chave-ficticia', origem: 'pre_turn_hook' });
});

it('envio comum não herda origem da mensagem anterior', async () => {
  handler.mockResolvedValue({ id: 'mensagem-ficticia', status: 'sent' });
  await sendTurnMessage({ query: async () => ({ rows: [] }) } as never, { supabase: {} } as never, {
    tenantId: 'empresa', leadId: 'contato', jobId: 'job', seq: 1, conversationId: 'conversa', body: 'Resposta comum',
  });
  expect(handler.mock.calls[0]![1]).not.toHaveProperty('c01Origin');
});
