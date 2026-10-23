import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/external-db/acesso', () => ({ abrirAcesso: vi.fn() }));
vi.mock('@/lib/agent-engine/edge/crm/card-do-contato', () => ({ lerCardDoContato: vi.fn() }));
vi.mock('@/lib/agent-engine/db/request-pool', () => ({ getRequestPool: () => ({ query: vi.fn() }) }));
import { abrirAcesso } from '@/lib/external-db/acesso';
import { lerCardDoContato } from '@/lib/agent-engine/edge/crm/card-do-contato';
import type { ConexaoExterna, PedidoDeLeitura } from '@/lib/external-db/types';
import type { McpContext } from '../types';
import { crmQueryExternalData } from './dados-externos';

const org = '11111111-1111-4111-8111-111111111111';
const connection = '22222222-2222-4222-8222-222222222222';
const contact = '33333333-3333-4333-8333-333333333333';
let policy: unknown, settingsError: unknown;
const lerTabela = vi.fn();
const colunas = new Set(['url', 'assunto', 'escolaridade', 'empresa', 'so_inscrito_tp2026', 'duvida']);
const perfil = { escolaridade: 'Só ensino médio', empresa_alvo: 'Transpetro', inscrito_tp2026: 'Sim' };
const assunto = { coluna: 'assunto', operador: 'eq', valor: 'como_estudar' } as const;
const input = { schema: 'c01', tabela: 'agente_videos_canal', filtros: [assunto], limite: 100 };
function ctx(comContato = true): McpContext {
  return { organizationId: org, contatoDoTurno: comContato ? contact : undefined,
    supabase: { from(table: string) {
      const chain = {
        select: vi.fn(() => chain), eq: vi.fn(() => chain),
        order: vi.fn(async () => ({ data: [{ id: connection, label: 'Base', db_type: 'postgres' }], error: null })),
        maybeSingle: vi.fn(async () => ({ data: { settings: { c01_contextual_catalog: policy } }, error: settingsError })),
      };
      if (!['external_db_connections_safe', 'organizations'].includes(table)) throw new Error('Tabela não esperada');
      return chain;
    } },
  } as unknown as McpContext;
}
async function consultar(filtros: Parameters<typeof crmQueryExternalData.handler>[0]['filtros'] = [assunto], context = ctx(), tabela = input.tabela) {
  return await crmQueryExternalData.handler({ ...input, filtros, tabela }, context) as Record<string, unknown>;
}
function filtrosLidos(n = 0) { return (lerTabela.mock.calls[n]![0] as PedidoDeLeitura).filtros; }
beforeEach(() => {
  vi.resetAllMocks(); settingsError = null;
  policy = { enabled: true, connection_id: connection };
  vi.mocked(abrirAcesso).mockResolvedValue({ ok: true,
    conexao: { id: connection, organizationId: org, label: 'Base', dbType: 'postgres', sourceMode: 'all', fontes: [],
      chaveDoCliente: null, maxRows: 200, maxFilters: 20, maxResponseBytes: 30000 } as unknown as ConexaoExterna,
    dialeto: { listarTabelas: vi.fn(), colunasDaTabela: vi.fn(async () => colunas), lerTabela } as never });
  vi.mocked(lerCardDoContato).mockResolvedValue({ id: 'card', status: 'open', etapa: 'qualifying',
    campos: { ...perfil }, etiquetas: [], ordemDoFunil: [] });
  lerTabela.mockResolvedValue({ colunas: ['url'], linhas: [{ url: 'https://example.invalid/estudo' }], limite: 20 });
});
describe('A5: perfil do card na consulta de vídeos, ativação explícita', () => {
  it('substitui filtros sugeridos pelo modelo com os campos reais do contato do turno', async () => {
    await consultar([assunto, { coluna: 'escolaridade', operador: 'eq', valor: 'Engenharia' },
      { coluna: 'empresa', operador: 'ne', valor: 'Transpetro' }, { coluna: 'so_inscrito_tp2026', operador: 'eq', valor: false }]);
    expect(lerCardDoContato).toHaveBeenCalledWith(expect.anything(), org, contact);
    expect(filtrosLidos()).toEqual([assunto,
      { coluna: 'escolaridade', operador: 'eq', valor: 'Só ensino médio' },
      { coluna: 'empresa', operador: 'eq', valor: 'Transpetro' },
      { coluna: 'so_inscrito_tp2026', operador: 'eq', valor: true }]);
    expect(lerTabela.mock.calls[0]![0].limite).toBe(20);
  });
  it('vazio da consulta exclusiva permite só retirar so_inscrito, preservando assunto e perfil', async () => {
    lerTabela.mockResolvedValueOnce({ colunas: ['url'], linhas: [], limite: 20 });
    const r = await consultar();
    expect(lerTabela).toHaveBeenCalledTimes(2);
    expect(filtrosLidos(1)).toEqual(filtrosLidos(0).filter(f => f.coluna !== 'so_inscrito_tp2026'));
    expect(r.perfil_do_card).toEqual({ aplicado: true, ampliou_inscricao: true });
  });
  it('falha da fonte não vira vazio nem repete consulta ampliada', async () => {
    lerTabela.mockRejectedValueOnce(new Error('offline'));
    expect((await consultar()).erro).toBe('indisponivel');
    expect(lerTabela).toHaveBeenCalledTimes(1);
  });
  it.each([null, {}, { enabled: false, connection_id: connection },
    { enabled: true, connection_id: '44444444-4444-4444-8444-444444444444' }])('sem ativação aplicável mantém legado (%j)', async p => {
    policy = p;
    await consultar(); expect(filtrosLidos()).toEqual([assunto]);
    expect(lerCardDoContato).not.toHaveBeenCalled();
  });
  it('fora de turno ou em outra tabela não consulta o card nem modifica o pedido', async () => {
    await consultar([assunto], ctx(false));
    await consultar([assunto], ctx(), 'outra_view');
    expect(lerCardDoContato).not.toHaveBeenCalled();
    expect(filtrosLidos()).toEqual([assunto]); expect(filtrosLidos(1)).toEqual([assunto]);
  });
  it('campo vazio usa não sei; não inventa inscrição', async () => {
    vi.mocked(lerCardDoContato).mockResolvedValue({ id: 'card', status: 'open', etapa: null, campos: {}, etiquetas: [], ordemDoFunil: [] });
    await consultar();
    expect(filtrosLidos()).toEqual([assunto, { coluna: 'escolaridade', operador: 'eq', valor: 'não sei' },
      { coluna: 'empresa', operador: 'eq', valor: 'não sei' }]);
  });
  it('sem card único não usa o perfil inventado pelo modelo', async () => {
    vi.mocked(lerCardDoContato).mockResolvedValue(null);
    expect((await consultar()).erro).toBe('perfil_do_card_indisponivel');
    expect(lerTabela).not.toHaveBeenCalled();
  });
  it('valor inválido no card não amplia para todos os perfis', async () => {
    vi.mocked(lerCardDoContato).mockResolvedValue({ id: 'card', status: 'open', etapa: null,
      campos: { ...perfil, escolaridade: 'texto arbitrário' }, etiquetas: [], ordemDoFunil: [] });
    expect((await consultar()).erro).toBe('perfil_do_card_invalido');
    expect(lerTabela).not.toHaveBeenCalled();
  });
  it('sem assunto claro pede consulta específica, sem inventar intenção', async () => {
    expect((await consultar([])).erro).toBe('assunto_do_video_invalido');
    expect(lerTabela).not.toHaveBeenCalled();
  });
  it('falha lendo configuração bloqueia só a consulta contextual candidata', async () => {
    settingsError = { message: 'indisponível' };
    expect((await consultar()).erro).toBe('perfil_do_card_indisponivel');
    expect(lerTabela).not.toHaveBeenCalled();
  });
});
