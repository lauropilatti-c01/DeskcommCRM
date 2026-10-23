import { conferirRetornoNoEnvioC01 } from "./c01-retorno";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProactiveContext } from "@/lib/agenda/efeito";
import { ApiError } from "@/lib/api/types";
import { AsyncLocalStorage } from "node:async_hooks";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { comTravaDeEfeito, type TravaDeEfeito } from "@/lib/agent-engine/db/trava-de-efeito";
import { configOrigemC01 } from "./c01-origem";
import { lerFatosAcompanhamentoC01 } from "./c01-acompanhamento-fatos";
import {
  avaliarAcompanhamento,
  c01AcompanhamentoSchema,
  type ConfigAcompanhamento,
  type DecisaoAcompanhamento,
  type FatosAcompanhamento,
} from "./c01-acompanhamento";

export interface EscopoAcompanhamento {
  organizationId: string;
  contactId: string;
  enrollmentId: string;
}
/**
 * Integração aplicada: reconcilia identidade,
 * negócio, origem e recibos. O sincronizador em observação NÃO implementa esta
 * porta e campos/tags editáveis pela IA NÃO são prova financeira.
 */
export type FonteAcompanhamento = (
  scope: EscopoAcompanhamento,
) => Promise<FatosAcompanhamento | null>;
const envio = new AsyncLocalStorage<{ key: string; lock: TravaDeEfeito; attempts: Set<string> }>();
export function conexaoDoAcompanhamentoC01() {
  return envio.getStore()?.lock.db;
}
async function fonteAplicada(
  scope: EscopoAcompanhamento,
  now: Date,
): Promise<FatosAcompanhamento | null> {
  const cfg = configOrigemC01();
  if (!cfg?.enabled || cfg.organizationId !== scope.organizationId) return null;
  const held = envio.getStore();
  const { lerSituacaoFinanceira } = await import("@/lib/leads/fonte-financeira");
  return lerFatosAcompanhamentoC01(
    held?.lock.db ?? getRequestPool(),
    cfg,
    scope,
    now,
    lerSituacaoFinanceira,
    held?.lock.signal,
  );
}

export async function decidirAcompanhamentoC01(
  config: ConfigAcompanhamento,
  scope: EscopoAcompanhamento,
  now: Date,
  fonte?: FonteAcompanhamento,
): Promise<DecisaoAcompanhamento> {
  if (!config.activated_at) return { kind: "blocked", reason: "ativacao_pendente" };
  const facts = await (fonte ? fonte(scope) : fonteAplicada(scope, now));
  if (!facts) return { kind: "blocked", reason: "integracao_aplicada_indisponivel" };
  if (facts.organizationId !== scope.organizationId || facts.contactId !== scope.contactId)
    return { kind: "blocked", reason: "fonte_fora_do_escopo" };
  return avaliarAcompanhamento(config, facts, now);
}

/** A mesma conexão retém a trava entre a releitura financeira e o aceite do transporte.
 * O registro de compra e o callback usam esta mesma chave. Um lock perdido veta
 * o próximo corte; o recibo de envio já aceito continua sendo registrado. */
export async function comEnvioAcompanhamentoC01<T>(
  db: SupabaseClient,
  context: ProactiveContext | undefined,
  organizationId: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!context) return action();
  if (!context.enrollmentId) {
    if (!(await callbackComercialC01(db, context, organizationId))) return action();
    return comTravaC01(context, organizationId, action);
  }
  const { data: row, error } = await db
    .from("followup_enrollments")
    .select("version_id")
    .eq("organization_id", organizationId)
    .eq("contact_id", context.contactId)
    .eq("id", context.enrollmentId)
    .maybeSingle();
  if (error || !row)
    throw new ApiError(
      409,
      "c01_acompanhamento_bloqueado",
      { terminal: true, reason: "inscricao_indisponivel" },
      context.jobId ?? "followup",
    );
  const { data: version, error: versionError } = await db
    .from("followup_flow_versions")
    .select("graph")
    .eq("organization_id", organizationId)
    .eq("id", row.version_id)
    .maybeSingle();
  if (versionError || !version) throw new Error("c01_versao_indisponivel");
  if (version.graph?.settings?.c01_acompanhamento === undefined) return action();
  // OFF/configuração ausente falha antes de abrir pool ou chamar fornecedor.
  const cfg = configOrigemC01();
  if (!cfg?.enabled) {
    await assertAcompanhamentoC01Supabase(db, context, organizationId);
    throw new Error("c01_configuracao_indisponivel");
  }
  return comTravaC01(context, organizationId, action);
}
async function callbackComercialC01(
  db: SupabaseClient,
  context: ProactiveContext,
  org: string,
): Promise<boolean> {
  if (!context.jobId) return false;
  const { data, error } = await db
    .from("job_queue")
    .select("payload")
    .eq("organization_id", org)
    .eq("contact_id", context.contactId)
    .eq("id", context.jobId)
    .maybeSingle();
  if (error || !data) throw new Error("c01_callback_job_unavailable");
  return data.payload?.scope === "commercial" || !!data.payload?.c01_callback;
}
async function comTravaC01<T>(
  context: ProactiveContext,
  organizationId: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!configOrigemC01()?.enabled || configOrigemC01()?.organizationId !== organizationId)
    throw new Error("c01_configuracao_indisponivel");
  const key = `callback:${organizationId}:${context.contactId}`;
  if (envio.getStore()?.key === key) return action();
  const held = await comTravaDeEfeito(getRequestPool(), key, (lock) =>
    envio.run({ key, lock, attempts: new Set() }, action),
  );
  if (held.ocupado)
    throw new ApiError(
      409,
      "c01_acompanhamento_ocupado",
      { terminal: false },
      context.jobId ?? "followup",
    );
  return held.resultado;
}

/**
 * Última defesa na porta comum de texto, mídia e template. Sempre relê o grafo
 * pinado, incluindo jobs já enfileirados: tirar a flag do payload não a apaga.
 * A falta de origem, recibo ou cobertura financeira mantém o envio bloqueado.
 */
export async function assertAcompanhamentoC01Supabase(
  db: SupabaseClient,
  context: ProactiveContext,
  organizationId: string,
  now = new Date(),
): Promise<void> {
  if (!context.enrollmentId) {
    if (!(await callbackComercialC01(db, context, organizationId))) return;
    const held = envio.getStore();
    if (!held || context.organizationId !== organizationId)
      throw new Error("c01_callback_lock_missing");
    await held.lock.conferir();
    const { lerSituacaoFinanceira } = await import("@/lib/leads/fonte-financeira");
    await conferirRetornoNoEnvioC01(
      held.lock.db,
      { organizationId, contactId: context.contactId, jobId: context.jobId! },
      now,
      held.lock.signal,
      lerSituacaoFinanceira,
    );
    return;
  }
  await envio.getStore()?.lock.conferir();
  const refuse = (reason: string): never => {
    throw new ApiError(
      409,
      "c01_acompanhamento_bloqueado",
      { terminal: true, reason },
      context.jobId ?? "followup",
      "Acompanhamento C01 bloqueado; confira as pendências do fluxo.",
    );
  };
  if (context.organizationId !== organizationId) refuse("organizacao_incompativel");
  const { data: enrollment, error: enrollmentError } = await db
    .from("followup_enrollments")
    .select("version_id,contact_id")
    .eq("organization_id", organizationId)
    .eq("id", context.enrollmentId)
    .eq("contact_id", context.contactId)
    .maybeSingle();
  if (enrollmentError || !enrollment) return refuse("inscricao_indisponivel");
  const { data: version, error: versionError } = await db
    .from("followup_flow_versions")
    .select("graph")
    .eq("organization_id", organizationId)
    .eq("id", enrollment.version_id)
    .maybeSingle();
  if (versionError || !version) return refuse("versao_indisponivel");
  const raw = version.graph?.settings?.c01_acompanhamento;
  if (raw === undefined) return;
  const config = c01AcompanhamentoSchema.safeParse(raw);
  if (!config.success) return refuse("politica_invalida");
  const decision = await decidirAcompanhamentoC01(
    config.data,
    { organizationId, contactId: context.contactId, enrollmentId: context.enrollmentId },
    now,
  );
  // Esta implementação não oferece uma chave para o operador afirmar que a
  // integração está pronta. Só código de uma fonte aplicada pode liberar.
  if (decision.kind !== "send")
    refuse("reason" in decision ? decision.reason : "envio_nao_autorizado");
}

/** Marca antes de sair da máquina. Queda depois do POST e antes do recibo não
 * vira repetição automática. O recibo confirmado continua nas tabelas nativas. */
export async function registrarTentativaEnvioC01(
  context: ProactiveContext | undefined,
  messageId: string,
): Promise<void> {
  const held = envio.getStore();
  if (!held || !context?.jobId) return;
  if (held.attempts.has(messageId)) return; // Cortes repetidos da mesma chamada física.
  await held.lock.conferir();
  const db = held.lock.db;
  if (context.enrollmentId) {
    const previous = (
      await db.query(
        `/* c01:tentativa:ler */ select id from followup_enrollment_events
      where organization_id=$1 and enrollment_id=$2 and event_type='c01_envio_iniciado'
        and (payload->>'job_id'=$3 or payload->>'message_id'=$4) limit 1`,
        [context.organizationId, context.enrollmentId, context.jobId, messageId],
      )
    ).rows;
    // Uma chamada pode produzir várias bolhas. Só recibos reais permitem avançar;
    // o job sem recibo de uma bolha anterior não pode reiniciar com texto novo.
    if (previous.length) {
      const unknown = (
        await db.query(
          `/* c01:tentativa:pendente */ select ev.id from followup_enrollment_events ev
        left join messages m on m.organization_id=ev.organization_id and m.id=(ev.payload->>'message_id')::uuid
        where ev.organization_id=$1 and ev.enrollment_id=$2 and ev.event_type='c01_envio_iniciado'
          and ev.payload->>'job_id'=$3 and (m.id is null or m.external_id is null or m.status not in ('sent','delivered','read')) limit 1`,
          [context.organizationId, context.enrollmentId, context.jobId],
        )
      ).rows;
      if (unknown.length) throw new Error("c01_entrega_indeterminada");
      const same = (
        await db.query(
          `select id from followup_enrollment_events where organization_id=$1
        and enrollment_id=$2 and idempotency_key=$3`,
          [context.organizationId, context.enrollmentId, `c01-send:${messageId}`],
        )
      ).rows;
      if (same.length) throw new Error("c01_envio_ja_tentado");
    }
    await db.query(
      `insert into followup_enrollment_events(organization_id,enrollment_id,node_id,event_type,idempotency_key,payload)
      values($1,$2,$3,'c01_envio_iniciado',$4,$5::jsonb)`,
      [
        context.organizationId,
        context.enrollmentId,
        context.nodeId ?? null,
        `c01-send:${messageId}`,
        JSON.stringify({ message_id: messageId, job_id: context.jobId }),
      ],
    );
  } else {
    const row = (
      await db.query(
        `select payload from job_queue where organization_id=$1 and contact_id=$2 and id=$3`,
        [context.organizationId, context.contactId, context.jobId],
      )
    ).rows[0];
    const attempts = row?.payload?.c01_send_attempts ?? [];
    if (!Array.isArray(attempts)) throw new Error("c01_tentativas_invalidas");
    if (attempts.includes(messageId)) throw new Error("c01_envio_ja_tentado");
    if (attempts.length) {
      const receipts = (
        await db.query(
          `select id from messages where organization_id=$1 and contact_id=$2 and id=any($3::uuid[])
        and external_id is not null and status in ('sent','delivered','read')`,
          [context.organizationId, context.contactId, attempts],
        )
      ).rows;
      if (receipts.length !== attempts.length) throw new Error("c01_entrega_indeterminada");
    }
    await db.query(
      `update job_queue set payload=jsonb_set(payload,'{c01_send_attempts}',$4::jsonb)
      where organization_id=$1 and contact_id=$2 and id=$3`,
      [
        context.organizationId,
        context.contactId,
        context.jobId,
        JSON.stringify([...attempts, messageId]),
      ],
    );
  }
  held.attempts.add(messageId);
}
