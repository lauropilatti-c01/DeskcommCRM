import { describe, expect, it, vi } from 'vitest';
import { criarAgendadorC01DoTurno, scheduleFollowupC01ToolSchema, type ScheduleFollowupResult } from './schedule-followup';

const entrada = { reason: 'Retorno pedido', promised_at: '2026-10-25T13:00:00Z', promise: 'Amanhã às 10h' };
const id = 'b7b7b7b7-0000-4000-8000-000000000001';
const sucesso: ScheduleFollowupResult = { ok: true, cronJobId: id, promisedAt: new Date(entrada.promised_at), message: 'agendado' };
const pendente: ScheduleFollowupResult = { ok: false, pendingCronJobId: id, error: { code: 'already_pending', message: 'pendente' } };

describe('contrato externo C01 de retorno', () => {
  it('aceita campos comerciais sem identificadores', () => {
    expect(scheduleFollowupC01ToolSchema.parse(entrada)).toEqual(entrada);
    expect(scheduleFollowupC01ToolSchema.parse({ ...entrada, substituir_pendente: true }).substituir_pendente).toBe(true);
  });
  it.each(['consent_message_id', 'offered_message_id', 'replace_pending_id'])('rejeita %s sem strip ou agendamento', async (campo) => {
    const aplicar = vi.fn(async (_raw: unknown) => sucesso);
    const agendar = criarAgendadorC01DoTurno(aplicar);
    expect(scheduleFollowupC01ToolSchema.safeParse({ ...entrada, [campo]: id }).success).toBe(false);
    expect(await agendar({ ...entrada, [campo]: id })).toMatchObject({ ok: false, error: { code: 'invalid_payload' } });
    expect(aplicar).not.toHaveBeenCalled();
  });
  it('mantém o ID só no turno; exige intenção explícita depois da recusa', async () => {
    const aplicar = vi.fn(async (_raw: unknown): Promise<ScheduleFollowupResult> => pendente)
      .mockResolvedValueOnce(pendente).mockResolvedValueOnce(pendente).mockResolvedValueOnce(sucesso);
    const agendar = criarAgendadorC01DoTurno(aplicar);
    const recusa = await agendar(entrada);
    expect(JSON.stringify(recusa)).not.toContain(id);
    expect(recusa).toMatchObject({ ok: false, error: { message: expect.stringContaining('substituir_pendente') } });
    await agendar(entrada);
    expect(aplicar.mock.calls[1]).toEqual([entrada]);
    expect(await agendar({ ...entrada, substituir_pendente: true })).toEqual(sucesso);
    expect(aplicar.mock.calls[2]).toEqual([{ ...entrada, replace_pending_id: id }]);
  });
  it('não substitui sem observação no próprio turno nem depois de sucesso', async () => {
    const aplicar = vi.fn(async (_raw: unknown): Promise<ScheduleFollowupResult> => pendente).mockResolvedValueOnce(pendente).mockResolvedValueOnce(sucesso);
    const agendar = criarAgendadorC01DoTurno(aplicar);
    expect(await agendar({ ...entrada, substituir_pendente: true })).toMatchObject({ ok: false });
    expect(aplicar).not.toHaveBeenCalled();
    await agendar(entrada);
    expect(await criarAgendadorC01DoTurno(aplicar)({ ...entrada, substituir_pendente: true })).toMatchObject({ ok: false });
    await agendar({ ...entrada, substituir_pendente: true });
    expect(await agendar({ ...entrada, substituir_pendente: true })).toMatchObject({ ok: false });
    expect(aplicar).toHaveBeenCalledTimes(2);
  });
  it('preserva a recusa atômica se o pendente mudar; não cria outro', async () => {
    const mudou: ScheduleFollowupResult = { ok: false, error: { code: 'pending_changed', message: 'mudou' } };
    const aplicar = vi.fn(async (_raw: unknown): Promise<ScheduleFollowupResult> => pendente).mockResolvedValueOnce(pendente).mockResolvedValueOnce(mudou);
    const agendar = criarAgendadorC01DoTurno(aplicar);
    await agendar(entrada);
    expect(await agendar({ ...entrada, substituir_pendente: true })).toEqual(mudou);
    expect(await agendar({ ...entrada, substituir_pendente: true })).toMatchObject({ ok: false });
    expect(aplicar).toHaveBeenCalledTimes(2);
  });
});
