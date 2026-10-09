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
 *
 * (C01, -c01.8, CRM-085 da C01) Duas chaves novas, opcionais:
 *
 *   { "travas_de_envio": {
 *       "texto_longo":       { "ligada": true, "max_caracteres": 700 },
 *       "valor_em_dinheiro": { "ligada": true,
 *                              "texto_afirmavel": { "coluna_texto": "texto_para_o_lead",
 *                                                   "coluna_pode_afirmar": "pode_afirmar",
 *                                                   "coluna_assunto": "assunto",
 *                                                   "assuntos": ["salario", "desconto"] } } } }
 *
 * - `texto_longo.max_caracteres`: o limite da mensagem quando o divisor de bolhas está
 *   desligado (uma mensagem por resposta); padrão `MAX_CARACTERES_SEM_DIVISOR`. Com o
 *   divisor ligado, a trava continua contando bolhas.
 * - `valor_em_dinheiro.texto_afirmavel`: as colunas da linha afirmável da base externa e
 *   os assuntos que liberam valor, uma lista de PERMITIDOS (ver `texto-afirmavel.ts`);
 *   cada chave ausente vale o padrão `COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL`.
 */
import { z } from 'zod';

import type { Queryable } from '../queue/queue';
import { chaveDoInterruptor } from './interruptores-de-trava';
import { INTERRUPTOR_DA_TRAVA, type LinkEValorArmado } from './link-e-valor-de-ferramenta';
import { normalizarDominio, normalizarLink, type LinkPermitidoArmado } from './link-permitido';
import { COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL, type ColunasDoTextoAfirmavel } from './texto-afirmavel';

/** (C01, -c01.8) O limite da mensagem sem o divisor de bolhas (CRM-085: até 700 caracteres). */
export const MAX_CARACTERES_SEM_DIVISOR = 700;

const travaSimples = z.object({ ligada: z.boolean() }).passthrough();

const travasDeEnvioSchema = z
  .object({
    // (C01, -c01.8) `max_caracteres`: o limite da mensagem com o divisor desligado.
    texto_longo: travaSimples.extend({ max_caracteres: z.number().int().positive().optional() }).optional(),
    // `dominios`: os domínios cujo link sai sempre (o domínio e os subdomínios dele).
    link_permitido: travaSimples.extend({ dominios: z.array(z.string()).optional() }).optional(),
    // (C01, -c01.8) `texto_afirmavel`: as colunas da linha afirmável da base externa e os
    // assuntos que liberam valor (cada chave ausente = o padrão).
    valor_em_dinheiro: travaSimples
      .extend({
        texto_afirmavel: z
          .object({
            coluna_texto: z.string().min(1).optional(),
            coluna_pode_afirmar: z.string().min(1).optional(),
            coluna_assunto: z.string().min(1).optional(),
            assuntos: z.array(z.string().min(1)).optional(),
          })
          .optional(),
      })
      .optional(),
    uma_pergunta: travaSimples.optional(),
    // (C01, -c01.7) Só as URLs fixas: o interruptor fica em `org_guardrail_layers`.
    link_e_valor_de_ferramenta: z.object({ urls: z.array(z.string()).optional() }).passthrough().optional(),
  })
  .passthrough();

/** O que a organização ligou. */
export interface TravasDeEnvioDaOrg {
  textoLongo: boolean;
  /** (C01, -c01.8) O limite da mensagem quando o divisor de bolhas está desligado. */
  textoLongoMaxCaracteres: number;
  linkPermitido: boolean;
  /** Os domínios liberados da trava de link, já normalizados (`exemplo.com.br`). */
  dominiosLiberados: readonly string[];
  valorEmDinheiro: boolean;
  /** (C01, -c01.8) As colunas da linha afirmável da base externa. */
  colunasDoTextoAfirmavel: ColunasDoTextoAfirmavel;
  umaPergunta: boolean;
  /** (C01, -c01.7) Link e valor de ferramenta: o interruptor da tela. */
  linkEValorDeFerramenta: boolean;
  /** As URLs que saem sempre com a trava de link e valor, já normalizadas. */
  urlsFixas: readonly string[];
}

export const TRAVAS_DESLIGADAS: Readonly<TravasDeEnvioDaOrg> = {
  textoLongo: false,
  textoLongoMaxCaracteres: MAX_CARACTERES_SEM_DIVISOR,
  linkPermitido: false,
  dominiosLiberados: [],
  valorEmDinheiro: false,
  colunasDoTextoAfirmavel: COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL,
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
   * quantas mensagens físicas ainda cabem no turno. (C01, -c01.8) Com o divisor
   * desligado (`semDivisor`), `maxChars` é o limite da mensagem inteira
   * (`texto_longo.max_caracteres`).
   */
  textoLongo?: { maxChars: number; restantes: number; semDivisor?: true };
  /** Link permitido: os links e os domínios liberados neste momento do turno. */
  linkPermitido?: LinkPermitidoArmado;
  /**
   * Valor em dinheiro. `true` = sem texto afirmável; (C01, -c01.8) com
   * `textosAfirmaveis`, os textos afirmáveis que a base externa devolveu neste turno
   * (o trecho exato deles passa).
   */
  valorEmDinheiro?: true | { textosAfirmaveis: readonly string[] };
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

/** (C01, -c01.8) As colunas e os assuntos do texto afirmável: cada chave ausente = o padrão. */
function colunasDoTextoAfirmavel(
  lido: { coluna_texto?: string; coluna_pode_afirmar?: string; coluna_assunto?: string; assuntos?: string[] } | undefined,
): ColunasDoTextoAfirmavel {
  if (lido === undefined) return COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL;
  return {
    texto: lido.coluna_texto ?? COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL.texto,
    podeAfirmar: lido.coluna_pode_afirmar ?? COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL.podeAfirmar,
    assunto: lido.coluna_assunto ?? COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL.assunto,
    assuntos: lido.assuntos ?? COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL.assuntos,
  };
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
      textoLongoMaxCaracteres: lido.data.texto_longo?.max_caracteres ?? MAX_CARACTERES_SEM_DIVISOR,
      linkPermitido: lido.data.link_permitido?.ligada ?? false,
      dominiosLiberados: (lido.data.link_permitido?.dominios ?? [])
        .map(normalizarDominio)
        .filter((d) => d.length > 0),
      valorEmDinheiro: valorEmDinheiroDaTela ?? lido.data.valor_em_dinheiro?.ligada ?? false,
      colunasDoTextoAfirmavel: colunasDoTextoAfirmavel(lido.data.valor_em_dinheiro?.texto_afirmavel),
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
