import { serviceFromMessage } from "@/lib/atendimento/origem-mensagem";
/**
 * Handler: ai-handoff-from-sentiment.v1
 *
 * Consume `ai.sentiment_alert` (emitido por `ai-sentiment-worker` quando
 * sentiment_score < threshold) e dispara handoff via orquestrador central
 * com reason='low_sentiment' (gate G2 do EPIC-06).
 *
 * Service-role bypassa RLS → toda query filtra `organization_id` programático.
 */

import type { EventHandler, HandlerResult } from "@/lib/event-log/dispatcher";
import { CHAVES_DO_CLIMA } from "@/lib/ai/decisao/metadados-do-clima";
import { triggerHandoff } from "@/lib/ai/handoff/orchestrator";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import {
  abrirCasoSemPassagem,
  BLOQUEIO_DO_CASO_POR_SENTIMENTO,
  passagemDesligadaNaConversa,
  resumoDoCasoPorSentimento,
  TITULO_DO_CASO_POR_SENTIMENTO,
} from "@/lib/c01/passagem-da-conversa";
import { createAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

export const AI_HANDOFF_FROM_SENTIMENT_KEY = "ai-handoff-from-sentiment.v1";

export const aiHandoffFromSentimentHandler: EventHandler = {
  key: AI_HANDOFF_FROM_SENTIMENT_KEY,
  events: ["ai.sentiment_alert"],
  async handle(row): Promise<HandlerResult> {
    const messageId =
      (row.payload?.["message_id"] as string | undefined) ?? row.entity_id ?? null;
    const conversationIdHint =
      (row.payload?.["conversation_id"] as string | undefined) ?? null;
    const sentimentScore =
      (row.payload?.["sentiment_score"] as number | undefined) ?? null;
    /** Qual motor mediu — a passagem marca "(percebido pelo Jev)" quando foi ele. */
    const sentimentEngine =
      (row.payload?.[CHAVES_DO_CLIMA.motor] as string | undefined) ?? null;

    if (!messageId && !conversationIdHint) {
      return {
        consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
        status: "skipped",
        detail: "missing_ids",
      };
    }

    const admin = createAdminClient();

    const boundary = messageId ? await serviceFromMessage(admin, row.organization_id, messageId) : null;
    if (!boundary || (conversationIdHint && boundary.conversation_id !== conversationIdHint)) {
      return { consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY, status: "skipped", detail: "service_boundary_stale" };
    }
    const conversationId = boundary.conversation_id;
    const contactId = boundary.contact_id;

    // Best-effort: resolve the most recent open lead for this contact so the
    // orchestrator can write a timeline activity. If unavailable we still
    // proceed — handoff itself doesn't depend on having a lead.
    let leadId: string | null = null;
    if (contactId) {
      const { data: lead } = await admin
        .from("crm_leads")
        .select("id, organization_id, status, created_at")
        .eq("organization_id", row.organization_id)
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lead) leadId = (lead as { id: string }).id;
    }

    // (C01, -c01.15, P3) Passagem desligada no agente da conversa: o sentimento baixo
    // abre um caso para a equipe e a IA continua atendendo — sem `triggerHandoff`,
    // que silenciaria a conversa para sempre. A mesma régua de elegibilidade dele:
    // conversa que a IA não está atendendo (calada, com dono humano, fora da lista)
    // não ganha caso; leitura que falha não abre nada, e o evento não re-tenta à toa.
    if (await passagemDesligadaNaConversa(admin, row.organization_id, conversationId)) {
      try {
        const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
          organizationId: row.organization_id,
          conversationId,
          agora: new Date(),
          ttlMs: ttlDaAutorizacaoMs(process.env),
        });
        if (elegib !== null && !elegib.permite) {
          return {
            consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
            status: "skipped",
            detail: `nao_elegivel:${elegib.motivo}`,
          };
        }
      } catch (err) {
        logger.warn("[ai-handoff-from-sentiment] elegibilidade indeterminada — caso não aberto", {
          conversation_id: conversationId,
          detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
        });
        return {
          consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
          status: "skipped",
          detail: "elegibilidade_indeterminada",
        };
      }
      try {
        const caso = await abrirCasoSemPassagem(admin, {
          organizationId: row.organization_id,
          conversationId,
          serviceBoundary: boundary,
          title: TITULO_DO_CASO_POR_SENTIMENTO,
          summary: resumoDoCasoPorSentimento(sentimentScore, sentimentEngine),
          blocker: BLOQUEIO_DO_CASO_POR_SENTIMENTO,
        });
        // Caso já aberto conta como feito: a equipe já tem a conversa na fila, e um
        // `skipped` aqui só diria "não fiz nada" sobre um alerta que foi atendido.
        return {
          consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
          status: "ok",
          detail: caso.aberto ? "caso_aberto_sem_passagem" : "caso_ja_aberto_sem_passagem",
        };
      } catch (err) {
        logger.warn("[ai-handoff-from-sentiment] caso sem passagem não aberto — o evento re-tenta", {
          conversation_id: conversationId,
          detail: err instanceof Error ? err.message.slice(0, 160) : "erro",
        });
        return {
          consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
          status: "error",
          detail: "caso_sem_passagem_falhou",
        };
      }
    }

    const result = await triggerHandoff({
      serviceBoundary: boundary,
      conversationId,
      organizationId: row.organization_id,
      reason: "low_sentiment",
      origem: "sentimento",
      leadId,
      metadata: {
        sentiment_score: sentimentScore,
        [CHAVES_DO_CLIMA.motor]: sentimentEngine,
        message_id: messageId,
        source: "ai.sentiment_alert",
      },
    });

    if (!result.triggered) {
      logger.info("[ai-handoff-from-sentiment] handoff not triggered", {
        conversation_id: conversationId,
        reason: result.reason,
      });
      return {
        consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
        status: "skipped",
        detail: result.reason,
      };
    }

    return {
      consumer_key: AI_HANDOFF_FROM_SENTIMENT_KEY,
      status: "ok",
      detail: result.reason,
    };
  },
};
