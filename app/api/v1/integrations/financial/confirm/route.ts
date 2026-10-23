/** Integração financeira server-to-server; cookie e token MCP não conferem este poder. */
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { configuracoesFinanceiras, integrarFonte } from "@/lib/leads/configuracao-financeira";
import { CompraRecusada, registrarCompraVerificada } from "@/lib/leads/compra-verificada";
import { audit } from "@/lib/audit";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const bodySchema = z
  .object({
    integration_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    transaction_id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
    lead_id: z.uuid(),
  })
  .strict();
export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const configs = configuracoesFinanceiras();
    if (!configs.some((c) => c.enabled))
      return fail("financial_integration_disabled", "Integração financeira desligada.", 503, {
        requestId,
      });
    const token = /^Bearer ([^\s]{32,512})$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token)
      return fail("financial_unauthorized", "Credencial financeira ausente ou inválida.", 401, {
        requestId,
      });
    const hash = createHash("sha256").update(token).digest();
    const cfg = configs.find(
      (c) => c.enabled && timingSafeEqual(hash, Buffer.from(c.tokenSha256, "hex")),
    );
    if (!cfg)
      return fail("financial_unauthorized", "Credencial financeira ausente ou inválida.", 401, {
        requestId,
      });
    const supportDenied = await requireSupportWrite(cfg.organizationId);
    if (supportDenied) return supportDenied;
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 2048)
      return fail("financial_invalid_request", "Pedido financeiro inválido.", 400, { requestId });
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return fail("financial_invalid_request", "Pedido financeiro inválido.", 400, { requestId });
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success)
      return fail(
        "financial_invalid_request",
        "Informe somente integração, transação e oportunidade.",
        400,
        { requestId },
      );
    if (parsed.data.integration_id !== cfg.integrationId)
      return fail("financial_scope_mismatch", "Credencial não autoriza esta integração.", 403, {
        requestId,
      });
    const result = await registrarCompraVerificada(
      { pool: getRequestPool(), integration: integrarFonte(cfg) },
      { token, transactionId: parsed.data.transaction_id, leadId: parsed.data.lead_id },
    );
    if (result.status === "applied")
      await audit({
        action: "lead.won",
        organizationId: cfg.organizationId,
        actorUserId: null,
        resourceType: "crm_lead",
        resourceId: result.leadId,
        requestId,
        metadata: {
          integration_id: cfg.integrationId,
          order_id: result.orderId,
          cancelled_jobs: result.cancelledJobs.length,
        },
      });
    return ok(result, { requestId, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof CompraRecusada ? error.code : "financial_unavailable";
    const status =
      code === "financial_lead_not_found"
        ? 404
        : code.includes("busy") || code.includes("conflict")
          ? 409
          : code.includes("unavailable") || code === "financial_unavailable"
            ? 503
            : 422;
    return fail(
      code,
      "Não foi possível confirmar a compra. Confira a pendência antes de tentar novamente.",
      status,
      { requestId },
    );
  }
}
