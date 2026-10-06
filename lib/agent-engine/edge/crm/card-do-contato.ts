/**
 * (C01, -c01.5) O CARD DO FUNIL de um contato, lido pelo motor (pg direto).
 *
 * Dois leitores, uma regra de escolha:
 *
 *   - o gancho antes do turno (`agent/gancho-antes-do-turno.ts`), que manda ao
 *     serviço de fora a etapa, os campos e as etiquetas do card, e grava neles o
 *     que o serviço devolver;
 *   - o contexto do turno (`get-lead-context.ts`), que mostra ao modelo um bloco
 *     compacto dos campos do card (`camposCompactosDoCard`). Até aqui o turno não
 *     via `custom_fields` nenhum: o agente perguntava de novo o que o card já sabia.
 *
 * QUAL card: o mesmo roteamento do resto do sistema (`resolveActiveLeadForContact`):
 * um aberto, ou o do funil padrão, ou o de atividade mais recente. Sem card aberto,
 * o mais recente de qualquer situação, para quem lê saber que o negócio está em
 * Ganho ou Perdido. Dois abertos empatados: nenhum (escolher seria chute, e gravar
 * no card errado é pior que não gravar).
 */
import { resolveActiveLeadForContact, type LeadCandidate } from '@/lib/leads/active-lead';
import type { LeadStatus } from '@/lib/types/leads';

import type { Queryable } from '../../queue/queue';

export interface CardDoContato {
  id: string;
  /** `open` | `won` | `lost`. */
  status: string;
  /** `slug` da etapa do funil; `null` se a etapa não foi achada. */
  etapa: string | null;
  campos: Record<string, unknown>;
  etiquetas: string[];
}

interface LinhaDoCard {
  id: string;
  organization_id: string;
  pipeline_id: string;
  status: string;
  last_activity_at: Date | string | null;
  created_at: Date | string;
  custom_fields: unknown;
  tags: string[] | null;
  etapa: string | null;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : v;

const objeto = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export async function lerCardDoContato(
  db: Queryable,
  organizationId: string,
  contactId: string,
): Promise<CardDoContato | null> {
  const { rows } = await db.query<LinhaDoCard>(
    `select l.id, l.organization_id, l.pipeline_id, l.status, l.last_activity_at, l.created_at,
            l.custom_fields, l.tags, s.slug as etapa
       from crm_leads l
       left join crm_stages s on s.id = l.stage_id and s.organization_id = l.organization_id
      where l.organization_id = $1 and l.contact_id = $2`,
    [organizationId, contactId],
  );
  if (rows.length === 0) return null;

  const candidatos: LeadCandidate[] = rows.map((r) => ({
    id: r.id,
    organization_id: r.organization_id,
    pipeline_id: r.pipeline_id,
    status: r.status as LeadStatus,
    last_activity_at: iso(r.last_activity_at),
    created_at: iso(r.created_at) ?? '',
  }));
  const { rows: padrao } = await db.query<{ id: string }>(
    `select id from crm_pipelines
      where organization_id = $1 and is_default = true and is_archived = false
      limit 1`,
    [organizationId],
  );
  const alvo = resolveActiveLeadForContact(candidatos, { defaultPipelineId: padrao[0]?.id ?? null });

  let escolhida: LinhaDoCard | undefined;
  if (alvo.routed) {
    escolhida = rows.find((r) => r.id === alvo.leadId);
  } else if (alvo.reason === 'no_open_lead') {
    const quando = (r: LinhaDoCard) => Date.parse(iso(r.last_activity_at) ?? iso(r.created_at) ?? '') || 0;
    escolhida = [...rows].sort((a, b) => quando(b) - quando(a))[0];
  }
  if (escolhida === undefined) return null;

  return {
    id: escolhida.id,
    status: escolhida.status,
    etapa: escolhida.etapa,
    campos: objeto(escolhida.custom_fields),
    etiquetas: escolhida.tags ?? [],
  };
}

/** Teto de cada valor de texto no bloco do modelo. */
export const TETO_DO_VALOR_NO_CONTEXTO = 120;
/** Teto de chaves no bloco do modelo. */
export const TETO_DE_CAMPOS_NO_CONTEXTO = 20;
/** Teto do bloco serializado: ele disputa o orçamento de tokens com o histórico. */
export const TETO_DO_BLOCO_NO_CONTEXTO = 800;

/**
 * Os campos do card como o modelo os lê: só valores curtos e legíveis.
 *
 * Fora: chave que começa com `_` (é de quem integra, não do atendimento), valor
 * vazio, objeto (JSON grande vira ruído e come o histórico) e lista que não seja
 * de valores simples. Lista simples vira texto separado por vírgula. Texto passa
 * de `TETO_DO_VALOR_NO_CONTEXTO`: cortado. O bloco inteiro respeita os dois tetos
 * acima, na ordem das chaves; o que não cabe fica de fora.
 */
export function camposCompactosDoCard(
  campos: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const saida: Record<string, string | number | boolean> = {};
  let tamanho = 2;
  for (const [chave, valor] of Object.entries(campos)) {
    if (Object.keys(saida).length >= TETO_DE_CAMPOS_NO_CONTEXTO) break;
    if (chave.startsWith('_') || chave.trim() === '') continue;
    const compacto = valorCompacto(valor);
    if (compacto === null) continue;
    const custo = JSON.stringify(chave).length + JSON.stringify(compacto).length + 2;
    if (tamanho + custo > TETO_DO_BLOCO_NO_CONTEXTO) continue;
    saida[chave] = compacto;
    tamanho += custo;
  }
  return saida;
}

function valorCompacto(valor: unknown): string | number | boolean | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'boolean') return valor;
  if (typeof valor === 'string') {
    const t = valor.trim();
    return t === '' ? null : t.slice(0, TETO_DO_VALOR_NO_CONTEXTO);
  }
  if (Array.isArray(valor)) {
    if (valor.length === 0) return null;
    if (!valor.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) return null;
    const t = valor.map(String).map((v) => v.trim()).filter((v) => v !== '').join(', ');
    return t === '' || t.length > TETO_DO_VALOR_NO_CONTEXTO ? null : t;
  }
  return null;
}
