/**
 * (C01, -c01.16) O CASO ABERTO GANHA UMA RESPONSÁVEL — e ela é avisada no celular.
 *
 * O caso aparece na Central para a equipe toda (`caso-na-central.handler.ts`),
 * sem dono e sem tocar em celular nenhum: com duas atendentes, cada uma achava
 * que a outra estava olhando. Este consumidor de `ai.case_opened` distribui:
 *
 *   - negócio do caso já com uma pessoa responsável: fica com ela, e ela recebe
 *     o push "Caso para você" (`destino-do-push.ts`);
 *   - negócio sem pessoa responsável: vai para a atendente (papel `agent`,
 *     convite aceito, não revogada) com MENOS casos esperando gente; empate, a
 *     que recebeu negócio há mais tempo; empate de novo, a ordem do id. A troca
 *     de dono dispara `lead.assigned`, e o push de negócio atribuído já diz que
 *     é um caso;
 *   - nenhuma atendente: nada muda (a Central continua sendo o aviso).
 *
 * Só para caso que espera gente (`awaiting_human`). A atribuição só pega negócio
 * ainda sem pessoa (`owner_user_id is null`): duas aberturas ao mesmo tempo não
 * tiram o negócio de quem o recebeu primeiro. A IA continua atendendo: o motor
 * não lê o dono do negócio. Desliga com `CASOS_PARA_ATENDENTES=desligado`.
 */
import { env } from "@/lib/env";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { pushDoCasoAtribuido } from "@/lib/notifications/destino-do-push";
import { vapidPronto } from "@/lib/notifications/vapid";
import { enviarPushAoUsuario } from "@/lib/notifications/web_push";
import { createAdminClient } from "@/lib/supabase/admin";

export const CASO_PARA_ATENDENTE_KEY = "c01.caso-para-atendente";
const ESPERA_MS = 60 * 1000;

const resultado = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CASO_PARA_ATENDENTE_KEY,
  status,
  detail,
});
const tentarDeNovo = (detail: string): HandlerResult => ({
  consumer_key: CASO_PARA_ATENDENTE_KEY,
  status: "retry",
  retry_at: new Date(Date.now() + ESPERA_MS).toISOString(),
  detail,
});

export function distribuicaoLigada(valor: string | undefined = env.CASOS_PARA_ATENDENTES): boolean {
  return (valor ?? "").trim().toLowerCase() !== "desligado";
}

/**
 * A atendente da vez. `abertos`: casos esperando gente por pessoa; `ultima`:
 * quando cada uma recebeu negócio pela última vez (ISO; ausente = nunca).
 */
export function escolherAtendente(
  elegiveis: readonly string[],
  abertos: ReadonlyMap<string, number>,
  ultima: ReadonlyMap<string, string>,
): string | null {
  if (elegiveis.length === 0) return null;
  return [...elegiveis].sort((a, b) => {
    const ca = abertos.get(a) ?? 0;
    const cb = abertos.get(b) ?? 0;
    if (ca !== cb) return ca - cb;
    const ua = ultima.get(a) ?? "";
    const ub = ultima.get(b) ?? "";
    if (ua !== ub) return ua < ub ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0] ?? null;
}

async function abrir(row: EventRow, caseId: string): Promise<HandlerResult> {
  const admin = createAdminClient();
  const org = row.organization_id;

  const { data: caso, error } = await admin
    .from("agent_cases")
    .select("status, lead_id")
    .eq("organization_id", org)
    .eq("id", caseId)
    .maybeSingle();
  if (error) return tentarDeNovo(`leitura do caso falhou: ${error.message}`);
  const c = caso as { status?: string; lead_id?: string | null } | null;
  if (c?.status !== "awaiting_human") return resultado("skipped", "caso_nao_espera_pessoa");
  if (!c.lead_id) return resultado("skipped", "caso_sem_negocio");

  const { data: lead, error: erroDoLead } = await admin
    .from("crm_leads")
    .select("owner_user_id")
    .eq("organization_id", org)
    .eq("id", c.lead_id)
    .maybeSingle();
  if (erroDoLead) return tentarDeNovo(`leitura do negócio falhou: ${erroDoLead.message}`);
  if (!lead) return resultado("skipped", "negocio_ausente");
  const dona = (lead as { owner_user_id?: string | null }).owner_user_id ?? null;

  // Já tem uma pessoa: não há troca de dono (nem `lead.assigned`), então o push sai daqui.
  if (dona) {
    if (!vapidPronto()) return resultado("skipped", "ja_tinha_responsavel:vapid_ausente");
    const { sent } = await enviarPushAoUsuario(org, dona, pushDoCasoAtribuido(caseId));
    return resultado("ok", `ja_tinha_responsavel:sent:${sent}`);
  }

  const { data: membros, error: erroDosMembros } = await admin
    .from("user_organizations")
    .select("user_id")
    .eq("organization_id", org)
    .eq("role", "agent")
    .not("accepted_at", "is", null)
    .is("revoked_at", null);
  if (erroDosMembros) return tentarDeNovo(`leitura da equipe falhou: ${erroDosMembros.message}`);
  const elegiveis = ((membros ?? []) as { user_id: string }[]).map((m) => m.user_id);
  if (elegiveis.length === 0) return resultado("skipped", "sem_atendente");

  // Carga de cada uma: casos esperando gente cujos negócios ela já tem.
  const { data: abertosRows, error: erroDosAbertos } = await admin
    .from("agent_cases")
    .select("lead_id")
    .eq("organization_id", org)
    .eq("status", "awaiting_human")
    .not("lead_id", "is", null);
  if (erroDosAbertos) return tentarDeNovo(`leitura dos casos falhou: ${erroDosAbertos.message}`);
  const leadsAbertos = [...new Set(((abertosRows ?? []) as { lead_id: string }[]).map((r) => r.lead_id))];
  const abertos = new Map<string, number>();
  if (leadsAbertos.length > 0) {
    const { data: donos, error: erroDosDonos } = await admin
      .from("crm_leads")
      .select("owner_user_id")
      .eq("organization_id", org)
      .in("id", leadsAbertos)
      .in("owner_user_id", elegiveis);
    if (erroDosDonos) return tentarDeNovo(`leitura das cargas falhou: ${erroDosDonos.message}`);
    for (const d of (donos ?? []) as { owner_user_id: string }[]) {
      abertos.set(d.owner_user_id, (abertos.get(d.owner_user_id) ?? 0) + 1);
    }
  }
  const ultima = new Map<string, string>();
  const { data: recentes, error: erroDosRecentes } = await admin
    .from("crm_leads")
    .select("owner_user_id, assigned_at")
    .eq("organization_id", org)
    .in("owner_user_id", elegiveis)
    .not("assigned_at", "is", null)
    .order("assigned_at", { ascending: false })
    .limit(200);
  if (erroDosRecentes) return tentarDeNovo(`leitura das atribuições falhou: ${erroDosRecentes.message}`);
  for (const r of (recentes ?? []) as { owner_user_id: string; assigned_at: string }[]) {
    if (!ultima.has(r.owner_user_id)) ultima.set(r.owner_user_id, r.assigned_at);
  }

  const escolhida = escolherAtendente(elegiveis, abertos, ultima);
  if (!escolhida) return resultado("skipped", "sem_atendente");

  const { data: trocados, error: erroDaTroca } = await admin
    .from("crm_leads")
    .update({
      owner_user_id: escolhida,
      owner_agent_id: null,
      owner_kind: "user",
      assigned_at: new Date().toISOString(),
    })
    .eq("organization_id", org)
    .eq("id", c.lead_id)
    .is("owner_user_id", null)
    .select("id");
  if (erroDaTroca) return tentarDeNovo(`atribuição falhou: ${erroDaTroca.message}`);
  if ((trocados ?? []).length === 0) return resultado("skipped", "negocio_ja_atribuido");
  return resultado("ok", "atribuido");
}

export const casoParaAtendenteHandler: EventHandler = {
  key: CASO_PARA_ATENDENTE_KEY,
  events: ["ai.case_opened"],
  async handle(row): Promise<HandlerResult> {
    if (!distribuicaoLigada()) return resultado("skipped", "desligado");
    const caseId =
      (typeof row.payload.case_id === "string" ? row.payload.case_id : null) ??
      (typeof row.entity_id === "string" ? row.entity_id : null);
    if (!caseId) return resultado("skipped", "sem_caso");
    return abrir(row, caseId);
  },
};
