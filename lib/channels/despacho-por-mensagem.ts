import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const TIPO = "ai_agent.dispatch_requested";
const idsSchema = z.object({
  organizationId: z.string().uuid(),
  contactId: z.string().uuid(),
  conversationId: z.string().uuid(),
  channelSessionId: z.string().uuid(),
  messageId: z.string().uuid(),
});
export type OrigemDoDespacho = z.infer<typeof idsSchema> & { origem: string; requestId?: string };

/** Identidade do pedido, não autorização: o vínculo é relido antes de usá-la. */
function idDoPedido(e: OrigemDoDespacho): string {
  const hash = createHash("sha256")
    .update(`dispatch-message:v1:${e.organizationId}:${e.messageId}`)
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x80; // UUID v8: espaço próprio, derivado do contrato.
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function payload(e: OrigemDoDespacho) {
  return {
    organization_id: e.organizationId,
    contact_id: e.contactId,
    conversation_id: e.conversationId,
    channel_session_id: e.channelSessionId,
    inbound_message_id: e.messageId,
  };
}
function eventoConfere(row: Record<string, unknown>, e: OrigemDoDespacho): boolean {
  if (
    typeof row.id !== "string" ||
    !z.string().uuid().safeParse(row.id).success ||
    row.organization_id !== e.organizationId ||
    row.entity_kind !== "message" ||
    row.entity_id !== e.messageId ||
    row.event_type !== TIPO
  )
    return false;
  const p = row.payload;
  return Boolean(
    p &&
    typeof p === "object" &&
    Object.entries(payload(e)).every(([k, v]) => (p as Record<string, unknown>)[k] === v),
  );
}

/**
 * Repetir SOMENTE o pedido de despacho conserva a origem da fila existente.
 * Não reaplica opt-out, card, campanha ou acompanhamento. Não é recuperador
 * de pós-entrada: o chamador precisa provar que os passos anteriores terminaram.
 */
export async function registrarDespachoPorMensagem(
  admin: SupabaseClient,
  entrada: OrigemDoDespacho,
): Promise<string> {
  idsSchema.parse(entrada);
  const { data: message, error: messageError } = await admin
    .from("messages")
    .select("id, organization_id, contact_id, conversation_id, channel_session_id, direction, type")
    .eq("organization_id", entrada.organizationId)
    .eq("id", entrada.messageId)
    .maybeSingle();
  if (
    messageError ||
    !message ||
    message.direction !== "inbound" ||
    message.type === "reaction" ||
    message.organization_id !== entrada.organizationId ||
    message.id !== entrada.messageId ||
    message.contact_id !== entrada.contactId ||
    message.conversation_id !== entrada.conversationId ||
    message.channel_session_id !== entrada.channelSessionId
  )
    throw new Error("despacho: mensagem ou vínculo não comprovado");

  // Eventos legados já são a origem de jobs/recibos. Nunca substituí-los por
  // um UUID novo; dois anteriores ou payload divergente exigem revisão.
  const { data: anteriores, error: readError } = await admin
    .from("event_log")
    .select("id, organization_id, event_type, entity_kind, entity_id, payload")
    .eq("organization_id", entrada.organizationId)
    .eq("event_type", TIPO)
    .eq("entity_kind", "message")
    .eq("entity_id", entrada.messageId)
    .limit(2);
  if (readError || !Array.isArray(anteriores))
    throw new Error("despacho: leitura da origem indisponível");
  if (anteriores.length) {
    if (anteriores.length !== 1 || !eventoConfere(anteriores[0], entrada))
      throw new Error("despacho: origem anterior ambígua");
    return anteriores[0].id as string;
  }

  const id = idDoPedido(entrada);
  const { data: inserted, error } = await admin
    .from("event_log")
    .insert({
      id,
      organization_id: entrada.organizationId,
      event_type: TIPO,
      entity_kind: "message",
      entity_id: entrada.messageId,
      payload: payload(entrada),
      metadata: {
        source: entrada.origem,
        request_id: entrada.requestId,
        emitted_at: Date.now() / 1000,
        dispatch_identity: "message:v1",
      },
    })
    .select("id")
    .maybeSingle();
  if (!error && inserted?.id === id) return id;
  if (error?.code !== "23505") throw new Error("despacho: persistência não confirmada");
  const { data: existente, error: conflictError } = await admin
    .from("event_log")
    .select("id, organization_id, event_type, entity_kind, entity_id, payload")
    .eq("organization_id", entrada.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (conflictError || !existente || !eventoConfere(existente, entrada))
    throw new Error("despacho: conflito sem prova de repetição");
  return id;
}
