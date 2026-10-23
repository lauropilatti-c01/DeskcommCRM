import { z } from "zod";

/** Extensão C01, opt-in no grafo JSON existente; ausência conserva o legado. */
export const c01AcompanhamentoSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["cronograma", "oferta"]),
  activated_at: z.string().datetime().nullable(),
  /** Parâmetros candidatos, sem autorização de ativação implícita. */
  cronograma_timing: z
    .strictObject({
      minimum_wait_minutes: z
        .number()
        .int()
        .min(1)
        .max(23 * 60),
      window_margin_minutes: z
        .number()
        .int()
        .min(1)
        .max(23 * 60),
    })
    .refine(
      (t) => t.minimum_wait_minutes + t.window_margin_minutes < 24 * 60,
      "Espera mínima e margem precisam caber na janela de 24 horas",
    )
    .optional(),
});
export type ConfigAcompanhamento = z.infer<typeof c01AcompanhamentoSchema>;
export type DecisaoAcompanhamento =
  | { kind: "send"; touch: number; transport: "text" | "template" }
  | { kind: "defer"; reason: string; until: string }
  | { kind: "blocked" | "cancel" | "lost" | "complete"; reason: string };

export interface Recibo {
  id: string;
  status: string;
  delivered_at: string | null;
  read_at: string | null;
  error_code: string | null;
}
/** Um toque pode ter mais de uma bolha; todas precisam de prova de entrega. */
export interface Toque {
  index: number;
  messageIds: string[];
  receipts: Recibo[];
}
export interface FatosAcompanhamento {
  organizationId: string;
  contactId: string;
  opportunityId: string;
  /** Origem autenticada + entrega reconciliada, nunca um custom_field da IA. */
  anchor: { kind: "cronograma" | "oferta"; at: string; delivered: boolean };
  lastInboundAt: string | null;
  hasNewReply: boolean;
  offerAfterAnchor: boolean;
  human: boolean;
  optedOut: boolean;
  restricted: boolean;
  callbackPending: boolean;
  anotherSequence: boolean;
  purchase: null | {
    source: "aplicada" | "observacao";
    organizationId: string;
    contactId: string;
    opportunityId: string;
    checkedAt: string;
    complete: boolean;
    identity: "univoca" | "ambigua" | "ausente";
    result: "comprou" | "nao_comprou";
  };
  template: { approved: boolean; accountReady: boolean };
  touches: Toque[];
}
const H = 3_600_000;
const MIN = 60_000;
/** Hipótese da candidata, ainda desligada; não muda oferta nem retorno combinado. */
const HORARIO_CRONOGRAMA_CANDIDATO = {
  minimum_wait_minutes: 120,
  window_margin_minutes: 15,
};
const BLOQUEIOS_META = new Set(["131047", "131049", "132015"]);
const valido = (value: string | null): value is string =>
  value !== null && Number.isFinite(Date.parse(value));

/** Falha/recusa prevalece sobre status sent tardio. Nunca promove accepted a delivered. */
export function estadoDoToque(t: Toque): "delivered" | "blocked" | "failed" | "unknown" {
  if (!t.messageIds.length || new Set(t.messageIds).size !== t.messageIds.length) return "unknown";
  if (t.receipts.some((r) => r.error_code !== null && BLOQUEIOS_META.has(r.error_code)))
    return "blocked";
  if (t.receipts.some((r) => r.status === "failed" || r.error_code !== null)) return "failed";
  if (
    t.receipts.length !== t.messageIds.length ||
    new Set(t.receipts.map((r) => r.id)).size !== t.receipts.length
  )
    return "unknown";
  return t.messageIds.every((id) =>
    t.receipts.some((r) => r.id === id && (valido(r.delivered_at) || valido(r.read_at))),
  )
    ? "delivered"
    : "unknown";
}

/** Faixa aprovada da C01 em Brasília (UTC−3), não usa o fuso da máquina. */
function janelaPermitida(at: number): number {
  const local = new Date(at - 3 * H);
  const hour = local.getUTCHours();
  if (hour >= 8 && hour < 21) return at;
  if (hour >= 21) local.setUTCDate(local.getUTCDate() + 1);
  local.setUTCHours(8, 0, 0, 0);
  return +local + 3 * H;
}

/** Último minuto entre 08h inclusive e 21h exclusive, sem ultrapassar o teto. */
function ultimoMinutoPermitido(at: number): number {
  const local = new Date(Math.floor(at / MIN) * MIN - 3 * H);
  const hour = local.getUTCHours();
  if (hour < 8) local.setUTCDate(local.getUTCDate() - 1);
  if (hour < 8 || hour >= 21) local.setUTCHours(20, 59, 0, 0);
  return +local + 3 * H;
}

function horarioDoCronograma(config: ConfigAcompanhamento, f: FatosAcompanhamento) {
  const timing = config.cronograma_timing ?? HORARIO_CRONOGRAMA_CANDIDATO;
  const inbound = Date.parse(f.lastInboundAt!);
  const encerraEm = inbound + 24 * H - timing.window_margin_minutes * MIN;
  const at = ultimoMinutoPermitido(Math.min(inbound + 23 * H, encerraEm - 1));
  const minimoEm = Math.max(inbound, Date.parse(f.anchor.at)) + timing.minimum_wait_minutes * MIN;
  return { at, minimoEm, encerraEm };
}

function adiar(at: number, reason: string): DecisaoAcompanhamento {
  return { kind: "defer", reason, until: new Date(at).toISOString() };
}

/**
 * Mesmo contrato na seleção e imediatamente antes do envio. O leitor de fatos
 * financeiro ainda é indisponível no runtime: ver c01-acompanhamento-runtime.
 * Testes injetam fatos autenticados fictícios, nunca liberam produção.
 */
export function avaliarAcompanhamento(
  config: ConfigAcompanhamento,
  f: FatosAcompanhamento,
  now: Date,
): DecisaoAcompanhamento {
  const bloqueio = (reason: string): DecisaoAcompanhamento => ({ kind: "blocked", reason });
  for (const [condition, reason] of [
    [f.optedOut, "recusa"],
    [f.restricted, "restricao"],
    [f.human, "atendimento_humano"],
    [
      f.hasNewReply ||
        (valido(f.lastInboundAt) &&
          valido(f.anchor.at) &&
          Date.parse(f.lastInboundAt) > Date.parse(f.anchor.at)),
      "respondeu",
    ],
    [config.kind === "cronograma" && f.offerAfterAnchor, "oferta_substitui_retomada_do_cronograma"],
    [f.callbackPending, "retorno_combinado_tem_prioridade"],
    [f.anotherSequence, "outra_sequencia_viva"],
  ] as const)
    if (condition) return { kind: "cancel", reason };
  if (!config.activated_at) return bloqueio("ativacao_pendente");
  if (
    !valido(config.activated_at) ||
    !valido(f.anchor.at) ||
    f.anchor.kind !== config.kind ||
    !f.anchor.delivered ||
    Date.parse(f.anchor.at) < Date.parse(config.activated_at)
  )
    return bloqueio("origem_sem_prova_apos_ativacao");
  if (!f.organizationId || !f.contactId || !f.opportunityId)
    return bloqueio("identidade_incompleta");
  if (
    Date.parse(f.anchor.at) > +now ||
    (valido(f.lastInboundAt) && Date.parse(f.lastInboundAt) > +now)
  )
    return bloqueio("relogio_incoerente");
  if (!valido(f.lastInboundAt)) return bloqueio("ultima_mensagem_desconhecida");

  if (config.kind === "cronograma" && f.touches.length === 0) {
    const horario = horarioDoCronograma(config, f);
    if (horario.at < horario.minimoEm) return bloqueio("sem_intervalo_util_para_retomada");
    if (+now < horario.at) return adiar(horario.at, "ainda_nao_venceu");
    // Um worker atrasado não transforma a retomada interna em campanha de modelo.
    // Se a próxima hora permitida perdeu a margem, interromper sem novo disparo.
    if (+now >= horario.encerraEm || janelaPermitida(+now) >= horario.encerraEm)
      return bloqueio("janela_do_cronograma_perdida");
  }

  // Não adianta reler compras à noite e usar o resultado pela manhã: deferir
  // devolve ao consumidor a obrigação de carregar tudo de novo ao acordar.
  const permitido = janelaPermitida(+now);
  if (permitido !== +now) return adiar(permitido, "fora_do_horario");
  const p = f.purchase;
  if (
    !p ||
    p.source !== "aplicada" ||
    !p.complete ||
    p.identity !== "univoca" ||
    p.organizationId !== f.organizationId ||
    p.contactId !== f.contactId ||
    p.opportunityId !== f.opportunityId
  )
    return bloqueio("compras_sem_conferencia_univoca");
  const idade = +now - Date.parse(p.checkedAt);
  if (!Number.isFinite(idade) || idade < 0 || idade > 15 * 60_000)
    return bloqueio("compras_desatualizadas");
  if (p.result === "comprou") return { kind: "cancel", reason: "compra_confirmada" };

  const touches = [...f.touches].sort((a, b) => a.index - b.index);
  if (touches.some((t, i) => t.index !== i + 1)) return bloqueio("toques_incoerentes");
  const messageIds = touches.flatMap((t) => t.messageIds);
  if (new Set(messageIds).size !== messageIds.length) return bloqueio("toques_incoerentes");
  for (const t of touches) {
    const estado = estadoDoToque(t);
    if (estado !== "delivered")
      return bloqueio(
        estado === "blocked"
          ? "entrega_bloqueada"
          : estado === "failed"
            ? "entrega_falhou"
            : "entrega_sem_confirmacao",
      );
  }
  const max = config.kind === "oferta" ? 4 : 1;
  if (touches.length > max) return bloqueio("toques_incoerentes");
  if (touches.length === max) {
    if (config.kind === "cronograma")
      return { kind: "complete", reason: "retomada_unica_concluida" };
    const ultimo = Math.max(
      ...touches.flatMap((t) =>
        t.receipts.map((r) =>
          Math.max(
            valido(r.delivered_at) ? Date.parse(r.delivered_at) : 0,
            valido(r.read_at) ? Date.parse(r.read_at) : 0,
          ),
        ),
      ),
    );
    if (+now < ultimo + 48 * H) return adiar(ultimo + 48 * H, "aguarda_48h_apos_entregas");
    return { kind: "lost", reason: "sem_resposta_apos_quatro_entregas" };
  }
  if (config.kind === "cronograma") return { kind: "send", touch: 1, transport: "text" };
  const due = Date.parse(f.anchor.at) + [2, 24, 72, 168][touches.length]! * H;
  if (+now < due) return adiar(janelaPermitida(due), "ainda_nao_venceu");
  const aberta = +now - Date.parse(f.lastInboundAt) < 24 * H;
  if (!aberta && (!f.template.approved || !f.template.accountReady))
    return bloqueio("modelo_ou_conta_indisponivel");
  return { kind: "send", touch: touches.length + 1, transport: aberta ? "text" : "template" };
}
