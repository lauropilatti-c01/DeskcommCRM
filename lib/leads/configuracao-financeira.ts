/** Configuração exclusiva do servidor; ausente/desligada nunca consulta a fonte. */
import { z } from "zod";
import { criarFonteFinanceira } from "./fontes-financeiras";
import type { IntegracaoFinanceira } from "./compra-verificada";
import { asaasSettlementSchema } from "./liquidacao-boleto-asaas";
import { projecaoHistoricaSchema } from "./projecao-historica-financeira";
const schema = z
  .object({
    enabled: z.boolean().default(false),
    integrationId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    organizationId: z.uuid(),
    provider: z.enum(["guru", "boleto"]),
    sourceAccountId: z.string().min(1),
    tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
    receiptSigningKey: z.string().min(32),
    baseUrl: z.url(),
    apiToken: z.string().min(1),
    asaasSettlement: asaasSettlementSchema.optional(),
    historyProjection: projecaoHistoricaSchema.optional(),
    // A ficha prova o início integral da conta; não é a data desta oportunidade.
    // Ausente não afeta confirmação por transação, mas impede negativa sem oferta.
    historyCoverage: z
      .object({
        startedAt: z.iso.datetime(),
        evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    products: z
      .array(
        z
          .object({
            productId: z.string().min(1),
            offerId: z.string().nullable(),
            crmProductKey: z.string().min(1),
            crmOfferKey: z.string().min(1),
            commercialFlowIds: z.array(z.uuid()),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine((c) => !c.asaasSettlement || c.provider === "boleto")
  .refine((c) => !c.historyProjection || c.provider === "guru");
export type ConfiguracaoFinanceira = z.infer<typeof schema>;
export function configuracoesFinanceiras(): ConfiguracaoFinanceira[] {
  const raw = process.env.C01_FINANCIAL_INTEGRATIONS_JSON;
  if (!raw) return [];
  const configs = z.array(schema).parse(JSON.parse(raw));
  if (
    new Set(configs.map((c) => c.integrationId)).size !== configs.length ||
    new Set(configs.map((c) => c.tokenSha256)).size !== configs.length
  )
    throw new Error("financial_configuration_invalid");
  return configs;
}
export function integrarFonte(cfg: ConfiguracaoFinanceira): IntegracaoFinanceira {
  return { ...cfg, readAuthoritativePayment: criarFonteFinanceira(cfg).readPayment };
}
