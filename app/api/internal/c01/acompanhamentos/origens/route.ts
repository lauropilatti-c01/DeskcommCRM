import { z } from "zod";
import { configOrigemC01, tokenDaOrigemValido } from "@/lib/followup/c01-origem";
import {
  OrigemRecusada,
  registrarOrigemEntregueC01,
} from "@/lib/followup/c01-acompanhamento-origens";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
export const runtime = "nodejs";
const inputSchema = z.strictObject({
  message_id: z.uuid(),
  lead_id: z.uuid(),
  kind: z.enum(["cronograma", "oferta"]),
  product_key: z.string().min(1).max(200),
});
/** Canal exclusivo do produtor; não utiliza autenticação de usuário/MCP. */
export async function POST(request: Request): Promise<Response> {
  const cfg = configOrigemC01();
  if (!cfg?.enabled) return Response.json({ code: "integration_disabled" }, { status: 503 });
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ") || !tokenDaOrigemValido(cfg, auth.slice(7)))
    return Response.json({ code: "unauthorized" }, { status: 401 });
  let raw: unknown;
  try {
    const text = await request.text();
    if (text.length > 4096) throw new Error();
    raw = JSON.parse(text);
  } catch {
    return Response.json({ code: "invalid_body" }, { status: 400 });
  }
  const input = inputSchema.safeParse(raw);
  if (!input.success) return Response.json({ code: "invalid_body" }, { status: 400 });
  try {
    const result = await registrarOrigemEntregueC01(getRequestPool(), cfg, {
      messageId: input.data.message_id,
      leadId: input.data.lead_id,
      productKey: input.data.product_key,
      kind: input.data.kind,
    });
    return Response.json(result, { status: result.status === "enrolled" ? 201 : 200 });
  } catch (err) {
    if (err instanceof OrigemRecusada) return Response.json({ code: err.code }, { status: 409 });
    return Response.json({ code: "origin_unavailable" }, { status: 503 });
  }
}
