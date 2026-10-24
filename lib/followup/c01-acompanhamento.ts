import { z } from "zod";
import {
  coletaFinanceiraViva,
  type ColetaFinanceira,
  type PrazoColetaFinanceira,
} from "@/lib/leads/coleta-financeira";

/** Extensão C01, opt-in no grafo JSON existente; ausência conserva o legado. */
export const c01AcompanhamentoSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["cronograma", "oferta", "video_curso", "conversa"]),
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
  anchor: {
    kind: "cronograma" | "oferta" | "video_curso" | "conversa";
    at: string;
    delivered: boolean;
  };
  /** Somente a prova assinada da continuação pode separar resposta de âncora. */
  continuation?: { replyBarrierAt: string; notBefore: string; ready: boolean };
  videoPolicyReady?: boolean;
  cronogramaCatalogReady?: boolean;
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
  financialCollection?: ColetaFinanceira;
  financialWait?: PrazoColetaFinanceira;
}
const H = 3_600_000;
const MIN = 60_000;
/** Hipótese da candidata, ainda desligada; não muda oferta nem retorno combinado. */
const HORARIO_CRONOGRAMA_CANDIDATO = {
  minimum_wait_minutes: 120,
  window_margin_minutes: 15,
};
const BLOQUEIOS_META = new Set(["131042", "131047", "131049", "132015"]);
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
  const tetoEm = inbound + 23 * H;
  const encerraEm = inbound + 24 * H - timing.window_margin_minutes * MIN;
  const at = ultimoMinutoPermitido(Math.min(tetoEm, encerraEm - 1));
  const minimoEm = Math.max(inbound, Date.parse(f.anchor.at)) + timing.minimum_wait_minutes * MIN;
  return { at, minimoEm, tetoEm, encerraEm };
}

function adiar(at: number, reason: string): DecisaoAcompanhamento {
  return { kind: "defer", reason, until: new Date(at).toISOString() };
}

/** Congelado na primeira espera. Nunca muda a âncora ou o orçamento do toque. */
export function limiteDaColetaC01(
  config: ConfigAcompanhamento,
  f: FatosAcompanhamento,
  collection: ColetaFinanceira,
  now: Date,
): string {
  const local = new Date(+now - 3 * H);
  local.setUTCHours(21, 0, 0, 0);
  let end = Math.min(Date.parse(collection.deadlineAt), +local + 3 * H);
  if (config.kind === "cronograma") {
    const h = horarioDoCronograma(config, f);
    end = Math.min(end, h.tetoEm, h.encerraEm);
  } else if (config.kind !== "oferta" || !f.template.approved || !f.template.accountReady)
    end = Math.min(end, Date.parse(f.lastInboundAt!) + 24 * H);
  if (config.kind === "oferta" && f.continuation) {
    const next = [2, 24, 72, 168][f.touches.length + 1];
    if (next !== undefined) end = Math.min(end, Date.parse(f.anchor.at) + next * H);
  }
  return new Date(end).toISOString();
}

/**
 * Mesmo contrato na seleção e imediatamente antes do envio. O leitor de fatos
 * financeiro relê as fontes no runtime. Falta de cobertura mantém bloqueado.
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
          Date.parse(f.lastInboundAt) > Date.parse(f.continuation?.replyBarrierAt ?? f.anchor.at)),
      "respondeu",
    ],
    [config.kind === "cronograma" && f.offerAfterAnchor, "oferta_substitui_retomada_do_cronograma"],
    [config.kind === "video_curso" && f.offerAfterAnchor, "oferta_substitui_toque_do_video"],
    [f.callbackPending, "retorno_combinado_tem_prioridade"],
    [f.anotherSequence, "outra_sequencia_viva"],
  ] as const)
    if (condition) return { kind: "cancel", reason };
  if (!config.activated_at) return bloqueio("ativacao_pendente");
  if (config.kind === "conversa" && !f.continuation?.ready)
    return bloqueio("continuacao_sem_prova");
  if (
    f.continuation &&
    (!f.continuation.ready ||
      !valido(f.continuation.replyBarrierAt) ||
      !valido(f.continuation.notBefore))
  )
    return bloqueio("continuacao_sem_prova");
  if (config.kind === "cronograma" && f.cronogramaCatalogReady === false)
    return bloqueio("catalogo_do_cronograma_indisponivel");
  if (config.kind === "video_curso" && !f.videoPolicyReady)
    return bloqueio("video_desligado_ou_politica_invalida");
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
  const p = f.purchase;
  if (
    p?.source === "aplicada" &&
    p.complete &&
    p.identity === "univoca" &&
    p.organizationId === f.organizationId &&
    p.contactId === f.contactId &&
    p.opportunityId === f.opportunityId &&
    p.result === "comprou" &&
    +now - Date.parse(p.checkedAt) >= 0 &&
    +now - Date.parse(p.checkedAt) <= 900_000
  )
    return { kind: "cancel", reason: "compra_confirmada" };
  if (f.financialWait && +now >= Date.parse(f.financialWait.deadlineAt))
    return bloqueio("prazo_da_coleta_financeira_esgotado");
  if (f.continuation && +now < Date.parse(f.continuation.notBefore))
    return adiar(
      janelaPermitida(Date.parse(f.continuation.notBefore)),
      "aguarda_silencio_da_continuacao",
    );
  if (config.kind === "video_curso" && f.touches.length === 0) {
    const due = Date.parse(f.anchor.at) + 15 * MIN;
    if (+now < due) return adiar(janelaPermitida(due), "ainda_nao_venceu");
  }

  if (config.kind === "cronograma" && f.touches.length === 0) {
    const horario = horarioDoCronograma(config, f);
    if (horario.at < horario.minimoEm) return bloqueio("sem_intervalo_util_para_retomada");
    if (+now < horario.at) return adiar(horario.at, "ainda_nao_venceu");
    // Um worker atrasado não transforma a retomada interna em campanha de modelo.
    // O teto de 23 h vale também na execução, com precisão de milissegundos.
    // Se a próxima hora permitida perdeu a margem, interromper sem novo disparo.
    if (
      +now > horario.tetoEm ||
      +now >= horario.encerraEm ||
      janelaPermitida(+now) >= horario.encerraEm
    )
      return bloqueio("janela_do_cronograma_perdida");
  }

  // Não adianta reler compras à noite e usar o resultado pela manhã: deferir
  // devolve ao consumidor a obrigação de carregar tudo de novo ao acordar.
  const permitido = janelaPermitida(+now);
  if (permitido !== +now) return adiar(permitido, "fora_do_horario");
  if (f.financialCollection) {
    const live = coletaFinanceiraViva(f.financialCollection, now),
      wait = f.financialWait;
    if (
      !live ||
      !wait ||
      !valido(wait.deadlineAt) ||
      !valido(wait.startedAt) ||
      Date.parse(wait.deadlineAt) > Date.parse(wait.startedAt) + 900_000
    )
      return bloqueio("coleta_financeira_sem_prazo_verificado");
    const end = Math.min(
      Date.parse(wait.deadlineAt),
      Date.parse(limiteDaColetaC01(config, f, live, now)),
    );
    if (+now >= end) return bloqueio("prazo_da_coleta_financeira_esgotado");
    return adiar(Math.min(+now + 60_000, end), "projecao_em_coleta");
  }
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
    if (config.kind === "conversa")
      return { kind: "complete", reason: "continuacao_unica_concluida" };
    if (config.kind === "video_curso")
      return { kind: "complete", reason: "toque_do_video_concluido" };
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
  if (config.kind === "conversa") {
    if (+now - Date.parse(f.lastInboundAt) >= 24 * H)
      return bloqueio("janela_da_continuacao_fechada");
    return { kind: "send", touch: 1, transport: "text" };
  }
  if (config.kind === "video_curso") {
    if (+now - Date.parse(f.lastInboundAt) >= 24 * H) return bloqueio("janela_do_video_fechada");
    return { kind: "send", touch: 1, transport: "text" };
  }
  const following = [2, 24, 72, 168][touches.length + 1];
  if (f.continuation && following !== undefined && +now >= Date.parse(f.anchor.at) + following * H)
    return bloqueio("orcamento_vencido_sem_intervalo");
  const due = Date.parse(f.anchor.at) + [2, 24, 72, 168][touches.length]! * H;
  if (+now < due) return adiar(janelaPermitida(due), "ainda_nao_venceu");
  const aberta = +now - Date.parse(f.lastInboundAt) < 24 * H;
  if (!aberta && (!f.template.approved || !f.template.accountReady))
    return bloqueio("modelo_ou_conta_indisponivel");
  return { kind: "send", touch: touches.length + 1, transport: aberta ? "text" : "template" };
}
