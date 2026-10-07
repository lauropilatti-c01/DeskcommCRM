/**
 * (C01, -c01.3) AS TRAVAS DE ENVIO NOVAS, LIGADAS POR ORGANIZAÇÃO.
 *
 * Cada trava nova da cadeia `before_send` nasce DESLIGADA e se liga em
 * `organizations.settings.travas_de_envio`, uma chave por trava:
 *
 *   { "travas_de_envio": {
 *       "texto_longo":       { "ligada": true },
 *       "link_permitido":    { "ligada": true, "dominios": ["exemplo.com.br"] },
 *       "valor_em_dinheiro": { "ligada": true },
 *       "uma_pergunta":      { "ligada": true } } }
 *
 * O turno do agente lê a configuração UMA vez e arma, no `send_message` (o único
 * corpo escrito pelo modelo), as travas ligadas — com o que cada uma precisa saber do
 * turno (`TravasArmadas`). Quem não arma (follow-up determinístico, template, aviso de
 * código, prévia) passa sem elas: veto ali não teria modelo para ensinar.
 *
 * JSON inválido ou leitura que falha = tudo desligado, com `leituraFalhou` para quem
 * chama registrar: a trava é proteção extra, e não pode calar o agente.
 *
 * (C01, -c01.7) A trava `link_e_valor_de_ferramenta` é a exceção na forma de ligar: o
 * interruptor fica na tela ("Confere antes de enviar"), numa linha de
 * `org_guardrail_layers` (`INTERRUPTOR_DA_TRAVA`), porque na produção quem liga é o
 * dono, e a rota `/api/v1/ai/send-guards` o devolve para conferir. Aqui, no JSON, fica
 * só a lista de URLs que saem sempre:
 *
 *   { "travas_de_envio": { "link_e_valor_de_ferramenta": { "urls": ["https://exemplo.com.br/pagina"] } } }
 *
 * O interruptor ligado vale mesmo com o JSON inválido (a trava arma sem as URLs fixas,
 * mais estrita): para link e dinheiro, segurar é melhor que soltar.
 *
 * (C01, -c01.7) A `valor_em_dinheiro` ganhou o mesmo interruptor na tela (na produção
 * ninguém a ligava sem SQL). A linha de `org_guardrail_layers`, se existe, manda — inclusive
 * para desligar e inclusive com o JSON inválido; sem linha, vale o `ligada` do JSON, como
 * antes. As chaves e a lista ficam em `interruptores-de-trava.ts`.
 */
import { z } from 'zod';

import type { Queryable } from '../queue/queue';
import { chaveDoInterruptor } from './interruptores-de-trava';
import { INTERRUPTOR_DA_TRAVA, type LinkEValorArmado } from './link-e-valor-de-ferramenta';
import { normalizarDominio, normalizarLink, type LinkPermitidoArmado } from './link-permitido';

const travaSimples = z.object({ ligada: z.boolean() }).passthrough();

const travasDeEnvioSchema = z
  .object({
    texto_longo: travaSimples.optional(),
    // `dominios`: os domínios cujo link sai sempre (o domínio e os subdomínios dele).
    link_permitido: travaSimples.extend({ dominios: z.array(z.string()).optional() }).optional(),
    valor_em_dinheiro: travaSimples.optional(),
    uma_pergunta: travaSimples.optional(),
    // (C01, -c01.7) Só as URLs fixas: o interruptor fica em `org_guardrail_layers`.
    link_e_valor_de_ferramenta: z.object({ urls: z.array(z.string()).optional() }).passthrough().optional(),
  })
  .passthrough();

/** O que a organização ligou. */
export interface TravasDeEnvioDaOrg {
  textoLongo: boolean;
  linkPermitido: boolean;
  /** Os domínios liberados da trava de link, já normalizados (`exemplo.com.br`). */
  dominiosLiberados: readonly string[];
  valorEmDinheiro: boolean;
  umaPergunta: boolean;
  /** (C01, -c01.7) Link e valor de ferramenta: o interruptor da tela. */
  linkEValorDeFerramenta: boolean;
  /** As URLs que saem sempre com a trava de link e valor, já normalizadas. */
  urlsFixas: readonly string[];
}

export const TRAVAS_DESLIGADAS: Readonly<TravasDeEnvioDaOrg> = {
  textoLongo: false,
  linkPermitido: false,
  dominiosLiberados: [],
  valorEmDinheiro: false,
  umaPergunta: false,
  linkEValorDeFerramenta: false,
  urlsFixas: [],
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
  /** Valor em dinheiro: só liga ou desliga; não depende do turno. */
  valorEmDinheiro?: true;
  /** Uma pergunta por mensagem: só liga ou desliga (some no turno ao chegar no limite de vetos). */
  umaPergunta?: true;
  /** (C01, -c01.7) Link e valor de ferramenta: os links e os valores liberados neste momento do turno. */
  linkEValorDeFerramenta?: LinkEValorArmado;
}

/**
 * Os interruptores da tela, como saíram de `org_guardrail_layers`: `null` (ou ausente) =
 * sem linha (a organização não escolheu pela tela).
 */
export interface InterruptoresDaTela {
  linkEValorDeFerramenta?: boolean | null;
  valorEmDinheiro?: boolean | null;
}

/**
 * Pura: o valor de `settings.travas_de_envio` (qualquer coisa) e os interruptores da
 * tela → o que está ligado. O interruptor vale mesmo com o JSON inválido; o da
 * `valor_em_dinheiro`, quando existe, passa por cima do JSON (ver o cabeçalho).
 */
export function interpretarTravasDeEnvio(
  valor: unknown,
  interruptores: InterruptoresDaTela = {},
): {
  travas: TravasDeEnvioDaOrg;
  invalida: boolean;
} {
  const linkEValorDeFerramenta = interruptores.linkEValorDeFerramenta === true;
  const valorEmDinheiroDaTela = interruptores.valorEmDinheiro ?? null;
  const soATela = { linkEValorDeFerramenta, valorEmDinheiro: valorEmDinheiroDaTela === true };
  if (valor === null || valor === undefined) return { travas: { ...TRAVAS_DESLIGADAS, ...soATela }, invalida: false };
  const lido = travasDeEnvioSchema.safeParse(valor);
  if (!lido.success) return { travas: { ...TRAVAS_DESLIGADAS, ...soATela }, invalida: true };
  return {
    travas: {
      textoLongo: lido.data.texto_longo?.ligada ?? false,
      linkPermitido: lido.data.link_permitido?.ligada ?? false,
      dominiosLiberados: (lido.data.link_permitido?.dominios ?? [])
        .map(normalizarDominio)
        .filter((d) => d.length > 0),
      valorEmDinheiro: valorEmDinheiroDaTela ?? lido.data.valor_em_dinheiro?.ligada ?? false,
      umaPergunta: lido.data.uma_pergunta?.ligada ?? false,
      linkEValorDeFerramenta,
      urlsFixas: (lido.data.link_e_valor_de_ferramenta?.urls ?? [])
        .map((u) => normalizarLink(u.trim()))
        .filter((u) => u.length > 0),
    },
    invalida: false,
  };
}

/**
 * Lê as travas da organização; falha ou JSON inválido = tudo desligado, com o aviso.
 * (C01, -c01.7) Na mesma consulta, os interruptores da tela (as chaves são constantes
 * do código, não entrada de ninguém).
 */
export async function lerTravasDeEnvioDaOrg(
  db: Queryable,
  organizationId: string,
): Promise<{ travas: TravasDeEnvioDaOrg; leituraFalhou: boolean }> {
  try {
    const { rows } = await db.query<{
      travas: unknown;
      link_e_valor?: boolean | null;
      valor_em_dinheiro?: boolean | null;
    }>(
      `select settings->'travas_de_envio' as travas,
              (select l.enabled from org_guardrail_layers l
                where l.organization_id = organizations.id
                  and l.layer = '${INTERRUPTOR_DA_TRAVA}') as link_e_valor,
              (select l.enabled from org_guardrail_layers l
                where l.organization_id = organizations.id
                  and l.layer = '${chaveDoInterruptor('valor_em_dinheiro')}') as valor_em_dinheiro
         from organizations where id = $1`,
      [organizationId],
    );
    const { travas, invalida } = interpretarTravasDeEnvio(rows[0]?.travas ?? null, {
      linkEValorDeFerramenta: rows[0]?.link_e_valor ?? null,
      valorEmDinheiro: rows[0]?.valor_em_dinheiro ?? null,
    });
    return { travas, leituraFalhou: invalida };
  } catch {
    return { travas: { ...TRAVAS_DESLIGADAS }, leituraFalhou: true };
  }
}
