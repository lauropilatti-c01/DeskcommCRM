import { createHash } from "node:crypto";

/** Dados exclusivamente fictícios; reproduz o contrato do produtor, não importa o leitor. */
export function contratoFicticio<
  T extends {
    id: string;
    org_id: string;
    total_value: number;
    created_at: string;
    customers: Record<string, unknown>;
    products: Record<string, unknown>;
  },
>(order: T, valores = [110], entrada = 20) {
  const principal = Number(order.total_value);
  const grandTotal = entrada + valores.reduce((a, b) => a + b, 0);
  const customers = Object.assign(order.customers, { name: "Pessoa Fictícia", cpf: "00000000000" });
  const products = Object.assign(order.products, { name: "Produto de teste" });
  const snapshot = {
    schemaVersion: 1,
    computedAt: order.created_at,
    totalValue: principal.toFixed(2),
    entryValue: entrada.toFixed(2),
    financedValue: (principal - entrada).toFixed(2),
    interestAmount: (grandTotal - principal).toFixed(2),
    grandTotal: grandTotal.toFixed(2),
    discountAmount: "0.00",
    couponPercentOff: "0",
    rule: { version: 3, taxaMensal: "0.0399", installmentCount: valores.length },
    installments: valores.map((v, i) => ({
      number: i + 1,
      value: v.toFixed(2),
      dueDate: `2026-11-${String(21 + i).padStart(2, "0")}`,
    })),
  };
  const fingerprint = {
    grandTotal: snapshot.grandTotal,
    entryValue: snapshot.entryValue,
    financedValue: snapshot.financedValue,
    interestAmount: snapshot.interestAmount,
    discountAmount: snapshot.discountAmount,
    couponCode: null,
    couponPercentOff: snapshot.couponPercentOff,
    taxaMensal: snapshot.rule.taxaMensal,
    installmentCount: valores.length,
    installments: snapshot.installments.map((i) => `${i.number}:${i.value}:${i.dueDate}`),
    firstDueDate: snapshot.installments[0]!.dueDate,
    productName: products.name,
    customerName: customers.name,
    customerCpf: customers.cpf,
  };
  const contracts = [
    {
      id: "44444444-4444-4444-8444-444444444444",
      org_id: order.org_id,
      order_id: order.id,
      provider: "clicksign",
      status: "signed",
      external_id: "55555555-5555-4555-8555-555555555555",
      external_envelope_id: "55555555-5555-4555-8555-555555555555",
      external_signer_id: "77777777-7777-4777-8777-777777777777",
      template_used: "clicksign:66666666-6666-4666-8666-666666666666@v1",
      rendered_text_hash: createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
      created_at: "2026-10-19T13:00:00Z",
      signed_at: "2026-10-19T14:00:00Z" as string | null,
      cancelled_at: null,
      remote_cancel_status: null as string | null,
    },
  ];
  return Object.assign(order, {
    external_ref: "ficticio-contrato",
    entry_value: entrada,
    installment_count: valores.length,
    installment_value: valores[0]!,
    discount_applied_at: null as string | null,
    discount_applied_pct: null,
    customers,
    products,
    parcelamento_snapshot: snapshot,
    contracts,
  });
}

export const clicksignFicticio = {
  accountKeySha256: createHash("sha256").update("conta-ficticia").digest("hex"),
  apiToken: "clicksign-ficticio",
};

export function documentoFicticio(order: ReturnType<typeof contratoFicticio>) {
  const s = order.parcelamento_snapshot;
  const brl = (v: string) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));
  return {
    document: {
      key: order.contracts[0]!.external_id,
      account_key: "conta-ficticia",
      status: "closed",
      uploaded_at: "2026-10-19T13:10:00Z",
      finished_at: "2026-10-19T14:00:00Z",
      template: {
        key: "66666666-6666-4666-8666-666666666666",
        data: {
          numero_contrato: "FICTICIO",
          data_emissao: "19/10/2026",
          nome_contratante: "Pessoa Fictícia",
          cpf_contratante: "000.000.000-00",
          nome_produto: "Produto de teste",
          valor_total: brl(s.grandTotal),
          numero_parcelas: String(order.installment_count),
          valor_entrada: brl(s.entryValue),
          valor_parcela: brl(s.installments[0]!.value),
          data_primeira_parcela: s.installments[0]!.dueDate.split("-").reverse().join("/"),
          juros_mensal: "3,99% a.m.",
        },
      },
      downloads: { signed_file_checksum: "a".repeat(64) },
      signers: [
        {
          key: "77777777-7777-4777-8777-777777777777",
          name: "Pessoa Fictícia",
          documentation: "000.000.000-00",
          signature: { name: "Pessoa Fictícia", documentation: "000.000.000-00" },
        },
      ],
    },
  };
}
