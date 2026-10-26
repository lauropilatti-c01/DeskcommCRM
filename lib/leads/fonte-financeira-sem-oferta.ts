/** Veto comercial por identidade, antes e depois da oferta. O chamador retém a trava de efeito e decide o envio; aqui nada é escrito. */
import { createHash } from "node:crypto";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { SituacaoFinanceira } from "./fonte-financeira";
import { configuracoesFinanceiras } from "./configuracao-financeira";
import { criarFonteFinanceira, type RegistroFinanceiro } from "./fontes-financeiras";
import type { ConfiguracaoFinanceira } from "./configuracao-financeira";
import { lerProjecaoHistorica } from "./projecao-historica-financeira";

export async function lerSituacaoFinanceiraSemOferta(input: {
  db: Queryable;
  organizationId: string;
  contactId: string;
  leadId: string;
  productKey: null;
  finalidade: "sem_oferta";
  /** Quando já houve oferta, a troca de produto durante a consulta invalida a prova. */
  expectedProductKey?: string;
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
    input.signal.throwIfAborted();
    const age = Date.now() - input.now.getTime();
    if (!Number.isFinite(age) || age > 60_000 || age < -5_000)
      return answer("indisponivel", "instante_da_consulta_financeira_desatualizado");
    if (input.productKey !== null || input.finalidade !== "sem_oferta")
      return answer("revisao", "finalidade_financeira_invalida");
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
    if (!row || row.status !== "open" || row.is_anonymized || row.is_merged_into)
      return answer("revisao", "identidade_ou_oportunidade_alterada");
    const initialProduct = row.custom_fields?.produto_chave ?? null;
    const initialOffer = row.custom_fields?.plano_oferecido ?? null;
    if (input.expectedProductKey !== undefined && initialProduct !== input.expectedProductKey)
      return answer("revisao", "identidade_ou_oportunidade_alterada");
    const phone = typeof row.phone_number === "string" ? row.phone_number : null;
    const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : null;
    if (
      (!phone && !email) ||
      (phone !== null && !/^\+\d{8,15}$/.test(phone)) ||
      (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    )
      return answer("revisao", "identidade_financeira_incompleta");
    const unique = await input.db.query(
      `select id from contacts where organization_id=$1 and not is_anonymized and is_merged_into is null and (phone_number=$2 or email_normalized=$3)`,
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
    const created = new Date(row.created_at);
    if (!Number.isFinite(created.getTime()) || created > input.now)
      return answer("revisao", "periodo_da_oportunidade_invalido");
    // Confere todas as coberturas antes do primeiro GET. Boleto pagina todos os pedidos.
    for (const cfg of configs) {
      if (
        cfg.provider === "guru" &&
        (!cfg.historyCoverage || new Date(cfg.historyCoverage.startedAt) > created)
      )
        return answer("indisponivel", "cobertura_historica_financeira_nao_comprovada");
    }
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(8_000)]);
    const references: string[] = [];
    let paid = false;
    const snapshots: { cfg: ConfiguracaoFinanceira; records: RegistroFinanceiro[] }[] = [];
    const projectionConfigs = configs.filter((cfg) => cfg.historyProjection);
    let projection: SituacaoFinanceira | undefined;
    if (projectionConfigs.length) {
      // O escopo revisado cobre exatamente as duas contas configuradas. Não
      // omite uma terceira integração nem recai numa varredura após falha.
      if (projectionConfigs.length !== 1 || configs.length !== 2)
        return answer("indisponivel", "escopo_da_projecao_financeira_divergente");
      const guru = configs.find((cfg) => cfg.provider === "guru")!;
      const boleto = configs.find((cfg) => cfg.provider === "boleto")!;
      const scope = {
        schema: 1,
        organization_id: input.organizationId,
        guru_account_id: guru.sourceAccountId,
        boleto_org_id: boleto.sourceAccountId,
        history_start: guru.historyCoverage!.startedAt.slice(0, 10),
        history_evidence_sha256: guru.historyCoverage!.evidenceHash,
        normalization: "e164-v1",
        max_age_seconds: 900,
        reconciliation: "full_before_negative",
      };
      const scopeHash = createHash("sha256")
        .update(JSON.stringify(scope, Object.keys(scope).sort()))
        .digest("hex");
      if (projectionConfigs[0]!.historyProjection!.scopeHash !== scopeHash)
        return answer("indisponivel", "escopo_da_projecao_financeira_divergente");
      projection = await lerProjecaoHistorica({
        config: projectionConfigs[0]!.historyProjection!,
        db: input.db,
        organizationId: input.organizationId,
        contactId: input.contactId,
        phone,
        email,
        now: input.now,
        signal,
      });
      if (
        !projection.complete ||
        !["confirmado", "nao_comprou_confirmado"].includes(projection.status)
      ) {
        if (projection.collection) {
          // A consulta temporária também precisa sobreviver à releitura da pessoa.
          const reread = (
            await input.db.query(
              `select l.custom_fields,l.status,c.phone_number,c.email,c.is_anonymized,c.is_merged_into from crm_leads l join contacts c on c.id=l.contact_id and c.organization_id=l.organization_id where l.organization_id=$1 and l.id=$2 and c.id=$3`,
              [input.organizationId, input.leadId, input.contactId],
            )
          ).rows[0];
          const identities = (
            await input.db.query(
              "select id from contacts where organization_id=$1 and not is_anonymized and is_merged_into is null and (phone_number=$2 or email_normalized=$3)",
              [input.organizationId, phone, email],
            )
          ).rows;
          const leads = (
            await input.db.query(
              "select id from crm_leads where organization_id=$1 and contact_id=$2 and status='open'",
              [input.organizationId, input.contactId],
            )
          ).rows;
          if (
            !reread ||
            reread.status !== "open" ||
            reread.is_anonymized ||
            reread.is_merged_into ||
            reread.phone_number !== phone ||
            (typeof reread.email === "string" ? reread.email.trim().toLowerCase() : null) !==
              email ||
            (reread.custom_fields?.produto_chave ?? null) !== initialProduct ||
            (reread.custom_fields?.plano_oferecido ?? null) !== initialOffer ||
            identities.length !== 1 ||
            identities[0]?.id !== input.contactId ||
            leads.length !== 1 ||
            leads[0]?.id !== input.leadId
          )
            return answer("revisao", "identidade_ou_oportunidade_alterada");
        }
        return projection;
      }
      paid = projection.status === "confirmado";
      references.push(projection.evidenceHash!);
    }
    for (const cfg of projection ? [] : configs) {
      const from = cfg.provider === "guru" ? new Date(cfg.historyCoverage!.startedAt) : new Date(0);
      const records = await criarFonteFinanceira(cfg).scan(from, input.now, signal, {
        phone,
        email,
      });
      snapshots.push({ cfg, records });
      references.push(
        createHash("sha256")
          .update(
            JSON.stringify({
              integration: cfg.integrationId,
              sourceAccount: cfg.sourceAccountId,
              coverage: cfg.provider === "guru" ? cfg.historyCoverage : "todos_os_pedidos",
              from: from.toISOString(),
              to: input.now.toISOString(),
              records,
            }),
          )
          .digest("hex"),
      );
    }
    // Descobre a contraparte só em memória, por vínculo exato. Duas passagens
    // cobrem o registro que veio antes de descobrirmos o segundo identificador.
    // Não inventa e-mail nem escolhe um entre identidades incompatíveis.
    let knownPhone = phone,
      knownEmail = email;
    for (let pass = 0; pass < 2; pass++) {
      for (const { records } of snapshots)
        for (const record of records) {
          const pm = !!knownPhone && record.phone === knownPhone;
          const em = !!knownEmail && record.email === knownEmail;
          if (!pm && !em) continue;
          if ((knownPhone && record.phone && !pm) || (knownEmail && record.email && !em))
            return answer("revisao", "identificadores_financeiros_conflitantes");
          knownPhone ??= record.phone;
          knownEmail ??= record.email;
        }
    }
    for (const { cfg, records } of snapshots) {
      for (const record of records) {
        const pm = !!knownPhone && record.phone === knownPhone,
          em = !!knownEmail && record.email === knownEmail;
        if (!pm && !em) continue;
        const identities = await input.db.query(
          `select id from contacts where organization_id=$1 and not is_anonymized and is_merged_into is null and (phone_number=$2 or email_normalized=$3)`,
          [input.organizationId, record.phone, record.email],
        );
        if (identities.rows.length !== 1 || identities.rows[0]?.id !== input.contactId)
          return answer("revisao", "identificadores_apontam_para_pessoas_diferentes");
        if (record.freeWithoutPayment) continue;
        // Um espelho local sem a conferência Asaas não certifica não pagamento.
        if (cfg.provider === "boleto" && !cfg.asaasSettlement?.enabled)
          return answer("revisao", "comprovante_financeiro_incompleto");
        if (record.status === "review")
          return answer(
            "revisao",
            record.reviewReason ?? "pagamento_parcial_reembolsado_ou_ambiguo",
          );
        if (record.status === "paid") paid = true;
      }
    }
    signal.throwIfAborted();
    // Os GETs não retêm trava de tabela. Uma alteração observada nesse intervalo
    // invalida a prova; o chamador ainda precisa de sua guarda no ponto do efeito.
    const current = (
      await input.db.query(
        `select l.custom_fields,l.created_at,l.status,c.phone_number,c.email,c.is_anonymized,c.is_merged_into from crm_leads l join contacts c on c.id=l.contact_id and c.organization_id=l.organization_id where l.organization_id=$1 and l.id=$2 and c.id=$3`,
        [input.organizationId, input.leadId, input.contactId],
      )
    ).rows[0];
    const currentContacts = await input.db.query(
      `select id from contacts where organization_id=$1 and not is_anonymized and is_merged_into is null and (phone_number=$2 or email_normalized=$3)`,
      [input.organizationId, knownPhone, knownEmail],
    );
    const currentLeads = await input.db.query(
      "select id from crm_leads where organization_id=$1 and contact_id=$2 and status='open'",
      [input.organizationId, input.contactId],
    );
    if (
      !current ||
      current.status !== "open" ||
      current.is_anonymized ||
      current.is_merged_into ||
      (current.custom_fields?.produto_chave ?? null) !== initialProduct ||
      (current.custom_fields?.plano_oferecido ?? null) !== initialOffer ||
      current.phone_number !== phone ||
      (typeof current.email === "string" ? current.email.trim().toLowerCase() : null) !== email ||
      new Date(current.created_at).getTime() !== created.getTime() ||
      currentContacts.rows.length !== 1 ||
      currentContacts.rows[0]?.id !== input.contactId ||
      currentLeads.rows.length !== 1 ||
      currentLeads.rows[0]?.id !== input.leadId
    )
      return answer("revisao", "identidade_ou_oportunidade_alterada_durante_consulta");
    signal.throwIfAborted();
    const evidenceHash = createHash("sha256")
      .update(
        JSON.stringify({
          finalidade: "sem_oferta",
          organization: input.organizationId,
          contact: input.contactId,
          lead: input.leadId,
          references,
        }),
      )
      .digest("hex");
    const result = answer(
      paid ? "confirmado" : "nao_comprou_confirmado",
      paid
        ? "compra_confirmada_na_identidade_sem_filtro_de_produto"
        : "sem_compra_na_identidade_e_periodo_conferidos",
      true,
      evidenceHash,
    );
    // Consultar novamente o mesmo espelho não renova o frescor da fonte.
    return projection ? { ...result, checkedAt: projection.checkedAt } : result;
  } catch {
    return answer("indisponivel", "consulta_financeira_incompleta_ou_falhou");
  }
}
