/**
 * C01: o valor do filtro é conferido pelo tipo da coluna ANTES de ir ao banco.
 *
 * O `eq` vai ao Postgres com o valor cru (`"col" = $1`). Numa coluna `boolean`,
 * o modelo manda o que o cliente disse ("Não", "sim"), o Postgres recusa
 * (`22P02`) e o erro chegava ao modelo como "não foi possível consultar o banco
 * externo agora" — o mesmo do banco fora do ar. O agente concluía que a base
 * estava indisponível e seguia sem o dado.
 *
 * Aqui: na coluna `boolean`, sim/s/verdadeiro/true/1 viram `true` e
 * não/nao/n/falso/false/0 viram `false` (sem diferença de acento ou maiúscula);
 * nas colunas de número e de uuid, o valor que não é do tipo volta como
 * `valor_invalido`, com o que a coluna espera. Os outros tipos (data, hora,
 * texto…) vão como vieram; o erro de tipo que o banco devolver vira
 * `valor_invalido` pelo código (`erroDeValorDoBanco`).
 *
 * `contem` e `comeca_com` comparam o texto da coluna (`cast(... as text)`) e
 * `nulo`/`nao_nulo` não levam valor: ficam de fora.
 */
import type { FiltroDeLeitura } from "./types";

const TIPOS_INTEIROS = new Set(["smallint", "integer", "bigint"]);
const TIPOS_DECIMAIS = new Set(["numeric", "decimal", "real", "double precision", "money"]);

const VERDADEIROS = new Set(["sim", "s", "verdadeiro", "true", "1"]);
const FALSOS = new Set(["nao", "n", "falso", "false", "0"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEIRO = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+([.,]\d+)?|[.,]\d+)$/;
/**
 * Milhar com ponto, como se escreve no Brasil ("1.500", "12.000"): o decimal acima o
 * leria como 1,5 e 12. Ambíguo, então volta `valor_invalido` pedindo o número sem ponto.
 */
const MILHAR_COM_PONTO = /^[+-]?\d{1,3}(\.\d{3})+$/;

/** Quanto do valor recusado volta ao modelo (o suficiente para ele reconhecer o que mandou). */
const MAX_ECO = 60;

type Conversao = { ok: true; valor: unknown } | { ok: false; espera: string };

function semAcento(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function paraBooleano(valor: unknown): Conversao {
  if (typeof valor === "boolean") return { ok: true, valor };
  if (typeof valor === "number" && (valor === 0 || valor === 1)) return { ok: true, valor: valor === 1 };
  if (typeof valor === "string") {
    const termo = semAcento(valor.trim().toLowerCase());
    if (VERDADEIROS.has(termo)) return { ok: true, valor: true };
    if (FALSOS.has(termo)) return { ok: true, valor: false };
  }
  return { ok: false, espera: "verdadeiro/falso" };
}

function paraNumero(valor: unknown, inteiro: boolean): Conversao {
  const espera = inteiro ? "número inteiro" : "número";
  if (typeof valor === "number") {
    return Number.isFinite(valor) && (!inteiro || Number.isInteger(valor)) ? { ok: true, valor } : { ok: false, espera };
  }
  if (typeof valor === "string") {
    const termo = valor.trim();
    if (MILHAR_COM_PONTO.test(termo)) return { ok: false, espera: `${espera} sem ponto de milhar (1500, não 1.500)` };
    if (inteiro ? INTEIRO.test(termo) : DECIMAL.test(termo)) {
      // String vai como string (o Postgres converte "12.5" sem perder precisão); só a vírgula decimal vira ponto.
      return { ok: true, valor: termo.replace(",", ".") };
    }
  }
  return { ok: false, espera };
}

function paraUuid(valor: unknown): Conversao {
  if (typeof valor === "string" && UUID.test(valor.trim())) return { ok: true, valor: valor.trim() };
  return { ok: false, espera: "um identificador (uuid)" };
}

function converterUm(tipo: string, valor: unknown): Conversao {
  if (valor === null || valor === undefined) return { ok: true, valor };
  if (tipo === "boolean") return paraBooleano(valor);
  if (TIPOS_INTEIROS.has(tipo)) return paraNumero(valor, true);
  if (TIPOS_DECIMAIS.has(tipo)) return paraNumero(valor, false);
  if (tipo === "uuid") return paraUuid(valor);
  return { ok: true, valor };
}

function eco(valor: unknown): string {
  const texto = typeof valor === "string" ? valor : JSON.stringify(valor) ?? String(valor);
  return texto.length > MAX_ECO ? `${texto.slice(0, MAX_ECO)}…` : texto;
}

export type ValoresDosFiltros =
  | { ok: true; filtros: FiltroDeLeitura[] }
  | { ok: false; mensagem: string };

/**
 * Converte o valor de cada filtro pelo tipo da coluna. Sem `tipos` (catálogo sem o
 * tipo), os filtros voltam como vieram. O primeiro valor que não converte devolve a
 * mensagem para o modelo: a coluna, o que ela espera e o que veio.
 */
export function converterValoresDosFiltros(
  filtros: readonly FiltroDeLeitura[],
  tipos: ReadonlyMap<string, string> | undefined,
): ValoresDosFiltros {
  if (!tipos) return { ok: true, filtros: [...filtros] };
  const saida: FiltroDeLeitura[] = [];
  for (const filtro of filtros) {
    const tipo = tipos.get(filtro.coluna);
    const comValor = filtro.operador !== "contem" && filtro.operador !== "comeca_com" && "valor" in filtro;
    if (!tipo || !comValor || filtro.operador === "nulo" || filtro.operador === "nao_nulo") {
      saida.push(filtro);
      continue;
    }
    const valores = Array.isArray(filtro.valor) ? filtro.valor : [filtro.valor];
    const convertidos: unknown[] = [];
    for (const valor of valores) {
      const c = converterUm(tipo, valor);
      if (!c.ok) {
        return {
          ok: false,
          mensagem:
            `${filtro.coluna} é ${c.espera}; veio '${eco(valor)}'. A consulta não foi feita: ` +
            "repita com o valor no formato da coluna (ou, se o cliente não disse, pergunte antes).",
        };
      }
      convertidos.push(c.valor);
    }
    saida.push({ ...filtro, valor: Array.isArray(filtro.valor) ? convertidos : convertidos[0] });
  }
  return { ok: true, filtros: saida };
}

/**
 * O erro que o banco devolveu é de VALOR (o pedido, não o banco)? Classe 22 do
 * Postgres (data exception: `22P02` texto que não converte, `22007` data
 * inválida, `22003` número fora da faixa…) e `42883` (não há operador para esses
 * tipos). O resto (conexão, tempo esgotado, permissão) é o banco indisponível.
 */
export function erroDeValorDoBanco(err: unknown): boolean {
  const codigo = (err as { code?: unknown } | null)?.code;
  if (typeof codigo !== "string") return false;
  return codigo.startsWith("22") || codigo === "42883";
}

export const MENSAGEM_VALOR_INVALIDO_DO_BANCO =
  "o banco recusou o valor de um filtro: ele não combina com o tipo da coluna (ex.: texto numa coluna de " +
  "número, data ou verdadeiro/falso). A consulta não foi feita. Confira o tipo com crm_describe_external_data " +
  "e repita com o valor no formato da coluna.";

export const MENSAGEM_INDISPONIVEL =
  "banco externo indisponível agora; tente de novo uma vez. Sem o dado, não o invente.";
