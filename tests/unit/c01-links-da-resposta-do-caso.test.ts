/** G3: só a URL literal da resposta humana persistida desta reentrada. Sem rede/IA. */
import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@/lib/agent-engine/queue/queue';
import type { GateContext } from '@/lib/agent-engine/guardrails/before-send';
import { linkPermitidoGate, normalizarLink } from '@/lib/agent-engine/guardrails/link-permitido';
import { linkEValorDeFerramentaGate } from '@/lib/agent-engine/guardrails/link-e-valor-de-ferramenta';
import { recusarEscritaFinanceiraGenerica } from '@/lib/leads/confirmacao-financeira';

const MODULO = '@/lib/agent-engine/agent/links-da-resposta-do-caso';
const carregar = () => import(/* @vite-ignore */ MODULO) as Promise<{
  lerLinksDaRespostaDoCaso: (db: Queryable, input: typeof entrada) => Promise<readonly string[]>;
}>;
const LINK = 'https://ajuda.exemplo.com.br/casos/curso?plano=anual#pagamento';
const BODY = `A resposta confirmada está em ${LINK}. O valor citado foi R$ 499,00.`;
const entrada = {
  tenantId: 'org-prova', contactId: 'contato-prova', conversationId: 'conversa-prova', jobId: 'job-prova',
  respostaDoCaso: { caseId: 'caso-prova', action: 'resolved', body: BODY },
};

function linha(mudancas: Record<string, unknown> = {}) {
  return {
    organization_id: entrada.tenantId, case_id: entrada.respostaDoCaso.caseId,
    conversation_id: entrada.conversationId, contact_id: entrada.contactId,
    status: 'resolved', event_organization_id: entrada.tenantId, event_case_id: entrada.respostaDoCaso.caseId,
    kind: 'human_replied', actor_kind: 'human', actor_user_id: 'atendente-autorizada',
    human_action: 'resolved', body: BODY, reply_precedes_job: true, no_later_transition: true,
    job_kind: 'case_reply_turn', job_case_id: entrada.respostaDoCaso.caseId,
    job_action: 'resolved', job_body: BODY,
    ...mudancas,
  };
}

async function ler(mudancas: Record<string, unknown> = {}, alvo = entrada) {
  const query = vi.fn().mockResolvedValue({ rows: [linha(mudancas)] });
  const { lerLinksDaRespostaDoCaso } = await carregar();
  const links = await lerLinksDaRespostaDoCaso({ query } as unknown as Queryable, alvo);
  return { links, query };
}

function contexto(body: string, urls: readonly string[]): GateContext {
  const links = new Set(urls.map(normalizarLink));
  // Os dois gates exercitados só consomem body/travasDeEnvio; não há envio aqui.
  return { body, travasDeEnvio: {
    linkPermitido: { liberados: links, dominios: [] },
    linkEValorDeFerramenta: { links, valores: new Set<number>() },
  } } as unknown as GateContext;
}

describe('G3 — evidência da resposta humana do caso', () => {
  it('reconhece a URL literal persistida, sem extrair valor ou domínio', async () => {
    const { links } = await ler();
    expect(links).toEqual([LINK]);
    expect(linkPermitidoGate.evaluate(contexto(LINK, links))).toEqual({ pass: true });
    expect(linkEValorDeFerramentaGate.evaluate(contexto(LINK, links))).toEqual({ pass: true });
  });

  it.each([
    ['outra organização do caso', { organization_id: 'org-errada' }],
    ['outra organização do evento', { event_organization_id: 'org-errada' }],
    ['outro caso', { case_id: 'caso-errado' }],
    ['evento de outro caso', { event_case_id: 'caso-errado' }],
    ['outro contato', { contact_id: 'contato-errado' }],
    ['outra conversa', { conversation_id: 'conversa-errada' }],
    ['nota comum', { kind: 'note_added' }],
    ['resposta do agente', { actor_kind: 'agent' }],
    ['resposta do cliente', { actor_kind: 'lead' }],
    ['sem atendente identificada', { actor_user_id: null }],
    ['ação de assumir/escalar', { human_action: 'escalate' }],
    ['caso escalado', { status: 'escalated' }],
    ['caso cancelado', { status: 'cancelled' }],
    ['caso reaberto', { status: 'awaiting_human' }],
    ['outra resposta concorrente', { body: `${BODY} Mais recente.` }],
    ['resposta posterior ao job antigo', { reply_precedes_job: false }],
    ['caso reaberto e concluído novamente por outra ação', { no_later_transition: false }],
    ['job de outro tipo', { job_kind: 'inbound_turn' }],
    ['job de outro caso', { job_case_id: 'caso-errado' }],
    ['job de outra ação', { job_action: 'need_lead_info' }],
    ['job com texto diferente', { job_body: `${BODY} Alterado.` }],
  ])('recusa %s', async (_nome, mudancas) => {
    expect((await ler(mudancas)).links).toEqual([]);
  });

  it('aceita pedir informação só no estado awaiting_lead correspondente', async () => {
    const alvo = { ...entrada, respostaDoCaso: { ...entrada.respostaDoCaso, action: 'need_lead_info' } };
    expect((await ler({ status: 'awaiting_lead', human_action: 'need_lead_info', job_action: 'need_lead_info' }, alvo)).links).toEqual([LINK]);
    expect((await ler({}, alvo)).links).toEqual([]);
  });

  it('recusa referência sem corpo ou ação que não produz reentrada', async () => {
    const { lerLinksDaRespostaDoCaso } = await carregar();
    const query = vi.fn();
    for (const referencia of [undefined, { caseId: 'caso-prova', action: 'resolved', body: '' },
      { caseId: 'caso-prova', action: 'escalate', body: BODY }]) {
      expect(await lerLinksDaRespostaDoCaso({ query } as unknown as Queryable,
        { ...entrada, respostaDoCaso: referencia } as typeof entrada)).toEqual([]);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('consulta o job persistido e o último evento, sem escolher uma resposta antiga que combine', async () => {
    const { query } = await ler();
    const [sql, valores] = query.mock.calls[0]!;
    expect(valores).toEqual([entrada.tenantId, entrada.contactId, entrada.conversationId, entrada.jobId,
      entrada.respostaDoCaso.caseId]);
    expect(sql).toContain('j.organization_id = $1');
    expect(sql).toContain('j.contact_id = $2');
    expect(sql).toContain('conv.contact_id = $2');
    expect(sql).toContain('conv.id = $3');
    expect(sql).toContain('j.id = $4');
    expect(sql).toContain('ac.id = $5');
    expect(sql).toContain('e.created_at <= j.created_at');
    expect(sql).toMatch(/order by ae.created_at desc, ae.id desc\s+limit 1/);
    expect(sql).not.toMatch(/where[^;]*ae\.body\s*=/);
  });

  it('sem evento ou erro de leitura não dá autorização implícita', async () => {
    const { lerLinksDaRespostaDoCaso } = await carregar();
    const vazio = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Queryable;
    expect(await lerLinksDaRespostaDoCaso(vazio, entrada)).toEqual([]);
    const quebrado = { query: vi.fn().mockRejectedValue(new Error('banco indisponível')) } as unknown as Queryable;
    await expect(lerLinksDaRespostaDoCaso(quebrado, entrada)).rejects.toThrow('banco indisponível');
  });

  it.each([
    'https://outro.exemplo.com.br/casos/curso?plano=anual#pagamento',
    'https://ajuda.exemplo.com.br/casos/outro?plano=anual#pagamento',
    'https://ajuda.exemplo.com.br/casos/curso?plano=vitalicio#pagamento',
    'https://ajuda.exemplo.com.br/casos/curso?plano=anual#outro',
    'https://ajuda.exemplo.com.br',
  ])('não autoriza variante inventada: %s', async (alterado) => {
    const { links } = await ler();
    expect(linkPermitidoGate.evaluate(contexto(alterado, links)).pass).toBe(false);
    expect(linkEValorDeFerramentaGate.evaluate(contexto(alterado, links)).pass).toBe(false);
  });

  it('o valor citado na resposta humana continua vetado e não confirma pagamento', async () => {
    const { links } = await ler();
    const veredito = linkEValorDeFerramentaGate.evaluate(contexto(`O valor é R$ 499,00. ${LINK}`, links));
    expect(veredito.pass).toBe(false);
    expect(veredito).toMatchObject({ detail: { links: 0, valores: 1 } });
    expect(() => recusarEscritaFinanceiraGenerica({ pagamento_confirmado: true }, 'fixture')).toThrow();
  });
});
