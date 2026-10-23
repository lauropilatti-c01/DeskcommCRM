/** Token nativo exclusivo de leitura. Cookie, token MCP e token de confirmação não bastam. */
import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { McpAuthError, validateBearerToken } from "@/lib/mcp/auth";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { lerRetratoFinanceiro } from "@/lib/leads/retrato-financeiro";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const SCOPES = new Set(["financial:snapshot:read", "role:viewer"]);

export async function GET(request: Request): Promise<Response> {
  const opts = { requestId: randomUUID(), headers: { "Cache-Control": "no-store" } };
  try {
    const auth = await validateBearerToken(request.headers.get("authorization"));
    if (
      auth.role !== "viewer" ||
      auth.scopes.length !== SCOPES.size ||
      new Set(auth.scopes).size !== SCOPES.size ||
      auth.scopes.some((s) => !SCOPES.has(s))
    )
      return fail(
        "financial_snapshot_forbidden",
        "Credencial não autoriza esta leitura.",
        403,
        opts,
      );
    // Organização sempre vem do token. Sem filtros/páginas que ocultem conflitos.
    if (new URL(request.url).search || request.body !== null)
      return fail(
        "financial_snapshot_invalid_request",
        "Esta leitura não aceita parâmetros.",
        400,
        opts,
      );
    const [token, org] = await Promise.all([
      checkRateLimit(`financial-snapshot:token:${auth.apiTokenId}`, 6, 60),
      checkRateLimit(`financial-snapshot:org:${auth.organizationId}`, 6, 60),
    ]);
    if (!token.allowed || !org.allowed)
      return fail("financial_snapshot_rate_limited", "Aguarde antes de repetir a leitura.", 429, {
        ...opts,
        headers: { ...opts.headers, "Retry-After": "60" },
      });
    return ok(await lerRetratoFinanceiro(getRequestPool(), auth.organizationId), opts);
  } catch (error) {
    if (error instanceof McpAuthError)
      return fail(
        "financial_snapshot_unauthorized",
        "Credencial ausente, indisponível ou inválida.",
        error.httpStatus,
        opts,
      );
    return fail(
      "financial_snapshot_unavailable",
      "Retrato indisponível; mantenha a compra em revisão.",
      503,
      opts,
    );
  }
}
