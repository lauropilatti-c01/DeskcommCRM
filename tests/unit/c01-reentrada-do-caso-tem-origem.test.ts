/** O handler transporta a referência do caso; a evidência é relida no turno. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { createCaseReplyTurnHandler } from '@/lib/agent-engine/agent/case-reply-turn';
import { runAgentTurn, type InboundTurnDeps } from '@/lib/agent-engine/agent/inbound-turn';
import type { JobRow } from '@/lib/agent-engine/queue/queue';

vi.mock('@/lib/agent-engine/agent/inbound-turn', () => ({ runAgentTurn: vi.fn(), ritualBlocks: () => [] }));
const CASE = '11111111-1111-4111-8111-111111111111';
const deps = { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } } as unknown as InboundTurnDeps;
const job = {
  id: 'job-ficticio', organization_id: 'org-ficticia', contact_id: 'contato-ficticio', kind: 'case_reply_turn',
  payload: { case_id: CASE, action: 'resolved', body: 'Veja https://ajuda.exemplo.com.br/caso/1' },
  source_event_id: null, status: 'running', priority: 100, run_after: new Date(0), attempts: 0,
  max_attempts: 5, last_error: null, locked_by: 'fixture', locked_at: new Date(0), created_at: new Date(0),
} satisfies JobRow;
const row = { status: 'resolved', conversation_id: 'conversa-ficticia', channel_session_id: 'canal-ficticio',
  contact_id: 'contato-ficticio' };

beforeEach(() => vi.mocked(runAgentTurn).mockReset());

describe('G3 — reentrada do caso', () => {
  it('passa referência sem transformar o corpo em consulta nem permissão de preço', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    await createCaseReplyTurnHandler(deps)(job, { query } as unknown as pg.Pool, { workerId: 'fixture' });
    const input = vi.mocked(runAgentTurn).mock.calls[0]?.[4];
    expect(input).toMatchObject({ conversationId: row.conversation_id,
      respostaDoCaso: { caseId: CASE, action: 'resolved', body: job.payload.body } });
    expect(input).not.toHaveProperty('valoresDaConsulta');
    expect(query.mock.calls[0]?.[1]).toEqual(['org-ficticia', CASE, 'contato-ficticio']);
  });

  it('contato do job diferente da conversa não chega ao turno', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...row, contact_id: 'outro-contato' }] });
    await createCaseReplyTurnHandler(deps)(job, { query } as unknown as pg.Pool, { workerId: 'fixture' });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'awaiting_human', 'escalated'])('caso %s não produz reentrada nem link autorizado', async (status) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...row, status }] });
    await createCaseReplyTurnHandler(deps)(job, { query } as unknown as pg.Pool, { workerId: 'fixture' });
    expect(runAgentTurn).not.toHaveBeenCalled();
  });

  it('ação assumir/escalar não lê nem reentra', async () => {
    const query = vi.fn();
    await createCaseReplyTurnHandler(deps)({ ...job, payload: { ...job.payload, action: 'escalate' } },
      { query } as unknown as pg.Pool, { workerId: 'fixture' });
    expect(query).not.toHaveBeenCalled();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
