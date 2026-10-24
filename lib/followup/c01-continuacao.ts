import { z } from "zod";
import { estadoDoToque, type Toque } from "./c01-acompanhamento";

/** A ferramenta propõe; identidade, conclusão e entrega pertencem ao servidor. */
export const propostaContinuacaoC01Schema = z.discriminatedUnion("estado", [
  z.strictObject({
    estado: z.enum(["concluido", "pausa", "recusa", "compra_informada", "humano"]),
  }),
  z.strictObject({
    estado: z.literal("pendente"),
    caminho: z.enum(["L1", "L2"]),
    mensagem_entrada_id: z.uuid(),
    trecho_do_pedido: z.string().trim().min(3).max(700),
    natureza: z.enum(["informacao_solicitada", "escolha_em_aberto", "decisao_da_oferta"]),
    texto: z.string().trim().min(1).max(700).optional(),
  }),
]);
export type PropostaContinuacaoC01 = z.infer<typeof propostaContinuacaoC01Schema>;

export interface FatosContinuacaoC01 {
  enabled: boolean;
  approved: boolean;
  activatedAt: string | null;
  organizationId: string;
  contactId: string;
  conversationId: string;
  leadId: string;
  productKey: string | null;
  job: {
    id: string;
    organizationId: string;
    contactId: string;
    conversationId: string;
    kind: string;
    status: string;
    createdAt: string;
    completedAt: string | null;
    inboundMessageId: string;
  };
  inbound: {
    id: string;
    organizationId: string;
    contactId: string;
    conversationId: string;
    direction: string;
    body: string;
    at: string;
    revoked: boolean;
  };
  final: {
    id: string;
    jobId: string;
    organizationId: string;
    contactId: string;
    conversationId: string;
    direction: string;
    externalId: string | null;
    sentAt: string;
    receipt: Toque;
  };
  latestInboundId: string;
  latestOutboundId: string;
  human: boolean;
  openCase: boolean;
  refused: boolean;
  restricted: boolean;
  pause: boolean;
  purchaseReported: boolean;
  callback: boolean;
  liveSequence: boolean;
  /** Leitura autenticada da origem; nunca etiqueta, next_action ou palpite do modelo. */
  offer: null | {
    enrollmentId: string;
    originMessageId: string;
    organizationId: string;
    contactId: string;
    conversationId: string;
    leadId: string;
    productKey: string;
    deliveredAt: string;
    trusted: boolean;
    touches: Toque[];
  };
}

export type PlanoContinuacaoC01 =
  | { kind: "blocked"; reason: string }
  | {
      kind: "candidate";
      path: "L1" | "L2";
      idempotencyKey: string;
      anchorMessageId: string;
      anchorAt: string;
      replyBarrierMessageId: string;
      nextTouch: number;
      dueAt: string;
      body: string | null;
      originalEnrollmentId: string | null;
    };

/** Ponto de decisão puro. Ainda não inscreve nem envia. */
export function planejarContinuacaoC01(
  raw: unknown,
  f: FatosContinuacaoC01,
  now: Date,
): PlanoContinuacaoC01 {
  const block = (reason: string): PlanoContinuacaoC01 => ({ kind: "blocked", reason });
  if (!f.enabled || !f.approved || !f.activatedAt) return block("politica_desligada_ou_candidata");
  const parsed = propostaContinuacaoC01Schema.safeParse(raw);
  if (!parsed.success || parsed.data.estado !== "pendente") return block("sem_pedido_aberto");
  const p = parsed.data;
  const scope = [f.job, f.inbound, f.final];
  if (
    scope.some(
      (s) =>
        s.organizationId !== f.organizationId ||
        s.contactId !== f.contactId ||
        s.conversationId !== f.conversationId,
    ) ||
    !f.leadId ||
    f.final.jobId !== f.job.id ||
    f.inbound.id !== f.job.inboundMessageId ||
    p.mensagem_entrada_id !== f.inbound.id ||
    f.inbound.direction !== "inbound" ||
    f.final.direction !== "outbound" ||
    f.inbound.revoked
  )
    return block("vinculo_do_turno_invalido");
  if (f.job.kind !== "inbound_turn" || f.job.status !== "done" || !f.job.completedAt)
    return block("turno_nao_concluido");
  const times = [
    f.activatedAt,
    f.job.createdAt,
    f.job.completedAt,
    f.inbound.at,
    f.final.sentAt,
  ].map(Date.parse);
  if (
    !Number.isFinite(+now) ||
    times.some((t) => !Number.isFinite(t) || t > +now) ||
    Date.parse(f.job.createdAt) < Date.parse(f.activatedAt) ||
    Date.parse(f.final.sentAt) < Date.parse(f.inbound.at) ||
    Date.parse(f.job.completedAt) < Date.parse(f.final.sentAt)
  )
    return block("relogio_ou_ativacao_invalida");
  if (f.latestInboundId !== f.inbound.id || f.latestOutboundId !== f.final.id)
    return block("conversa_mudou");
  if (
    f.human ||
    f.openCase ||
    f.refused ||
    f.restricted ||
    f.pause ||
    f.purchaseReported ||
    f.callback ||
    f.liveSequence
  )
    return block("prioridade_ou_bloqueio_atual");
  if (!f.inbound.body.includes(p.trecho_do_pedido) || encerramentoIsolado(f.inbound.body))
    return block("pedido_sem_evidencia");
  if (
    !f.final.externalId ||
    f.final.receipt.messageIds.length !== 1 ||
    f.final.receipt.messageIds[0] !== f.final.id ||
    estadoDoToque(f.final.receipt) !== "delivered"
  )
    return block("saida_final_sem_entrega");
  const receipt = f.final.receipt.receipts[0]!;
  // Read pode substituir delivered_at no canal. O maior horário é conservador.
  const delivery = Math.max(
    ...[receipt.delivered_at, receipt.read_at]
      .filter((t): t is string => t !== null && Number.isFinite(Date.parse(t)))
      .map(Date.parse),
  );
  if (!Number.isFinite(delivery) || delivery > +now || delivery < Date.parse(f.final.sentAt))
    return block("recibo_com_relogio_invalido");
  const silenceDue = delivery + 2 * 3_600_000;
  const base = {
    kind: "candidate" as const,
    path: p.caminho,
    idempotencyKey: `c01-continuation:${f.job.id}`,
    replyBarrierMessageId: f.inbound.id,
  };
  if (p.caminho === "L1") {
    if (f.offer || !p.texto || p.natureza === "decisao_da_oferta")
      return block("L1_sem_texto_ou_com_oferta");
    const due = horarioPermitido(Math.max(silenceDue, +now));
    if (due >= Date.parse(f.inbound.at) + 24 * 3_600_000) return block("L1_sem_janela");
    return {
      ...base,
      anchorMessageId: f.final.id,
      anchorAt: new Date(delivery).toISOString(),
      nextTouch: 1,
      dueAt: new Date(due).toISOString(),
      body: p.texto,
      originalEnrollmentId: null,
    };
  }
  const o = f.offer;
  if (
    !o?.trusted ||
    !f.productKey ||
    p.texto !== undefined ||
    o.organizationId !== f.organizationId ||
    o.contactId !== f.contactId ||
    o.conversationId !== f.conversationId ||
    o.leadId !== f.leadId ||
    o.productKey !== f.productKey ||
    !Number.isFinite(Date.parse(o.deliveredAt)) ||
    Date.parse(o.deliveredAt) > Date.parse(f.inbound.at)
  )
    return block("oferta_original_sem_prova");
  const touches = [...o.touches].sort((a, b) => a.index - b.index);
  const ids = touches.flatMap((t) => t.messageIds);
  if (
    touches.length >= 4 ||
    touches.some((t, i) => t.index !== i + 1 || estadoDoToque(t) !== "delivered") ||
    new Set(ids).size !== ids.length
  )
    return block("orcamento_ou_recibos_invalidos");
  const nextTouch = touches.length + 1;
  const originalDue = Date.parse(o.deliveredAt) + [2, 24, 72, 168][nextTouch - 1]! * 3_600_000;
  return {
    ...base,
    anchorMessageId: o.originMessageId,
    anchorAt: new Date(o.deliveredAt).toISOString(),
    nextTouch,
    dueAt: new Date(horarioPermitido(Math.max(originalDue, silenceDue, +now))).toISOString(),
    body: null,
    originalEnrollmentId: o.enrollmentId,
  };
}

/** Só vetos conservadores; não autoriza pendência por palavra-chave. */
function encerramentoIsolado(body: string): boolean {
  const text = body
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
  return (
    /^(?:muito\s+)?(?:obrigad[oa]|valeu|agradeco)(?:\s+(?:pela|pelo)\s+(?:ajuda|atencao|resposta))?[.!\s👍🙏😊]*$/u.test(
      text,
    ) || /^(?:vou ver|vou pensar|depois vejo|amanha eu volto)[.!\s]*$/u.test(text)
  );
}

function horarioPermitido(at: number): number {
  const local = new Date(at - 3 * 3_600_000);
  if (local.getUTCHours() >= 8 && local.getUTCHours() < 21) return at;
  if (local.getUTCHours() >= 21) local.setUTCDate(local.getUTCDate() + 1);
  local.setUTCHours(8, 0, 0, 0);
  return +local + 3 * 3_600_000;
}
