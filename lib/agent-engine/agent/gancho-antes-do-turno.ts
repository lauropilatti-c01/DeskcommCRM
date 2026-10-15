/**
 * (C01, -c01.5) GANCHO ANTES DO TURNO: um serviço de fora decide, antes do modelo,
 * se o turno segue ou se ele mesmo responde.
 *
 * Liga só por ambiente (`AGENT_PRE_TURN_HOOK_URL`, `AGENT_PRE_TURN_HOOK_SECRET`,
 * `AGENT_PRE_TURN_HOOK_TIMEOUT_MS`, padrão 4.000 ms). Sem a URL, o knob não existe e o
 * turno é byte a byte o de antes: nenhuma consulta, nenhuma chamada.
 *
 * ## Onde entra
 *
 * Em `inbound-turn.ts`, depois de tudo que silencia o turno (agente pausado ou
 * assistido, pessoa na conversa, pedido de humano, suspeita de opt-out) e antes do
 * roteiro e do modelo. Só em `inbound_turn`, nunca na prévia, nunca para contato
 * bloqueado.
 *
 * ## O contrato (versão 1)
 *
 * `POST <URL>` com `X-Hook-Signature: t=<unix>,v1=<hex HMAC-SHA256(segredo, "<t>." + corpo)>`.
 * O pedido leva a conversa (canal, pessoa atendendo, última entrada), o card do funil
 * (etapa, campos, etiquetas), as últimas 12 mensagens (com o `status` de cada uma e,
 * na que falhou, o código do `erro`) e o `formulario`: a resposta de formulário mais
 * nova dessas 12, enquanto o gancho ainda não a processou. Nunca telefone, e-mail ou
 * nome do contato: campo do card com nome de dado pessoal (`chaveEDadoPessoal`) fica
 * de fora.
 *
 * A resposta é conferida por schema (`respostaDoGanchoSchema`):
 *
 *   - `seguir`: aplica `gravar` (campos e etiquetas no card), troca o texto da
 *     resposta do formulário pelo `resumo` (o original continua em
 *     `metadata.interactive`), marca a resposta como processada
 *     (`metadata.gancho_processado`) e o turno segue: o modelo lê o resumo;
 *   - `segurar`: envia cada item de `enviar`, na ordem, pela mesma cadeia de envio
 *     do aviso de escalação (`runBeforeSend`), aplica `gravar` e o turno TERMINA,
 *     sem modelo e sem fail-safe: o cliente recebeu resposta. `enviar: []` é o
 *     silêncio de propósito (o serviço acabou de mandar o formulário e a pessoa
 *     escreveu antes de vê-lo): grava e termina, sem enviar nada. `segurar` sem a
 *     lista `enviar` é resposta fora do contrato. O formulário do pedido também fica
 *     marcado como processado.
 *
 * `resumo` vazio vale ausente; `resumo` e `motivo` longos demais são cortados, sem
 * derrubar a resposta.
 *
 * (C01, -c01.7) `apagar_memoria: true`, com `seguir` ou `segurar`: apaga a memória do
 * contato (`lead_notes`: as notas, o índice que o turno monta delas e o embedding de
 * cada uma) junto com o `gravar` e nas mesmas condições dele. Só para o celular de
 * teste: o contato ou um card dele tem de ter a etiqueta `ETIQUETA_DO_CELULAR_DE_TESTE`,
 * conferida no banco na mesma instrução que apaga. Sem a etiqueta, com a etiqueta posta
 * pela própria resposta ou com erro na leitura: nada é apagado, fica no log e o turno
 * segue. Não mexe em mensagens, casos, campos, card nem no checkpoint do contato.
 *
 * ## Falha nunca cala o cliente
 *
 * Erro de rede, prazo estourado, status fora de 2xx, resposta fora do schema, canal
 * que não envia interativo ou o PRIMEIRO envio do `segurar` que não sai: o turno roda
 * o modelo, como se o gancho não existisse, e o `gravar` daquela resposta NÃO é
 * aplicado (o card não diz "formulário enviado" sem ele ter saído). Envio parcial (o
 * 1º saiu, um seguinte não): o que saiu fica, o `gravar` vale e o turno termina, com
 * aviso no log; o cliente já recebeu resposta e o modelo não sabe o que saiu.
 * Os logs levam o motivo em código, nunca corpo, URL ou dado pessoal.
 *
 * Exceção restrita: `qualificacao-motor-v1` devolve recibo opaco, não respostas.
 * Falha do gancho ou `seguir` sem resumo deixa `piloto_pendente` no payload e
 * lança erro: o mesmo job reconsulta, sem modelo às cegas. Na última tentativa,
 * a escolta da preparação abre caso e passa à equipe. Não vale para o legado,
 * follow-up nem reconsulta agendada; não guarda token/recibo na anotação.
 *
 * ## A resposta do formulário não se perde
 *
 * Só a decisão aplicada marca o formulário como processado. Gancho fora do ar,
 * desligado ou com resposta inválida: a resposta continua não processada e volta no
 * `formulario` do próximo pedido; enquanto isso, o modelo lê as respostas montadas do
 * `response_json` (`textoDaRespostaDeFormulario`), não o texto neutro. Resposta mais
 * antiga sob uma mais nova já processada não volta: gravaria por cima da mais nova.
 *
 * ## Re-execução do job
 *
 * A decisão fica anotada no próprio job (`job_queue.payload.gancho_antes_do_turno`)
 * antes de qualquer efeito. A re-execução (reaper, retry) repete a decisão anotada em
 * vez de perguntar de novo: perguntando, o serviço veria o formulário que acabou de
 * mandar e responderia com o lembrete, e o cliente receberia dois. Se uma mensagem
 * nova do cliente chegou depois da anotação (a rajada cresceu enquanto o job voltava
 * à fila), ela não vale mais e o gancho é chamado de novo; vale para a decisão e para
 * o "segue para o modelo" de uma falha. Cada envio tem posição própria no ledger
 * (`seq` negativo, que o modelo nunca usa nem conta) e, na re-execução, o conteúdo
 * que o job já registrou vai direto ao canal, sem passar de novo pela cadeia: a
 * cadeia vetaria agora (janela, ritmo) o que já saiu, e o turno cairia no modelo com
 * o cliente já respondido. O canal reconhece o já aceito: nada sai duas vezes.
 *
 * ## Por que as travas de conteúdo não valem aqui
 *
 * O texto vem de código (como o aviso de escalação, `aviso-de-escalacao.ts`), não do
 * modelo: as travas de estilo, o vocabulário interno e o classificador de promessa
 * existem para o texto do modelo e ficam desarmados (não são passados). Continuam
 * valendo: opt-out, LGPD, janela de 24 h, ritmo do número, apresentação automática
 * da 1ª mensagem e o modo do agente. O anti-spinning fica desarmado no canal
 * oficial: o formulário é o MESMO texto para todo lead novo, e armado ele vetaria a
 * partir do terceiro lead na janela do número (a conta do cabeçalho de
 * `GateContext.spinningEnforced`); o anti-ban protege o número não oficial, onde ele
 * segue armado.
 */
import { createHmac } from 'node:crypto';

import type pg from 'pg';
import { z } from 'zod';

import type { AgentOperationContext } from '@/lib/ai/agents/operation';
import { JobLeasePerdidoError, PrazoDaExecucaoVencidoError, StaleServiceBoundaryError } from '@/lib/atendimento/fronteira';
import { guardServiceEffect } from '@/lib/atendimento/fronteira-server';
import { canalEnviaInterativo, TEXTO_DA_RESPOSTA_DE_FORMULARIO, tipoDoCanalParaIntegracao } from '@/lib/channels/interativo';
import { normalizarTags } from '@/lib/contacts/tag-normalizada';
import { logger } from '@/lib/logger';
import { isoLocalComOffset } from '@/lib/tempo/agora';

import type { ChannelAdapter, ChannelSendResult } from '../channel-adapter';
import { chaveEDadoPessoal, lerCardDoContato, type CardDoContato } from '../edge/crm/card-do-contato';
import { MARCA_DE_PROCESSADO, type LeadContextMessage } from '../edge/crm/get-lead-context';
import { conteudoRegistradoNoJob } from '../edge/crm/send-ledger';
import { scheduleCronJob } from '../cron/scheduler';
import { runBeforeSend } from '../guardrails/before-send';
import type { DesfechoDoAviso } from './aviso-de-escalacao';
import { performHumanHandoff } from './human-handoff';
import type { LgpdInput } from '../guardrails/lgpd/legal-basis';
import type { Logger } from '../obs/logger';
import { claimOfJob } from '../queue/claim';
import type { JobRow, Queryable } from '../queue/queue';


/** Como o gancho chega ao turno (`InboundTurnKnobs.ganchoAntesDoTurno`). */
export interface GanchoAntesDoTurnoConfig {
  url: string;
  segredo: string;
  prazoMs: number;
}

/**
 * O knob a partir do ambiente. URL e segredo juntos, e a URL `http(s)` válida; o que
 * faltar desliga o gancho com um aviso no boot (sem a URL no log: ela pode levar
 * credencial). Sem a URL, silêncio: é o caso de toda instalação que não usa o gancho.
 */
export function ganchoAntesDoTurnoDoAmbiente(env: {
  AGENT_PRE_TURN_HOOK_URL?: string | undefined;
  AGENT_PRE_TURN_HOOK_SECRET?: string | undefined;
  AGENT_PRE_TURN_HOOK_TIMEOUT_MS: number;
}): { ganchoAntesDoTurno?: GanchoAntesDoTurnoConfig } {
  const url = env.AGENT_PRE_TURN_HOOK_URL;
  if (url === undefined) return {};
  let valida = false;
  try {
    const u = new URL(url);
    valida = u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    valida = false;
  }
  if (!valida) {
    logger.warn('gancho antes do turno desligado: AGENT_PRE_TURN_HOOK_URL não é um endereço http(s) válido');
    return {};
  }
  if (env.AGENT_PRE_TURN_HOOK_SECRET === undefined) {
    logger.warn('gancho antes do turno desligado: falta AGENT_PRE_TURN_HOOK_SECRET');
    return {};
  }
  return {
    ganchoAntesDoTurno: { url, segredo: env.AGENT_PRE_TURN_HOOK_SECRET, prazoMs: env.AGENT_PRE_TURN_HOOK_TIMEOUT_MS },
  };
}

// ─── o pedido ──────────────────────────────────────────────────────────────────

export interface MensagemDoPedido {
  direcao: 'entrada' | 'saida';
  texto: string;
  em: string;
  interativo: unknown;
  /**
   * A situação da linha: `failed`, `read`, `delivered` quando a Meta avisou, senão a
   * coluna como está (`sent`, `queued`, `pending`…). A falha que a Meta avisa depois
   * do aceite (131026, número sem WhatsApp) chega aqui. Ausente sem situação.
   */
  status?: string;
  /** O código do erro da mensagem que falhou (só o código, nunca o texto). */
  erro?: string;
}

export interface FormularioDoPedido {
  mensagem_id: string;
  resposta: unknown;
  flow_token: string | null;
  bruto: string | null;
}

export interface PedidoDoGancho {
  versao: 1;
  evento: 'turno';
  organizacao_id: string;
  agente_id: string | null;
  conversa: { id: string; canal: string; pessoa_atendendo: boolean; ultima_entrada_em: string | null };
  lead: { id: string | null; etapa: string | null; campos: Record<string, unknown>; etiquetas: string[] };
  mensagens: MensagemDoPedido[];
  formulario?: FormularioDoPedido;
  /**
   * (C01, -c01.6) `true` só no turno que o próprio gancho pediu (`reconsultar_em_s`):
   * não há mensagem nova do cliente. Ausente nos outros.
   */
  reconsulta?: true;
}

/** Quantas mensagens vão no pedido. */
export const MENSAGENS_NO_PEDIDO = 12;

/**
 * Campo do card que é dado pessoal não vai no pedido (`chaveEDadoPessoal`, em
 * `card-do-contato.ts`, a mesma régua do bloco do modelo). Reexportado aqui: é por
 * este módulo que o contrato do gancho é lido.
 */
export { chaveEDadoPessoal };

const semDadoPessoal = (campos: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(campos).filter(([k]) => !chaveEDadoPessoal(k)));

const iso = (v: Date | string | null | undefined): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

const objeto = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Uma resposta de formulário guardada na entrada (`metadata.interactive`, -c01.5 item A). */
interface LinhaDoFormulario {
  id: string;
  interativo: unknown;
  sent_at: Date | string | null;
  processado: boolean | null;
}

/**
 * `metadata.gancho_processado`: a decisão do gancho sobre esta resposta já foi aplicada.
 * Definida com as colunas do formulário (`get-lead-context.ts`), que também a leem.
 */
export { MARCA_DE_PROCESSADO };

export interface FormularioDoTurno {
  pedido: FormularioDoPedido;
  /** O `sent_at` da linha: é por ele que o resumo acha a mensagem no contexto do turno. */
  sentAt: string | null;
}

/**
 * A resposta de formulário que este turno atende: a mais nova das 12 mensagens do
 * pedido, se o gancho ainda não a processou (`metadata.gancho_processado`). Não importa
 * se ela veio antes ou depois da última saída: com o gancho fora do ar no turno dela, o
 * modelo respondeu, e a resposta volta no turno seguinte. Mais antiga sob uma mais nova
 * processada não volta: a mais nova já disse o que o card precisa.
 */
export async function formularioDoTurno(
  db: Queryable,
  alvo: { organizationId: string; conversationId: string },
): Promise<FormularioDoTurno | null> {
  const { rows } = await db.query<LinhaDoFormulario>(
    `with janela as (
       select m.id, m.direction, m.metadata, m.sent_at, m.created_at,
              coalesce(m.sent_at, m.created_at) as quando
         from messages m
        where m.organization_id = $1 and m.conversation_id = $2
          and m.direction in ('inbound', 'outbound') and m.type <> 'system'
        order by coalesce(m.sent_at, m.created_at) desc, m.created_at desc, m.id desc
        limit $3)
     select j.id, j.metadata->'interactive' as interativo, j.sent_at,
            coalesce(j.metadata->>'${MARCA_DE_PROCESSADO}', '') = 'true' as processado
       from janela j
      where j.direction = 'inbound' and j.metadata->'interactive'->>'type' = 'nfm_reply'
      order by j.quando desc, j.created_at desc, j.id desc
      limit 1`,
    [alvo.organizationId, alvo.conversationId, MENSAGENS_NO_PEDIDO],
  );
  const linha = rows[0];
  if (linha === undefined || linha.processado === true) return null;
  const i = objeto(linha.interativo) ?? {};
  return {
    pedido: {
      mensagem_id: linha.id,
      resposta: i.response ?? null,
      flow_token: typeof i.flow_token === 'string' ? i.flow_token : null,
      bruto: typeof i.raw === 'string' ? i.raw : null,
    },
    sentAt: iso(linha.sent_at),
  };
}

/** A etapa como o serviço a lê: `won`/`lost` quando o negócio fechou, senão o slug da etapa. */
const etapaDoCard = (card: CardDoContato): string | null => (card.status !== 'open' ? card.status : card.etapa);

export async function montarPedidoDoGancho(
  db: Queryable,
  alvo: {
    organizationId: string;
    contactId: string;
    conversationId: string;
    channelSessionId: string;
    agentId: string | null;
    inboundMessageId: string | null;
    /** As etiquetas do CONTATO lidas no contexto do turno: o serviço vê as duas listas juntas. */
    etiquetasDoContato: readonly string[];
    /** (C01, -c01.6) O turno é a reconsulta pedida pelo gancho. */
    reconsulta?: boolean;
  },
): Promise<{ pedido: PedidoDoGancho; card: CardDoContato | null; formulario: FormularioDoTurno | null; canalEnviaInterativo: boolean }> {
  const { rows: conversas } = await db.query<{
    assignee_kind: string | null;
    assigned_to_user_id: string | null;
    last_inbound_at: Date | string | null;
    provider: string | null;
  }>(
    `select c.assignee_kind, c.assigned_to_user_id, c.last_inbound_at,
            (select s.provider from channel_sessions s where s.organization_id = $1 and s.id = $3) as provider
       from conversations c
      where c.organization_id = $1 and c.id = $2`,
    [alvo.organizationId, alvo.conversationId, alvo.channelSessionId],
  );
  const conversa = conversas[0];
  const card = await lerCardDoContato(db, alvo.organizationId, alvo.contactId);
  const { rows: linhas } = await db.query<{
    direction: string;
    type: string;
    body: string | null;
    interativo: unknown;
    em: Date | string;
    situacao?: string | null;
    erro?: string | null;
  }>(
    `select direction, type, body, metadata->'interactive' as interativo, coalesce(sent_at, created_at) as em,
            case when status = 'failed' then 'failed'
                 when read_at is not null then 'read'
                 when delivered_at is not null then 'delivered'
                 else status end as situacao,
            case when status = 'failed' then error_code end as erro
       from messages
      where organization_id = $1 and conversation_id = $2
        and direction in ('inbound', 'outbound') and type <> 'system'
      order by coalesce(sent_at, created_at) desc, created_at desc, id desc
      limit $3`,
    [alvo.organizationId, alvo.conversationId, MENSAGENS_NO_PEDIDO],
  );
  // (C01, -c01.6) A reconsulta não atende formulário: a resposta que chegar enquanto
  // ela espera é do turno da própria mensagem (marcá-la aqui a tiraria dele).
  const formulario = alvo.reconsulta === true ? null : await formularioDoTurno(db, alvo);

  const pedido: PedidoDoGancho = {
    versao: 1,
    evento: 'turno',
    organizacao_id: alvo.organizationId,
    agente_id: alvo.agentId,
    conversa: {
      id: alvo.conversationId,
      canal: tipoDoCanalParaIntegracao(conversa?.provider),
      pessoa_atendendo:
        conversa?.assignee_kind === 'user' ||
        (conversa?.assignee_kind == null && conversa?.assigned_to_user_id != null),
      ultima_entrada_em: iso(conversa?.last_inbound_at),
    },
    lead: {
      id: card?.id ?? null,
      etapa: card ? etapaDoCard(card) : null,
      campos: semDadoPessoal(card?.campos ?? {}),
      etiquetas: normalizarTags([...(card?.etiquetas ?? []), ...alvo.etiquetasDoContato]),
    },
    mensagens: linhas.reverse().map((m) => ({
      direcao: m.direction === 'inbound' ? 'entrada' : 'saida',
      texto: m.body ?? `[${m.type}]`,
      em: iso(m.em) ?? '',
      interativo: objeto(m.interativo),
      ...(m.situacao ? { status: m.situacao } : {}),
      ...(m.erro ? { erro: m.erro.slice(0, 40) } : {}),
    })),
    ...(formulario !== null ? { formulario: formulario.pedido } : {}),
    ...(alvo.reconsulta === true ? { reconsulta: true as const } : {}),
  };
  return { pedido, card, formulario, canalEnviaInterativo: canalEnviaInterativo(conversa?.provider) };
}

// ─── a chamada ─────────────────────────────────────────────────────────────────

/** `t=<unix>,v1=<hex HMAC-SHA256(segredo, "<t>." + corpo)>`. */
export function assinaturaDoGancho(segredo: string, corpo: string, t: number): string {
  const v1 = createHmac('sha256', segredo).update(`${t}.${corpo}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

const itemTexto = z.object({ tipo: z.literal('texto'), texto: z.string().trim().min(1).max(4096) });
const itemInterativo = z.object({
  tipo: z.literal('interativo'),
  interactive: z.looseObject({ type: z.string().min(1) }),
});

/** Teto do `gravar.campos` serializado: o card não vira depósito. */
export const TETO_DOS_CAMPOS_GRAVADOS = 16_000;
/** Teto do corpo da resposta do gancho. */
const TETO_DA_RESPOSTA = 64_000;
/** Teto do `resumo`: o que passa é cortado, sem derrubar a resposta. */
export const TETO_DO_RESUMO = 4096;
/** Teto do `motivo` (vai ao log): o que passa é cortado. */
export const TETO_DO_MOTIVO = 200;
/** (C01, -c01.6) Limites de `reconsultar_em_s`, em segundos. */
export const RECONSULTA_MINIMA_S = 30;
export const RECONSULTA_MAXIMA_S = 900;

/**
 * (C01, -c01.6) Marca no payload do job da reconsulta. O job é um `inbound_turn`
 * agendado pelo cron de uma vez (`cron_jobs`, kind `at`) com os mesmos ponteiros do
 * turno que pediu, mais esta marca e `reconsulta_de` (o job que pediu: é por ele que
 * a re-execução não agenda duas vezes).
 */
export const MARCA_DA_RECONSULTA = 'gancho_reconsulta';
export const eReconsultaDoGancho = (payload: unknown): boolean => objeto(payload)?.[MARCA_DA_RECONSULTA] === true;

/** `resumo` vazio ou só espaço vale ausente; longo demais, cortado. */
const resumoTolerante = z
  .string()
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined) return v;
    const t = v.trim();
    return t === '' ? null : t.slice(0, TETO_DO_RESUMO);
  });

export const respostaDoGanchoSchema = z
  .object({
    acao: z.enum(['seguir', 'segurar']),
    enviar: z.array(z.discriminatedUnion('tipo', [itemTexto, itemInterativo])).max(5).nullish(),
    gravar: z
      .object({
        campos: z.record(z.string().trim().min(1).max(100), z.unknown()).nullish(),
        etiquetas_mais: z.array(z.string()).max(20).nullish(),
        etiquetas_menos: z.array(z.string()).max(20).nullish(),
      })
      .nullish(),
    resumo: resumoTolerante,
    motivo: z
      .string()
      .nullish()
      .transform((v) => (typeof v === 'string' ? v.slice(0, TETO_DO_MOTIVO) : v)),
    /** (C01, -c01.6) Rodar um turno marcado `reconsulta` daqui a N segundos. */
    reconsultar_em_s: z.number().int().min(RECONSULTA_MINIMA_S).max(RECONSULTA_MAXIMA_S).nullish(),
    /** (C01, -c01.6) Só com `segurar`: depois dos envios, passa a conversa à equipe. */
    passar_a_equipe: z.boolean().nullish(),
    /** (C01, -c01.7) Apagar a memória do contato; só vale no celular de teste (`apagarMemoriaDoContato`). */
    apagar_memoria: z.boolean().nullish(),
    /**
     * (C01, -c01.15) Só com `seguir`: mensagens fixas que saem ANTES do modelo, no mesmo
     * turno e pelo mesmo caminho do `enviar` do `segurar`; o modelo as lê no histórico
     * (`enviarAntesDoModelo`). A -c01.14 descarta a chave (o `z.object` ignora chave
     * desconhecida) e segue como `seguir` puro.
     */
    enviar_antes: z.array(z.discriminatedUnion('tipo', [itemTexto, itemInterativo])).max(5).nullish(),
  })
  .refine((r) => r.acao !== 'segurar' || Array.isArray(r.enviar), {
    message: 'segurar sem a lista enviar (para não enviar nada, enviar: [])',
    path: ['enviar'],
  })
  .refine((r) => JSON.stringify(r.gravar?.campos ?? {}).length <= TETO_DOS_CAMPOS_GRAVADOS, {
    message: 'gravar.campos grande demais',
    path: ['gravar', 'campos'],
  })
  .refine((r) => r.passar_a_equipe !== true || r.acao === 'segurar', {
    message: 'passar_a_equipe só com segurar',
    path: ['passar_a_equipe'],
  })
  .refine((r) => (r.enviar_antes ?? []).length === 0 || r.acao === 'seguir', {
    message: 'enviar_antes só com seguir (no segurar, use enviar)',
    path: ['enviar_antes'],
  });

export type RespostaDoGancho = z.infer<typeof respostaDoGanchoSchema>;

export type ChamadaDoGancho =
  | { ok: true; resposta: RespostaDoGancho }
  | { ok: false; motivo: 'prazo' | 'rede' | 'status' | 'resposta_invalida'; status?: number };

export async function chamarGancho(
  config: GanchoAntesDoTurnoConfig,
  pedido: PedidoDoGancho,
  agoraUnix: () => number = () => Math.floor(Date.now() / 1000),
): Promise<ChamadaDoGancho> {
  const corpo = JSON.stringify(pedido);
  let res: Response;
  try {
    res = await fetch(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hook-Signature': assinaturaDoGancho(config.segredo, corpo, agoraUnix()),
      },
      body: corpo,
      redirect: 'error',
      signal: AbortSignal.timeout(config.prazoMs),
    });
  } catch (err) {
    return { ok: false, motivo: eTimeout(err) ? 'prazo' : 'rede' };
  }
  if (res.status < 200 || res.status > 299) return { ok: false, motivo: 'status', status: res.status };
  let texto: string;
  try {
    texto = await res.text();
  } catch (err) {
    return { ok: false, motivo: eTimeout(err) ? 'prazo' : 'rede' };
  }
  if (texto.length > TETO_DA_RESPOSTA) return { ok: false, motivo: 'resposta_invalida' };
  let json: unknown;
  try {
    json = JSON.parse(texto);
  } catch {
    return { ok: false, motivo: 'resposta_invalida' };
  }
  const lido = respostaDoGanchoSchema.safeParse(json);
  return lido.success ? { ok: true, resposta: lido.data } : { ok: false, motivo: 'resposta_invalida' };
}

const eTimeout = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

// ─── a decisão anotada no job ──────────────────────────────────────────────────

export const CHAVE_NO_JOB = 'gancho_antes_do_turno';

type DecisaoAnotada =
  | {
      situacao: 'decidido';
      resposta: RespostaDoGancho;
      formulario: { mensagem_id: string; sent_at: string | null } | null;
      /** `max(created_at)` das entradas no momento da decisão, como texto do Postgres. */
      ate: string | null;
      /** A fonte foi um recibo opaco do piloto, conferido no pedido montado. */
      recibo_opaco?: true;
      /**
       * (C01, -c01.15) O `enviar_antes` já foi tentado neste job: a re-execução não manda
       * nada dele de novo (nem o item que falhou); o que saiu já está no histórico lido.
       */
      enviar_antes_feito?: true;
    }
  | {
      situacao: 'modelo';
      motivo: string;
      /** Como em `decidido`: mensagem nova do cliente depois disto invalida a anotação. */
      ate?: string | null;
    }
  | {
      situacao: 'piloto_pendente';
      motivo: string;
      formulario: { mensagem_id: string; sent_at: string | null };
      ate: string | null;
    };

function decisaoAnotada(payload: Record<string, unknown> | null | undefined): DecisaoAnotada | null {
  const d = objeto(payload?.[CHAVE_NO_JOB]);
  if (d === null) return null;
  if (d.situacao === 'modelo')
    return { situacao: 'modelo', motivo: String(d.motivo ?? ''), ate: typeof d.ate === 'string' ? d.ate : null };
  if (d.situacao === 'piloto_pendente') {
    const f = objeto(d.formulario);
    if (typeof f?.mensagem_id !== 'string') return null;
    return { situacao: 'piloto_pendente', motivo: String(d.motivo ?? ''),
      formulario: { mensagem_id: f.mensagem_id, sent_at: typeof f.sent_at === 'string' ? f.sent_at : null },
      ate: typeof d.ate === 'string' ? d.ate : null };
  }
  if (d.situacao !== 'decidido') return null;
  const lido = respostaDoGanchoSchema.safeParse(d.resposta);
  if (!lido.success) return null;
  const f = objeto(d.formulario);
  return {
    situacao: 'decidido',
    resposta: lido.data,
    formulario:
      f !== null && typeof f.mensagem_id === 'string'
        ? { mensagem_id: f.mensagem_id, sent_at: typeof f.sent_at === 'string' ? f.sent_at : null }
        : null,
    ate: typeof d.ate === 'string' ? d.ate : null,
    ...(d.recibo_opaco === true ? { recibo_opaco: true as const } : {}),
    ...(d.enviar_antes_feito === true ? { enviar_antes_feito: true as const } : {}),
  };
}

/** Só o marcador do contrato do piloto; recibo inválido também precisa de recuperação. */
function eReciboOpacoDoPiloto(formulario: FormularioDoTurno | null): boolean {
  if (formulario === null) return false;
  let resposta = objeto(formulario.pedido.resposta);
  if (resposta === null && formulario.pedido.bruto !== null) {
    try { resposta = objeto(JSON.parse(formulario.pedido.bruto)); } catch { return false; }
  }
  return resposta?.formulario === 'qualificacao-motor-v1';
}

async function anotarNoJob(db: Queryable, job: Pick<JobRow, 'id' | 'organization_id'>, d: DecisaoAnotada): Promise<void> {
  await db.query(
    `update job_queue set payload = payload || jsonb_build_object($3::text, $4::jsonb)
      where organization_id = $1 and id = $2`,
    [job.organization_id, job.id, CHAVE_NO_JOB, JSON.stringify(d)],
  );
}

async function ultimaEntrada(db: Queryable, organizationId: string, conversationId: string): Promise<string | null> {
  const { rows } = await db.query<{ em: string | null }>(
    `select max(created_at)::text as em from messages
      where organization_id = $1 and conversation_id = $2 and direction = 'inbound'`,
    [organizationId, conversationId],
  );
  return rows[0]?.em ?? null;
}

async function chegouEntradaDepois(
  db: Queryable,
  organizationId: string,
  conversationId: string,
  ate: string | null,
): Promise<boolean> {
  if (ate === null) return false;
  const { rows } = await db.query<{ chegou: boolean }>(
    `select exists (select 1 from messages
      where organization_id = $1 and conversation_id = $2 and direction = 'inbound'
        and created_at > $3::timestamptz) as chegou`,
    [organizationId, conversationId, ate],
  );
  return rows[0]?.chegou === true;
}

// ─── os efeitos ────────────────────────────────────────────────────────────────

/**
 * `gravar` no card: campos em merge raso (`||`), etiquetas somadas e tiradas já
 * normalizadas, sem repetir e na ordem da primeira aparição. Um statement só.
 */
export async function gravarNoCard(
  db: Queryable,
  organizationId: string,
  cardId: string,
  gravar: NonNullable<RespostaDoGancho['gravar']>,
): Promise<void> {
  const campos = gravar.campos ?? {};
  const mais = normalizarTags(gravar.etiquetas_mais ?? []);
  const menos = normalizarTags(gravar.etiquetas_menos ?? []);
  if (Object.keys(campos).length === 0 && mais.length === 0 && menos.length === 0) return;
  await db.query(
    `update crm_leads
        set custom_fields = coalesce(custom_fields, '{}'::jsonb) || $3::jsonb,
            tags = array(
              select x.t from (
                select distinct on (lower(btrim(u.t))) u.t, u.ord
                  from unnest(coalesce(tags, '{}'::text[]) || $4::text[]) with ordinality as u(t, ord)
                 where btrim(u.t) <> '' and lower(btrim(u.t)) <> all($5::text[])
                 order by lower(btrim(u.t)), u.ord
              ) x order by x.ord),
            updated_at = now()
      where organization_id = $1 and id = $2`,
    [organizationId, cardId, JSON.stringify(campos), mais, menos],
  );
}

/**
 * A resposta do formulário fica marcada como processada (`metadata.gancho_processado`)
 * e, com `resumo`, o texto que o turno lê no lugar dela. O original fica no metadata.
 */
async function marcarFormularioProcessado(
  db: Queryable,
  alvo: { organizationId: string; conversationId: string; mensagemId: string },
  resumo: string | null,
): Promise<void> {
  await db.query(
    `update messages
        set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object($5::text, true),
            body = coalesce($4, body)
      where organization_id = $1 and conversation_id = $2 and id = $3 and direction = 'inbound'`,
    [alvo.organizationId, alvo.conversationId, alvo.mensagemId, resumo, MARCA_DE_PROCESSADO],
  );
}

/**
 * A mesma troca no contexto já lido pelo turno (a abertura do modelo usa a leitura do
 * começo do turno): a resposta de formulário de entrada com o mesmo instante.
 */
export function trocarResumoNoContexto(
  mensagens: LeadContextMessage[],
  alvo: { sentAt: string | null; resumo: string },
  fuso: string,
): boolean {
  const quando = alvo.sentAt === null ? null : isoLocalComOffset(new Date(alvo.sentAt), fuso);
  // Ainda sem resumo: o texto neutro, ou as respostas montadas do formulário
  // (`textoDaRespostaDeFormulario`), que começam por ele.
  const semResumo = (m: LeadContextMessage) =>
    m.body === TEXTO_DA_RESPOSTA_DE_FORMULARIO || m.body.startsWith(`${TEXTO_DA_RESPOSTA_DE_FORMULARIO}:\n`);
  const candidatas = mensagens.filter(
    (m) => m.direction === 'inbound' && (m.formulario === true || m.body === TEXTO_DA_RESPOSTA_DE_FORMULARIO),
  );
  // Pelo instante; sem ele (fuso ou precisão diferentes), a mais nova ainda sem resumo.
  const certa = candidatas.find((m) => m.sent_at === quando) ?? candidatas.filter(semResumo).at(-1) ?? null;
  if (certa === null) return false;
  certa.body = alvo.resumo;
  return true;
}

/** Erros de fronteira sobem: a execução não é mais dona do job, ou o prazo dela venceu. */
const eDeFronteira = (err: unknown): boolean =>
  err instanceof StaleServiceBoundaryError ||
  err instanceof JobLeasePerdidoError ||
  err instanceof PrazoDaExecucaoVencidoError;

const OK_DO_GANCHO = new Set<ChannelSendResult['kind']>(['sent', 'already_sent', 'queued']);

// ─── a execução ────────────────────────────────────────────────────────────────

export interface ContextoDoGancho {
  pool: pg.Pool;
  log: Logger;
  config: GanchoAntesDoTurnoConfig;
  job: JobRow;
  tenantId: string;
  contactId: string;
  conversationId: string;
  channelSessionId: string;
  inboundMessageId: string | null;
  agentId: string | null;
  agentOperation?: AgentOperationContext;
  etiquetasDoContato: readonly string[];
  channel: ChannelAdapter;
  optedOutThisTurn: boolean;
  lgpd?: LgpdInput;
  disclosureMode?: 'inject' | 'veto';
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Relógio da assinatura (testes). Ausente = o relógio real: é o que o serviço confere. */
  agoraUnix?: () => number;
}

export type DesfechoDoGancho =
  /** `segurar` cumprido: o cliente recebeu a resposta do gancho e o turno termina. */
  | { fim: true }
  /**
   * O turno segue para o modelo; com `resumo`, o texto do formulário a trocar no contexto;
   * com `camposDoCard`, os campos do card relidos depois do `gravar` (o contexto do turno
   * foi lido antes dele).
   */
  | {
      fim: false;
      resumo?: { mensagemId: string; sentAt: string | null; texto: string };
      camposDoCard?: Record<string, unknown>;
      /**
       * (C01, -c01.15) O que o `enviar_antes` mandou NESTA execução, na ordem: o turno
       * acrescenta ao histórico já lido (`acrescentarEnviadasAntesNoContexto`).
       */
      enviadasAntes?: EnviadaAntes[];
    };

export async function rodarGanchoAntesDoTurno(ctx: ContextoDoGancho): Promise<DesfechoDoGancho> {
  const { pool, log, job } = ctx;
  const alvo = { organizationId: ctx.tenantId, conversationId: ctx.conversationId };
  const reconsulta = eReconsultaDoGancho(job.payload);

  // 1. A anotação de uma execução anterior deste job. Mensagem nova do cliente depois
  //    dela (a rajada cresceu) a invalida, seja a decisão, seja o "segue para o modelo".
  let decisao: Extract<DecisaoAnotada, { situacao: 'decidido' }> | null = null;
  let canalInterativo: boolean | null = null;
  let card: CardDoContato | null | undefined;
  const anotada = decisaoAnotada(job.payload);
  let pilotoPendente = anotada?.situacao === 'piloto_pendente' ? anotada.formulario : null;
  const aguardarPiloto = async (
    motivo: string,
    formulario: NonNullable<typeof pilotoPendente>,
    ate: string | null,
  ): Promise<never> => {
    await guardServiceEffect();
    await anotarComCuidado(ctx, { situacao: 'piloto_pendente', motivo, formulario, ate });
    log.warn('gancho antes do turno: recibo do piloto pendente — sem modelo, job tenta recuperar', { motivo });
    const erro = new Error(`Formulário do piloto aguarda recuperação do atendimento (${motivo}).`);
    erro.name = 'formulario_piloto_pendente';
    throw erro;
  };
  if (anotada !== null) {
    let chegou = false;
    try {
      chegou = await chegouEntradaDepois(pool, ctx.tenantId, ctx.conversationId, anotada.ate ?? null);
    } catch (err) {
      if (eDeFronteira(err)) throw err;
      chegou = false;
    }
    if (chegou) {
      log.info('gancho antes do turno: mensagem nova depois da anotação do job — pergunta de novo', {
        anotada: anotada.situacao,
      });
    } else if (anotada.situacao === 'modelo') {
      // Retoma também a anotação de fallback gravada pela c01.8: o recibo
      // ainda não processado não pode desaparecer atrás da decisão 'modelo'.
      const f = !reconsulta && job.kind === 'inbound_turn' ? await formularioDoTurno(pool, alvo) : null;
      if (eReciboOpacoDoPiloto(f)) {
        pilotoPendente = { mensagem_id: f!.pedido.mensagem_id, sent_at: f!.sentAt };
      } else {
        log.info('gancho antes do turno: re-execução segue para o modelo, como a anterior', { motivo: anotada.motivo });
        return { fim: false };
      }
    } else if (anotada.situacao === 'decidido') {
      decisao = anotada;
    }
  }

  // 2. Sem decisão válida: pergunta ao gancho.
  if (decisao === null) {
    let montado: Awaited<ReturnType<typeof montarPedidoDoGancho>>;
    let ate: string | null;
    try {
      ate = await ultimaEntrada(pool, ctx.tenantId, ctx.conversationId);
      montado = await montarPedidoDoGancho(pool, {
        ...alvo,
        contactId: ctx.contactId,
        channelSessionId: ctx.channelSessionId,
        agentId: ctx.agentId,
        inboundMessageId: ctx.inboundMessageId,
        etiquetasDoContato: ctx.etiquetasDoContato,
        reconsulta,
      });
    } catch (err) {
      if (eDeFronteira(err)) throw err;
      // A leitura do card pode falhar antes de a montagem chegar ao formulário.
      // Só nesse erro, tenta reconhecer o recibo diretamente; se a leitura dele
      // também falhar, o erro sobe à fila/escolta em vez de presumir respostas.
      if (pilotoPendente === null && !reconsulta && job.kind === 'inbound_turn') {
        const f = await formularioDoTurno(pool, alvo);
        if (eReciboOpacoDoPiloto(f))
          pilotoPendente = { mensagem_id: f!.pedido.mensagem_id, sent_at: f!.sentAt };
      }
      if (pilotoPendente !== null) await aguardarPiloto('pedido_nao_montado', pilotoPendente, anotada?.ate ?? null);
      log.warn('gancho antes do turno: pedido não montado — o turno segue para o modelo', {
        erro: err instanceof Error ? err.name : 'desconhecido',
      });
      return { fim: false };
    }
    const f = montado.formulario;
    if (!reconsulta && job.kind === 'inbound_turn' && eReciboOpacoDoPiloto(f)) {
      pilotoPendente = { mensagem_id: f!.pedido.mensagem_id, sent_at: f!.sentAt };
    } else if (pilotoPendente !== null) {
      // Uma resposta NOVA de outro formulário substitui a pendência antiga.
      // Ausência na janela não é confirmação de entrega nem autoriza o modelo.
      if (f !== null && f.pedido.mensagem_id !== pilotoPendente.mensagem_id) pilotoPendente = null;
      else await aguardarPiloto('recibo_nao_reapresentado', pilotoPendente, ate);
    }
    const chamada = await chamarGancho(ctx.config, montado.pedido, ctx.agoraUnix);
    if (!chamada.ok) {
      if (pilotoPendente !== null) await aguardarPiloto(chamada.motivo, pilotoPendente, ate);
      log.warn('gancho antes do turno falhou — o turno segue para o modelo, sem gravar nada', {
        motivo: chamada.motivo,
        ...(chamada.status !== undefined ? { status: chamada.status } : {}),
      });
      await anotarComCuidado(ctx, { situacao: 'modelo', motivo: chamada.motivo, ate });
      return { fim: false };
    }
    if (pilotoPendente !== null && chamada.resposta.acao === 'seguir' && !chamada.resposta.resumo) {
      await aguardarPiloto('sem_resumo', pilotoPendente, ate);
    }
    decisao = {
      situacao: 'decidido',
      resposta: chamada.resposta,
      formulario: montado.formulario
        ? { mensagem_id: montado.formulario.pedido.mensagem_id, sent_at: montado.formulario.sentAt }
        : null,
      ate,
      ...(pilotoPendente !== null ? { recibo_opaco: true as const } : {}),
    };
    canalInterativo = montado.canalEnviaInterativo;
    card = montado.card;
    await guardServiceEffect();
    await anotarComCuidado(ctx, decisao);
  }

  const { resposta, ate: ateDaDecisao } = decisao;
  if (decisao.recibo_opaco === true && decisao.formulario !== null) pilotoPendente = decisao.formulario;
  const paraOModelo = async (motivo: string): Promise<DesfechoDoGancho> => {
    if (pilotoPendente !== null) return aguardarPiloto(motivo, pilotoPendente, ateDaDecisao);
    await anotarComCuidado(ctx, { situacao: 'modelo', motivo: motivo.slice(0, 60), ate: ateDaDecisao });
    return { fim: false };
  };
  log.info('gancho antes do turno decidiu', {
    acao: resposta.acao,
    motivo: (resposta.motivo ?? '').slice(0, 40),
    enviar: resposta.enviar?.length ?? 0,
    ...(resposta.enviar_antes?.length ? { enviar_antes: resposta.enviar_antes.length } : {}),
  });

  // 3. Os efeitos.
  if (card === undefined) card = await lerCardComCuidado(ctx);

  if (resposta.acao === 'seguir') {
    await guardServiceEffect();
    // (C01, -c01.15) As mensagens fixas do `enviar_antes` saem antes do resto: falha não
    // muda a decisão (o turno segue para o modelo, que lê o que saiu).
    const enviadasAntes = await enviarAntesDoModelo(ctx, decisao, canalInterativo);
    const antes = enviadasAntes.length > 0 ? { enviadasAntes } : {};
    // Antes do `gravar`: a etiqueta conferida é a de antes desta resposta.
    await apagarMemoriaSePedida(ctx, resposta);
    const gravou = await aplicarGravar(ctx, card, resposta.gravar);
    const relido = gravou ? await lerCardComCuidado(ctx) : null;
    const campos = relido !== null ? { camposDoCard: relido.campos, ...antes } : antes;
    await agendarReconsulta(ctx, resposta.reconsultar_em_s);
    const f = decisao.formulario;
    if (f !== null) {
      const resumo = resposta.resumo ?? null;
      try {
        await marcarFormularioProcessado(pool, { ...alvo, mensagemId: f.mensagem_id }, resumo);
        if (resumo !== null)
          return { fim: false, resumo: { mensagemId: f.mensagem_id, sentAt: f.sent_at, texto: resumo }, ...campos };
      } catch (err) {
        if (eDeFronteira(err)) throw err;
        if (pilotoPendente !== null)
          await aguardarPiloto('resumo_nao_persistido', pilotoPendente, ateDaDecisao);
        // Sem a marca, o próximo pedido leva o formulário de novo; o modelo lê as
        // respostas montadas do formulário.
        log.warn('gancho antes do turno: formulário não marcado como processado — o modelo lê as respostas dele', {
          erro: err instanceof Error ? err.name : 'desconhecido',
        });
      }
    }
    return { fim: false, ...campos };
  }

  // segurar
  const itens = resposta.enviar ?? [];
  // Na re-execução, o que este job já registrou no ledger (aceito ou com o canal) vai
  // direto ao canal, sem a cadeia: ela vetaria agora o que já saiu.
  const registrados = await Promise.all(itens.map((item) => registradoNoJob(ctx, item)));
  if (canalInterativo === null) {
    try {
      canalInterativo = await canalDoNumeroEnviaInterativo(ctx);
    } catch (err) {
      if (eDeFronteira(err)) throw err;
      log.warn('gancho antes do turno: canal do número não lido — o turno segue para o modelo', {
        erro: err instanceof Error ? err.name : 'desconhecido',
      });
      return paraOModelo('canal_nao_lido');
    }
  }
  if (!canalInterativo && itens.some((i, n) => i.tipo === 'interativo' && !registrados[n])) {
    log.warn('gancho antes do turno: canal sem mensagem interativa — o turno segue para o modelo');
    return paraOModelo('canal_sem_interativo');
  }
  let enviadas = 0;
  for (const [i, item] of itens.entries()) {
    const desfecho = await enviarItem(ctx, item, -(i + 1), canalInterativo === true, registrados[i] === true);
    if (desfecho === 'ok') {
      enviadas += 1;
      continue;
    }
    if (enviadas === 0) {
      log.warn('gancho antes do turno: envio não saiu — o turno segue para o modelo, sem gravar', {
        item: i + 1,
        desfecho,
      });
      return paraOModelo(`envio_${desfecho}`);
    }
    // O cliente já recebeu resposta: o modelo, sem saber o que saiu, repetiria.
    log.warn('gancho antes do turno: envio parcial — o que saiu fica, o gravar vale e o turno termina sem o modelo', {
      item: i + 1,
      desfecho,
      enviadas,
      previstas: itens.length,
    });
    break;
  }
  await apagarMemoriaSePedida(ctx, resposta);
  await aplicarGravar(ctx, card, resposta.gravar);
  if (decisao.formulario !== null) {
    try {
      // (C01, -c01.6) O resumo vale também no `segurar`: o modelo do turno seguinte
      // lê o resumo, não o texto neutro do formulário.
      await marcarFormularioProcessado(
        pool,
        { ...alvo, mensagemId: decisao.formulario.mensagem_id },
        resposta.resumo ?? null,
      );
    } catch (err) {
      if (eDeFronteira(err)) throw err;
      log.warn('gancho antes do turno: formulário não marcado como processado', {
        erro: err instanceof Error ? err.name : 'desconhecido',
      });
    }
  }
  if (resposta.passar_a_equipe === true) {
    await passarAEquipe(ctx, resposta, enviadas);
  } else {
    await agendarReconsulta(ctx, resposta.reconsultar_em_s);
  }
  log.info(
    itens.length === 0
      ? 'gancho antes do turno segurou sem enviar nada — turno encerrado sem o modelo'
      : 'gancho antes do turno respondeu o cliente — turno encerrado sem o modelo',
    { enviadas },
  );
  return { fim: true };
}

/**
 * (C01, -c01.6) `reconsultar_em_s`: um `inbound_turn` marcado (`MARCA_DA_RECONSULTA`)
 * pelo cron de uma vez, sem espalhamento (o cron confere a cada ~30 s: chega entre N
 * e N+30 s). Idempotente por `reconsulta_de`: a re-execução deste job não agenda de
 * novo. Passagem à equipe e opt-out cancelam o agendado (`cancelPendingCronsForLead`).
 * Falhar aqui não desfaz o que saiu: fica no log.
 */
async function agendarReconsulta(ctx: ContextoDoGancho, segundos: number | null | undefined): Promise<void> {
  if (segundos === null || segundos === undefined) return;
  const p = ctx.job.payload ?? {};
  try {
    const { rowCount } = await ctx.pool.query(
      `select 1 from cron_jobs
        where organization_id = $1 and contact_id = $2 and payload->>'reconsulta_de' = $3`,
      [ctx.tenantId, ctx.contactId, ctx.job.id],
    );
    if (rowCount !== null && rowCount > 0) return;
    const agora = ctx.now().getTime();
    await scheduleCronJob(ctx.pool, ctx.tenantId, {
      leadId: ctx.contactId,
      spec: { kind: 'at', at: new Date(agora + segundos * 1000) },
      jobKind: 'inbound_turn',
      payload: {
        conversation_id: p.conversation_id ?? ctx.conversationId,
        contact_id: p.contact_id ?? ctx.contactId,
        channel_session_id: p.channel_session_id ?? ctx.channelSessionId,
        inbound_message_id: p.inbound_message_id ?? ctx.inboundMessageId,
        crm_event_id: p.crm_event_id,
        [MARCA_DA_RECONSULTA]: true,
        reconsulta_de: ctx.job.id,
      },
      maxAttempts: 3,
      staggerWindowMs: 0,
      now: () => agora,
    });
    ctx.log.info('gancho antes do turno: reconsulta agendada', { segundos });
  } catch (err) {
    if (eDeFronteira(err)) throw err;
    ctx.log.warn('gancho antes do turno: reconsulta não agendada', {
      erro: err instanceof Error ? err.name : 'desconhecido',
    });
  }
}

/**
 * (C01, -c01.6) `passar_a_equipe`: a mesma passagem da palavra "atendente"
 * (`performHumanHandoff`: a IA fica calada, os agendados caem e abre um aviso na
 * Central), sem a linha de passagem (como o fail-safe). O aviso ao cliente é o que o
 * gancho já enviou. Idempotente: a re-execução não passa duas vezes.
 */
/**
 * (C01, -c01.6) O motivo e o título da passagem pedida pelo gancho. Frase legível, não
 * código (a mesma régua de `MOTIVO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO`): sem linha de
 * `passagens_de_atendimento`, o motivo é o que a Central mostra (`Motivo: …`) e o que fica
 * em `conversations.last_handoff_reason`. O `motivo` da resposta do gancho é código do
 * serviço de fora e vai só para o log.
 */
export const MOTIVO_DA_PASSAGEM_PELO_GANCHO =
  'O atendimento de entrada passou a conversa para uma pessoa antes de a IA responder';
export const TITULO_DA_PASSAGEM_PELO_GANCHO = 'Passado à equipe na entrada — assumir a conversa';

async function passarAEquipe(ctx: ContextoDoGancho, resposta: RespostaDoGancho, enviadas: number): Promise<void> {
  const motivo = (resposta.motivo ?? '').trim().slice(0, 60);
  // O aviso ao cliente é o que o próprio serviço de entrada mandou neste turno: a Central
  // diz à pessoa que assume se o cliente já sabe que alguém vai falar com ele.
  const avisoAoLead: DesfechoDoAviso =
    enviadas > 0 ? { avisado: true } : { avisado: false, porque: 'gancho_sem_envio' };
  try {
    await performHumanHandoff(
      ctx.pool,
      { tenantId: ctx.tenantId, leadId: ctx.contactId, conversationId: ctx.conversationId },
      {
        reason: MOTIVO_DA_PASSAGEM_PELO_GANCHO,
        conversationSummary: resposta.resumo ?? MOTIVO_DA_PASSAGEM_PELO_GANCHO,
        inboxTitle: TITULO_DA_PASSAGEM_PELO_GANCHO,
        avisoAoLead,
        log: ctx.log,
      },
    );
    ctx.log.info('gancho antes do turno: conversa passada à equipe', { motivo });
  } catch (err) {
    // A pessoa já leu que vai falar com alguém: engolir o erro deixaria a IA ligada e a
    // Central sem aviso. Sobe, como na passagem por pedido explícito (`inbound-turn.ts`),
    // e o job tenta de novo: a re-execução repete a decisão anotada, os envios voltam
    // `already_sent` pelo ledger do job e `performHumanHandoff` é idempotente.
    if (!eDeFronteira(err)) {
      ctx.log.error('gancho antes do turno: passagem à equipe falhou — o job tenta de novo', {
        erro: err instanceof Error ? err.name : 'desconhecido',
        motivo,
      });
    }
    throw err;
  }
}

/**
 * (C01, -c01.7) A etiqueta que autoriza `apagar_memoria`: o contato, ou um card dele, a
 * tem (comparada já normalizada, como o banco guarda). Constante genérica, sem nada de
 * uma organização: quem usa o `#zerar` no celular de teste põe essa etiqueta nele.
 */
export const ETIQUETA_DO_CELULAR_DE_TESTE = 'celular-de-teste';

/**
 * (C01, -c01.7) Apaga a memória do contato (`lead_notes`) só se o contato ou um card
 * dele tiver `ETIQUETA_DO_CELULAR_DE_TESTE`. Conferir e apagar numa instrução só: não há
 * janela entre a etiqueta lida e as notas apagadas. O índice da memória e o embedding
 * são da própria linha e saem com ela. Só lê `contacts.tags` e `crm_leads.tags`; só
 * apaga `lead_notes` daquele contato naquela organização.
 */
export async function apagarMemoriaDoContato(
  db: Queryable,
  organizationId: string,
  contactId: string,
): Promise<{ autorizado: boolean; apagadas: number }> {
  const { rows } = await db.query<{ autorizado: boolean; apagadas: number }>(
    `with autorizado as (
       select (
         exists (select 1 from contacts c, unnest(c.tags) as t(tag)
                  where c.organization_id = $1 and c.id = $2 and lower(btrim(t.tag)) = $3)
         or exists (select 1 from crm_leads l, unnest(l.tags) as t(tag)
                     where l.organization_id = $1 and l.contact_id = $2 and lower(btrim(t.tag)) = $3)
       ) as ok
     ),
     apagadas as (
       delete from lead_notes n
        where n.organization_id = $1 and n.contact_id = $2 and (select ok from autorizado)
       returning n.id
     )
     select (select ok from autorizado) as autorizado, (select count(*) from apagadas)::int as apagadas`,
    [organizationId, contactId, ETIQUETA_DO_CELULAR_DE_TESTE],
  );
  return { autorizado: rows[0]?.autorizado === true, apagadas: Number(rows[0]?.apagadas ?? 0) };
}

/**
 * (C01, -c01.7) `apagar_memoria`. Recusa, sem apagar nada e com o motivo no log: o
 * contato sem a etiqueta de teste; a própria resposta pondo a etiqueta
 * (`gravar.etiquetas_mais`, que valeria na re-execução); erro na leitura. Um erro do
 * gancho nunca apaga a memória de quem não é celular de teste. Falhar aqui não cala o
 * cliente: o turno segue.
 */
async function apagarMemoriaSePedida(ctx: ContextoDoGancho, resposta: RespostaDoGancho): Promise<void> {
  if (resposta.apagar_memoria !== true) return;
  if (normalizarTags(resposta.gravar?.etiquetas_mais ?? []).includes(ETIQUETA_DO_CELULAR_DE_TESTE)) {
    ctx.log.warn('gancho antes do turno: memória não apagada — a própria resposta põe a etiqueta de teste', {
      porque: 'etiqueta_na_resposta',
    });
    return;
  }
  try {
    await guardServiceEffect();
    const { autorizado, apagadas } = await apagarMemoriaDoContato(ctx.pool, ctx.tenantId, ctx.contactId);
    if (!autorizado) {
      ctx.log.warn('gancho antes do turno: memória não apagada — contato sem a etiqueta de teste', {
        porque: 'sem_etiqueta',
      });
      return;
    }
    ctx.log.info('gancho antes do turno: memória do contato apagada (celular de teste)', { notas: apagadas });
  } catch (err) {
    if (eDeFronteira(err)) throw err;
    ctx.log.warn('gancho antes do turno: memória não apagada — a leitura da etiqueta falhou', {
      porque: 'erro',
      erro: err instanceof Error ? err.name : 'desconhecido',
    });
  }
}

async function anotarComCuidado(ctx: ContextoDoGancho, d: DecisaoAnotada): Promise<void> {
  try {
    await anotarNoJob(ctx.pool, ctx.job, d);
  } catch (err) {
    if (eDeFronteira(err)) throw err;
    // Sem a anotação, a re-execução pergunta de novo; o ledger ainda segura o que
    // já saiu com o mesmo conteúdo.
    ctx.log.warn('gancho antes do turno: decisão não anotada no job', {
      erro: err instanceof Error ? err.name : 'desconhecido',
    });
  }
}

async function lerCardComCuidado(ctx: ContextoDoGancho): Promise<CardDoContato | null> {
  try {
    return await lerCardDoContato(ctx.pool, ctx.tenantId, ctx.contactId);
  } catch (err) {
    if (eDeFronteira(err)) throw err;
    return null;
  }
}

async function canalDoNumeroEnviaInterativo(ctx: ContextoDoGancho): Promise<boolean> {
  const { rows } = await ctx.pool.query<{ provider: string | null }>(
    'select provider from channel_sessions where organization_id = $1 and id = $2',
    [ctx.tenantId, ctx.channelSessionId],
  );
  return canalEnviaInterativo(rows[0]?.provider);
}

/**
 * `gravar` é efeito de conveniência: falhar aqui não cala o cliente nem desfaz o que
 * saiu. Fica no log (sem os valores) e o turno segue.
 */
async function aplicarGravar(
  ctx: ContextoDoGancho,
  card: CardDoContato | null,
  gravar: RespostaDoGancho['gravar'],
): Promise<boolean> {
  if (!gravar) return false;
  if (card === null) {
    ctx.log.warn('gancho antes do turno: sem card do funil para gravar — nada gravado');
    return false;
  }
  try {
    await gravarNoCard(ctx.pool, ctx.tenantId, card.id, gravar);
    return true;
  } catch (err) {
    if (eDeFronteira(err)) throw err;
    ctx.log.warn('gancho antes do turno: gravar no card falhou', {
      erro: err instanceof Error ? err.name : 'desconhecido',
    });
    return false;
  }
}

type DesfechoDoItem = 'ok' | 'vetado' | ChannelSendResult['kind'] | 'erro';

/** O texto que a linha da conversa mostra para um interativo. */
const textoDoInterativo = (interactive: Record<string, unknown>): string => {
  const corpo = objeto(interactive.body);
  const texto = typeof corpo?.text === 'string' ? corpo.text.trim() : '';
  return texto !== '' ? texto : `[${String(interactive.type)}]`;
};

/** O texto e o interativo de um item, como o ledger os identifica. */
function conteudoDoItem(item: NonNullable<RespostaDoGancho['enviar']>[number]): {
  body: string;
  interactive?: { type: string } & Record<string, unknown>;
} {
  return item.tipo === 'interativo'
    ? { body: textoDoInterativo(item.interactive), interactive: item.interactive }
    : { body: item.texto };
}

/**
 * Este item já tem recibo neste job (aceito, ou com o canal)? Só lê. Falhou a leitura:
 * `false`, e o item passa pela cadeia como um envio novo (o ledger ainda reconhece o
 * conteúdo aceito).
 */
async function registradoNoJob(
  ctx: ContextoDoGancho,
  item: NonNullable<RespostaDoGancho['enviar']>[number],
): Promise<boolean> {
  try {
    return await conteudoRegistradoNoJob(ctx.pool, { tenantId: ctx.tenantId, jobId: ctx.job.id, ...conteudoDoItem(item) });
  } catch (err) {
    if (eDeFronteira(err)) throw err;
    return false;
  }
}

async function enviarItem(
  ctx: ContextoDoGancho,
  item: NonNullable<RespostaDoGancho['enviar']>[number],
  seq: number,
  canalOficial: boolean,
  registrado: boolean,
): Promise<DesfechoDoItem> {
  const { body, interactive } = conteudoDoItem(item);
  const envio = (corpo: string, extra: { identidade?: string; interactive?: Record<string, unknown> & { type: string } }) =>
    ctx.channel.send({
      ...(ctx.agentOperation !== undefined ? { agentOperation: ctx.agentOperation } : {}),
      tenantId: ctx.tenantId,
      leadId: ctx.contactId,
      jobId: ctx.job.id,
      jobClaim: claimOfJob(ctx.job),
      seq,
      conversationId: ctx.conversationId,
      body: corpo,
      ...extra,
      origem: ORIGEM_DO_GANCHO,
    });
  try {
    if (registrado) {
      // A re-execução: o canal reconhece o conteúdo pelo ledger (o aceito volta
      // `already_sent`; o pendente é retomado com a mesma chave).
      const r = await envio(body, interactive !== undefined ? { interactive } : {});
      return OK_DO_GANCHO.has(r.kind) ? 'ok' : r.kind;
    }
    const cadeia = await runBeforeSend({
      pool: ctx.pool,
      log: ctx.log,
      tenantId: ctx.tenantId,
      leadId: ctx.contactId,
      jobId: ctx.job.id,
      channelSessionId: ctx.channelSessionId,
      body,
      optedOutThisTurn: ctx.optedOutThisTurn,
      // Ver o cabeçalho: no canal oficial o anti-spinning vetaria o formulário a
      // partir do terceiro lead na janela do número.
      enforceSpinning: !canalOficial,
      crmDailyLimit: null,
      resposta: true,
      now: ctx.now(),
      ...(ctx.sleep !== undefined ? { sleep: ctx.sleep } : {}),
      ...(ctx.lgpd !== undefined ? { lgpd: ctx.lgpd } : {}),
      agentId: ctx.agentId,
      ...(ctx.disclosureMode !== undefined ? { disclosureMode: ctx.disclosureMode } : {}),
      ...(ctx.agentOperation !== undefined ? { agentOperation: ctx.agentOperation } : {}),
      send: (finalBody) => {
        // A apresentação automática da 1ª mensagem emenda o corpo: no interativo, ela
        // vai no texto do próprio balão. `identidade` guarda o texto de antes, para a
        // re-execução reconhecer o envio (o hash do interativo ignora o texto do balão).
        const emendado = finalBody !== body;
        const final =
          interactive !== undefined && emendado
            ? { ...interactive, body: { ...(objeto(interactive.body) ?? {}), text: finalBody } }
            : interactive;
        return envio(finalBody, {
          ...(emendado ? { identidade: body } : {}),
          ...(final !== undefined ? { interactive: final } : {}),
        });
      },
    });
    if (cadeia.status === 'vetoed') {
      ctx.log.info('gancho antes do turno: envio vetado pela cadeia', { code: cadeia.code });
      return 'vetado';
    }
    return OK_DO_GANCHO.has(cadeia.outcome.kind) ? 'ok' : cadeia.outcome.kind;
  } catch (err) {
    if (eDeFronteira(err)) throw err;
    ctx.log.warn('gancho antes do turno: envio lançou erro', { erro: err instanceof Error ? err.name : 'desconhecido' });
    return 'erro';
  }
}

/** `metadata.origem` das mensagens que o gancho envia. */
export const ORIGEM_DO_GANCHO = 'pre_turn_hook';

// ─── (C01, -c01.15) `seguir` com `enviar_antes` ───────────────────────────────────

/**
 * Posições do ledger do `enviar_antes`: -101 a -105. Negativas, como as do `enviar`
 * (`doGancho` do ledger, fora da conta e do teto do modelo), mas em outra faixa: a
 * re-execução com a pergunta refeita pode trocar `seguir` por `segurar` no mesmo job.
 */
export const SEQ_DO_ENVIAR_ANTES = -100;

/** Uma mensagem do `enviar_antes` que saiu: o texto da linha da conversa e o instante. */
export interface EnviadaAntes {
  texto: string;
  em: Date;
}

/**
 * Manda os itens do `enviar_antes`, na ordem, pelo mesmo caminho do `enviar` do
 * `segurar` (`enviarItem`: a cadeia de antes do envio, sem atraso humano; o item que o
 * ledger deste job já tem vai direto ao canal). Devolve o que saiu NESTA execução e
 * ainda não estava no ledger — o que já estava, o histórico lido no começo do turno já
 * mostra.
 *
 * O 1º item que não sai (veto, falha do canal, interativo num canal que não o envia)
 * fica no log, os seguintes não saem (o cliente não recebe a 2ª parte sem a 1ª) e o
 * turno segue para o modelo. A anotação `enviar_antes_feito` impede a re-execução de
 * tentar de novo, inclusive o item que falhou.
 */
async function enviarAntesDoModelo(
  ctx: ContextoDoGancho,
  decisao: Extract<DecisaoAnotada, { situacao: 'decidido' }>,
  canalJaLido: boolean | null,
): Promise<EnviadaAntes[]> {
  const itens = decisao.resposta.enviar_antes ?? [];
  if (itens.length === 0) return [];
  if (decisao.enviar_antes_feito === true) {
    ctx.log.info('gancho antes do turno: enviar_antes já tentado neste job — não sai de novo', {
      previstas: itens.length,
    });
    return [];
  }
  const registrados = await Promise.all(itens.map((item) => registradoNoJob(ctx, item)));
  let canalInterativo = canalJaLido;
  if (canalInterativo === null && itens.some((i, n) => i.tipo === 'interativo' && !registrados[n])) {
    try {
      canalInterativo = await canalDoNumeroEnviaInterativo(ctx);
    } catch (err) {
      if (eDeFronteira(err)) throw err;
      ctx.log.warn('gancho antes do turno: canal do número não lido — enviar_antes sem interativo', {
        erro: err instanceof Error ? err.name : 'desconhecido',
      });
      canalInterativo = false;
    }
  }
  const enviadas: EnviadaAntes[] = [];
  for (const [i, item] of itens.entries()) {
    const desfecho: DesfechoDoItem | 'canal_sem_interativo' =
      item.tipo === 'interativo' && !registrados[i] && canalInterativo !== true
        ? 'canal_sem_interativo'
        : await enviarItem(ctx, item, SEQ_DO_ENVIAR_ANTES - (i + 1), canalInterativo === true, registrados[i] === true);
    if (desfecho !== 'ok') {
      ctx.log.warn('gancho antes do turno: enviar_antes parou — o turno segue para o modelo com o que saiu', {
        item: i + 1,
        desfecho,
        enviadas: i,
        previstas: itens.length,
      });
      break;
    }
    if (!registrados[i]) enviadas.push({ texto: conteudoDoItem(item).body, em: ctx.now() });
  }
  await anotarComCuidado(ctx, { ...decisao, enviar_antes_feito: true });
  return enviadas;
}

/**
 * O que o `enviar_antes` mandou, no fim do histórico já lido pelo turno (a abertura do
 * modelo usa a leitura do começo do turno, feita antes do envio): o modelo responde
 * sabendo o que o cliente já recebeu.
 */
export function acrescentarEnviadasAntesNoContexto(
  mensagens: LeadContextMessage[],
  enviadas: readonly EnviadaAntes[],
  fuso: string,
): void {
  for (const e of enviadas) {
    mensagens.push({ direction: 'outbound', body: e.texto, sent_at: isoLocalComOffset(e.em, fuso) });
  }
}
