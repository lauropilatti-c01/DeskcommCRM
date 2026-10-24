/** Consulta para a guarda final. Deve ser chamada com a trava de efeito já retida. */
import { createHash } from "node:crypto";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { configuracoesFinanceiras } from "./configuracao-financeira";
import { criarFonteFinanceira } from "./fontes-financeiras";
import type { ColetaFinanceira } from "./coleta-financeira";
export { criarFonteFinanceira } from "./fontes-financeiras";
export interface SituacaoFinanceira {
  status: "confirmado" | "revisao" | "indisponivel" | "nao_comprou_confirmado";
  checkedAt: string;
  complete: boolean;
  reason: string;
  evidenceHash?: string;
  collection?: ColetaFinanceira;
}
export async function lerSituacaoFinanceira(input: {
  db: Queryable;
  organizationId: string;
  contactId: string;
  leadId: string;
  productKey: string;
  now: Date;
  signal: AbortSignal;
}): Promise<SituacaoFinanceira> {
  const answer = (
    status: SituacaoFinanceira["status"],
    reason: string,
    complete = false,
    evidenceHash?: string,
  ): SituacaoFinanceira => ({
    status,
    reason,
    complete,
    checkedAt: new Date().toISOString(),
    ...(evidenceHash ? { evidenceHash } : {}),
  });
  try {
    const age = Date.now() - input.now.getTime();
    if (!Number.isFinite(age) || age > 60_000 || age < -5_000)
      return answer("indisponivel", "instante_da_consulta_financeira_desatualizado");
    const configs = configuracoesFinanceiras().filter(
      (c) => c.enabled && c.organizationId === input.organizationId,
    );
    if (
      !configs.some((c) => c.provider === "guru") ||
      !configs.some((c) => c.provider === "boleto")
    )
      return answer("indisponivel", "fontes_financeiras_desligadas_ou_ausentes");
    const row = (
      await input.db.query(
        `select l.custom_fields,l.created_at,l.status,c.phone_number,c.email,c.is_anonymized,c.is_merged_into from crm_leads l join contacts c on c.id=l.contact_id and c.organization_id=l.organization_id where l.organization_id=$1 and l.id=$2 and c.id=$3`,
        [input.organizationId, input.leadId, input.contactId],
      )
    ).rows[0];
    if (
      !row ||
      row.is_anonymized ||
      row.is_merged_into ||
      row.custom_fields?.produto_chave !== input.productKey
    )
      return answer("revisao", "identidade_ou_oportunidade_alterada");
    const phone = row.phone_number as string | null,
      email = typeof row.email === "string" ? row.email.trim().toLowerCase() : null;
    if (!phone && !email) return answer("revisao", "identidade_financeira_ausente");
    const unique = await input.db.query(
      `select id from contacts where organization_id=$1 and not is_anonymized and is_merged_into is null and (($2::text is not null and phone_number=$2) or ($3::text is not null and email_normalized=$3))`,
      [input.organizationId, phone, email],
    );
    if (unique.rows.length !== 1 || unique.rows[0]?.id !== input.contactId)
      return answer("revisao", "identidade_compartilhada");
    const opportunities = await input.db.query(
      "select id from crm_leads where organization_id=$1 and contact_id=$2 and status='open'",
      [input.organizationId, input.contactId],
    );
    if (opportunities.rows.length !== 1 || opportunities.rows[0]?.id !== input.leadId)
      return answer("revisao", "oportunidade_encerrada_ou_ambigua");
    const from = new Date(row.created_at);
    if (!Number.isFinite(from.getTime()) || from > input.now)
      return answer("revisao", "periodo_da_oportunidade_invalido");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(8_000)]),
      references: string[] = [];
    let paid = false;
    for (const cfg of configs) {
      const maps = cfg.products.filter(
        (p) =>
          p.crmProductKey === input.productKey &&
          p.crmOfferKey === row.custom_fields?.plano_oferecido,
      );
      const map = maps.length === 1 ? maps[0] : undefined;
      if (!map) return answer("revisao", "produto_ou_oferta_sem_mapa_exato");
      const records = await criarFonteFinanceira(cfg).scan(from, input.now, signal, {
        phone,
        email,
      });
      for (const r of records) {
        const pm = !!phone && phone === r.phone,
          em = !!email && email === r.email;
        if (!pm && !em) continue;
        const identities = await input.db.query(
          `select id from contacts where organization_id=$1 and not is_anonymized and is_merged_into is null
           and (($2::text is not null and phone_number=$2) or ($3::text is not null and email_normalized=$3))`,
          [input.organizationId, r.phone, r.email],
        );
        if (identities.rows.length !== 1 || identities.rows[0]?.id !== input.contactId)
          return answer("revisao", "identificadores_apontam_para_pessoas_diferentes");
        if ((phone && r.phone && !pm) || (email && r.email && !em))
          return answer("revisao", "identificadores_financeiros_conflitantes");
        if (r.productId !== map.productId) continue;
        if (r.offerId !== map.offerId) return answer("revisao", "oferta_financeira_divergente");
        if (Date.parse(r.orderedAt) < from.getTime())
          return answer("revisao", "pedido_anterior_a_oportunidade");
        if (r.status === "review")
          return answer("revisao", r.reviewReason ?? "pagamento_parcial_reembolsado_ou_ambiguo");
        if (r.status === "paid") paid = true;
      }
      references.push(
        createHash("sha256")
          .update(
            JSON.stringify({
              integration: cfg.integrationId,
              from: from.toISOString(),
              to: input.now.toISOString(),
              records,
            }),
          )
          .digest("hex"),
      );
    }
    signal.throwIfAborted();
    const evidenceHash = createHash("sha256").update(references.join(":")).digest("hex");
    return answer(
      paid ? "confirmado" : "nao_comprou_confirmado",
      paid ? "compra_confirmada_na_fonte" : "sem_compra_na_identidade_produto_e_periodo_conferidos",
      true,
      evidenceHash,
    );
  } catch {
    return answer("indisponivel", "consulta_financeira_incompleta_ou_falhou");
  }
}
