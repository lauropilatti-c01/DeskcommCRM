import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { marcaDaSaida } from "@/lib/branding/saida";
import { createAdminClient } from "@/lib/supabase/admin";
import { montarPayloadDeInbound, truncar } from "./push_payload";
import { enviarPushAoUsuario, enviarPushDaOrg } from "./web_push";
import { vapidPronto } from "./vapid";
import { pushDoAvisoDaCentral } from "./push-dos-avisos";
import type { PushPayload } from "./push_payload";
import { rotuloDoContato, SEM_NOME } from "@/lib/contacts/rotulo-do-contato";
import {
  casoEsperandoGente,
  modoDoPushDeMensagem,
  pushDoCasoAtribuido,
  responsaveisDaConversa,
  type AdminDoPush,
} from "./destino-do-push";

export const WEB_PUSH_INBOUND_KEY = "web-push-inbound.v1";

async function handleInbound(row: EventRow): Promise<HandlerResult> {
  const conversationId =
    (typeof row.payload.conversation_id === "string" ? row.payload.conversation_id : null) ?? null;
  const previewRaw = row.payload.body_preview;
  const preview = typeof previewRaw === "string" && previewRaw.trim() ? previewRaw : "Nova mensagem";
  const type = typeof row.payload.type === "string" ? row.payload.type : "text";
  const body = type === "text" ? preview : "Mídia";

  const contactId = typeof row.payload.contact_id === "string" ? row.payload.contact_id : null;

  // (C01, -c01.16) Só quem responde pela conversa recebe; sem responsável, a IA
  // está atendendo e ninguém é tocado. Ver `./destino-do-push.ts`.
  let destinatarios: string[] | null = null;
  if (modoDoPushDeMensagem() === "responsavel") {
    destinatarios = await responsaveisDaConversa(
      createAdminClient() as unknown as AdminDoPush,
      row.organization_id,
      conversationId,
      contactId,
    );
    if (destinatarios === null) {
      return {
        consumer_key: WEB_PUSH_INBOUND_KEY,
        status: "retry",
        retry_at: new Date(Date.now() + 60_000).toISOString(),
        detail: "responsavel_ilegivel",
      };
    }
    if (destinatarios.length === 0) {
      return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_responsavel" };
    }
  }

  const marca = await marcaDaSaida(row.organization_id);
  let contactName: string | null = null;
  let icon: string | null = null;
  if (contactId) {
    const admin = createAdminClient();
    const { data } = await admin
      .from("contacts")
      .select("display_name, name, phone_number, avatar_storage_path, is_anonymized")
      .eq("id", contactId)
      .eq("organization_id", row.organization_id)
      .maybeSingle();
    const c = data as {
      display_name?: string | null;
      name?: string | null;
      phone_number?: string | null;
      avatar_storage_path?: string | null;
      is_anonymized?: boolean | null;
    } | null;
    // A cadeia CANÔNICA, e não a de dois campos remontada aqui: aquela deixava
    // passar o identificador técnico do WhatsApp — a notificação chegaria à tela
    // de bloqueio do celular escrita "Contato 543134@lid". `rotuloDoContato`
    // recusa identificador, cai para o telefone formatado, e só então desiste.
    //
    // (A varredura de `rotulo-do-contato.test.ts` lê o arquivo INTEIRO, comentário
    // incluído — por isso a cadeia proibida não é escrita nem aqui em prosa.)
    //
    // `SEM_NOME` volta a `null` de propósito: o payload já tem um desfecho
    // melhor para "não sei o nome" (`"Nova mensagem"`, em push_payload.ts), e
    // trocá-lo por "Sem nome" pioraria o título sem ninguém pedir.
    const rotulo = rotuloDoContato(c);
    contactName = rotulo === SEM_NOME ? null : rotulo;
    if (c?.avatar_storage_path && !c.is_anonymized) {
      const { data: signed } = await admin.storage
        .from("whatsapp-media")
        .createSignedUrl(c.avatar_storage_path, 300);
      icon = signed?.signedUrl ?? null;
    }
  }
  const payload = montarPayloadDeInbound({
    brand: marca.nome,
    conversationId,
    preview: body,
    contactName,
    icon,
  });
  if (destinatarios !== null) {
    let enviados = 0;
    for (const userId of destinatarios) {
      enviados += (await enviarPushAoUsuario(row.organization_id, userId, payload)).sent;
    }
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${enviados}` };
  }
  const { sent } = await enviarPushDaOrg(row.organization_id, payload);
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
}

/**
 * `message.group_received` — MESMO payload de `message.received` (a
 * conversa é a do GRUPO ligado, o "contato" é o placeholder de
 * `kind='whatsapp_group'`), mas nunca a cópia do 1:1: não busca nome/avatar de
 * contato (a IA não serve grupos, e a Task 8 não abre exceção só para a
 * notificação), não cria nem roteia nada — só avisa o atendente que o grupo
 * está falando. Título fixo, igual em toda organização.
 */
async function handleGroupInbound(row: EventRow): Promise<HandlerResult> {
  const conversationId =
    (typeof row.payload.conversation_id === "string" ? row.payload.conversation_id : null) ?? null;
  const previewRaw = row.payload.body_preview;
  const preview = typeof previewRaw === "string" && previewRaw.trim() ? previewRaw : "Nova mensagem";
  const type = typeof row.payload.type === "string" ? row.payload.type : "text";
  const body = type === "text" ? preview : "Mídia";

  const payload: PushPayload = {
    title: "Nova mensagem no grupo",
    body: truncar(body),
    tag: conversationId ? `msg:${conversationId}` : "msg",
    href: conversationId ? `/app/inbox?id=${conversationId}` : "/app/inbox",
  };
  const { sent } = await enviarPushDaOrg(row.organization_id, payload);
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
}

/** Os avisos da Central que pedem gente — ver `./push-dos-avisos.ts`. */
async function handleAvisoQuePedeGente(row: EventRow): Promise<HandlerResult> {
  const id = typeof row.payload.item_id === "string" ? row.payload.item_id : row.entity_id;
  if (!id) return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_alvo" };
  const payload = await pushDoAvisoDaCentral(createAdminClient(), row.organization_id, id);
  if (payload === null) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "aviso_fora_do_celular" };
  }
  const { sent } = await enviarPushDaOrg(row.organization_id, payload);
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
}

async function leadBits(organizationId: string, leadId: string): Promise<{
  title: string;
  ownerUserId: string | null;
  pipelineId: string | null;
}> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("crm_leads")
    .select("title, owner_user_id, pipeline_id")
    .eq("id", leadId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const row = data as {
    title?: string | null;
    owner_user_id?: string | null;
    pipeline_id?: string | null;
  } | null;
  return {
    title: row?.title?.trim() || "Lead",
    ownerUserId: row?.owner_user_id ?? null,
    pipelineId: row?.pipeline_id ?? null,
  };
}

function hrefDoLead(pipelineId: string | null): string {
  return pipelineId ? `/app/pipelines/${pipelineId}` : "/app/kanban";
}

async function enviarParaUsuario(
  organizationId: string,
  userId: string | null,
  payload: PushPayload,
): Promise<HandlerResult> {
  if (!userId) {
    return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_destinatario" };
  }
  const { sent } = await enviarPushAoUsuario(organizationId, userId, payload);
  return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "ok", detail: `sent:${sent}` };
}

export const webPushInboundHandler: EventHandler = {
  key: WEB_PUSH_INBOUND_KEY,
  events: [
    "message.received",
    "message.group_received",
    "lead.assigned",
    "lead.won",
    "lead.lost",
    "user.mentioned",
    // Os avisos que pedem gente (migration 0442) — ver `./push-dos-avisos.ts`.
    "central.aviso_criado",
  ],
  async handle(row): Promise<HandlerResult> {
    if (!vapidPronto()) {
      return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "vapid_ausente" };
    }
    if (row.event_type === "message.received") return handleInbound(row);
    if (row.event_type === "message.group_received") return handleGroupInbound(row);
    if (row.event_type === "central.aviso_criado") return handleAvisoQuePedeGente(row);

    if (row.event_type === "user.mentioned") {
      const toUserId = typeof row.payload.to_user_id === "string" ? row.payload.to_user_id : null;
      const conversationId =
        typeof row.payload.conversation_id === "string" ? row.payload.conversation_id : null;
      const preview =
        typeof row.payload.body_preview === "string" ? row.payload.body_preview : "Você foi mencionado";
      return enviarParaUsuario(row.organization_id, toUserId, {
        title: "Você foi mencionado",
        body: truncar(preview),
        tag: conversationId ? `mention:${conversationId}` : "mention",
        href: conversationId ? `/app/inbox/${conversationId}` : "/app/inbox",
      });
    }

    const leadId =
      (typeof row.payload.lead_id === "string" ? row.payload.lead_id : null) ??
      (typeof row.entity_id === "string" ? row.entity_id : null);
    if (!leadId) {
      return { consumer_key: WEB_PUSH_INBOUND_KEY, status: "skipped", detail: "sem_lead" };
    }
    const lead = await leadBits(row.organization_id, leadId);
    const href = hrefDoLead(lead.pipelineId);

    if (row.event_type === "lead.assigned") {
      const toUserId = typeof row.payload.to_user_id === "string" ? row.payload.to_user_id : lead.ownerUserId;
      // (C01, -c01.16) Negócio atribuído com um caso esperando gente: o push diz
      // que é um caso e abre o caso. Leitura que falha cai no aviso de sempre.
      if (toUserId) {
        const caso = await casoEsperandoGente(
          createAdminClient() as unknown as AdminDoPush,
          row.organization_id,
          leadId,
        );
        if (caso) return enviarParaUsuario(row.organization_id, toUserId, pushDoCasoAtribuido(caso));
      }
      return enviarParaUsuario(row.organization_id, toUserId, {
        title: "Lead atribuído a você",
        body: truncar(lead.title),
        tag: `lead-assigned:${leadId}`,
        href,
      });
    }
    if (row.event_type === "lead.won") {
      return enviarParaUsuario(row.organization_id, lead.ownerUserId, {
        title: "Lead ganho",
        body: truncar(lead.title),
        tag: `lead-won:${leadId}`,
        href,
      });
    }
    return enviarParaUsuario(row.organization_id, lead.ownerUserId, {
      title: "Lead perdido",
      body: truncar(lead.title),
      tag: `lead-lost:${leadId}`,
      href,
    });
  },
};
