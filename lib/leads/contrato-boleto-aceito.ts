import { createHash } from "node:crypto";
import { z } from "zod";

const money = z
  .union([z.string(), z.number()])
  .refine(
    (v) =>
      /^[0-9]+(?:\.[0-9]{1,2})?$/.test(String(v)) &&
      Number.isSafeInteger(Math.round(Number(v) * 100)),
  );
const cents = (v: string | number) => Math.round(Number(v) * 100);
const text = z.string().min(1);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  });
const instant = z.iso.datetime({ offset: true });
const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  computedAt: instant,
  totalValue: money,
  grandTotal: money,
  entryValue: money,
  financedValue: money,
  interestAmount: money,
  discountAmount: money.optional(),
  couponCode: text.nullish(),
  couponPercentOff: z.union([z.string(), z.number()]).nullish(),
  rule: z.object({
    version: z.number().int().positive(),
    taxaMensal: z.union([z.string(), z.number()]),
    installmentCount: z.number().int().min(1).max(100),
  }),
  installments: z
    .array(z.object({ number: z.number().int().positive(), value: money, dueDate: date }))
    .min(1)
    .max(100),
});
const orderSchema = z.object({
  id: z.uuid(),
  org_id: z.guid(),
  external_ref: text,
  created_at: instant,
  total_value: money,
  entry_value: money,
  installment_value: money,
  installment_count: z.number().int().min(1).max(100),
  discount_applied_at: z.null().optional(),
  discount_applied_pct: z.union([z.null(), z.literal(0), z.literal("0")]).optional(),
  customers: z.object({ name: text, cpf: text }),
  products: z.object({ name: text }),
  parcelamento_snapshot: snapshotSchema,
  contracts: z
    .array(
      z.object({
        id: z.uuid(),
        org_id: z.guid(),
        order_id: z.uuid(),
        provider: z.literal("clicksign"),
        status: z.literal("signed"),
        external_id: z.uuid(),
        external_envelope_id: z.uuid(),
        external_signer_id: z.uuid(),
        template_used: z.string().regex(/^clicksign:[0-9a-f-]{36}@v[1-9]\d*$/i),
        rendered_text_hash: z.string().regex(/^[0-9a-f]{64}$/),
        created_at: instant,
        signed_at: instant,
        cancelled_at: z.null().optional(),
        remote_cancel_status: z.null().optional(),
      }),
    )
    .length(1),
  payments: z
    .array(
      z.object({
        type: z.enum([
          "entry_pix",
          "installment_boleto",
          "installment_pix",
          "installment_pix_automatic",
        ]),
        installment_number: z.number().int().nonnegative().nullish(),
        amount: money,
        due_date: date,
      }),
    )
    .min(1)
    .max(100),
});

/**
 * Fonte autenticada do produtor, schema 1: compara o fingerprint financeiro gravado
 * na criação do documento com o pedido atual. Não deriva quitação de assinatura.
 * Algoritmo de origem: boleto-parcelado/src/lib/contracts/render.ts, clicksignVariablesHash.
 * Não é hash do PDF, nem autenticação independente de assinatura na ClickSign.
 */
export function lerContratoBoletoAceito(
  raw: unknown,
  now: Date,
): {
  totalCents: number;
  evidence: {
    contractId: string;
    documentId: string;
    template: string;
    fingerprint: string;
    schemaVersion: number;
  };
  document: {
    key: string;
    templateKey: string;
    signerKey: string;
    createdAt: string;
    customerName: string;
    customerCpf: string;
    variables: Record<string, string>;
  };
} | null {
  const parsed = orderSchema.safeParse(raw);
  if (!parsed.success) return null;
  const o = parsed.data,
    s = o.parcelamento_snapshot,
    c = o.contracts[0]!;
  if (
    c.org_id !== o.org_id ||
    c.order_id !== o.id ||
    c.external_id !== c.external_envelope_id ||
    Date.parse(s.computedAt) > Date.parse(c.created_at) ||
    Date.parse(c.created_at) < Date.parse(o.created_at) ||
    Date.parse(c.signed_at) < Date.parse(c.created_at) ||
    Date.parse(c.signed_at) > now.getTime() ||
    cents(s.totalValue) !== cents(o.total_value) ||
    cents(s.entryValue) !== cents(o.entry_value) ||
    s.installments.length !== o.installment_count ||
    s.rule.installmentCount !== o.installment_count ||
    cents(s.installments[0]!.value) !== cents(o.installment_value)
  )
    return null;
  const fingerprint = {
    grandTotal: s.grandTotal,
    entryValue: s.entryValue,
    financedValue: s.financedValue,
    interestAmount: s.interestAmount,
    discountAmount: s.discountAmount ?? null,
    couponCode: s.couponCode ?? null,
    couponPercentOff: s.couponPercentOff ?? null,
    taxaMensal: s.rule.taxaMensal,
    installmentCount: o.installment_count,
    installments: s.installments.map((i) => `${i.number}:${i.value}:${i.dueDate}`),
    firstDueDate: s.installments[0]!.dueDate,
    productName: o.products.name,
    customerName: o.customers.name,
    customerCpf: o.customers.cpf,
  };
  const hash = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
  if (c.rendered_text_hash !== hash) return null;
  const total = cents(s.grandTotal),
    entry = cents(s.entryValue),
    financed = cents(s.financedValue);
  if (
    total <= 0 ||
    financed !== cents(s.totalValue) - entry - cents(s.discountAmount ?? 0) ||
    total !== entry + financed + cents(s.interestAmount)
  )
    return null;
  const entries = o.payments.filter((p) => p.type === "entry_pix");
  const installments = o.payments.filter((p) => p.type !== "entry_pix");
  if (
    entries.length !== (entry > 0 ? 1 : 0) ||
    installments.length !== s.installments.length ||
    entries.some(
      (p) =>
        cents(p.amount) !== entry || (p.installment_number != null && p.installment_number !== 0),
    )
  )
    return null;
  let sum = entry;
  for (const [index, expected] of s.installments.entries()) {
    if (expected.number !== index + 1) return null;
    const matches = installments.filter((p) => p.installment_number === expected.number);
    if (
      matches.length !== 1 ||
      cents(matches[0]!.amount) !== cents(expected.value) ||
      matches[0]!.due_date !== expected.dueDate ||
      cents(expected.value) <= 0
    )
      return null;
    sum += cents(expected.value);
    if (!Number.isSafeInteger(sum)) return null;
  }
  if (sum !== total) return null;
  return {
    totalCents: total,
    evidence: {
      contractId: c.id,
      documentId: c.external_id,
      template: c.template_used,
      fingerprint: hash,
      schemaVersion: s.schemaVersion,
    },
    document: {
      key: c.external_id,
      templateKey: c.template_used.slice("clicksign:".length).split("@")[0]!,
      signerKey: c.external_signer_id,
      createdAt: c.created_at,
      customerName: o.customers.name,
      customerCpf: o.customers.cpf,
      variables: {
        numero_contrato: o.external_ref.slice(0, 8).toUpperCase(),
        data_emissao: o.created_at.slice(0, 10).split("-").reverse().join("/"),
        nome_contratante: o.customers.name,
        cpf_contratante: o.customers.cpf
          .replace(/\D/g, "")
          .replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4"),
        nome_produto: o.products.name,
        valor_total: brl(s.grandTotal),
        numero_parcelas: String(o.installment_count),
        valor_entrada: brl(s.entryValue),
        valor_parcela: brl(s.installments[0]!.value),
        data_primeira_parcela: s.installments[0]!.dueDate.split("-").reverse().join("/"),
        juros_mensal: percent(s.rule.taxaMensal),
      },
    },
  };
}

const brl = (v: number | string) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));
function percent(v: number | string): string {
  const n = Math.round(Number(v) * 10000) / 100;
  return `${
    n
      .toFixed(2)
      .replace(/\.?0+$/, "")
      .replace(".", ",") || n.toString()
  }% a.m.`;
}
export type ContratoBoletoAceito = NonNullable<ReturnType<typeof lerContratoBoletoAceito>>;
