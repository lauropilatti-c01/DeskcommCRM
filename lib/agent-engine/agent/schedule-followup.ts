import { prepararRetornoComercialC01, JANELA_RETORNO_C01, RecusaRetornoC01 } from "@/lib/followup/c01-retorno";
/**
 * Tool schedule_followup (F3-02) — o agente agenda o PRÓPRIO retorno ao lead: o
 * motor da continuidade (dor nº 4 do dono). Valida o que o modelo prometeu e cria
 * um cron_job one-shot (kind 'at') em promised_at. No disparo o cron enfileira um
 * followup_turn na fila do lead (lane por lead, F2-03) e se desabilita — one-shot.
 * A re-entrada temporal plena ("passaram N dias, você prometeu X") é a F3-03; aqui
 * a tool só CRIA o agendamento com o snapshot.
 *
 * Disciplina espelhada da update_lead_state (F2-10): whitelist .strict() + guard de
 * prototype pollution ANTES do parse (Zod v4 dropa __proto__ em silêncio — F2-12);
 * campo extra/forjado vira ENSINO pt-br ao modelo, nunca strip silencioso. tenant e
 * lead vêm SEMPRE do runtime (row do job), jamais do payload do modelo. Data no
 * passado / fora da janela aceitável (knobs) → ensino, sem agendar nada.
 *
 * ⚠️ A REGRA NÃO MORA MAIS AQUI (IA 360 · wave 2). Janela, guard anti-empilhamento
 * e formato do payload vivem em `lib/followup/retorno.ts`, compartilhados com a
 * capacidade configurável na tela e com a rota do humano. O que sobrou neste
 * arquivo é o que é só do modelo: a whitelist do payload e o ENSINO em português —
 * texto que existe para o LLM se corrigir, e que não faz sentido numa rota REST.
 */
import { z } from 'zod';
import type pg from 'pg';

import type { JanelaDeAtendimento } from './janela-de-atendimento';
import { duracaoLegivel, agendaRetorno } from '@/lib/followup/retorno';
import { criaRetornoDbPg } from '@/lib/followup/retorno-pg';
import { emitAgentActivityForContact } from '@/lib/leads/agent-activity';

import { findForbiddenKey, zodIssuesSummary } from './lead-state';

/** Janela aceitável do retorno agendado pelo agente — knobs (env.ts), nunca constantes. */
export interface FollowupWindowKnobs {
  /** antecedência mínima: promised_at antes disso é "muito cedo" (FOLLOWUP_MIN_AHEAD_MS). */
  minAheadMs: number;
  /** horizonte máximo: promised_at além disso é "muito distante" (FOLLOWUP_MAX_AHEAD_MS). */
  maxAheadMs: number;
  /** janela do stagger determinístico herdada do cron (CRON_STAGGER_WINDOW_MS). */
  staggerWindowMs: number;
}

/** Whitelist EXATA do que o modelo promete — .strict() rejeita o resto (mesmo padrão da F2-10). */
export const scheduleFollowupInputSchema = z.strictObject({
  consent_message_id: z.string().uuid().optional(),
  consent_excerpt: z.string().min(1).max(2000).optional(),
  offered_message_id: z.string().uuid().optional(),
  replace_pending_id: z.string().min(1).max(64).optional(),
  reason: z.string().min(1).max(500),
  promised_at: z.string().min(1).max(64),
  promise: z.string().min(1).max(1_000),
  context_snapshot: z.string().max(4_000).nullable().optional(),
});
export type ScheduleFollowupInput = z.infer<typeof scheduleFollowupInputSchema>;

/** Contrato público C01: identidade e prova continuam resolvidas pelo servidor. */
export const scheduleFollowupC01ToolSchema = scheduleFollowupInputSchema.omit({
  consent_message_id: true, offered_message_id: true, replace_pending_id: true,
}).extend({ substituir_pendente: z.boolean().optional() });

export const SCHEDULE_FOLLOWUP_C01_DESCRIPTION =
  'Agenda retorno SOMENTE quando o lead confirmou o dia e a hora exatos. ' +
  'Informe reason, promised_at e promise; context_snapshot e consent_excerpt são opcionais. ' +
  'Não informe identificadores de mensagens ou retornos: o servidor vincula a confirmação do turno e a oferta anterior. ' +
  'Se receber already_pending e o cliente pediu outro horário, repita com substituir_pendente=true. ' +
  'Nunca substitua sem pedido. Só confirme ao lead depois de ok=true; então encerre o turno.';

export type ScheduleFollowupResult =
  | { ok: true; cronJobId: string; promisedAt: Date; message: string }
  | {
      ok: false;
      /** Referência interna da recusa; o adaptador C01 nunca a entrega ao modelo. */
      pendingCronJobId?: string;
      error: {
        code: 'invalid_payload' | 'promised_at_in_past' | 'promised_at_out_of_window' | 'already_pending' | 'pending_changed' | 'outside_send_window' | 'callback_not_confirmed';
        message: string;
      };
    };

/** Uma instância por turno: não transforma UUID forjado em consentimento nem troca implícita. */
export function criarAgendadorC01DoTurno(aplicar: (input: unknown) => Promise<ScheduleFollowupResult>) {
  let pendenteObservado: string | undefined;
  return async (raw: unknown): Promise<ScheduleFollowupResult> => {
    const parsed = scheduleFollowupC01ToolSchema.safeParse(raw);
    if (findForbiddenKey(raw) !== null || !parsed.success) {
      return { ok: false, error: { code: 'invalid_payload', message:
        `Não informe IDs ou campos extras em schedule_followup. ${SCHEDULE_FOLLOWUP_C01_DESCRIPTION}` } };
    }
    const { substituir_pendente, ...input } = parsed.data;
    if (substituir_pendente && !pendenteObservado) {
      return { ok: false, error: { code: 'invalid_payload', message:
        'Nenhum retorno pendente foi observado nesta conversa do turno. Primeiro chame sem substituir_pendente; não invente um identificador nem confirme alteração.' } };
    }
    const result = await aplicar({ ...input, ...(substituir_pendente ? { replace_pending_id: pendenteObservado } : {}) });
    if (result.ok) {
      pendenteObservado = undefined;
      return result;
    }
    const { pendingCronJobId, ...publico } = result;
    if (result.error.code === 'already_pending') {
      pendenteObservado = pendingCronJobId;
      return { ...publico, error: { code: 'already_pending', message:
        'Já existe um retorno pendente. Não crie outro. Se o cliente pediu o novo horário, repita com substituir_pendente=true e o horário confirmado; só confirme a alteração depois de ok=true.' } };
    }
    if (result.error.code === 'pending_changed') pendenteObservado = undefined;
    return publico;
  };
}

const PAYLOAD_TEACHING =
  'Campos aceitos: reason (por que agendar), promised_at (data ISO 8601 do retorno, no futuro), ' +
  'promise (o que você prometeu ao lead), context_snapshot (contexto curto para o run futuro), ' +
  'replace_pending_id (id já existente, somente para mudar um retorno a pedido do cliente) — ' +
  'consent_message_id, consent_excerpt e offered_message_id (prova do horário confirmado). ' +
  'Nada além. Lead e organização vêm do runtime, nunca do payload da tool.';

function teachInvalidPayload(issues: string): ScheduleFollowupResult {
  return {
    ok: false,
    error: { code: 'invalid_payload', message: `payload inválido em schedule_followup (${issues}). ${PAYLOAD_TEACHING}` },
  };
}

/**
 * Valida o payload prometido e cria o cron_job one-shot. Idempotência/exactly-once do
 * DISPARO é da F3-01 (scheduleCronJob + tickCron); aqui a garantia é só de validação
 * na CRIAÇÃO. Erros de DB (ex.: lead sumiu) sobem — o tool wrapper do run os captura
 * e ensina o modelo a encerrar (padrão F2-09).
 */
export async function applyScheduleFollowup(
  db: pg.Pool,
  cfg: { clock: () => Date; knobs: FollowupWindowKnobs; horario?: JanelaDeAtendimento | null; c01Callback?: boolean },
  ids: { tenantId: string; leadId: string; agentId?: string | null; sourceJobId?: string },
  rawInput: unknown,
): Promise<ScheduleFollowupResult> {
  const forbidden = findForbiddenKey(rawInput);
  if (forbidden !== null) {
    return teachInvalidPayload(`campos não reconhecidos: ${forbidden}`);
  }
  const parsed = scheduleFollowupInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return teachInvalidPayload(zodIssuesSummary(parsed.error));
  }
  const input = parsed.data;

  // Um relógio só para decidir E para ensinar — ver o ⚠️ das mensagens abaixo.
  const agora = cfg.clock();
  let comercial: Awaited<ReturnType<typeof prepararRetornoComercialC01>> | undefined;
  if (cfg.c01Callback) {
    try {
      comercial = await prepararRetornoComercialC01(db, {
        organizationId: ids.tenantId, contactId: ids.leadId, sourceJobId: ids.sourceJobId, agentId: ids.agentId, promisedAt: input.promised_at, consent: input,
      });
    } catch (err) {
      // Recusa de política é resposta, não falha: refazer o turno não muda o que a pessoa disse.
      if (!(err instanceof RecusaRetornoC01)) throw err;
      return { ok: false, error: { code: 'callback_not_confirmed', message:
        `nenhum retorno foi criado (${err.message}). Não prometa retorno nem horário; responda ao lead sem agendar ` +
        `e, se for o caso, diga que ela pode chamar aqui quando puder.` } };
    }
  }
  const horario = cfg.c01Callback ? JANELA_RETORNO_C01 : cfg.horario;
  const resultado = await agendaRetorno(
    criaRetornoDbPg(db),
    { agora, janela: cfg.knobs, horario },
    // No harness, "lead" É o contato (inbound-turn: leadId = job.contact_id) — é
    // exatamente o que `cron_jobs.contact_id` guarda.
    { orgId: ids.tenantId, contactId: ids.leadId },
    {
      comercial,
      substituirRetornoId: input.replace_pending_id,
      agenteId: ids.agentId ?? undefined,
      motivo: input.reason,
      prometidoPara: input.promised_at,
      promessa: input.promise,
      contexto: input.context_snapshot ?? null,
    },
  );

  if (!resultado.ok) {
    // ⚠️ A RECUSA DIZ QUE HORAS SÃO. O modelo não sabe que dia é hoje — medido
    // num turno real: pedido "daqui a três dias", ele mandou a data do próprio
    // treino. Dizer só "já passou" é verdade e é inútil: ele repete a mesma data
    // e queima os passos do turno. Quem recusa devolve o que falta para corrigir.
    const agoraIso = agora.toISOString();
    switch (resultado.codigo) {
      case 'instante_invalido':
        return teachInvalidPayload(
          `promised_at não é uma data ISO 8601 válida. AGORA é ${agoraIso} — some o prazo pedido a este instante e mande o resultado absoluto`,
        );
      case 'instante_no_passado':
        return {
          ok: false,
          error: {
            code: 'promised_at_in_past',
            message:
              `a data prometida (promised_at) já passou: AGORA é ${agoraIso}. Some o prazo ` +
              `combinado a este instante e mande a data absoluta resultante — não repita a mesma data.`,
          },
        };
      case 'instante_fora_da_janela': {
        const cedoDemais = new Date(agora.getTime() + resultado.janela.minAheadMs).toISOString();
        const tardeDemais = new Date(agora.getTime() + resultado.janela.maxAheadMs).toISOString();
        return {
          ok: false,
          error: {
            code: 'promised_at_out_of_window',
            message:
              `horário fora da janela aceitável de follow-up. AGORA é ${agoraIso}; o retorno tem de ` +
              `cair entre ${cedoDemais} e ${tardeDemais} ` +
              `(${duracaoLegivel(resultado.janela.minAheadMs)} a ${duracaoLegivel(resultado.janela.maxAheadMs)} a partir de agora).`,
          },
        };
      }
      case 'horario_nao_permitido':
        return { ok: false, error: { code: 'outside_send_window', message:
          `O horário fica fora da faixa permitida (${horario?.start}–${horario?.end}, ${horario?.timezone}). Combine outro horário; nenhum retorno foi criado ou alterado.` } };
      case 'retorno_alterado':
        return { ok: false, error: { code: 'pending_changed', message:
          'O retorno foi cancelado, disparou ou mudou enquanto você tentava alterar. Não prometa o novo horário nem crie outro automaticamente; confira o estado atual.' } };
      case 'ja_existe_retorno': {
        // Guard anti-empilhamento (1 follow-up VIVO por lead): sem isto, o agente
        // marca um "reconfirmar amanhã" a cada turno e o lead vira alvo de N
        // sequências paralelas com data relativa congelada — o bug de spam de
        // produção. Um follow-up pendente já cobre o retorno; o modelo é ENSINADO
        // a não duplicar (não é erro fatal, é continue-sem-agendar).
        const quando = resultado.existente?.prometidoPara ?? null;
        return {
          ok: false,
          ...(cfg.c01Callback ? { pendingCronJobId: resultado.existente?.id } : {}),
          error: {
            code: 'already_pending',
            message:
              `este lead JÁ tem um follow-up agendado${quando ? ` para ${quando}` : ''} — ` +
              `não agende outro (evita bombardear o lead com confirmações repetidas). ` +
              `Se o cliente pediu outro horário, repita a chamada com replace_pending_id="${resultado.existente?.id}" e a nova data. ` +
              `Só confirme a alteração depois de ok=true; nunca cancele e crie outro em duas chamadas. ` +
              `Use SEMPRE data ABSOLUTA (ex.: "2026-07-25T13:00:00Z"), nunca relativa como "amanhã" — ` +
              `a promessa é lida dias depois e "amanhã" fica sem sentido.`,
          },
        };
      }
    }
  }

  // O RETORNO ENTRA NA TIMELINE DO NEGÓCIO. Antes desta wave, o agendamento feito
  // pelo motor só existia em `cron_jobs`: o humano via o card do negócio parar de
  // esfriar (o radar o classifica "em voo") e não tinha onde ler POR QUÊ. Falha
  // baixo e roteamento sem adivinhação são de `emitAgentActivityForContact` — não
  // se inventa emissor novo aqui.
  await emitAgentActivityForContact({
    pool: db,
    organizationId: ids.tenantId,
    contactId: ids.leadId,
    type: 'followup_scheduled',
    reason: `${resultado.substituiu ? "Retorno reagendado" : "Retorno agendado"} — ${input.reason}`,
    sourceModule: 'followup',
    sourceId: null,
    agentId: ids.agentId ?? null,
    payload: {
      retorno_id: resultado.retorno.id,
      quando: resultado.retorno.quando,
      prometido_para: resultado.retorno.prometidoPara,
      ...(resultado.substituiu ? { horario_anterior: resultado.substituiu.prometidoPara ?? resultado.substituiu.quando } : {}),
    },
  });

  return {
    ok: true,
    cronJobId: resultado.retorno.id,
    promisedAt: new Date(resultado.retorno.quando),
    message:
      `retorno ${resultado.substituiu ? "reagendado" : "agendado"} para ${input.promised_at}. Agora confirme ao lead, numa resposta curta, ` +
      `o dia e a hora combinados e depois encerre o turno; o sistema fará o follow-up com o lead no horário combinado.`,
  };
}
