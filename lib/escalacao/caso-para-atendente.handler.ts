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
 *
 * O negócio do caso: `openCase` (do autor) nunca preenche `agent_cases.lead_id`
 * (na produção, todos os casos têm `lead_id` nulo); o caso ancora na conversa.
 * Sem `lead_id`, vale o negócio aberto do contato da conversa (`negocioDoCaso`).
 * A carga de cada atendente segue o mesmo caminho.
 *
 * A dona que já existia só recebe o push daqui se for da equipe agora, e se não
 * houver prova de que o aviso já foi enfileirado (`avisoJaEnfileirado`): o
 * worker que atribuiu e caiu antes de marcar o evento consumido volta aqui e
 * acha a dona, mas o push dela já saiu pelo `lead.assigned` da troca. Sem
 * prova, manda: aviso repetido é melhor que nenhum.
 */
import { env } from "@/lib/env";
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import type { LeadStatus } from "@/lib/types/leads";
import { membrosAtivos, pushDoCasoAtribuido, type AdminDoPush } from "@/lib/notifications/destino-do-push";
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

type Admin = ReturnType<typeof createAdminClient>;
type Caso = { status?: string; lead_id?: string | null; conversation_id?: string | null; opened_at?: string | null };
type Negocio = { id: string; owner_user_id: string | null; assigned_at: string | null };
type Falha = { erro: string };
const falhou = (v: unknown): v is Falha => typeof v === "object" && v !== null && "erro" in v;

/** Negócio aberto de um contato, com o que a regra de escolha e a distribuição leem. */
type NegocioAberto = Negocio & {
  organization_id: string;
  contact_id: string;
  pipeline_id: string;
  status: LeadStatus;
  last_activity_at: string | null;
  created_at: string;
};
const COLUNAS_DO_NEGOCIO =
  "id, organization_id, contact_id, pipeline_id, status, last_activity_at, created_at, owner_user_id, assigned_at";

/**
 * Qual dos negócios abertos do contato é o do caso: a mesma regra com que o
 * motor move o card (`resolveActiveLeadForContact`): o único aberto; senão o do
 * funil padrão; senão o de atividade mais recente (`last_activity_at`, que só
 * anda com interação; `updated_at` anda com qualquer escrita, inclusive de
 * sistema, e `created_at` daria o negócio mais novo, não o que está em
 * conversa); empate = nenhum. Assim o caso fica no mesmo card que a IA mexe.
 */
function negocioDoContato(abertos: readonly NegocioAberto[], funilPadrao: string | null): NegocioAberto | null {
  if (abertos.length === 0) return null;
  const candidatos: LeadCandidate[] = abertos.map((l) => ({
    id: l.id,
    organization_id: l.organization_id,
    pipeline_id: l.pipeline_id,
    status: l.status,
    last_activity_at: l.last_activity_at,
    created_at: l.created_at,
  }));
  const alvo = resolveActiveLeadForContact(candidatos, { defaultPipelineId: funilPadrao });
  return alvo.routed ? (abertos.find((l) => l.id === alvo.leadId) ?? null) : null;
}

async function funilPadraoDa(admin: Admin, org: string): Promise<string | null | Falha> {
  const { data, error } = await admin
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", org)
    .eq("is_default", true)
    .eq("is_archived", false)
    .limit(1)
    .maybeSingle();
  if (error) return { erro: `leitura do funil padrão falhou: ${error.message}` };
  return (data as { id?: string } | null)?.id ?? null;
}

/**
 * O negócio do caso: o `lead_id`, se vier; senão, o negócio aberto do contato da
 * conversa (`negocioDoContato`). `null` = sem negócio (ou ambíguo); `{ erro }` =
 * leitura que falhou.
 */
async function negocioDoCaso(admin: Admin, org: string, caso: Caso): Promise<Negocio | null | Falha> {
  if (caso.lead_id) {
    const { data, error } = await admin
      .from("crm_leads")
      .select("id, owner_user_id, assigned_at")
      .eq("organization_id", org)
      .eq("id", caso.lead_id)
      .maybeSingle();
    if (error) return { erro: `leitura do negócio falhou: ${error.message}` };
    return (data as Negocio | null) ?? null;
  }
  if (!caso.conversation_id) return null;
  const { data: conversa, error: erroDaConversa } = await admin
    .from("conversations")
    .select("contact_id")
    .eq("organization_id", org)
    .eq("id", caso.conversation_id)
    .maybeSingle();
  if (erroDaConversa) return { erro: `leitura da conversa falhou: ${erroDaConversa.message}` };
  const contato = (conversa as { contact_id?: string | null } | null)?.contact_id ?? null;
  if (!contato) return null;
  const { data: abertos, error: erroDosNegocios } = await admin
    .from("crm_leads")
    .select(COLUNAS_DO_NEGOCIO)
    .eq("organization_id", org)
    .eq("contact_id", contato)
    .eq("status", "open");
  if (erroDosNegocios) return { erro: `leitura dos negócios falhou: ${erroDosNegocios.message}` };
  const linhas = (abertos ?? []) as NegocioAberto[];
  let funilPadrao: string | null = null;
  if (linhas.length > 1) {
    const f = await funilPadraoDa(admin, org);
    if (falhou(f)) return f;
    funilPadrao = f;
  }
  const n = negocioDoContato(linhas, funilPadrao);
  return n ? { id: n.id, owner_user_id: n.owner_user_id ?? null, assigned_at: n.assigned_at ?? null } : null;
}

/**
 * Casos esperando gente por atendente. O caso chega ao negócio pelo `lead_id`
 * ou, como na produção, pela conversa: conta só para a dona do negócio que
 * `negocioDoContato` escolhe (o mesmo que a distribuição usaria), e não para
 * todas as donas de negócios abertos do contato. O caso que está sendo
 * distribuído não conta.
 */
async function cargas(
  admin: Admin,
  org: string,
  caseId: string,
  elegiveis: readonly string[],
): Promise<Map<string, number> | Falha> {
  const { data, error } = await admin
    .from("agent_cases")
    .select("id, lead_id, conversation_id")
    .eq("organization_id", org)
    .eq("status", "awaiting_human");
  if (error) return { erro: `leitura dos casos falhou: ${error.message}` };
  const casos = ((data ?? []) as { id: string; lead_id: string | null; conversation_id: string | null }[]).filter(
    (c) => c.id !== caseId,
  );
  const leadIds = [...new Set(casos.flatMap((c) => (c.lead_id ? [c.lead_id] : [])))];
  const convIds = [...new Set(casos.flatMap((c) => (!c.lead_id && c.conversation_id ? [c.conversation_id] : [])))];

  const donoDoNegocio = new Map<string, string>();
  if (leadIds.length > 0) {
    const { data: donos, error: erroDosDonos } = await admin
      .from("crm_leads")
      .select("id, owner_user_id")
      .eq("organization_id", org)
      .in("id", leadIds)
      .in("owner_user_id", [...elegiveis]);
    if (erroDosDonos) return { erro: `leitura das cargas falhou: ${erroDosDonos.message}` };
    for (const d of (donos ?? []) as { id: string; owner_user_id: string }[]) donoDoNegocio.set(d.id, d.owner_user_id);
  }
  const contatoDaConversa = new Map<string, string>();
  const donaDoContato = new Map<string, string>();
  if (convIds.length > 0) {
    const { data: conversas, error: erroDasConversas } = await admin
      .from("conversations")
      .select("id, contact_id")
      .eq("organization_id", org)
      .in("id", convIds);
    if (erroDasConversas) return { erro: `leitura das conversas falhou: ${erroDasConversas.message}` };
    for (const c of (conversas ?? []) as { id: string; contact_id: string | null }[]) {
      if (c.contact_id) contatoDaConversa.set(c.id, c.contact_id);
    }
    const contatos = [...new Set(contatoDaConversa.values())];
    if (contatos.length > 0) {
      const { data: negocios, error: erroDosNegocios } = await admin
        .from("crm_leads")
        .select(COLUNAS_DO_NEGOCIO)
        .eq("organization_id", org)
        .in("contact_id", contatos)
        .eq("status", "open");
      if (erroDosNegocios) return { erro: `leitura das cargas falhou: ${erroDosNegocios.message}` };
      const porContato = new Map<string, NegocioAberto[]>();
      for (const n of (negocios ?? []) as NegocioAberto[]) {
        porContato.set(n.contact_id, [...(porContato.get(n.contact_id) ?? []), n]);
      }
      let funilPadrao: string | null = null;
      if ([...porContato.values()].some((ls) => ls.length > 1)) {
        const f = await funilPadraoDa(admin, org);
        if (falhou(f)) return f;
        funilPadrao = f;
      }
      for (const [contato, abertos] of porContato) {
        const dona = negocioDoContato(abertos, funilPadrao)?.owner_user_id ?? null;
        if (dona && elegiveis.includes(dona)) donaDoContato.set(contato, dona);
      }
    }
  }

  const abertos = new Map<string, number>();
  for (const c of casos) {
    const dona = c.lead_id
      ? donoDoNegocio.get(c.lead_id)
      : donaDoContato.get(contatoDaConversa.get(c.conversation_id ?? "") ?? "");
    if (dona) abertos.set(dona, (abertos.get(dona) ?? 0) + 1);
  }
  return abertos;
}

/**
 * Prova de que o "Caso para você" desta dona já foi enfileirado: um
 * `lead.assigned` do negócio, de ninguém para ela, emitido depois da abertura do
 * caso. A troca que este consumidor faz (só pega negócio sem dono) gera
 * exatamente esse evento, na mesma transação (`fn_emit_event_on_lead_change`), e
 * o push desse evento sai como "Caso para você" porque o caso espera gente.
 * Não serve a hora da atribuição (`assigned_at`): a API a renova quando um PATCH
 * reenvia o mesmo dono, sem `lead.assigned` nenhum, e o único aviso seria calado.
 */
async function avisoJaEnfileirado(
  admin: Admin,
  org: string,
  leadId: string,
  dona: string,
  abertoEm: string | null | undefined,
): Promise<boolean | Falha> {
  if (!abertoEm) return false;
  const { data, error } = await admin
    .from("event_log")
    .select("id")
    .eq("organization_id", org)
    .eq("event_type", "lead.assigned")
    .eq("entity_kind", "lead")
    .eq("entity_id", leadId)
    .eq("payload->>to_user_id", dona)
    .is("payload->>from_user_id", null)
    .gte("created_at", abertoEm)
    .limit(1);
  if (error) return { erro: `leitura dos eventos do negócio falhou: ${error.message}` };
  return ((data ?? []) as unknown[]).length > 0;
}

async function abrir(row: EventRow, caseId: string): Promise<HandlerResult> {
  const admin = createAdminClient();
  const org = row.organization_id;

  const { data: caso, error } = await admin
    .from("agent_cases")
    .select("status, lead_id, conversation_id, opened_at")
    .eq("organization_id", org)
    .eq("id", caseId)
    .maybeSingle();
  if (error) return tentarDeNovo(`leitura do caso falhou: ${error.message}`);
  const c = caso as Caso | null;
  if (c?.status !== "awaiting_human") return resultado("skipped", "caso_nao_espera_pessoa");

  const negocio = await negocioDoCaso(admin, org, c);
  if (falhou(negocio)) return tentarDeNovo(negocio.erro);
  if (!negocio) return resultado("skipped", "caso_sem_negocio");
  const dona = negocio.owner_user_id;

  // Já tem uma pessoa: não há troca de dono (nem `lead.assigned`), então o push sai daqui.
  if (dona) {
    const jaAvisada = await avisoJaEnfileirado(admin, org, negocio.id, dona, c.opened_at);
    if (falhou(jaAvisada)) return tentarDeNovo(jaAvisada.erro);
    if (jaAvisada) return resultado("skipped", "atribuido_por_este_caso");
    const ativas = await membrosAtivos(admin as unknown as AdminDoPush, org, [dona]);
    if (ativas === null) return tentarDeNovo("leitura da equipe falhou");
    if (!ativas.has(dona)) return resultado("skipped", "ja_tinha_responsavel:fora_da_equipe");
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

  const abertos = await cargas(admin, org, caseId, elegiveis);
  if (falhou(abertos)) return tentarDeNovo(abertos.erro);
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
    .eq("id", negocio.id)
    .is("owner_user_id", null)
    .select("id");
  if (erroDaTroca) return tentarDeNovo(`atribuição falhou: ${erroDaTroca.message}`);
  if ((trocados ?? []).length === 0) return resultado("skipped", "negocio_ja_atribuido");
  return resultado("ok", "atribuido");
}

export const casoParaAtendenteHandler: EventHandler = {
  key: CASO_PARA_ATENDENTE_KEY,
  // (Junção da 1.86.0) Pula na organização parada: pode mandar push ao celular
  // da atendente (sai para fora), como o `webPushInboundHandler`.
  naOrgParada: "pula",
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
