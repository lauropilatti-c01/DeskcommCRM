import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { hashDoCorpo } from "@/lib/api/idempotency";
import { configOrigemC01 } from "./c01-origem";
import type { LeitorFinanceiroC01 } from "./c01-acompanhamento-fatos";

export const JANELA_RETORNO_C01 = {
  timezone: "America/Sao_Paulo",
  start: "08:00",
  end: "21:00",
  weekdays: [0, 1, 2, 3, 4, 5, 6],
};

export interface ConsentimentoRetornoC01 {
  consent_message_id?: string;
  consent_excerpt?: string;
  offered_message_id?: string;
}
/** Subconjunto explícito, conservador: o que não é demonstrável volta como pendência.
 * Não tenta deduzir consentimento por sentimento ou silêncio. */
export function horarioConfirmadoC01(
  consent: string,
  consentAt: string,
  offered?: string,
  offeredAt?: string,
): string | null {
  const normal = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  const text = normal(consent);
  if (!text || /\b(nao|pare|parar|cancel|talvez|pensar|depois vejo)\b/.test(text)) return null;
  const day = "(hoje|amanha|[0-9]{1,2}/[0-9]{1,2}(?:/[0-9]{4})?)";
  const time = "as? +[0-9]{1,2}(?::[0-9]{2})? *h?";
  const direct = new RegExp(
    "^(?:pode me chamar|me cham[ae]|vamos falar|vamos conversar) +" + day + " +" + time + "[.! ]*$",
  );
  const proposal = new RegExp(
    "^(?:posso (?:te |lhe )?(?:chamar|retornar|falar|voltar|voltar a falar)) +" +
      day +
      " +" +
      time +
      "[? ]*$",
  );
  const yes = /^(sim|pode|pode sim|combinado|confirmado|ok|certo)[.! 👍✅]*$/.test(text);
  const normalizedOffer = offered ? normal(offered) : "";
  const isDirect = direct.test(text);
  const source = isDirect ? text : yes && proposal.test(normalizedOffer) ? normalizedOffer : null;
  const sourceAt = isDirect ? consentAt : offeredAt;
  if (!source || !sourceAt) return null;
  const hour = source.match(/\bas?\s+(\d{1,2})(?::(\d{2}))?\s*h?\b/);
  if (!hour || Number(hour[1]) > 23 || Number(hour[2] ?? 0) > 59) return null;
  const local = new Date(Date.parse(sourceAt) - 3 * 3600000);
  if (!Number.isFinite(+local)) return null;
  const explicit = source.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
  if (explicit) {
    const year = Number(explicit[3] ?? local.getUTCFullYear()),
      month = Number(explicit[2]) - 1,
      day = Number(explicit[1]);
    local.setUTCFullYear(year, month, day);
    if (
      local.getUTCFullYear() !== year ||
      local.getUTCMonth() !== month ||
      local.getUTCDate() !== day
    )
      return null;
  } else if (/\bamanha\b/.test(source)) local.setUTCDate(local.getUTCDate() + 1);
  else if (!/\bhoje\b/.test(source)) return null;
  local.setUTCHours(Number(hour[1]), Number(hour[2] ?? 0), 0, 0);
  return new Date(+local + 3 * 3600000).toISOString();
}
const proofSchema = z.strictObject({
  version: z.literal(1),
  organization_id: z.uuid(),
  contact_id: z.uuid(),
  conversation_id: z.uuid(),
  lead_id: z.uuid(),
  product_key: z.string().min(1),
  message_id: z.uuid(),
  offered_message_id: z.uuid().nullable(),
  consent_hash: z.string(),
  offered_hash: z.string().nullable(),
  consented_at: z.iso.datetime(),
  promised_at: z.iso.datetime(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ProvaRetornoC01 = z.infer<typeof proofSchema>;
const hash = (value: unknown) => hashDoCorpo(value);

export async function prepararRetornoComercialC01(
  db: Queryable,
  input: {
    organizationId: string;
    contactId: string;
    leadId?: string | null;
    sourceJobId?: string;
    promisedAt: string;
    consent: ConsentimentoRetornoC01;
  },
): Promise<{
  scope: "commercial";
  lead_id: string;
  product_key: string;
  c01_callback: ProvaRetornoC01;
}> {
  const cfg = configOrigemC01();
  if (!cfg?.enabled || cfg.organizationId !== input.organizationId)
    throw new Error("c01_callback_configuration_missing");
  const consent = { ...input.consent };
  if (input.sourceJobId) {
    const job = (
      await db.query(
        `select payload from job_queue where organization_id=$1 and contact_id=$2
      and id=$3 and kind='inbound_turn'`,
        [input.organizationId, input.contactId, input.sourceJobId],
      )
    ).rows[0];
    const source = job?.payload?.inbound_message_id;
    if (
      typeof source !== "string" ||
      (consent.consent_message_id && consent.consent_message_id !== source)
    )
      throw new Error("c01_callback_consent_outside_current_turn");
    consent.consent_message_id = source;
  }
  if (!consent.consent_message_id) throw new Error("c01_callback_consent_missing");
  const message = (
    await db.query(
      `select id,conversation_id,body,sent_at from messages
    where organization_id=$1 and contact_id=$2 and id=$3 and direction='inbound' and revoked_at is null`,
      [input.organizationId, input.contactId, consent.consent_message_id],
    )
  ).rows[0];
  if (
    !message?.body ||
    (consent.consent_excerpt && !message.body.includes(consent.consent_excerpt))
  )
    throw new Error("c01_callback_consent_not_found");
  if (!input.sourceJobId && !consent.consent_excerpt?.trim())
    throw new Error("c01_callback_consent_missing");
  if (input.sourceJobId && !consent.offered_message_id) {
    const prior = (
      await db.query(
        `select id,direction from messages where organization_id=$1 and contact_id=$2
      and conversation_id=$3 and sent_at<$4 and type<>'reaction' and revoked_at is null order by sent_at desc,id desc limit 1`,
        [input.organizationId, input.contactId, message.conversation_id, message.sent_at],
      )
    ).rows[0];
    if (prior?.direction === "outbound") consent.offered_message_id = prior.id;
  }
  let offer: { id: string; body: string; sent_at: string } | null = null;
  if (consent.offered_message_id) {
    const row = (
      await db.query(
        `select id,body,sent_at from messages where organization_id=$1 and contact_id=$2
      and conversation_id=$3 and id=$4 and direction='outbound' and external_id is not null
      and status in ('sent','delivered','read') and revoked_at is null and sent_at<$5`,
        [
          input.organizationId,
          input.contactId,
          message.conversation_id,
          consent.offered_message_id,
          message.sent_at,
        ],
      )
    ).rows[0];
    if (!row) throw new Error("c01_callback_offer_not_found");
    const between = (
      await db.query(
        `select id from messages where organization_id=$1 and contact_id=$2
      and conversation_id=$3 and sent_at>$4 and sent_at<$5 and type<>'reaction' limit 1`,
        [
          input.organizationId,
          input.contactId,
          message.conversation_id,
          row.sent_at,
          message.sent_at,
        ],
      )
    ).rows;
    if (between.length) throw new Error("c01_callback_offer_not_immediate");
    offer = { id: row.id, body: row.body, sent_at: new Date(row.sent_at).toISOString() };
  }
  const promised = horarioConfirmadoC01(
    message.body,
    new Date(message.sent_at).toISOString(),
    offer?.body,
    offer?.sent_at,
  );
  if (!promised || promised !== new Date(input.promisedAt).toISOString())
    throw new Error("c01_callback_time_not_confirmed");
  if (Date.parse(promised) - +new Date(message.sent_at) >= 24 * 3600000)
    throw new Error("c01_callback_template_required_before_promise");
  const promisedHour = new Date(Date.parse(promised) - 3 * 3600000).getUTCHours();
  if (promisedHour < 8 || promisedHour >= 21) throw new Error("c01_callback_outside_send_window");
  const leads = (
    await db.query(
      `select id,custom_fields from crm_leads where organization_id=$1 and contact_id=$2
    and status not in ('won','lost') and ($3::uuid is null or id=$3) order by created_at,id limit 2`,
      [input.organizationId, input.contactId, input.leadId ?? null],
    )
  ).rows;
  if (leads.length !== 1 || !leads[0]!.custom_fields?.produto_chave)
    throw new Error("c01_callback_opportunity_ambiguous");
  const state = (
    await db.query(
      `select cv.last_inbound_at,cv.assignee_kind,cv.status,cv.bot_silenced_until,
    c.is_blocked,c.ai_opt_out,c.force_human,c.is_anonymized,c.is_merged_into
    from conversations cv join contacts c on c.organization_id=cv.organization_id and c.id=cv.contact_id
    where cv.organization_id=$1 and cv.contact_id=$2 and cv.id=$3`,
      [input.organizationId, input.contactId, message.conversation_id],
    )
  ).rows[0];
  const checkedAt = new Date();
  if (
    !state ||
    !state.last_inbound_at ||
    +new Date(state.last_inbound_at) > +new Date(message.sent_at) ||
    state.is_blocked ||
    state.ai_opt_out ||
    state.force_human ||
    state.is_anonymized ||
    state.is_merged_into ||
    ["user", "human"].includes(state.assignee_kind) ||
    !["open", "pending", "ai_handling"].includes(state.status) ||
    state.bot_silenced_until === "infinity" ||
    (state.bot_silenced_until && +new Date(state.bot_silenced_until) > +checkedAt)
  )
    throw new Error("c01_callback_current_state_forbids_promise");
  const { lerSituacaoFinanceira } = await import("@/lib/leads/fonte-financeira");
  const financial = await lerSituacaoFinanceira({
    db,
    organizationId: input.organizationId,
    contactId: input.contactId,
    leadId: leads[0]!.id,
    productKey: leads[0]!.custom_fields.produto_chave,
    now: checkedAt,
    signal: AbortSignal.timeout(10_000),
  });
  if (financial.status !== "nao_comprou_confirmado" || !financial.complete)
    throw new Error("c01_callback_financial_capability_unavailable_before_promise");
  const body = {
    version: 1 as const,
    organization_id: input.organizationId,
    contact_id: input.contactId,
    conversation_id: message.conversation_id as string,
    lead_id: leads[0]!.id as string,
    product_key: leads[0]!.custom_fields.produto_chave as string,
    message_id: message.id as string,
    offered_message_id: offer?.id ?? null,
    consent_hash: hash(message.body),
    offered_hash: offer ? hash(offer.body) : null,
    consented_at: new Date(message.sent_at).toISOString(),
    promised_at: promised,
  };
  const proof = {
    ...body,
    signature: createHmac("sha256", cfg.signingKey).update(hash(body)).digest("hex"),
  };
  return {
    scope: "commercial",
    lead_id: body.lead_id,
    product_key: body.product_key,
    c01_callback: proof,
  };
}

export function conferirProvaRetornoC01(raw: unknown): ProvaRetornoC01 | null {
  const cfg = configOrigemC01(),
    parsed = proofSchema.safeParse(raw);
  if (!cfg || !parsed.success || cfg.organizationId !== parsed.data.organization_id) return null;
  const { signature, ...body } = parsed.data;
  const expected = createHmac("sha256", cfg.signingKey).update(hash(body)).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex")) ? parsed.data : null;
}

/** Releitura no corte final: a prova não autoriza mensagens depois de resposta,
 * passagem humana, edição de consentimento ou mudança da oportunidade. */
export async function conferirRetornoNoEnvioC01(
  db: Queryable,
  scope: {
    organizationId: string;
    contactId: string;
    jobId: string;
  },
  now: Date,
  signal: AbortSignal,
  financeiro: LeitorFinanceiroC01,
): Promise<void> {
  const fail = (reason: string): never => {
    throw new Error(`c01_callback_${reason}`);
  };
  const job = (
    await db.query(
      `/* c01:callback:job */ select payload from job_queue
    where organization_id=$1 and contact_id=$2 and id=$3 and kind='followup_turn'`,
      [scope.organizationId, scope.contactId, scope.jobId],
    )
  ).rows[0];
  const proof = conferirProvaRetornoC01(job?.payload?.c01_callback);
  if (!configOrigemC01()?.enabled || !proof || job?.payload?.scope !== "commercial")
    return fail("proof_missing");
  if (!job) return fail("job_missing");
  const p = proof!;
  if (
    p.organization_id !== scope.organizationId ||
    p.contact_id !== scope.contactId ||
    p.lead_id !== job.payload.lead_id ||
    p.product_key !== job.payload.product_key ||
    p.promised_at !== new Date(job.payload.promised_at).toISOString()
  )
    fail("scope_mismatch");
  if (+now < Date.parse(p.promised_at)) fail("not_due");
  const hour = new Date(+now - 3 * 3600000).getUTCHours();
  if (hour < 8 || hour >= 21) fail("outside_send_window");
  const row = (
    await db.query(
      `/* c01:callback:state */ select m.body,m.sent_at,cv.last_inbound_at,
    cv.status,cv.assignee_kind,cv.bot_silenced_until,c.is_blocked,c.ai_opt_out,c.force_human,
    c.is_anonymized,c.is_merged_into,l.custom_fields,l.status as lead_status
    from messages m join conversations cv on cv.organization_id=m.organization_id and cv.id=m.conversation_id
      and cv.contact_id=m.contact_id
    join contacts c on c.organization_id=m.organization_id and c.id=m.contact_id
    join crm_leads l on l.organization_id=m.organization_id and l.contact_id=m.contact_id and l.id=$4
    where m.organization_id=$1 and m.contact_id=$2 and m.id=$3 and m.direction='inbound'
      and m.revoked_at is null and cv.id=$5`,
      [scope.organizationId, scope.contactId, p.message_id, p.lead_id, p.conversation_id],
    )
  ).rows[0];
  if (
    !row ||
    hash(row.body) !== p.consent_hash ||
    new Date(row.sent_at).toISOString() !== p.consented_at ||
    row.custom_fields?.produto_chave !== p.product_key
  )
    return fail("consent_changed");
  if (
    row.is_blocked ||
    row.ai_opt_out ||
    row.is_anonymized ||
    row.is_merged_into ||
    ["won", "lost"].includes(row.lead_status)
  )
    fail("restricted");
  if (
    row.force_human ||
    ["human", "user"].includes(row.assignee_kind) ||
    !["open", "pending", "ai_handling"].includes(row.status) ||
    row.bot_silenced_until === "infinity" ||
    (row.bot_silenced_until && +new Date(row.bot_silenced_until) > +now)
  )
    fail("human");
  if (!row.last_inbound_at || +new Date(row.last_inbound_at) > Date.parse(p.consented_at))
    fail("new_reply");
  // Callback por IA ainda não escolhe modelo aprovado de forma determinística.
  // Fora da janela, fica bloqueado; não transforma texto comum em template.
  if (+now - +new Date(row.last_inbound_at) >= 24 * 3600000) fail("template_required");
  if (p.offered_message_id) {
    const offer = (
      await db.query(
        `/* c01:callback:offer */ select body from messages where organization_id=$1
      and contact_id=$2 and conversation_id=$3 and id=$4 and direction='outbound' and revoked_at is null`,
        [scope.organizationId, scope.contactId, p.conversation_id, p.offered_message_id],
      )
    ).rows[0];
    if (!offer || hash(offer.body) !== p.offered_hash) fail("offer_changed");
  }
  const paid = await financeiro({
    db,
    ...scope,
    leadId: p.lead_id,
    productKey: p.product_key,
    now,
    signal,
  });
  if (
    paid.status !== "nao_comprou_confirmado" ||
    !paid.complete ||
    !Number.isFinite(Date.parse(paid.checkedAt)) ||
    +now - Date.parse(paid.checkedAt) > 15 * 60000 ||
    Date.parse(paid.checkedAt) > +now + 1000
  )
    fail(paid.status === "confirmado" ? "purchased" : "purchase_unconfirmed");
}

/** Executado sob a mesma trava da criação do callback. Se falhar, o callback
 * persistido já impede o envio da cadência; a falha continua visível. */
export async function cederCadenciaAoRetornoC01(
  db: Queryable,
  org: string,
  contact: string,
): Promise<void> {
  await db.query(
    `with cancelled as (
    update followup_enrollments e set status='cancelled',cancel_reason='retorno_combinado_tem_prioridade',
      completed_at=now(),next_eval_at=null,claimed_until=null
    from followup_flow_versions v where e.organization_id=$1 and e.contact_id=$2
      and v.organization_id=e.organization_id and v.id=e.version_id
      and v.graph->'settings' ? 'c01_acompanhamento'
      and e.status in ('active','waiting_reply','paused_handoff','paused_manual','dormente','coletando') returning e.id
  ) update job_queue set status='done',last_error='c01_callback_priority'
    where organization_id=$1 and contact_id=$2 and kind='followup_turn' and status in ('pending','running')
      and payload->>'followup_enrollment_id' in (select id::text from cancelled)`,
    [org, contact],
  );
}
