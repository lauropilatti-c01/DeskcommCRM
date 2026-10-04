/**
 * (C01, -c01.3) AS TRAVAS DE ENVIO NOVAS, LIGADAS POR ORGANIZAÇÃO.
 *
 * Cada trava nova da cadeia `before_send` nasce DESLIGADA e se liga em
 * `organizations.settings.travas_de_envio`, uma chave por trava:
 *
 *   { "travas_de_envio": {
 *       "texto_longo":    { "ligada": true },
 *       "link_permitido": { "ligada": true, "dominios": ["c01.com.br"] } } }
 *
 * O turno do agente lê a configuração UMA vez e arma, no `send_message` (o único
 * corpo escrito pelo modelo), as travas ligadas — com o que cada uma precisa saber do
 * turno (`TravasArmadas`). Quem não arma (follow-up determinístico, template, aviso de
 * código, prévia) passa sem elas: veto ali não teria modelo para ensinar.
 *
 * JSON inválido ou leitura que falha = tudo desligado, com `leituraFalhou` para quem
 * chama registrar: a trava é proteção extra, e não pode calar o agente.
 */
import { z } from 'zod';

import type { Queryable } from '../queue/queue';
import { normalizarDominio, type LinkPermitidoArmado } from './link-permitido';

const travaSimples = z.object({ ligada: z.boolean() }).passthrough();

const travasDeEnvioSchema = z
  .object({
    texto_longo: travaSimples.optional(),
    // `dominios`: os domínios cujo link sai sempre (o domínio e os subdomínios dele).
    link_permitido: travaSimples.extend({ dominios: z.array(z.string()).optional() }).optional(),
  })
  .passthrough();

/** O que a organização ligou. */
export interface TravasDeEnvioDaOrg {
  textoLongo: boolean;
  linkPermitido: boolean;
  /** Os domínios liberados da trava de link, já normalizados (`c01.com.br`). */
  dominiosLiberados: readonly string[];
}

export const TRAVAS_DESLIGADAS: Readonly<TravasDeEnvioDaOrg> = {
  textoLongo: false,
  linkPermitido: false,
  dominiosLiberados: [],
};

/**
 * O que o turno arma em cada tentativa de envio — vai ao `GateContext.travasDeEnvio`.
 * Chave ausente = trava desarmada.
 */
export interface TravasArmadas {
  /**
   * Texto longo: o teto de caracteres por bolha do divisor (`split_max_chars`) e
   * quantas mensagens físicas ainda cabem no turno. Só se arma com o divisor ligado.
   */
  textoLongo?: { maxChars: number; restantes: number };
  /** Link permitido: os links e os domínios liberados neste momento do turno. */
  linkPermitido?: LinkPermitidoArmado;
}

/** Pura: o valor de `settings.travas_de_envio` (qualquer coisa) → o que está ligado. */
export function interpretarTravasDeEnvio(valor: unknown): {
  travas: TravasDeEnvioDaOrg;
  invalida: boolean;
} {
  if (valor === null || valor === undefined) return { travas: { ...TRAVAS_DESLIGADAS }, invalida: false };
  const lido = travasDeEnvioSchema.safeParse(valor);
  if (!lido.success) return { travas: { ...TRAVAS_DESLIGADAS }, invalida: true };
  return {
    travas: {
      textoLongo: lido.data.texto_longo?.ligada ?? false,
      linkPermitido: lido.data.link_permitido?.ligada ?? false,
      dominiosLiberados: (lido.data.link_permitido?.dominios ?? [])
        .map(normalizarDominio)
        .filter((d) => d.length > 0),
    },
    invalida: false,
  };
}

/** Lê as travas da organização; falha ou JSON inválido = tudo desligado, com o aviso. */
export async function lerTravasDeEnvioDaOrg(
  db: Queryable,
  organizationId: string,
): Promise<{ travas: TravasDeEnvioDaOrg; leituraFalhou: boolean }> {
  try {
    const { rows } = await db.query<{ travas: unknown }>(
      `select settings->'travas_de_envio' as travas from organizations where id = $1`,
      [organizationId],
    );
    const { travas, invalida } = interpretarTravasDeEnvio(rows[0]?.travas ?? null);
    return { travas, leituraFalhou: invalida };
  } catch {
    return { travas: { ...TRAVAS_DESLIGADAS }, leituraFalhou: true };
  }
}
