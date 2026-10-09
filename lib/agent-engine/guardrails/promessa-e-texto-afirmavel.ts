/**
 * (C01, CRM-089 D4) O TEXTO QUE A BASE MANDA DIZER NÃO É VETADO PELA TRAVA DE PROMESSA.
 *
 * A trava semântica de promessa (`promise_semantic`, `promise/semantic.ts`) é um
 * classificador de modelo: ele lê a mensagem e diz se há promessa em texto livre. Na
 * rodada da v0.28 do laboratório (09/10), 7 dos 10 envios vetados por ela eram fatos da
 * base ditos palavra por palavra ("o acesso vale até você passar e não expira", "7 dias
 * de garantia"), e a resposta ao lead virava "ficou com a equipe". A trava de valor em
 * dinheiro já deixava passar o texto afirmável da base; a de promessa, não.
 *
 * A regra: o trecho da mensagem que reproduz um texto afirmável que a base externa
 * devolveu NESTE turno não é vetado; o resto continua passando pelo classificador. O
 * trecho é o de `trechosAprovados` (`texto-afirmavel.ts`), a mesma leitura da trava de
 * dinheiro: a frase inteira igual a uma frase do texto da base, ou o texto da base
 * inteiro dentro de uma frase maior, sem diferença de maiúscula, acento, espaço,
 * formatação do WhatsApp, emoji e pontuação do fim. Paráfrase e frase pela metade não
 * são o texto da base.
 *
 * Como decide (quem chama é o classificador do turno, na carga da cadeia `before_send`):
 *
 * 1. Sem texto afirmável no turno, ou sem trecho dele na mensagem: o classificador lê a
 *    mensagem inteira, como antes.
 * 2. A mensagem é só o texto da base (nada com letra ou número fora dele): passa, sem
 *    gastar o classificador.
 * 3. Senão, o classificador lê a mensagem INTEIRA, com todo o contexto. Sem promessa,
 *    passa. Com promessa, a frase suspeita que ele devolveu é procurada na mensagem: se
 *    alguma ocorrência dela sai do trecho da base, mesmo que só passe da borda ("não
 *    expira nunca"), a mensagem é vetada com ela.
 * 4. A frase suspeita que só aparece dentro do trecho da base, ou que não se acha na
 *    mensagem (nula ou com outras palavras), não decide: o classificador lê de novo só o
 *    RESTO (o texto fora do trecho da base) e o veredito dele vale. Assim a promessa
 *    inventada noutra frase não se esconde atrás do trecho da base que o classificador
 *    apontou primeiro.
 *
 * Diferença de propósito para a trava de dinheiro: aqui vale QUALQUER assunto da linha
 * afirmável (`textosAfirmaveisDaPromessaNoResultado`). A lista de assuntos de lá existe
 * para que o preço marcado por engano não libere valor; os fatos vetados eram de produto
 * e de garantia, que aquela lista deixa de fora de propósito. O valor em dinheiro dentro
 * do texto continua com a trava de dinheiro, com a lista dela. Fica igual o resto do
 * mecanismo: só a base externa, só a consulta sem erro deste turno, só a linha com a
 * coluna do texto e a marca de afirmar estritamente `true`.
 *
 * Limites conhecidos: (a) o resto vai ao classificador como o texto é comparado (sem
 * acento, minúsculo, sem links, valores na forma única), não como o modelo escreveu;
 * (b) no passo 4 o resto é lido sem o texto da base em volta: um acréscimo que só é
 * promessa junto dele ("Na verdade são 30 dias.") passa se, na leitura da mensagem
 * inteira, o classificador apontou o trecho da base; (c) uma frase do texto da base
 * dita dentro de uma frase maior da mensagem (com outra coisa antes ou depois, na mesma
 * frase) só vale se for o texto da base inteiro; senão continua indo inteira ao
 * classificador, como na trava de dinheiro.
 */
import type { Logger } from '../obs/logger';
import type { PromiseClassification } from './promise/semantic';
import {
  COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL,
  type ColunasDoTextoAfirmavel,
  fraseParaComparar,
  textoParaConferir,
  textosAfirmaveisNoResultado,
  trechosAprovados,
} from './texto-afirmavel';

const SEM_PROMESSA: PromiseClassification = { isPromise: false, suspectPhrase: null };

/** Letra ou número de qualquer escrita: o pedaço sem eles (pontuação, espaço) não é texto. */
const TEM_TEXTO = /[\p{L}\p{N}]/u;

/**
 * Os textos afirmáveis de um resultado de consulta que valem para a trava de promessa:
 * as colunas da organização (texto, marca de afirmar), com QUALQUER assunto.
 */
export function textosAfirmaveisDaPromessaNoResultado(
  valor: unknown,
  colunas: Pick<ColunasDoTextoAfirmavel, 'texto' | 'podeAfirmar' | 'assunto'> = COLUNAS_PADRAO_DO_TEXTO_AFIRMAVEL,
  achados: Set<string> = new Set(),
): Set<string> {
  return textosAfirmaveisNoResultado(
    valor,
    { texto: colunas.texto, podeAfirmar: colunas.podeAfirmar, assunto: colunas.assunto, assuntos: null },
    achados,
  );
}

/** O texto de `t` fora dos trechos aprovados, em pedaços com texto, separados por " … ". */
export function restoForaDosTrechos(t: string, aprovados: ReadonlyArray<readonly [number, number]>): string {
  const pedacos: string[] = [];
  let i = 0;
  for (const [a, b] of aprovados) {
    pedacos.push(t.slice(i, a));
    i = b;
  }
  pedacos.push(t.slice(i));
  return pedacos
    .map((p) => p.trim())
    .filter((p) => TEM_TEXTO.test(p))
    .join(' … ');
}

/**
 * Onde está a frase suspeita: `fora` se alguma ocorrência dela não cabe inteira num
 * trecho aprovado; `dentro` se todas cabem; `nao_achada` se ela é nula ou não aparece.
 */
export function ondeEstaASuspeita(
  t: string,
  aprovados: ReadonlyArray<readonly [number, number]>,
  suspeita: string | null,
): 'fora' | 'dentro' | 'nao_achada' {
  if (suspeita === null) return 'nao_achada';
  // Sem aspas nas pontas, que o classificador às vezes devolve junto.
  const frase = fraseParaComparar(textoParaConferir(suspeita).replace(/^[\s"'“”‘’«»]+|[\s"'“”‘’«»]+$/g, ''));
  if (!TEM_TEXTO.test(frase)) return 'nao_achada';
  let achou = false;
  for (let i = t.indexOf(frase); i !== -1; i = t.indexOf(frase, i + 1)) {
    achou = true;
    const fim = i + frase.length;
    if (!aprovados.some(([a, b]) => i >= a && fim <= b)) return 'fora';
  }
  return achou ? 'dentro' : 'nao_achada';
}

/**
 * O veredito da trava semântica de promessa com os textos afirmáveis deste turno.
 * `classificar` é o classificador do turno (uma chamada de modelo por vez). O log leva
 * só contagens, nunca o texto.
 */
export async function classificarPromessaComTextoAfirmavel(
  body: string,
  afirmaveis: readonly string[],
  classificar: (texto: string) => Promise<PromiseClassification>,
  log?: Logger,
): Promise<PromiseClassification> {
  if (afirmaveis.length === 0) return classificar(body);
  const t = textoParaConferir(body);
  const aprovados = trechosAprovados(t, afirmaveis);
  if (aprovados.length === 0) return classificar(body);
  const resto = restoForaDosTrechos(t, aprovados);
  if (resto === '') {
    log?.info('trava de promessa: a mensagem é só o texto afirmável da base — não classificada', {
      event: 'promise_semantic_texto_afirmavel',
      trechos: aprovados.length,
      releu_o_resto: false,
    });
    return SEM_PROMESSA;
  }
  const inteira = await classificar(body);
  if (!inteira.isPromise) return inteira;
  if (ondeEstaASuspeita(t, aprovados, inteira.suspectPhrase) === 'fora') return inteira;
  const doResto = await classificar(resto);
  if (!doResto.isPromise) {
    log?.info('trava de promessa: a promessa apontada estava no texto afirmável da base — o resto passou', {
      event: 'promise_semantic_texto_afirmavel',
      trechos: aprovados.length,
      releu_o_resto: true,
    });
  }
  return doResto;
}
