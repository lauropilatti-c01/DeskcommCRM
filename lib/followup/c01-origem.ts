import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { hashDoCorpo } from "@/lib/api/idempotency";

export const origemSchema = z.strictObject({
  kind: z.enum(["cronograma", "oferta", "video_curso"]),
  leadId: z.uuid(),
  productKey: z.string().min(1).max(200),
  videoKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/).optional(),
});
export type OrigemC01 = z.infer<typeof origemSchema>;
const configSchema = z.strictObject({
  enabled: z.boolean(),
  organizationId: z.uuid(),
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
  signingKey: z.string().min(32),
  offerConnectionId: z.uuid().optional(),
  allowedKinds: z.array(z.enum(["cronograma", "oferta", "video_curso"])).min(1),
  /** OFF e copy proposta não capturam origem nem autorizam envio. */
  videoCourse: z.strictObject({
    enabled: z.boolean(),
    connectionId: z.uuid(),
    copyStatus: z.enum(["proposed", "approved"]),
    question: z.string().trim().min(1).max(700),
    catalog: z.array(z.strictObject({
      key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
      productKey: z.string().min(1).max(200),
      url: z.url().startsWith("https://"),
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })).max(100),
  }).refine(v => new Set(v.catalog.map(i => i.key)).size === v.catalog.length).optional(),
  /** Opcional e OFF: só um modelo revisado, na conexão exata, sem valores de IA. */
  callbackTemplate: z.strictObject({
    enabled: z.boolean(),
    connectionId: z.uuid(),
    templateId: z.uuid(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
});
export type ConfigOrigemC01 = z.infer<typeof configSchema>;
export function configOrigemC01(): ConfigOrigemC01 | null {
  try {
    const parsed = configSchema.safeParse(
      JSON.parse(process.env.C01_ACOMPANHAMENTO_INTEGRATION?.trim() || "null"),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function tokenDaOrigemValido(cfg: ConfigOrigemC01, token: string): boolean {
  const actual = createHash("sha256").update(token).digest();
  return timingSafeEqual(actual, Buffer.from(cfg.tokenSha256, "hex"));
}
const provaSchema = origemSchema.extend({
  version: z.literal(1),
  organizationId: z.uuid(),
  contactId: z.uuid(),
  conversationId: z.uuid(),
  messageId: z.uuid(),
  createdAt: z.iso.datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ProvaOrigemC01 = z.infer<typeof provaSchema>;
export function assinarOrigemC01(
  cfg: ConfigOrigemC01,
  input: Omit<ProvaOrigemC01, "version" | "signature">,
): ProvaOrigemC01 {
  if (cfg.organizationId !== input.organizationId || !cfg.allowedKinds.includes(input.kind))
    throw new Error("origin_outside_integration");
  if (input.kind === "video_curso" && !input.videoKey) throw new Error("video_identity_missing");
  const body = {
    version: 1 as const,
    kind: input.kind,
    leadId: input.leadId,
    productKey: input.productKey,
    organizationId: input.organizationId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    createdAt: input.createdAt,
    contentHash: input.contentHash,
    ...(input.videoKey ? { videoKey: input.videoKey } : {}),
  };
  return {
    ...body,
    signature: createHmac("sha256", cfg.signingKey).update(hashDoCorpo(body)).digest("hex"),
  };
}
export function conferirOrigemC01(cfg: ConfigOrigemC01, raw: unknown): ProvaOrigemC01 | null {
  const parsed = provaSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { signature, version: _version, ...input } = parsed.data;
  if (cfg.organizationId !== input.organizationId || !cfg.allowedKinds.includes(input.kind))
    return null;
  if (input.kind === "video_curso" && !input.videoKey) return null;
  const signed = assinarOrigemC01(cfg, input);
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signed.signature, "hex"))
    ? parsed.data
    : null;
}

/** Assina a mensagem persistida, não apenas o seu identificador. */
export function hashDoConteudoDaOrigem(message: Record<string, unknown>): string {
  const metadata = message.metadata as Record<string, unknown> | null | undefined;
  return hashDoCorpo({
    type: message.type,
    body: message.body ?? null,
    media_url: message.media_url ?? null,
    media_storage_path: message.media_storage_path ?? null,
    interactive: metadata?.interactive ?? null,
  });
}
