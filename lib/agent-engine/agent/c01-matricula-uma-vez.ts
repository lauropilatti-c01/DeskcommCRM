/** T5 C01. Somente o literal configurado, por página comprovada e conversa.
 * OFF sem configuração. Não grava recibos nem altera preços, copy ou o ledger.
 * Chamado dentro do send de before-send, sob o lock já existente do canal.
 */
import { z } from 'zod';
import type { Queryable } from '../queue/queue';
import { linksNoTexto } from '../guardrails/link-permitido';
import type { ChannelSendResult } from '../channel-adapter';

const schema = z.object({
  enabled: z.literal(true),
  literal: z.string().trim().min(40).max(1000),
  offer_connection_id: z.string().uuid(),
}).strict();
export type PoliticaMatricula = z.infer<typeof schema> | { enabled: false };
export async function lerPoliticaMatricula(db: Queryable, org: string): Promise<PoliticaMatricula> {
  try {
    const { rows } = await db.query<{ policy: unknown }>(
      "select settings->'c01_matricula_once' as policy from organizations where id = $1", [org],
    );
    const result = schema.safeParse(rows[0]?.policy);
    return result.success ? result.data : { enabled: false };
  } catch { return { enabled: false }; }
}
export interface EnvioMatricula {
  job_id: string;
  seq: number;
  body: string;
  status: string | null;
  message_id: string;
  ledger_id: string;
}
type Alvo = { organizationId: string; contactId: string; conversationId: string; jobId: string };
type Resultado = {
  body: string;
  reason: 'none' | 'accepted' | 'pending';
  receipt?: { messageId: string; idempotencyKey: string };
};
/** Uma supressão integral só reutiliza um recibo real, nunca fabrica envio. */
export function reciboDaMatriculaSuprimida(result: Resultado): ChannelSendResult {
  if (result.body || result.reason === 'none' || !result.receipt)
    return { kind: 'unavailable', reason: 'matricula_aguarda_conciliacao' };
  return { kind: result.reason === 'accepted' ? 'already_sent' : 'queued', ...result.receipt };
}
const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
const pattern = (s: string): RegExp => new RegExp(s.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gu');
const strip = (body: string, literal: string): string => body.replace(pattern(literal), '').replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n').trim();

/** Os únicos links candidatos vêm da consulta estruturada de páginas/ofertas.
 * Vídeo ou outro link auxiliar não muda o escopo. Sem página comprovada, legado.
 * O job atual também resolve página enviada em chamada separada. Só um corpo
 * idêntico já registrado mantém o replay do ledger; nova chamada é conferida.
 * db é o client da transação de before-send, nunca o pool com esse client retido.
 */
export async function prepararMatriculaUmaVez(
  db: Queryable, alvo: Alvo, policy: PoliticaMatricula, body: string, paginas: ReadonlySet<string>,
): Promise<Resultado> {
  const unchanged: Resultado = { body, reason: 'none' };
  if (!policy.enabled || !pattern(policy.literal).test(body) || paginas.size === 0) return unchanged;
  let rows: EnvioMatricula[];
  await db.query('savepoint c01_matricula_read');
  try {
    // Sem limite temporal/quantitativo que esqueça a primeira matrícula da conversa.
    // O agrupamento reconstrói o literal se o divisor o separou em várias bolhas.
    rows = (await db.query<EnvioMatricula>(`
      with envios as (
        select sl.job_id, sl.seq, sl.id as ledger_id, m.id as message_id, m.body, m.status
        from send_ledger sl
        join messages m on m.organization_id = sl.organization_id and m.id = sl.crm_message_id
        join conversations c on c.organization_id = m.organization_id and c.id = m.conversation_id
        where sl.organization_id = $1 and sl.contact_id = $2
          and m.conversation_id = $3 and c.contact_id = $2 and m.direction = 'outbound'
      ), candidatos as (
        select job_id from envios group by job_id
        having job_id = $4 or strpos(regexp_replace(string_agg(coalesce(body, ''), ' ' order by seq), '\\s+', ' ', 'g'), $5) > 0
      ) select e.* from envios e join candidatos c using (job_id) order by e.job_id, e.seq`,
    [alvo.organizationId, alvo.contactId, alvo.conversationId, alvo.jobId, normalize(policy.literal)])).rows;
  } catch {
    // A consulta pode abortar a transação; preserva a conexão do canal utilizável.
    await db.query('rollback to savepoint c01_matricula_read');
    // Sem prova não inventamos entrega nem nova tentativa do mesmo literal.
    // A resposta útil e a página permanecem disponíveis; só o fechamento espera.
    return { body: strip(body, policy.literal), reason: 'pending' };
  } finally {
    await db.query('release savepoint c01_matricula_read');
  }
  // O ledger nativo concilia o corpo exato; não mudar sua identidade neste replay.
  if (rows.some(r => r.job_id === alvo.jobId && r.body === body && r.status !== 'failed')) return unchanged;
  const relevantPages = (text: string): string[] => linksNoTexto(text).filter(url => paginas.has(url));
  const currentPages = new Set(relevantPages(body));
  if (currentPages.size === 0) {
    for (const row of rows.filter(r => r.job_id === alvo.jobId)) {
      for (const url of relevantPages(row.body ?? '')) currentPages.add(url);
    }
  }
  if (currentPages.size === 0) return unchanged;
  const byJob = new Map<string, EnvioMatricula[]>();
  for (const row of rows) {
    const list = byJob.get(row.job_id) ?? [];
    list.push(row); byJob.set(row.job_id, list);
  }
  let pending: Resultado | undefined;
  for (const list of byJob.values()) {
    list.sort((a, b) => a.seq - b.seq);
    const priorPages = new Set(list.flatMap(row => relevantPages(row.body ?? '')));
    if (![...currentPages].every(url => priorPages.has(url))) continue;
    let text = '';
    const spans = list.map(row => {
      if (text) text += ' ';
      const start = text.length;
      text += normalize(row.body ?? '');
      return { row, start, end: text.length };
    });
    // Uma tentativa falhada não apaga outra cópia aceita/pendente do mesmo job.
    for (const occurrence of text.matchAll(pattern(policy.literal))) {
      const start = occurrence.index;
      const end = start + occurrence[0].length;
      const involved = spans.filter(s => s.start < end && s.end > start).map(s => s.row);
      if (involved.length === 0 || involved.some(r => r.status === 'failed')) continue;
      const accepted = involved.every(r => ['sent', 'delivered', 'read'].includes(r.status ?? ''));
      const last = involved.at(-1)!;
      const result: Resultado = { body: strip(body, policy.literal), reason: accepted ? 'accepted' : 'pending',
        receipt: { messageId: last.message_id, idempotencyKey: last.ledger_id } };
      if (accepted) return result;
      pending = result;
    }
  }
  return pending ?? unchanged;
}
