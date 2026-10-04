/**
 * (C01, -c01.3, item 1a) PRAZO POR REQUISIÇÃO AO PROVEDOR DE IA.
 *
 * O prazo das chamadas da C54 (`prazoDasChamadas`, lease − 60 s = 540 s) é da
 * EXECUÇÃO inteira: uma requisição que pendura come esse prazo todo antes de cair,
 * e o job só volta à fila depois de nove minutos. Foi a C41 da volta 19-A2: duas
 * chamadas de ~536 s seguidas, tentativas gastas, lead sem resposta.
 *
 * Aqui cada requisição ao modelo — cada etapa do laço de ferramentas é uma — ganha
 * prazo próprio (`LLM_REQUEST_TIMEOUT_MS`, padrão 120 s), somado ao sinal que a
 * requisição já recebe (o do chamador e o da execução, combinados em
 * `runModelCall`). Vencido o prazo, a requisição é abortada e falha com
 * `PrazoDaRequisicaoVencidoError`: o SDK não a repete por conta própria (o nome é
 * de abortamento, ver abaixo), `runModelCall` grava a falha em `llm_calls` e
 * relança, e o job segue o caminho de nova tentativa da fila.
 *
 * Duas travas, e não uma: o sinal vai ao `fetch` do provedor (a conexão é
 * fechada), e a corrida com o relógio garante o prazo mesmo com um provedor que
 * ignore o sinal.
 *
 * Só a REQUISIÇÃO, não a etapa: o `timeout.stepMs` do SDK mediria também a
 * execução das ferramentas da etapa (o envio ao lead, com a pausa humana e a fila
 * do número), e cortá-la no meio é pior que esperar. Só `doGenerate`: o seam chama
 * apenas `generateText`; `doStream` passa intacto.
 */
import type { LanguageModel } from 'ai';

/** Padrão do prazo por requisição, quando o ambiente não diz outro. */
export const PRAZO_POR_REQUISICAO_PADRAO_MS = 120_000;

/**
 * A requisição passou do prazo. O nome `TimeoutError` é um dos que o SDK trata
 * como abortamento (`isAbortError`): ele relança na hora, sem as novas tentativas
 * internas (que somariam mais 2 × 120 s dentro da mesma execução). A mensagem
 * começa com "timeout" para `normalizarErro` a classificar como provedor
 * indisponível, a mesma régua da tela de execuções.
 */
export class PrazoDaRequisicaoVencidoError extends Error {
  override readonly name = 'TimeoutError';
  constructor(readonly prazoMs: number) {
    super(`timeout: a requisição ao provedor de IA passou do prazo de ${prazoMs} ms e foi abortada`);
  }
}

type ChamadaDoModelo = (opcoes: { abortSignal?: AbortSignal } & Record<string, unknown>) => Promise<unknown>;

async function gerarComPrazo(
  doGenerate: ChamadaDoModelo,
  opcoes: { abortSignal?: AbortSignal } & Record<string, unknown>,
  prazoMs: number,
): Promise<unknown> {
  const controle = new AbortController();
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const vencido = new Promise<never>((_, rejeitar) => {
    relogio = setTimeout(() => {
      const erro = new PrazoDaRequisicaoVencidoError(prazoMs);
      controle.abort(erro);
      rejeitar(erro);
    }, prazoMs);
    // Um relógio pendente não segura o processo no desligamento do worker.
    (relogio as { unref?: () => void }).unref?.();
  });
  const sinal =
    opcoes.abortSignal === undefined ? controle.signal : AbortSignal.any([opcoes.abortSignal, controle.signal]);
  try {
    return await Promise.race([doGenerate({ ...opcoes, abortSignal: sinal }), vencido]);
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * O mesmo modelo, com prazo em cada `doGenerate`. Proxy, e não cópia: os modelos
 * dos provedores são instâncias de classe (campos privados, getters), e um objeto
 * espalhado perderia o protótipo. Modelo por nome (string) e prazo inválido voltam
 * intactos.
 */
export function comPrazoPorRequisicao(model: LanguageModel, prazoMs: number): LanguageModel {
  if (typeof model === 'string' || !Number.isFinite(prazoMs) || prazoMs <= 0) return model;
  return new Proxy(model, {
    get(alvo, prop) {
      const valor = Reflect.get(alvo, prop, alvo) as unknown;
      if (prop === 'doGenerate' && typeof valor === 'function') {
        const doGenerate = (valor as ChamadaDoModelo).bind(alvo);
        return (opcoes: { abortSignal?: AbortSignal } & Record<string, unknown>) =>
          gerarComPrazo(doGenerate, opcoes, prazoMs);
      }
      return typeof valor === 'function' ? (valor as (...a: unknown[]) => unknown).bind(alvo) : valor;
    },
  });
}
