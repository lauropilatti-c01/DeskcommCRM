/**
 * (C01, G3) URLs da resposta interna autorizada, sem ampliar domínio nem preço.
 * A referência do handler não é prova: reler caso, conversa, job e último evento
 * humano no banco antes de alimentar as evidências de consulta do turno.
 */
import type { Queryable } from '../queue/queue';
import { linksNoTexto } from '../guardrails/link-permitido';

export interface RespostaDoCasoNoTurno {
  caseId: string;
  action: string;
  body?: string;
}

interface Entrada {
  tenantId: string;
  contactId: string;
  conversationId: string;
  jobId: string;
  respostaDoCaso?: RespostaDoCasoNoTurno;
}

interface RespostaPersistida {
  organization_id: string;
  case_id: string;
  conversation_id: string;
  contact_id: string;
  status: string;
  event_organization_id: string;
  event_case_id: string;
  kind: string;
  actor_kind: string;
  actor_user_id: string | null;
  human_action: string | null;
  body: string | null;
  reply_precedes_job: boolean;
  no_later_transition: boolean;
  job_kind: string;
  job_case_id: string | null;
  job_action: string | null;
  job_body: string | null;
}

/**
 * Só a reentrada `resolved`/`need_lead_info` pode obter URLs. Caso resolvido é
 * esperado depois do clique humano; reaberto, cancelado ou escalado não vale.
 * A rota autenticada grava human_replied + ator + job na mesma transação.
 *
 * O evento mais recente é escolhido ANTES de comparar ação/corpo: não procurar
 * uma resposta antiga que combine com um job atrasado. Compara horários no SQL
 * para preservar a precisão do Postgres. Sem linha = nenhuma autorização;
 * erro de leitura é propagado, nunca convertido em liberação de domínio.
 */
export async function lerLinksDaRespostaDoCaso(db: Queryable, input: Entrada): Promise<readonly string[]> {
  const ref = input.respostaDoCaso;
  const esperado = ref?.action === 'resolved' ? 'resolved'
    : ref?.action === 'need_lead_info' ? 'awaiting_lead' : null;
  if (!ref || !esperado || typeof ref.body !== 'string' || ref.body.trim() === '') return [];

  const { rows } = await db.query<RespostaPersistida>(
    `select ac.organization_id, ac.id as case_id, ac.status, ac.conversation_id, conv.contact_id,
            e.organization_id as event_organization_id, e.case_id as event_case_id,
            e.kind, e.actor_kind, e.actor_user_id, e.human_action, e.body,
            e.created_at <= j.created_at as reply_precedes_job,
            not exists (
              select 1 from agent_case_events posterior
               where posterior.organization_id = ac.organization_id and posterior.case_id = ac.id
                 and posterior.created_at > e.created_at
                 and posterior.kind in ('lead_asked', 'lead_provided', 'lead_unresponsive', 'resolved', 'escalated', 'cancelled')
            ) as no_later_transition,
            j.kind as job_kind, j.payload->>'case_id' as job_case_id,
            j.payload->>'action' as job_action, j.payload->>'body' as job_body
       from job_queue j
       join agent_cases ac on ac.organization_id = j.organization_id and ac.id = $5
       join conversations conv on conv.id = ac.conversation_id and conv.organization_id = ac.organization_id
       join lateral (
         select ae.organization_id, ae.case_id, ae.kind, ae.actor_kind, ae.actor_user_id,
                ae.human_action, ae.body, ae.created_at
           from agent_case_events ae
          where ae.organization_id = ac.organization_id and ae.case_id = ac.id and ae.kind = 'human_replied'
          order by ae.created_at desc, ae.id desc
          limit 1
       ) e on true
      where j.organization_id = $1 and j.contact_id = $2 and conv.contact_id = $2
        and conv.id = $3 and j.id = $4`,
    [input.tenantId, input.contactId, input.conversationId, input.jobId, ref.caseId],
  );
  const row = rows[0];
  if (!row || row.organization_id !== input.tenantId || row.case_id !== ref.caseId
      || row.conversation_id !== input.conversationId || row.contact_id !== input.contactId
      || row.event_organization_id !== input.tenantId || row.event_case_id !== ref.caseId
      || row.status !== esperado || row.kind !== 'human_replied' || row.actor_kind !== 'human'
      || typeof row.actor_user_id !== 'string' || row.actor_user_id.trim() === ''
      || row.human_action !== ref.action || row.body !== ref.body || row.reply_precedes_job !== true
      || row.no_later_transition !== true
      || row.job_kind !== 'case_reply_turn' || row.job_case_id !== ref.caseId
      || row.job_action !== ref.action || row.job_body !== ref.body) return [];

  // Só URLs: nunca enviar o corpo da resposta a registrarConsulta, que também
  // extrai valores em dinheiro. As duas travas de link usam o mesmo reconhecedor.
  return [...new Set(linksNoTexto(row.body))];
}
