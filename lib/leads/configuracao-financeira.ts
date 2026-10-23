/** Configuração exclusiva do servidor; ausente/desligada nunca consulta a fonte. */
import { z } from "zod";
import { criarFonteFinanceira } from "./fontes-financeiras";
import type { IntegracaoFinanceira } from "./compra-verificada";
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
  .strict();
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
