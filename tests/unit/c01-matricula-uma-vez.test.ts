import { describe, expect, it, vi } from 'vitest';
import { prepararMatriculaUmaVez, lerPoliticaMatricula, reciboDaMatriculaSuprimida, type EnvioMatricula } from '../../lib/agent-engine/agent/c01-matricula-uma-vez';
import type pg from 'pg';
import { runBeforeSend } from '../../lib/agent-engine/guardrails/before-send';
import type { Queryable } from '../../lib/agent-engine/queue/queue';
import { sendInBubbles } from '../../lib/agent-engine/agent/split-message';

const literal = 'Para fazer a matrícula, escolha a forma de pagamento. O acesso chega após a confirmação.';
const page = 'https://loja.example/curso?a=1';
const other = 'https://loja.example/curso?a=2';
const alvo = { organizationId: 'org', contactId: 'contact', conversationId: 'conversation', jobId: 'current' };
const policy = { enabled: true, literal, offer_connection_id: '11111111-1111-4111-8111-111111111111' };
function part(body: string, status: string | null = 'sent', jobId = 'prior', seq = 1): EnvioMatricula {
  return { job_id: jobId, seq, body, status, message_id: `${jobId}-${seq}`, ledger_id: `ledger-${jobId}-${seq}` };
}
function db(rows: EnvioMatricula[]) {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Queryable;
}
const run = (body: string, rows: EnvioMatricula[], pages = [page]) => prepararMatriculaUmaVez(db(rows), alvo, policy, body, new Set(pages));

describe('T5: só o fechamento literal repetido', () => {
  it('primeira página mantém o texto', async () => {
    const body = `Veja aqui:\n${page}\n\n${literal}`;
    expect((await run(body, [])).body).toBe(body);
  });
  it.each(['sent', 'delivered', 'read'])('%s impede nova cópia sem perder página nem pergunta', async status => {
    const out = await run(`Veja:\n${page}\n\n${literal}\n\nPrefere esta opção?`, [part(`${page}\n\n${literal}`, status)]);
    expect(out.body).toBe(`Veja:\n${page}\n\nPrefere esta opção?`);
    expect(out.reason).toBe('accepted');
  });
  it.each(['queued', 'sending', null])('%s fica pendente e não autoriza uma segunda cópia', async status => {
    const out = await run(`${page}\n\n${literal}`, [part(`${page}\n\n${literal}`, status)]);
    expect(out.body).toBe(page);
    expect(out.reason).toBe('pending');
  });
  it('falha confirmada permite tentar o parágrafo novamente', async () => {
    const body = `${page}\n\n${literal}`;
    expect((await run(body, [part(body, 'failed')])).body).toBe(body);
  });
  it('página e literal em bolhas diferentes têm o mesmo recibo lógico', async () => {
    const out = await run(`${page}\n\n${literal}`, [part(page), part(literal, 'sent', 'prior', 2)]);
    expect(out.body).toBe(page);
  });
  it('literal sem URL resolve a página já enviada em outra chamada do mesmo job', async () => {
    const out = await run(literal, [part(page), part(literal, 'sent', 'prior', 2), part(page, 'sent', 'current')]);
    expect(out.body).toBe('');
    expect(out.receipt?.messageId).toBe('prior-2');
  });
  it('vídeo auxiliar no job anterior não altera a identidade da página', async () => {
    const out = await run(`${page}\n\n${literal}`, [part('https://video.example/intro'), part(page, 'sent', 'prior', 2), part(literal, 'sent', 'prior', 3)]);
    expect(out.body).toBe(page);
  });
  it('outra página e outro literal continuam disponíveis', async () => {
    const body = `${other}\n\n${literal}`;
    expect((await run(body, [part(`${page}\n${literal}`)], [page, other])).body).toBe(body);
    const changed = `${page}\n\nOutra orientação de matrícula.`;
    expect((await run(changed, [part(`${page}\n${literal}`)])).body).toBe(changed);
  });
  it('replay do mesmo job continua a cargo do ledger', async () => {
    const body = `${page}\n\n${literal}`;
    expect((await run(body, [part(body, 'sent', 'current')])).body).toBe(body);
  });
  it('nova chamada no mesmo job preserva a pergunta, mas não repete o literal', async () => {
    const initial = `${page}\n\n${literal}`;
    const out = await run(`${initial}\n\nConseguiu abrir?`, [part(initial, 'sent', 'current')]);
    expect(out.reason).toBe('accepted');
    expect(out.body).toBe(`${page}\n\nConseguiu abrir?`);
  });
  it.each(['sent', 'queued'])('ocorrência posterior %s vence a primeira falhada', async status => {
    const out = await run(`${page}\n\n${literal}\n\nResposta nova.`, [
      part(`${page}\n\n${literal}`, 'failed'), part(literal, status, 'prior', 2),
    ]);
    expect(out.reason).toBe(status === 'sent' ? 'accepted' : 'pending');
    expect(out.body).toBe(`${page}\n\nResposta nova.`);
    expect(out.receipt?.messageId).toBe('prior-2');
  });
  it('todas as ocorrências falhadas no mesmo job permitem nova tentativa', async () => {
    const body = `${page}\n\n${literal}\n\nResposta nova.`;
    expect((await run(body, [part(`${page}\n${literal}`, 'failed', 'current'),
      part(literal, 'failed', 'current', 2)])).body).toBe(body);
  });
  it('before-send fornece o client já retido para T5 sem pedir outra conexão', async () => {
    let transaction = false;
    const client = { query: vi.fn(async (sql: string) => {
      if (sql === 'begin') transaction = true;
      if (sql === 'commit' || sql === 'rollback') transaction = false;
      return { rows: sql.includes('with envios') ? [part(`${page}\n${literal}`)] : [], rowCount: 0 };
    }), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), query: vi.fn(async () => {
      if (transaction) throw new Error('pool não pode emprestar outra conexão durante T5');
      return { rows: [], rowCount: 0 };
    }) };
    const result = await runBeforeSend({
      pool: pool as unknown as pg.Pool, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tenantId: 'org', leadId: 'contact', channelSessionId: 'channel', body: `${page}\n\n${literal}`,
      optedOutThisTurn: false, crmDailyLimit: null, now: new Date('2026-10-23T15:00:00Z'),
      gates: [], sleep: async () => {},
      send: async (body, dbUnderLock) => {
        expect(dbUnderLock).toBe(client);
        const out = await prepararMatriculaUmaVez(dbUnderLock, alvo, policy, body, new Set([page]));
        expect(out.body).toBe(page);
        return { kind: 'sent', messageId: 'new', idempotencyKey: 'new-ledger' };
      },
    });
    expect(result.status).toBe('sent');
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(transaction).toBe(false);
  });
  it('não considera URL que não veio da consulta de páginas', async () => {
    const body = `${page}\n\n${literal}`;
    expect((await run(body, [part(body)], [])).body).toBe(body);
  });
  it('literal dividido entre bolhas só é aceito com todas as partes aceitas', async () => {
    const [a, b] = [literal.slice(0, 56).trim(), literal.slice(56).trim()];
    const out = await run(`${page}\n\n${literal}`, [part(page), part(a, 'sent', 'prior', 2), part(b, 'queued', 'prior', 3)]);
    expect(out.reason).toBe('pending');
    const failed = await run(`${page}\n\n${literal}`, [part(page), part(a, 'sent', 'prior', 2), part(b, 'failed', 'prior', 3)]);
    expect(failed.reason).toBe('none');
  });
  it('erro de leitura segura só o literal e preserva a resposta útil', async () => {
    let aborted = false;
    const store = { query: vi.fn(async (sql: string) => {
      if (sql.includes('with envios')) { aborted = true; throw new Error('segredo não deve vazar'); }
      if (sql.startsWith('rollback to savepoint')) aborted = false;
      if (aborted) throw new Error('transação abortada');
      return { rows: [], rowCount: 0 };
    }) } as unknown as Queryable;
    const out = await prepararMatriculaUmaVez(store, alvo, policy, `${page}\n\n${literal}\n\nResposta útil.`, new Set([page]));
    expect(out.body).toBe(`${page}\n\nResposta útil.`);
    expect(out.reason).toBe('pending');
    expect(out.receipt).toBeUndefined();
    expect(aborted).toBe(false);
    expect(vi.mocked(store.query).mock.calls.at(-1)?.[0]).toBe('release savepoint c01_matricula_read');
  });
  it('consulta cerca organização, pessoa, conversa e mensagem outbound com ledger', async () => {
    const store = db([]);
    await prepararMatriculaUmaVez(store, alvo, policy, `${page}\n${literal}`, new Set([page]));
    const [sql, args] = vi.mocked(store.query).mock.calls.find(([sql]) => String(sql).includes('with envios'))!;
    expect(args?.slice(0, 4)).toEqual(['org', 'contact', 'conversation', 'current']);
    expect(sql).toContain('sl.organization_id = $1');
    expect(sql).toContain('sl.contact_id = $2');
    expect(sql).toContain('m.conversation_id = $3');
    expect(sql).toContain("m.direction = 'outbound'");
    expect(sql).toContain('c.contact_id = $2');
  });
  it('OFF mantém o legado sem consultar histórico', async () => {
    const store = db([]); const body = `${page}\n${literal}`;
    expect((await prepararMatriculaUmaVez(store, alvo, { enabled: false }, body, new Set([page]))).body).toBe(body);
    expect(store.query).not.toHaveBeenCalled();
  });
  it('configuração inválida/ausente fica OFF e a leitura é da própria organização', async () => {
    const store = { query: vi.fn().mockResolvedValue({ rows: [{ policy: { enabled: true, literal } }] }) } as unknown as Queryable;
    expect(await lerPoliticaMatricula(store, 'org')).toEqual({ enabled: false });
    expect(vi.mocked(store.query).mock.calls[0]?.[1]).toEqual(['org']);
  });
  it('supressão integral devolve recibo existente sem inventar mensagem', async () => {
    const out = await run(literal, [part(`${page}\n${literal}`), part(page, 'sent', 'current')]);
    expect(reciboDaMatriculaSuprimida(out)).toEqual({ kind: 'already_sent', messageId: 'prior-1', idempotencyKey: 'ledger-prior-1' });
    expect(reciboDaMatriculaSuprimida({ body: '', reason: 'pending' })).toEqual({ kind: 'unavailable', reason: 'matricula_aguarda_conciliacao' });
  });
  it('recibo pendente permanece queued e não é anunciado como aceito', async () => {
    const out = await run(literal, [part(`${page}\n${literal}`, 'queued'), part(page, 'sent', 'current')]);
    expect(reciboDaMatriculaSuprimida(out).kind).toBe('queued');
  });
  it('dois turnos pelo divisor real mantêm o novo link e não repetem o fechamento', async () => {
    const sent: string[] = [];
    const history: EnvioMatricula[] = [];
    for (const [jobId, body] of [
      ['first', `Veja aqui:\n${page}\n\n${literal}`],
      ['next', `Claro, a página é esta:\n${page}\n\n${literal}\n\nConseguiu abrir?`],
    ]) {
      const prepared = await prepararMatriculaUmaVez(db(history), { ...alvo, jobId: jobId! }, policy, body!, new Set([page]));
      let seq = 0;
      await sendInBubbles(prepared.body, {
        enabled: true, maxChars: 700, maxBubbles: 10,
        sleep: async () => {}, jitter: () => 0,
        send: async text => {
          seq += 1; sent.push(text); history.push(part(text, 'sent', jobId!, seq));
          return { kind: 'sent', messageId: `${jobId}-${seq}` };
        },
      });
    }
    expect(sent.filter(text => text.includes(literal))).toHaveLength(1);
    expect(sent.filter(text => text.includes(page))).toHaveLength(2);
    expect(sent.at(-1)).toBe('Conseguiu abrir?');
  });
});
