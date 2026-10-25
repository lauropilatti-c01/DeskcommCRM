import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import type pg from 'pg';

import { applyScheduleFollowup } from './schedule-followup';

/**
 * Pool fake: roteia por conteúdo da SQL. O guard anti-empilhamento faz um SELECT
 * (`enabled = true`); a criação faz o INSERT (`insert into cron_jobs`). Cada teste
 * decide o que o SELECT devolve — com ou sem pendente.
 */
function fakePool(pendentes: Array<{ id: string; promised_at: string | null }>): {
  db: pg.Pool;
  inserts: number;
} {
  let inserts = 0;
  const db = Object.assign(new EventEmitter(), {
    release() {},
    async connect() { return this; },
    async query(sql: string) {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] };
      if (/pg_advisory_unlock|select 1/.test(sql)) return { rows: [] };
      if (/insert into cron_jobs/i.test(sql)) {
        inserts += 1;
        return { rows: [{ id: 'cron-novo', next_run_at: new Date('2026-07-25T13:00:00Z') }] };
      }
      // guard SELECT
      return { rows: pendentes };
    },
  }) as unknown as pg.Pool;
  return { db, get inserts() { return inserts; } } as { db: pg.Pool; inserts: number };
}

const CFG = {
  clock: () => new Date('2026-07-23T12:00:00Z'),
  knobs: { minAheadMs: 30 * 60_000, maxAheadMs: 30 * 86_400_000, staggerWindowMs: 60_000 },
};
const IDS = { tenantId: 'org-1', leadId: 'lead-1' };
const VALID = {
  reason: 'reconfirmar call',
  promised_at: '2026-07-25T13:00:00Z',
  promise: 'confirmar a call de diagnóstico',
  context_snapshot: null,
};

describe('applyScheduleFollowup — guard anti-empilhamento (1 pendente por lead)', () => {
  it('lead JÁ tem follow-up pendente → already_pending, NÃO cria segundo', async () => {
    const p = fakePool([{ id: 'cron-existente', promised_at: '2026-07-25T10:00:00Z' }]);
    const res = await applyScheduleFollowup(p.db, CFG, IDS, VALID);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('esperava falha');
    expect(res.error.code).toBe('already_pending');
    expect(res.error.message).toContain('2026-07-25T10:00:00Z');
    expect(p.inserts).toBe(0); // o insert do cron NÃO rodou — sem empilhar
  });

  it('lead SEM pendente → agenda normalmente (cria 1)', async () => {
    const p = fakePool([]);
    const res = await applyScheduleFollowup(p.db, CFG, IDS, VALID);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('esperava sucesso');
    expect(res.cronJobId).toBe('cron-novo');
    expect(res).not.toHaveProperty('crm_lead_id');
    expect(p.inserts).toBe(1);
  });

  it('o ensino manda usar data ABSOLUTA (anti "amanhã")', async () => {
    const p = fakePool([{ id: 'x', promised_at: null }]);
    const res = await applyScheduleFollowup(p.db, CFG, IDS, VALID);
    if (res.ok) throw new Error('esperava falha');
    expect(res.error.message.toLowerCase()).toContain('absoluta');
    expect(res.error.message).toContain('amanhã');
  });
});


describe('applyScheduleFollowup — troca explícita de horário', () => {
  it.each([true, false])('só confirma a troca depois de a escrita vencer (venceu=%s)', async (venceu) => {
    const queries: string[] = [];
    const original = { id: 'cron-existente', contact_id: 'lead-1', next_run_at: '2026-07-24T13:00:00Z', payload: { reason: 'original', promised_at: '2026-07-24T13:00:00Z' }, enabled: true };
    const db = Object.assign(new EventEmitter(), { release() {}, async connect() { return this; }, query: async (sql: string) => {
      queries.push(sql);
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked: true }] };
      if (/pg_advisory_unlock|select 1/.test(sql)) return { rows: [] };
      if (/update cron_jobs/i.test(sql)) return { rows: venceu ? [{ ...original, next_run_at: VALID.promised_at }] : [] };
      if (/from cron_jobs/i.test(sql)) return { rows: [original] };
      return { rows: [] };
    } }) as unknown as pg.Pool;
    const res = await applyScheduleFollowup(db, CFG, IDS, { ...VALID, replace_pending_id: original.id });
    expect(res.ok).toBe(venceu);
    if (!res.ok) expect(res.error.code).toBe('pending_changed');
    else expect(res.message).toContain('reagendado');
    expect(queries.some((sql) => /insert into cron_jobs/i.test(sql))).toBe(false);
  });
});
