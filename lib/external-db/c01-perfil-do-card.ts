/** A5: o perfil vem do card do contato do turno; nunca dos argumentos do modelo.
 * Opt-in por organização/conexão. Não amplia tabelas, permissões ou dados pessoais.
 */
import { z } from 'zod';
import { getRequestPool } from '@/lib/agent-engine/db/request-pool';
import { lerCardDoContato } from '@/lib/agent-engine/edge/crm/card-do-contato';
import type { McpContext } from '@/lib/mcp/types';
import type { FiltroDeLeitura } from './types';

const configSchema = z.object({ enabled: z.boolean(), connection_id: z.uuid() }).strict();
const ESCOLARIDADES = new Set(['Só ensino médio', 'Curso técnico', 'Tecnólogo', 'Engenharia', 'Outro superior', 'Cursando', 'não sei']);
const EMPRESAS = new Set(['Petrobras', 'Transpetro', 'As duas', 'não sei']);
const ASSUNTOS = new Set(['conhecer_o_concurso', 'carreira_e_salario', 'requisitos_e_formacao', 'escolher_area',
  'edital_e_prova', 'como_estudar', 'motivacao', 'noticia']);
const PERFIL = new Set(['escolaridade', 'empresa', 'so_inscrito_tp2026']);
type ResolucaoPerfil = { ativo: false } | { ativo: true; filtros: FiltroDeLeitura[]; inscrito: boolean }
  | { erro: string; mensagem: string };
const indisponivel = (): ResolucaoPerfil => ({ erro: 'perfil_do_card_indisponivel',
  mensagem: 'Não foi possível confirmar o perfil no card desta conversa. Não escolha outro perfil para obter um vídeo.' });
const vazio = (v: unknown) => v === undefined || v === null || v === '';

export async function resolverPerfilVideosC01(ctx: McpContext, connectionId: string,
  schema: string, tabela: string, filtros: FiltroDeLeitura[]): Promise<ResolucaoPerfil> {
  // Os demais conectores e o MCP fora da conversa mantêm o contrato existente.
  if (!ctx.contatoDoTurno || schema !== 'c01' || tabela !== 'agente_videos_canal') return { ativo: false };
  try {
    const { data, error } = await ctx.supabase.from('organizations').select('settings')
      .eq('id', ctx.organizationId).maybeSingle();
    if (error || !data) return indisponivel();
    const raw = data.settings?.c01_contextual_catalog;
    if (!raw || raw.enabled !== true) return { ativo: false };
    const config = configSchema.safeParse(raw);
    if (!config.success) return indisponivel();
    if (config.data.connection_id !== connectionId) return { ativo: false };
    const assuntos = filtros.filter(f => f.coluna === 'assunto');
    if (assuntos.length !== 1 || assuntos[0]?.operador !== 'eq' || typeof assuntos[0]?.valor !== 'string'
      || !ASSUNTOS.has(assuntos[0].valor)) {
      return { erro: 'assunto_do_video_invalido', mensagem: 'Informe um único assunto válido da dúvida atual. O perfil será lido do card.' };
    }
    const card = await lerCardDoContato(getRequestPool(), ctx.organizationId, ctx.contatoDoTurno);
    if (!card) return indisponivel();
    const escolaridade = vazio(card.campos.escolaridade) ? 'não sei' : card.campos.escolaridade;
    const empresa = vazio(card.campos.empresa_alvo) ? 'não sei' : card.campos.empresa_alvo;
    const inscricao = card.campos.inscrito_tp2026;
    if (typeof escolaridade !== 'string' || !ESCOLARIDADES.has(escolaridade)
      || typeof empresa !== 'string' || !EMPRESAS.has(empresa)
      || (!vazio(inscricao) && !['Sim', 'Não', 'Não sabe'].includes(String(inscricao)))) {
      return { erro: 'perfil_do_card_invalido', mensagem: 'O card tem um valor de perfil fora das opções previstas. Não invente uma equivalência nem remova os filtros.' };
    }
    const inscrito = inscricao === 'Sim';
    return { ativo: true, inscrito, filtros: [
      ...filtros.filter(f => !PERFIL.has(f.coluna)),
      { coluna: 'escolaridade', operador: 'eq', valor: escolaridade },
      { coluna: 'empresa', operador: 'eq', valor: empresa },
      ...(inscrito ? [{ coluna: 'so_inscrito_tp2026', operador: 'eq' as const, valor: true }] : []),
    ] };
  } catch { return indisponivel(); }
}
