import { createHash } from "node:crypto";
import { z } from "zod";
import type { ContratoBoletoAceito } from "./contrato-boleto-aceito";

export const clicksignReadSchema = z
  .object({
    accountKeySha256: z.string().regex(/^[0-9a-f]{64}$/),
    apiToken: z.string().min(1),
  })
  .strict();
const instant = z.iso.datetime({ offset: true });
const responseSchema = z.object({
  document: z.object({
    key: z.uuid(),
    account_key: z.string().min(1),
    status: z.literal("closed"),
    uploaded_at: instant,
    finished_at: instant,
    template: z.object({ key: z.uuid(), data: z.record(z.string(), z.string()) }),
    downloads: z.object({ signed_file_checksum: z.string().regex(/^[a-f0-9]{64}$/i) }),
    signers: z
      .array(
        z.object({
          key: z.uuid(),
          name: z.string(),
          documentation: z.string(),
          signature: z.object({ name: z.string(), documentation: z.string() }),
        }),
      )
      .length(1),
  }),
});
const clean = (v: string) => v.normalize("NFC").replace(/\s+/g, " ").trim();
function cpf(v: string) {
  return /^[\d.\s-]+$/.test(v) ? v.replace(/\D/g, "") : "";
}

/** Metadados retornados por GET autenticado do documento exato, nunca por webhook. */
export function conferirDocumentoClicksign(
  raw: unknown,
  expected: ContratoBoletoAceito,
  accountKeySha256: string,
  now: Date,
): { documentHash: string; signedFileChecksum: string; finishedAt: string } | null {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const d = parsed.data.document,
    signer = d.signers[0]!,
    e = expected.document;
  if (
    d.key !== e.key ||
    d.template.key !== e.templateKey ||
    signer.key !== e.signerKey ||
    createHash("sha256").update(d.account_key).digest("hex") !== accountKeySha256 ||
    Date.parse(d.uploaded_at) < Date.parse(e.createdAt) ||
    Date.parse(d.finished_at) < Date.parse(d.uploaded_at) ||
    Date.parse(d.finished_at) > now.getTime() ||
    !/^\d{11}$/.test(cpf(e.customerCpf)) ||
    cpf(signer.documentation) !== cpf(e.customerCpf) ||
    cpf(signer.signature.documentation) !== cpf(e.customerCpf) ||
    clean(signer.name) !== clean(e.customerName) ||
    clean(signer.signature.name) !== clean(e.customerName) ||
    Object.entries(e.variables).some(
      ([key, value]) => clean(d.template.data[key] ?? "") !== clean(value),
    )
  )
    return null;
  // Sem URL de assinatura, dados pessoais ou token na evidência que circula no CRM.
  return {
    documentHash: createHash("sha256").update(JSON.stringify(d)).digest("hex"),
    signedFileChecksum: d.downloads.signed_file_checksum,
    finishedAt: d.finished_at,
  };
}
