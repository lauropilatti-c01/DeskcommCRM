/**
 * (C01, -c01.15, P1) O PEDIDO DE UMA PESSOA COM A PASSAGEM DESLIGADA NÃO CALA A CONVERSA.
 *
 * O defeito: com a "ferramenta de passagem" desligada na tela do agente
 * (`handoff_tool_enabled = false`), o pedido do cliente por uma pessoa (padrões fixos de
 * `detectHumanHandoffRequest` ou palavra configurada, `matchesHandoffKeyword`) ainda
 * rodava `performHumanHandoff`: `force_human`, `bot_silenced_until = 'infinity'` e o aviso
 * de que uma pessoa ia assumir. Na C01 a equipe atende pelo caso, não pela conversa: o
 * cliente ficava sem resposta até alguém devolver o atendimento à mão.
 *
 * A correção (`lib/c01/passagem-desligada.ts`): com a passagem desligada o pedido abre um
 * caso (source 'agent', com a fala do cliente no resumo), move o card para a etapa de
 * passagem (best-effort) e o turno segue — no assistido, o rascunho; no automático, o
 * modelo, com o bloco "o caso já foi aberto; diga que vai verificar e já retorna".
 * Com a passagem ligada, nada muda. O STOP ambíguo ("SAIR"), logo depois, também não.
 *
 * O modo assistido é provado pelo caminho de produção (`createInboundTurnHandler` e
 * `runAgentTurn`), com o mesmo harness de `assistido-roda-as-deteccoes.test.ts`. O
 * automático exigiria montar o turno inteiro até o modelo; ali a prova é pela fiação do
 * código, como em `c01-blocos-sem-promessa-de-retorno.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublishedAgentConfig } from '@/lib/agent-engine/agent/agent-config';

const mocks = vi.hoisted(() => ({
  router: vi.fn(),
  classify: vi.fn(),
  byId: vi.fn(),
  bySession: vi.fn(),
  conversationAgent: vi.fn(),
  draft: vi.fn(),
  passagem: vi.fn(),
  aviso: vi.fn(),
  avisoLendo: vi.fn(),
  cancel: vi.fn(),
  emHandoff: vi.fn(),
  elegibilidade: vi.fn(),
  leadContext: vi.fn(),
  mover: vi.fn(),
}));

vi.mock('@/lib/agent-engine/agent/router-config', () => ({ loadActiveRouter: mocks.router }));
vi.mock('@/lib/agent-engine/agent/intent-classifier', () => ({ classifyIntent: mocks.classify }));
vi.mock('@/lib/agent-engine/agent/agent-config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPublishedAgentConfigById: mocks.byId,
  loadPublishedAgentConfig: mocks.bySession,
  loadConversationAgentConfig: mocks.conversationAgent,
}));
vi.mock('@/lib/agent-engine/agent/reply-drafts', () => ({ generateReplyDraft: mocks.draft }));
vi.mock('@/lib/atendimento/fronteira-server', () => ({
  currentExecutionBoundary: () => undefined,
  setExecutionAgentOperation: vi.fn(),
  guardServiceEffect: vi.fn(),
}));
vi.mock('@/lib/agent-engine/agent/human-handoff', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLeadInHandoff: mocks.emHandoff,
  performHumanHandoff: mocks.passagem,
}));
vi.mock('@/lib/agent-engine/agent/aviso-de-escalacao', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  avisarLeadDaEscalacao: mocks.aviso,
  avisarLeadLendoOContato: mocks.avisoLendo,
}));
vi.mock('@/lib/agent-engine/cron/scheduler', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cancelPendingCronsForLead: mocks.cancel,
}));
vi.mock('@/lib/agent-engine/edge/crm/get-lead-context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLeadContext: mocks.leadContext,
}));
vi.mock('@/lib/agent-engine/guardrails/camadas-da-org', () => ({
  lerCamadasDaOrg: vi.fn(async () => ({})),
  camadaLigada: vi.fn(() => false),
}));
vi.mock('@/lib/agent-engine/agent/fuso-da-org', () => ({
  fusoDaOrganizacao: vi.fn(async () => 'UTC'),
}));
vi.mock('@/lib/ai/elegibilidade/consulta-pg', () => ({
  decidirElegibilidadeDaConversa: mocks.elegibilidade,
}));
vi.mock('@/lib/agent-engine/pacing/store', () => ({
  loadChannelKnobs: vi.fn(async () => ({ knobs: {} })),
}));
vi.mock('@/lib/agent-engine/pacing/engine', () => ({
  janelaDeEnvioAberta: () => true,
  proximaAberturaDaJanela: vi.fn(),
}));
vi.mock('@/lib/agent-engine/pacing/aviso-de-janela', () => ({
  resolverAvisoDeJanela: vi.fn(async () => 0),
  avisarJanelaFechada: vi.fn(),
}));
// A etapa de passagem do card: best-effort, numa promessa adiada (`abrirCasoDoPedidoDePessoa`).
vi.mock('@/lib/leads/handoff-stage-move', () => ({ moverLeadParaEtapaDeHandoff: mocks.mover }));
vi.mock('@/lib/supabase/admin', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createAdminClient: vi.fn(() => ({ admin: 'falso' })),
}));

import {
  createInboundTurnHandler,
  runAgentTurn,
  type InboundTurnDeps,
} from '@/lib/agent-engine/agent/inbound-turn';
import {
  abrirCasoDoPedidoDePessoa,
  BLOCO_DO_PEDIDO_DE_PESSOA_SEM_PASSAGEM,
  TITULO_DO_CASO_DO_PEDIDO_DE_PESSOA,
} from '@/lib/c01/passagem-desligada';

const ids = {
  org: '11000000-0000-4000-8000-000000000001',
  contact: '11000000-0000-4000-8000-000000000002',
  conversation: '11000000-0000-4000-8000-000000000003',
  channel: '11000000-0000-4000-8000-000000000004',
  job: '11000000-0000-4000-8000-000000000005',
  mensagem: '11000000-0000-4000-8000-000000000006',
  evento: '11000000-0000-4000-8000-000000000007',
  followup: '11000000-0000-4000-8000-000000000008',
};

const inbound = {
  id: ids.job,
  organization_id: ids.org,
  contact_id: ids.contact,
  kind: 'inbound_turn',
  payload: {
    conversation_id: ids.conversation,
    contact_id: ids.contact,
    channel_session_id: ids.channel,
    inbound_message_id: ids.mensagem,
    crm_event_id: ids.evento,
  },
};

const followup = {
  id: ids.followup,
  organization_id: ids.org,
  contact_id: ids.contact,
  kind: 'followup_turn',
  payload: { conversation_id: ids.conversation, contact_id: ids.contact },
};

const deps = {
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  llmCfg: {},
  crmCfg: {},
  knobs: {},
  channel: () => ({ send: vi.fn(async () => ({ kind: 'sent' })) }),
} as unknown as InboundTurnDeps;

function assistido(handoffToolEnabled: boolean): PublishedAgentConfig {
  return {
    agentId: 'A',
    versionId: 'version-A',
    operationRevision: '7',
    operationMode: 'assisted',
    pausedAt: null,
    handoffKeywords: ['suporte'],
    handoffToolEnabled,
  } as PublishedAgentConfig;
}

/** O insert de `openCase`: `rows` com o id do caso novo, ou vazio quando já havia um aberto. */
type InsertDoCaso = () => Promise<{ rows: Array<{ case_id: string }> }>;

function pool(agente: PublishedAgentConfig, insertDoCaso?: InsertDoCaso) {
  mocks.router.mockResolvedValue(null);
  mocks.byId.mockResolvedValue(agente);
  mocks.bySession.mockResolvedValue(agente);
  mocks.conversationAgent.mockResolvedValue(agente);
  return {
    query: vi.fn(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('insert into agent_cases')) {
        return insertDoCaso ? insertDoCaso() : { rows: [{ case_id: 'caso-1' }] };
      }
      if (typeof sql === 'string' && sql.includes('lead_checkpoints')) return { rows: [] };
      return { rows: [{ active_ai_agent_id: null, active_intent: null, body: 'oi' }] };
    }),
  };
}

function contexto(mensagens: Array<{ direction: 'inbound' | 'outbound'; body: string }>) {
  return {
    ok: true,
    tokenCount: 12,
    lgpd: { isAnonymized: false },
    context: {
      lead_id: ids.contact,
      contact: { name: 'Cliente', phone: null, email: null, tags: [], is_blocked: false },
      conversation_id: ids.conversation,
      last_human_decision: null,
      messages: mensagens,
    },
  };
}

/** Os inserts de caso que o turno fez, com os parâmetros na ordem de `openCase`. */
function casosAbertos(p: ReturnType<typeof pool>): unknown[][] {
  return p.query.mock.calls
    .filter(([sql]) => typeof sql === 'string' && sql.includes('insert into agent_cases'))
    .map((chamada) => (chamada as unknown as [string, unknown[]])[1]);
}

/** Nenhuma escrita de silêncio na conversa (o `performHumanHandoff` real é o que as faz). */
function escritasDeSilencio(p: ReturnType<typeof pool>): string[] {
  return p.query.mock.calls
    .map(([sql]) => String(sql))
    .filter((sql) => /update\s+conversations/i.test(sql) && /force_human|bot_silenced_until/.test(sql));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emHandoff.mockResolvedValue(false);
  mocks.elegibilidade.mockResolvedValue({ permite: true, motivo: 'gate_aberto' });
  mocks.aviso.mockResolvedValue({ avisado: true });
  mocks.avisoLendo.mockResolvedValue({ avisado: true });
  mocks.passagem.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(2);
  mocks.mover.mockResolvedValue(undefined);
  mocks.leadContext.mockResolvedValue(contexto([{ direction: 'inbound', body: 'oi, tudo bem?' }]));
});

describe('(C01, -c01.15, P1) modo assistido com a passagem desligada', () => {
  it('pedido explícito de uma pessoa → caso aberto com a fala do cliente, card movido, rascunho segue; sem passagem e sem aviso', async () => {
    mocks.leadContext.mockResolvedValue(
      contexto([{ direction: 'inbound', body: 'quero falar com uma pessoa' }]),
    );
    const p = pool(assistido(false));
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(mocks.passagem, 'com a passagem desligada nada silencia').not.toHaveBeenCalled();
    expect(mocks.aviso, 'nenhum "uma pessoa vai assumir"').not.toHaveBeenCalled();
    expect(mocks.avisoLendo).not.toHaveBeenCalled();
    expect(escritasDeSilencio(p)).toEqual([]);

    const casos = casosAbertos(p);
    expect(casos).toHaveLength(1);
    const [org, conversa, agente, titulo, resumo, , , origem] = casos[0]!;
    expect([org, conversa, agente]).toEqual([ids.org, ids.conversation, 'A']);
    expect(titulo).toBe(TITULO_DO_CASO_DO_PEDIDO_DE_PESSOA);
    expect(resumo).toContain('"quero falar com uma pessoa"');
    expect(origem).toBe('agent');

    await vi.waitFor(() => expect(mocks.mover).toHaveBeenCalledTimes(1));
    expect(mocks.mover).toHaveBeenCalledWith(
      { admin: 'falso' },
      { organizationId: ids.org, leadId: ids.contact, reason: 'pedido_de_pessoa_sem_passagem' },
    );

    expect(mocks.draft, 'o rascunho segue para a aprovação humana').toHaveBeenCalledTimes(1);
  });

  it('o modo é respeitado: depois do caso, o resultado é RASCUNHO para o atendente aprovar — nada sai ao cliente, nem o modelo do automático roda', async () => {
    mocks.leadContext.mockResolvedValue(
      contexto([{ direction: 'inbound', body: 'quero falar com um atendente' }]),
    );
    const enviado = vi.fn(async () => ({ kind: 'sent' }));
    const p = pool(assistido(false));
    await createInboundTurnHandler({ ...deps, channel: () => ({ send: enviado }) } as unknown as InboundTurnDeps)(
      inbound as never,
      p as never,
      { workerId: 'w' },
    );

    expect(casosAbertos(p)).toHaveLength(1);
    // O rascunho, com o agente assistido: é ele que vai para a fila de aprovação.
    expect(mocks.draft).toHaveBeenCalledTimes(1);
    expect(mocks.draft).toHaveBeenCalledWith(
      p,
      expect.anything(),
      expect.objectContaining({
        organizationId: ids.org,
        conversationId: ids.conversation,
        agent: expect.objectContaining({ operationMode: 'assisted' }),
      }),
    );
    // Nada sai ao cliente sem aprovação: nem pelo canal, nem por aviso, nem pelo ledger de envio.
    expect(enviado).not.toHaveBeenCalled();
    expect(mocks.aviso).not.toHaveBeenCalled();
    expect(mocks.avisoLendo).not.toHaveBeenCalled();
    const sqls = p.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.filter((sql) => /send_ledger|insert into messages/i.test(sql))).toEqual([]);
  });

  it('palavra-chave configurada → o mesmo caminho: caso aberto e rascunho, sem passagem', async () => {
    mocks.leadContext.mockResolvedValue(
      contexto([{ direction: 'inbound', body: 'abre um chamado no suporte pra mim' }]),
    );
    const p = pool(assistido(false));
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(casosAbertos(p)).toHaveLength(1);
    expect(mocks.passagem).not.toHaveBeenCalled();
    expect(mocks.draft).toHaveBeenCalledTimes(1);
  });

  it('caso já aberto na conversa (`case_already_open`) é sucesso: o rascunho segue do mesmo jeito', async () => {
    mocks.leadContext.mockResolvedValue(
      contexto([{ direction: 'inbound', body: 'quero falar com uma pessoa' }]),
    );
    const p = pool(assistido(false), async () => ({ rows: [] }));
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(casosAbertos(p)).toHaveLength(1);
    expect(mocks.passagem).not.toHaveBeenCalled();
    expect(mocks.draft).toHaveBeenCalledTimes(1);
  });

  it('erro de banco ao abrir o caso sobe (o job re-tenta): sem rascunho e sem passagem', async () => {
    mocks.leadContext.mockResolvedValue(
      contexto([{ direction: 'inbound', body: 'quero falar com uma pessoa' }]),
    );
    const falha = new Error('banco fora');
    const p = pool(assistido(false), async () => {
      throw falha;
    });
    await expect(
      createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' }),
    ).rejects.toBe(falha);

    expect(mocks.passagem).not.toHaveBeenCalled();
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  it('follow-up de agente assistido com o pedido pendente: caso aberto e o rascunho sai', async () => {
    mocks.leadContext.mockResolvedValue(
      contexto([{ direction: 'inbound', body: 'quero falar com uma pessoa' }]),
    );
    const agente = assistido(false);
    const p = pool(agente);
    await runAgentTurn(
      deps,
      followup as never,
      p as never,
      { workerId: 'w' },
      {
        resolvedAgent: {
          config: agente,
          routerId: null,
          intentName: null,
          confidence: null,
          outcome: 'fallback',
        },
        channelSessionId: ids.channel,
        conversationId: ids.conversation,
        buildOpening: () => '',
      } as never,
    );

    expect(casosAbertos(p)).toHaveLength(1);
    expect(mocks.passagem).not.toHaveBeenCalled();
    expect(mocks.draft).toHaveBeenCalledTimes(1);
  });

  it('STOP ambíguo ("SAIR") não muda: aviso de opt-out + passagem de opt-out, sem caso e sem rascunho', async () => {
    mocks.leadContext.mockResolvedValue(contexto([{ direction: 'inbound', body: 'SAIR' }]));
    const p = pool(assistido(false));
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(mocks.aviso).toHaveBeenCalledTimes(1);
    expect(mocks.aviso.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ motivo: 'suspeita_de_opt_out' }),
    );
    expect(mocks.passagem).toHaveBeenCalledTimes(1);
    expect(mocks.passagem).toHaveBeenCalledWith(
      p,
      { tenantId: ids.org, leadId: ids.contact, conversationId: ids.conversation },
      expect.objectContaining({ reason: 'suspected_optout' }),
    );
    expect(casosAbertos(p)).toEqual([]);
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  it('rajada com pedido de pessoa e "SAIR": o caso abre e o STOP, logo depois, ainda silencia', async () => {
    mocks.leadContext.mockResolvedValue(
      contexto([
        { direction: 'inbound', body: 'quero falar com uma pessoa' },
        { direction: 'inbound', body: 'SAIR' },
      ]),
    );
    const p = pool(assistido(false));
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(casosAbertos(p)).toHaveLength(1);
    expect(mocks.passagem).toHaveBeenCalledTimes(1);
    expect(mocks.passagem).toHaveBeenCalledWith(
      p,
      { tenantId: ids.org, leadId: ids.contact, conversationId: ids.conversation },
      expect.objectContaining({ reason: 'suspected_optout' }),
    );
    expect(mocks.draft).not.toHaveBeenCalled();
  });
});

describe('(C01, -c01.15, P1) modo assistido com a passagem LIGADA: nada muda', () => {
  it('pedido explícito de uma pessoa → aviso + passagem `requested_human`, sem caso e sem rascunho', async () => {
    mocks.leadContext.mockResolvedValue(
      contexto([{ direction: 'inbound', body: 'quero falar com uma pessoa' }]),
    );
    const p = pool(assistido(true));
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(mocks.aviso).toHaveBeenCalledTimes(1);
    expect(mocks.aviso.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ motivo: 'pediu_humano' }));
    expect(mocks.passagem).toHaveBeenCalledWith(
      p,
      { tenantId: ids.org, leadId: ids.contact, conversationId: ids.conversation },
      expect.objectContaining({
        reason: 'requested_human',
        passagem: expect.objectContaining({ origem: 'pedido_explicito' }),
      }),
    );
    expect(casosAbertos(p)).toEqual([]);
    expect(mocks.mover).not.toHaveBeenCalled();
    expect(mocks.draft).not.toHaveBeenCalled();
  });

  it('mensagem comum com a passagem desligada → o rascunho sai e nada é aberto (controle)', async () => {
    const p = pool(assistido(false));
    await createInboundTurnHandler(deps)(inbound as never, p as never, { workerId: 'w' });

    expect(mocks.draft).toHaveBeenCalledTimes(1);
    expect(casosAbertos(p)).toEqual([]);
    expect(mocks.passagem).not.toHaveBeenCalled();
    expect(mocks.aviso).not.toHaveBeenCalled();
  });
});

describe('(C01, -c01.15, P1) `abrirCasoDoPedidoDePessoa`, sozinha', () => {
  const log = { info: vi.fn(), warn: vi.fn() };
  const idsDoCaso = {
    tenantId: ids.org,
    leadId: ids.contact,
    conversationId: ids.conversation,
    agentId: 'A',
  };

  it('caso novo → `jaHavia: false`; a fala de cada mensagem pendente vai entre aspas no resumo', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ case_id: 'caso-1' }] })) };
    const r = await abrirCasoDoPedidoDePessoa(db as never, idsDoCaso, {
      pendentes: ['oi', '  quero falar com um atendente  ', ''],
      log,
    });
    expect(r).toEqual({ jaHavia: false });
    const parametros = (db.query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(parametros[4]).toBe(
      'O cliente pediu para falar com uma pessoa. O que ele escreveu:\n"oi"\n"quero falar com um atendente"',
    );
  });

  it('caso já aberto → `jaHavia: true`, sem erro; o card é movido do mesmo jeito', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const r = await abrirCasoDoPedidoDePessoa(db as never, idsDoCaso, {
      pendentes: ['quero falar com um atendente'],
      motivoDaEtapa: 'gancho_sem_passagem',
      log,
    });
    expect(r).toEqual({ jaHavia: true });
    await vi.waitFor(() =>
      expect(mocks.mover).toHaveBeenCalledWith(
        { admin: 'falso' },
        { organizationId: ids.org, leadId: ids.contact, reason: 'gancho_sem_passagem' },
      ),
    );
  });

  it('a falha do card não derruba o caso: vira aviso no log', async () => {
    mocks.mover.mockRejectedValueOnce(new Error('etapa não configurada'));
    const db = { query: vi.fn(async () => ({ rows: [{ case_id: 'caso-1' }] })) };
    await expect(
      abrirCasoDoPedidoDePessoa(db as never, idsDoCaso, { pendentes: ['quero um humano'], log }),
    ).resolves.toEqual({ jaHavia: false });
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(1));
  });
});

/**
 * FIAÇÃO DO AUTOMÁTICO — montar o turno automático inteiro até o modelo pede o banco, o
 * canal e o modelo falsos de ponta a ponta. O que se vigia aqui é a forma do desvio: o
 * ramo da passagem desligada vem ANTES do de sempre, não dá `return`, põe o bloco no
 * contexto do modelo e marca o caso do turno; o STOP ambíguo continua logo depois.
 */
describe('(C01, -c01.15, P1) fiação do turno automático', () => {
  const FONTE = readFileSync(join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'), 'utf8');
  const turno = FONTE.slice(FONTE.indexOf('async function executarTurnoDoAgente('));

  function entre(inicio: string, fim: string): string {
    const i = turno.indexOf(inicio);
    const f = turno.indexOf(fim, i + inicio.length);
    expect(i, `ausente: ${inicio}`).toBeGreaterThan(-1);
    expect(f, `ausente depois de ${inicio}: ${fim}`).toBeGreaterThan(i);
    return turno.slice(i, f);
  }

  it('a passagem desligada é lida do agente do turno antes da detecção do pedido', () => {
    const lida = turno.indexOf('const semPassagem = passagemDesligada(agentConfig);');
    const deteccao = turno.indexOf('if (pediuPessoa && semPassagem) {');
    expect(lida).toBeGreaterThan(-1);
    expect(deteccao).toBeGreaterThan(lida);
  });

  it('o pedido conta com os detectores de sempre, sobre os inbounds pendentes, fora do preview', () => {
    expect(turno).toMatch(
      /const pediuPessoa =\s*!preview &&\s*inboundsPendentes\.some\(\s*\(texto\) =>\s*detectHumanHandoffRequest\(texto\) \|\|\s*\(agentConfig !== null && matchesHandoffKeyword\(texto, agentConfig\.handoffKeywords\)\),?\s*\);/,
    );
  });

  it('sem passagem: abre o caso com a fala pendente, põe o bloco e NÃO silencia nem retorna', () => {
    const ramo = entre('if (pediuPessoa && semPassagem) {', '} else if (pediuPessoa) {');
    expect(ramo).toMatch(/await abrirCasoDoPedidoDePessoa\(\s*pool,/);
    expect(ramo).toMatch(/\{ pendentes: inboundsPendentes, log: runLog \}/);
    expect(ramo).toMatch(/blocoDoPedidoDePessoa = BLOCO_DO_PEDIDO_DE_PESSOA_SEM_PASSAGEM;/);
    expect(ramo).not.toMatch(/performHumanHandoff\(/);
    expect(ramo).not.toMatch(/avisarLeadDaEscalacao\(/);
    expect(ramo).not.toMatch(/\breturn\b/);
  });

  it('com a passagem ligada, o ramo de sempre: aviso, passagem `requested_human` e `return`', () => {
    const ramo = entre('} else if (pediuPessoa) {', '// F4-07: STOP AMBÍGUO');
    expect(ramo).toMatch(/motivo: 'pediu_humano'/);
    expect(ramo).toMatch(/await performHumanHandoff\(/);
    expect(ramo).toMatch(/reason: 'requested_human'/);
    expect(ramo).toMatch(/return; \/\/ bot silencia/);
  });

  it('o STOP ambíguo continua logo depois, intacto, e silencia com ou sem passagem', () => {
    const stop = entre('// F4-07: STOP AMBÍGUO', 'marca.desviosConferidos = true;');
    expect(stop).toMatch(
      /if \(!preview && inboundsPendentes\.some\(\(texto\) => detectAmbiguousOptOut\(texto\)\)\) \{/,
    );
    expect(stop).toMatch(/reason: 'suspected_optout'/);
    expect(stop).not.toMatch(/semPassagem/);
  });

  it('o bloco entra no contexto do modelo e o caso do pedido conta como aberto no turno', () => {
    expect(turno).toMatch(/caseAwaitingLeadBlock,\s*blocoDoPedidoDePessoa,/);
    expect(turno).toMatch(/let openedCaseThisTurn = blocoDoPedidoDePessoa !== '';/);
  });

  it('o bloco manda dizer que vai verificar e já retorna, sem dizer que chamou alguém e sem vender', () => {
    expect(BLOCO_DO_PEDIDO_DE_PESSOA_SEM_PASSAGEM).toMatch(/JÁ foi aberto \(não abra outro\)/);
    expect(BLOCO_DO_PEDIDO_DE_PESSOA_SEM_PASSAGEM).toMatch(/vou verificar e já te retorno/);
    expect(BLOCO_DO_PEDIDO_DE_PESSOA_SEM_PASSAGEM).toMatch(
      /sem dizer que chamou, transferiu ou passou a conversa para alguém/,
    );
    expect(BLOCO_DO_PEDIDO_DE_PESSOA_SEM_PASSAGEM).toMatch(/sem vender neste turno/);
  });
});
