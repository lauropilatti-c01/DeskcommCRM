import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  snapshotSchema,
  simulationRequestSchema,
  simulationResultSchema,
  type SimulationRequest,
} from "./contrato";

const readerConfiguration = z.object({
  url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  secret: z.string().min(32),
});

type Operation = "snapshot" | "refresh" | "simulate";
const MAX_REQUEST = 65_536;
const MAX_RESPONSE = 8_000_000;
async function boundedJson(response: Response | Request, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}
/** Toda autorização acontece ANTES do leitor privado. Cache dele não guarda permissões. */
export async function handleJornadas(request: Request, operation: Operation): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "c01_jornadas" });
  if (!authz.ok) return authz.response;
  if (!(await moduloLigado(createAdminClient(), "c01_jornadas")))
    return fail("not_found", "Jornadas está desligado nesta instalação.", 404, { requestId });
  if (operation !== "snapshot") {
    const origin = request.headers.get("origin");
    if (
      request.headers.get("sec-fetch-site") === "cross-site" ||
      (origin && origin !== new URL(request.url).origin)
    )
      return fail("forbidden", "Origem da solicitação não permitida.", 403, { requestId });
  }
  let payload: SimulationRequest | undefined;
  if (operation === "simulate") {
    try {
      payload = simulationRequestSchema.parse(await boundedJson(request, MAX_REQUEST));
    } catch {
      return fail("validation_error", "Confira as respostas e a versão do cenário.", 400, {
        requestId,
      });
    }
  }
  const configuration = readerConfiguration.safeParse({
    url: env.C01_JORNADAS_URL,
    secret: env.C01_JORNADAS_SECRET,
  });
  if (!configuration.success)
    return fail("not_configured", "A fonte de Jornadas ainda não foi configurada.", 503, {
      requestId,
    });
  try {
    const endpoint = new URL(`/v1/${operation}`, configuration.data.url);
    const result = await fetch(endpoint, {
      method: operation === "snapshot" ? "GET" : "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(operation === "simulate" ? 40_000 : 5_000),
      headers: {
        Authorization: `Bearer ${configuration.data.secret}`,
        "X-Organization-Id": authz.org.orgId,
        "Content-Type": "application/json",
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!result.ok) {
      // Nunca retransmitir texto de erro da fonte: pode conter caminhos ou credenciais.
      const status = [403, 404, 409, 429].includes(result.status) ? result.status : 503;
      const message =
        status === 409
          ? "Essa fotografia ou versão não permite conferir o cenário. Atualize os dados."
          : status === 429
            ? "Aguarde um momento antes de solicitar outra conferência."
            : status === 404
              ? "Fonte não configurada para esta organização."
              : "Não foi possível conferir a fonte de Jornadas.";
      return fail("jornadas_unavailable", message, status, { requestId });
    }
    const raw = await boundedJson(result, MAX_RESPONSE);
    let data: unknown;
    if (operation === "snapshot") {
      const parsed = snapshotSchema.safeParse(raw);
      if (!parsed.success || parsed.data.organization_id !== authz.org.orgId)
        return fail("invalid_source", "A fonte retornou uma fotografia incompatível.", 502, {
          requestId,
        });
      data = parsed.data;
    } else if (operation === "simulate") {
      const parsed = simulationResultSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.snapshot_id !== payload?.snapshot_id ||
        parsed.data.flow_id !== payload?.flow_id
      )
        return fail("invalid_source", "O resultado não corresponde ao cenário selecionado.", 502, {
          requestId,
        });
      data = parsed.data;
    } else {
      data = z.object({ accepted: z.literal(true) }).parse(raw);
    }
    return ok(data, { requestId, headers: { "Cache-Control": "private, no-store" } });
  } catch {
    logger.warn("c01.jornadas: fonte indisponível", {
      requestId,
      operation,
      organization_id: authz.org.orgId,
    });
    return fail(
      "upstream_unavailable",
      "Não foi possível consultar Jornadas agora. O atendimento continua independente desta tela.",
      503,
      { requestId },
    );
  }
}
