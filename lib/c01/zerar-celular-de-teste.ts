/**
 * (C01, -c01.15, P8) O `#zerar` DO CELULAR DE TESTE PASSA ANTES DO BLOQUEIO.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Quem testa o agente pelo celular manda `#zerar` para recomeçar a conversa do
 * zero, e quem atende o comando é o gancho antes do turno (o porteiro limpa o
 * card e apaga a memória, `apagarMemoriaDoContato`). Só que o gancho roda DENTRO
 * do turno, e o turno nunca chega quando a conversa está calada ou bloqueada:
 *
 *   - o drain não enfileira conversa com `force_human`, silêncio ou dono humano
 *     (`decidirElegibilidadeDaConversa`);
 *   - o handler pula o lead em passagem (`isLeadInHandoff`);
 *   - o turno não chama o gancho com o contato bloqueado (`optedOutThisTurn`).
 *
 * Bastava o teste chegar numa passagem ao humano, ou mandar "parar" para conferir
 * o opt-out, e o celular de teste ficava preso: o `#zerar` não destravava nada,
 * e só a tela do CRM devolvia o número.
 *
 * ─── O que esta função faz ──────────────────────────────────────────────────
 *
 * Na ingestão, ANTES do despacho: se o texto é exatamente `#zerar` (sem espaços
 * nas pontas, sem diferença de maiúsculas) e o contato, ou um card dele, tem a
 * etiqueta do celular de teste, ela tira o bloqueio de opt-out (só o de
 * opt-out, `stop_keyword`) e devolve as conversas do contato à IA pela MESMA
 * regra do botão da tela (`devolverAtendimentoAoAgente`: dono humano, silêncio,
 * `force_human`). O turno segue normal, e o gancho faz a limpeza do card.
 *
 * Número sem a etiqueta: nada muda, nem uma consulta a mais quando o texto não é
 * o comando. Nunca lança: a mensagem do cliente já está gravada (ver o cabeçalho
 * de `lib/channels/pos-entrada.ts`).
 */
import { audit } from "@/lib/audit";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * A etiqueta que autoriza o comando. É a MESMA de `ETIQUETA_DO_CELULAR_DE_TESTE`
 * (`lib/agent-engine/agent/gancho-antes-do-turno.ts`), repetida aqui para a
 * ingestão não importar o motor do agente inteiro. Mudar uma exige mudar a outra:
 * `tests/unit/c01-zerar-celular-de-teste.test.ts` compara as duas.
 */
export const ETIQUETA_DO_CELULAR_DE_TESTE = "celular-de-teste";

/** O comando: exatamente `#zerar`, sem espaços nas pontas e sem diferença de maiúsculas. */
export function ehComandoZerar(texto: string | null): boolean {
  return texto !== null && texto.trim().toLowerCase() === "#zerar";
}

export interface EntradaDoZerar {
  organizationId: string;
  contactId: string;
  conversationId: string;
  channelSessionId: string;
  texto: string | null;
  requestId?: string;
  origem: string;
}

export interface DesfechoDoZerar {
  aplicado: boolean;
  motivo?: "nao_e_zerar" | "sem_etiqueta" | "erro";
  conversasDevolvidas: number;
  desbloqueado: boolean;
}

interface ContatoDoZerar {
  tags: string[] | null;
  force_human: boolean | null;
  is_blocked: boolean | null;
  blocked_reason: string | null;
}

interface ConversaDoZerar {
  id: string;
  bot_silenced_until: string | null;
  assignee_kind: string | null;
  assigned_to_user_id: string | null;
}

/** Mesma comparação de `apagarMemoriaDoContato`: `lower(btrim(tag))`. */
function temEtiquetaDeTeste(tags: readonly unknown[] | null | undefined): boolean {
  return (tags ?? []).some(
    (tag) => typeof tag === "string" && tag.trim().toLowerCase() === ETIQUETA_DO_CELULAR_DE_TESTE,
  );
}

const detalhe = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 160);

export async function zerarCelularDeTesteSePedido(
  admin: Admin,
  entrada: EntradaDoZerar,
): Promise<DesfechoDoZerar> {
  const nada = { conversasDevolvidas: 0, desbloqueado: false };
  if (!ehComandoZerar(entrada.texto)) return { aplicado: false, motivo: "nao_e_zerar", ...nada };

  const { organizationId, contactId } = entrada;
  let contato: ContatoDoZerar | null;
  let etiquetada: boolean;
  try {
    const { data, error } = await admin
      .from("contacts")
      .select("tags, force_human, is_blocked, blocked_reason")
      .eq("organization_id", organizationId)
      .eq("id", contactId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    contato = (data ?? null) as ContatoDoZerar | null;
    etiquetada = temEtiquetaDeTeste(contato?.tags);
    if (!etiquetada) {
      const { data: cards, error: erroDosCards } = await admin
        .from("crm_leads")
        .select("tags")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId);
      if (erroDosCards) throw new Error(erroDosCards.message);
      etiquetada = ((cards ?? []) as Array<{ tags: string[] | null }>).some((card) =>
        temEtiquetaDeTeste(card.tags),
      );
    }
  } catch (err) {
    // Na dúvida, não age: destravar um contato que não é de teste é o pior erro daqui.
    logger.warn("[zerar] etiqueta do celular de teste não lida — nada destravado", {
      organization_id: organizationId,
      origem: entrada.origem,
      detail: detalhe(err),
    });
    return { aplicado: false, motivo: "erro", ...nada };
  }
  if (contato === null || !etiquetada) return { aplicado: false, motivo: "sem_etiqueta", ...nada };

  // (1) O bloqueio de opt-out, e só ele: outro motivo de bloqueio foi decisão de alguém.
  let desbloqueado = false;
  if (contato.is_blocked === true && contato.blocked_reason === "stop_keyword") {
    try {
      const { error } = await admin
        .from("contacts")
        .update({ is_blocked: false, blocked_reason: null, blocked_at: null })
        .eq("organization_id", organizationId)
        .eq("id", contactId)
        .eq("blocked_reason", "stop_keyword");
      if (error) throw new Error(error.message);
      desbloqueado = true;
      // Espelha a rota de desbloqueio (`contacts/[id]/unblock`): o fato fica no log,
      // sem telefone.
      await audit({
        action: "contact.unblocked",
        organizationId,
        resourceType: "contact",
        resourceId: contactId,
        requestId: entrada.requestId,
        metadata: { contact_id: contactId, origem: "zerar_celular_de_teste" },
      });
    } catch (err) {
      logger.error("[zerar] bloqueio de opt-out do celular de teste não foi tirado", {
        organization_id: organizationId,
        contact_id: contactId,
        detail: detalhe(err),
      });
    }
  }

  // (2) As conversas voltam à IA pela regra do botão da tela. A da entrada sempre;
  // as outras do contato só se estiverem fora da IA — `isLeadInHandoff` olha todas.
  const alvos = new Set<string>([entrada.conversationId]);
  try {
    const { data, error } = await admin
      .from("conversations")
      .select("id, bot_silenced_until, assignee_kind, assigned_to_user_id")
      .eq("organization_id", organizationId)
      .eq("contact_id", contactId);
    if (error) throw new Error(error.message);
    for (const conversa of (data ?? []) as ConversaDoZerar[]) {
      if (
        conversa.bot_silenced_until !== null ||
        conversa.assignee_kind === "user" ||
        conversa.assigned_to_user_id !== null
      ) {
        alvos.add(conversa.id);
      }
    }
  } catch (err) {
    logger.warn("[zerar] conversas do contato não lidas — só a da mensagem volta à IA", {
      organization_id: organizationId,
      detail: detalhe(err),
    });
  }

  let conversasDevolvidas = 0;
  let daEntradaDevolvida = false;
  for (const conversationId of alvos) {
    try {
      const resultado = await devolverAtendimentoAoAgente(
        {
          supabase: admin,
          organizationId,
          actor: { type: "webhook_source", id: entrada.channelSessionId },
          requestId: entrada.requestId ?? "zerar-celular-de-teste",
        },
        { conversationId },
      );
      if (resultado.ok) {
        conversasDevolvidas += 1;
        if (conversationId === entrada.conversationId) daEntradaDevolvida = true;
      } else {
        logger.warn("[zerar] conversa do celular de teste não voltou à IA", {
          organization_id: organizationId,
          conversation_id: conversationId,
          erro: resultado.erro,
        });
      }
    } catch (err) {
      logger.warn("[zerar] devolução da conversa do celular de teste falhou", {
        organization_id: organizationId,
        conversation_id: conversationId,
        detail: detalhe(err),
      });
    }
  }

  // (3) `force_human` é do contato e cala todas as conversas: se a devolução da
  // conversa da mensagem não chegou a soltá-lo, solta aqui.
  if (contato.force_human === true && !daEntradaDevolvida) {
    try {
      const { error } = await admin
        .from("contacts")
        .update({ force_human: false })
        .eq("organization_id", organizationId)
        .eq("id", contactId);
      if (error) throw new Error(error.message);
    } catch (err) {
      logger.error("[zerar] force_human do celular de teste não foi limpo", {
        organization_id: organizationId,
        contact_id: contactId,
        detail: detalhe(err),
      });
    }
  }

  logger.info("[zerar] celular de teste destravado antes do despacho", {
    organization_id: organizationId,
    conversation_id: entrada.conversationId,
    conversas_devolvidas: conversasDevolvidas,
    desbloqueado,
  });
  return { aplicado: true, conversasDevolvidas, desbloqueado };
}
