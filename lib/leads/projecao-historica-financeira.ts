/** Consulta limitada ao espelho autenticado. Não confirma Ganho nem modifica o CRM. */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { SituacaoFinanceira } from "./fonte-financeira";
import { coletaFinanceiraSchema, coletaFinanceiraViva } from "./coleta-financeira";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const projecaoHistoricaSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.url().refine((value) => {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === "/"
      );
    }),
    apiToken: z.string().min(32).max(512),
    hmacKeyHex: hex,
    scopeHash: hex,
  })
  .strict();
const responseSchema = z
  .object({
    data: z
      .object({
        schema: z.literal(1),
        organizationId: z.uuid(),
        scopeHash: hex,
        requestId: z.uuid(),
        requestHash: hex,
        status: z.enum(["nao_comprou_confirmado", "confirmado", "revisao", "indisponivel"]),
        reason: z.string().regex(/^[a-z0-9_]{1,200}$/),
        complete: z.boolean(),
        checkedAt: z.string().nullable(),
        evidenceHash: hex.optional(),
        collection: coletaFinanceiraSchema.optional(),
        identityKeys: z
          .array(z.object({ phoneHash: hex.nullable(), emailHash: hex.nullable() }).strict())
          .max(1),
      })
      .strict(),
  })
  .strict();
const MAX_BYTES = 16_384;
async function boundedJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || response.redirected || !response.body)
    throw new Error("projection_http_failed");
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES))
    throw new Error("projection_too_large");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BYTES) throw new Error("projection_too_large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function lerProjecaoHistorica(input: {
  config: z.infer<typeof projecaoHistoricaSchema>;
  db: Queryable;
  organizationId: string;
  contactId: string;
  phone: string | null;
  email: string | null;
  now: Date;
  signal: AbortSignal;
}): Promise<SituacaoFinanceira> {
  const unavailable = (
    reason = "projecao_historica_incompleta_ou_invalida",
  ): SituacaoFinanceira => ({
    status: "indisponivel",
    reason,
    complete: false,
    checkedAt: input.now.toISOString(),
  });
  try {
    const cfg = projecaoHistoricaSchema.parse(input.config);
    if (!cfg.enabled) return unavailable("projecao_historica_desligada");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(8_000)]);
    signal.throwIfAborted();
    const hmac = (kind: string, value: string | null) =>
      value
        ? createHmac("sha256", Buffer.from(cfg.hmacKeyHex, "hex"))
            .update(`${kind}:${value}`)
            .digest("hex")
        : null;
    const request = {
      organizationId: input.organizationId,
      scopeHash: cfg.scopeHash,
      phoneHash: hmac("tel", input.phone),
      emailHash: hmac("email", input.email),
      requestId: randomUUID(),
    };
    if (!request.phoneHash && !request.emailHash)
      return unavailable("identidade_financeira_incompleta");
    const body = JSON.stringify(request);
    const response = await fetch(new URL("/v1/financial/history/person", cfg.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body,
      redirect: "error",
      signal,
    });
    const r = responseSchema.parse(await boundedJSON(response, signal)).data;
    if (
      r.organizationId !== input.organizationId ||
      r.scopeHash !== cfg.scopeHash ||
      r.requestId !== request.requestId ||
      r.requestHash !== createHash("sha256").update(body).digest("hex")
    )
      return unavailable();
    const collection = r.collection ? coletaFinanceiraViva(r.collection, new Date()) : null;
    if (
      r.collection &&
      (!collection ||
        r.status !== "indisponivel" ||
        r.reason !== "projecao_em_coleta" ||
        r.complete ||
        Date.parse(r.checkedAt ?? "") !== Date.parse(r.collection.startedAt))
    )
      return unavailable();
    if (r.status === "indisponivel" && !collection) return unavailable(r.reason);
    const at = r.checkedAt ? new Date(r.checkedAt).getTime() : NaN,
      age = Date.now() - at;
    if (
      !Number.isFinite(age) ||
      age < 0 ||
      age > 900_000 ||
      !r.evidenceHash ||
      r.identityKeys.length !== 1
    )
      return unavailable();
    const identity = r.identityKeys[0]!;
    if (
      (request.phoneHash && identity.phoneHash !== request.phoneHash) ||
      (request.emailHash && identity.emailHash !== request.emailHash)
    )
      return unavailable("identidade_da_projecao_divergente");
    // A fonte pode conhecer o e-mail que ainda não está no card. Confere a
    // contraparte contra o tenant inteiro em memória; nunca põe o segredo em SQL.
    const contacts = await input.db.query(
      "select id,phone_number,email_normalized from contacts where organization_id=$1 and not is_anonymized and is_merged_into is null order by id limit 20001",
      [input.organizationId],
    );
    if (contacts.rows.length > 20_000) return unavailable("identidade_excede_limite_da_projecao");
    const matched = contacts.rows.filter(
      (c) =>
        (identity.phoneHash && hmac("tel", c.phone_number) === identity.phoneHash) ||
        (identity.emailHash && hmac("email", c.email_normalized) === identity.emailHash),
    );
    if (matched.length !== 1 || matched[0]?.id !== input.contactId)
      return {
        status: "revisao",
        complete: false,
        reason: "identificadores_apontam_para_pessoas_diferentes",
        checkedAt: r.checkedAt!,
      };
    if ((r.status === "nao_comprou_confirmado" || r.status === "confirmado") && !r.complete)
      return unavailable();
    if (
      r.status === "nao_comprou_confirmado" &&
      r.reason !== "sem_compra_na_identidade_e_periodo_conferidos"
    )
      return unavailable();
    signal.throwIfAborted();
    return {
      status: r.status,
      complete: r.status === "revisao" ? false : r.complete,
      reason: r.reason,
      checkedAt: r.checkedAt!,
      evidenceHash: r.evidenceHash,
      ...(collection ? { collection } : {}),
    };
  } catch {
    return unavailable();
  }
}
