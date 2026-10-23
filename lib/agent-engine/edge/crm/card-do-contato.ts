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
 *
 * (C01, -c01.16) O card traz também a ordem dos campos definidos no funil dele
 * (`ordemDoFunil`, de `crm_pipelines.settings.fields`, lida na MESMA consulta por
 * junção com o funil do card). `camposCompactosDoCard` põe esses campos primeiro:
 * sem isso, o corte seguia a ordem do `jsonb` (chave curta primeiro), e o lead
 * antigo perdia campo de atendimento (`plano_oferecido`, `objecao_principal`)
 * para carimbo técnico de nome curto.
 */
import { resolveActiveLeadForContact, type LeadCandidate } from '@/lib/leads/active-lead';
import { camposDoFunil } from '@/lib/leads/campos-do-funil';
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
  /** As chaves dos campos definidos no funil do card, na ordem do funil; `[]` = sem definição. */
  ordemDoFunil: string[];
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
  campos_do_funil: unknown;
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
            l.custom_fields, l.tags, s.slug as etapa, p.settings -> 'fields' as campos_do_funil
       from crm_leads l
       left join crm_stages s on s.id = l.stage_id and s.organization_id = l.organization_id
       left join crm_pipelines p on p.id = l.pipeline_id and p.organization_id = l.organization_id
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
    ordemDoFunil: camposDoFunil({ fields: escolhida.campos_do_funil }).map((f) => f.key),
  };
}

/**
 * Campo do card que é dado pessoal. Pelo NOME da chave, depois de minúscula, sem
 * acento e sem separador: `Telefone`, `e-mail`, `nome_completo` saem;
 * `nome_do_produto` fica. Vale para o pedido ao gancho antes do turno e para o bloco
 * do modelo (`camposCompactosDoCard`).
 */
const CHAVES_DE_DADO_PESSOAL = new Set([
  'nome', 'name', 'nomecompleto', 'fullname', 'primeironome', 'firstname', 'sobrenome', 'lastname',
  'cpf', 'rg', 'documento', 'endereco', 'address',
]);
const TRECHOS_DE_DADO_PESSOAL = ['telefone', 'phone', 'celular', 'whatsapp', 'email', 'mail'];

export function chaveEDadoPessoal(chave: string): boolean {
  const k = chave
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return CHAVES_DE_DADO_PESSOAL.has(k) || TRECHOS_DE_DADO_PESSOAL.some((t) => k.includes(t));
}

/** Teto de cada valor de texto no bloco do modelo. */
export const TETO_DO_VALOR_NO_CONTEXTO = 120;
/** Teto de chaves no bloco do modelo. */
export const TETO_DE_CAMPOS_NO_CONTEXTO = 20;
/** Teto do bloco serializado: ele disputa o orçamento de tokens com o histórico. */
export const TETO_DO_BLOCO_NO_CONTEXTO = 800;
/**
 * (C01, -c01.16) Os tetos quando o funil define os campos: a ordem do funil decide
 * quem entra, e os tetos maiores fazem caber o card de um lead antigo que entra
 * pela campanha. Os 70 lugares cobrem até 50 campos declarados, nativos e
 * campos técnicos. O orçamento total do contexto continua sendo conferido.
 * Card sem definição no funil fica nos tetos de cima.
 */
export const TETO_DE_CAMPOS_COM_FUNIL = 70;
export const TETO_DO_BLOCO_COM_FUNIL = 32768;
export const TETO_DO_VALOR_COM_FUNIL = 512;
/**
 * (C01, -c01.16) Os campos que o próprio Deskcomm grava no card (a qualificação do
 * agente), logo depois dos do funil: não são definidos no funil, e sem eles na frente
 * o lead antigo os perdia para carimbo técnico.
 */
export const CAMPOS_NATIVOS_DO_CARD = ['next_action', 'need', 'timeline', 'budget', 'authority', 'reason'] as const;

/**
 * Os campos do card como o modelo os lê: só valores curtos e legíveis.
 *
 * Fora: chave que começa com `_` (é de quem integra, não do atendimento), chave com
 * nome de dado pessoal (`chaveEDadoPessoal`: o card não vira segunda cópia do
 * telefone, do nome ou do e-mail), valor vazio, objeto e texto com cara de JSON
 * (começa com `{` ou `[`: JSON grande vira ruído e come o histórico), e lista que
 * não seja de valores simples. Lista simples vira texto separado por vírgula. Texto
 * acima do teto recebe reticência e é identificado como parcial. Para os
 * consumidores de contexto, `projetarCamposDoCard` também distingue campos
 * vazios, omitidos e truncados; este wrapper conserva apenas os valores.
 *
 * (C01, -c01.16) Com `ordemDoFunil` (as chaves definidas no funil do card), esses
 * campos vêm primeiro, na ordem do funil; depois os nativos (`CAMPOS_NATIVOS_DO_CARD`);
 * depois os demais, na ordem de antes. Os tetos passam a `TETO_DE_CAMPOS_COM_FUNIL` e
 * `TETO_DO_BLOCO_COM_FUNIL`, com até 512 caracteres por valor. Sem
 * definição no funil, mantêm-se os tetos anteriores. A projeção do prompt (`projetarRetornoDeTool`)
 * continua depois daqui.
 */
export function camposCompactosDoCard(
  campos: Record<string, unknown>,
  ordemDoFunil: readonly string[] = [],
): Record<string, string | number | boolean> {
  return projetarCamposDoCard(campos, ordemDoFunil).campos;
}

export interface ProjecaoDosCamposDoCard {
  campos: Record<string, string | number | boolean>;
  /** Campos legíveis fora do resumo: ausência aqui nunca significa dado vazio no banco. */
  omitidos: string[];
  /** O valor é um trecho; consulte o card inteiro antes de decidir pelo texto. */
  truncados: string[];
  /** Chaves presentes mas sem valor, diferentes das omitidas por limite. */
  vazios: string[];
}

/** Uma única projeção para a leitura inicial e para o resultado do gancho. */
export function projetarCamposDoCard(
  campos: Record<string, unknown>,
  ordemDoFunil: readonly string[] = [],
): ProjecaoDosCamposDoCard {
  const comFunil = ordemDoFunil.length > 0;
  const tetoDeCampos = comFunil ? TETO_DE_CAMPOS_COM_FUNIL : TETO_DE_CAMPOS_NO_CONTEXTO;
  const tetoDoBloco = comFunil ? TETO_DO_BLOCO_COM_FUNIL : TETO_DO_BLOCO_NO_CONTEXTO;
  const primeiro = comFunil ? [...ordemDoFunil, ...CAMPOS_NATIVOS_DO_CARD] : [];
  const naOrdem = [
    ...new Set([...primeiro.filter((k) => Object.prototype.hasOwnProperty.call(campos, k)), ...Object.keys(campos)]),
  ];
  const saida: Record<string, string | number | boolean> = {};
  const omitidos: string[] = [];
  const truncados: string[] = [];
  const vazios: string[] = [];
  let tamanho = 2;
  for (const chave of naOrdem) {
    const valor = campos[chave];
    if (chave.startsWith('_') || chave.trim() === '' || chaveEDadoPessoal(chave)) continue;
    if (valor === null || valor === undefined || (typeof valor === 'string' && valor.trim() === '') || (Array.isArray(valor) && valor.length === 0)) {
      vazios.push(chave);
      continue;
    }
    const tetoDoValor = comFunil ? TETO_DO_VALOR_COM_FUNIL : TETO_DO_VALOR_NO_CONTEXTO;
    const compacto = valorCompacto(valor, tetoDoValor);
    if (compacto === null) {
      omitidos.push(chave);
      continue;
    }
    const custo = JSON.stringify(chave).length + JSON.stringify(compacto).length + 2;
    if (Object.keys(saida).length >= tetoDeCampos || tamanho + custo > tetoDoBloco) {
      omitidos.push(chave);
      continue;
    }
    const texto = typeof valor === 'string' ? valor.trim() : null;
    if (texto !== null && texto.length > tetoDoValor) truncados.push(chave);
    saida[chave] = compacto;
    tamanho += custo;
  }
  return { campos: saida, omitidos, truncados, vazios };
}

function valorCompacto(valor: unknown, teto = TETO_DO_VALOR_NO_CONTEXTO): string | number | boolean | null {
  if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
  if (typeof valor === 'boolean') return valor;
  if (typeof valor === 'string') {
    const t = valor.trim();
    return t === '' || t.startsWith('{') || t.startsWith('[') ? null : t.length > teto ? `${t.slice(0, teto - 1)}…` : t;
  }
  if (Array.isArray(valor)) {
    if (valor.length === 0) return null;
    if (!valor.every((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) return null;
    const t = valor.map(String).map((v) => v.trim()).filter((v) => v !== '').join(', ');
    return t === '' || t.length > teto ? null : t;
  }
  return null;
}
