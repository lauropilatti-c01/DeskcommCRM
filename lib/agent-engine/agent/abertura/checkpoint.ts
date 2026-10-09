/**
 * Recorte 1 do #636 — o checkpoint do turno, fora do arquivo do turno.
 *
 * Saiu de `inbound-turn.ts` byte a byte (a única linha nova é o `export` de
 * `insertCheckpoint`, que era privado lá): mesmas strings, mesmo Zod, mesma
 * instrução de fechamento — portanto mesmo comportamento.
 *
 * O que mora aqui é o DADO do checkpoint: o schema que o Zod valida na chamada
 * de fechamento, a ROW do `lead_checkpoints`, a instrução fixa (com o
 * `rolling_summary` que ela pede), a gravação e o parse. O fechamento EM SI — a
 * chamada de modelo, o veto e a emissão da atividade — continua em
 * `inbound-turn.ts`: este recorte não toca no laço.
 *
 * `inbound-turn.ts` reexporta estes símbolos, e é por lá que os testes e os
 * irmãos (follow-up, resposta de caso, retomada) continuam os buscando.
 */

import { z } from "zod";

import { JobLeasePerdidoError } from "@/lib/atendimento/fronteira";
import {
  currentExecutionBoundary,
  currentExecutionJob,
  guardServiceEffect,
} from "@/lib/atendimento/fronteira-server";

import { claimOfJob } from "../../queue/claim";
import type { Queryable } from "../../queue/queue";
import {
  DECLARACAO_INSTRUCTION,
  declaracaoDoTurnoSchema,
  type DeclaracaoDoTurno,
} from "../declaracao";

/** Conteúdo do checkpoint — o modelo devolve, o Zod valida, o Postgres guarda. */
export const checkpointContentSchema = z.object({
  commitments: z.array(z.string()).default([]),
  objections: z.array(z.string()).default([]),
  next_action: z.string().nullable().default(null),
  rolling_summary: z.string().default(''),
  /**
   * A declaração do turno (spec 16 §5) — a fronteira entre FALAR e OPERAR.
   *
   * `.optional()` SEM default, e a diferença importa: `undefined` significa que o
   * modelo não declarou nada (fechamento incompleto — turno a investigar), e é
   * estado distinto de `{nada_a_declarar: true}`, que é uma avaliação registrada.
   * Um `.default({})` aqui apagaria essa distinção e faria "o modelo esqueceu"
   * parecer "não havia nada" — ver o cabeçalho de `declaracao.ts`.
   *
   * Opcional também é o que mantém a retrocompatibilidade: checkpoint gravado
   * antes desta versão, e clone self-host cujo modelo ainda não conhece o campo,
   * seguem validando.
   */
  declaracao: declaracaoDoTurnoSchema.optional(),
});
export type CheckpointContent = z.infer<typeof checkpointContentSchema>;

/**
 * A ROW como o Postgres a devolve. `declaracao` é `Omit`-ada e redeclarada porque
 * o "não sei" tem representação DIFERENTE nas duas pontas: o modelo omite o campo
 * (`undefined`), o banco guarda `null`. Herdar o `?:` do schema faria o tipo
 * prometer `undefined` onde `select *` entrega `null` — e o `=== undefined` de
 * quem lesse a row seria falso justamente no caso que ele quer pegar.
 */
export interface LeadCheckpointRow extends Omit<CheckpointContent, 'declaracao'> {
  id: string;
  seq: string;
  organization_id: string;
  contact_id: string;
  job_id: string | null;
  created_at: Date;
  declaracao: DeclaracaoDoTurno | null;
}

/**
 * Instrução FIXA do fechamento — o runtime a impõe; o teste a usa como marcador.
 *
 * A declaração (spec 16 §5) viaja AQUI, na chamada que já acontece, e não numa
 * tool: uma `declarar_intencao` dependeria de o modelo lembrar de chamá-la, e o
 * turno em que ele esquecesse seria um lead parado em silêncio. É o mesmo
 * argumento que este arquivo já usa para o checkpoint — e sai de graça, porque
 * é a mesma chamada de modelo.
 */
export const CHECKPOINT_INSTRUCTION =
  'Feche o turno AGORA. Responda SOMENTE com um JSON válido no formato ' +
  '{"commitments": string[], "objections": string[], "next_action": string|null, "rolling_summary": string} ' +
  '— compromissos assumidos, objeções do lead, próxima ação e o resumo acumulado ' +
  'da conversa até aqui (inclua o que o resumo anterior já dizia). ' +
  // ⚠️ O REFERENCIAL DE `next_action`, e ele não é zelo de redação.
  //
  // Este JSON é escrito no FECHO do turno: a pergunta já saiu, a resposta ainda
  // não chegou. Sem dizer QUANDO, "próxima ação" é ambígua entre "o que acabei
  // de fazer" e "o que farei depois" — e o modelo gravava a primeira. No turno
  // seguinte o texto volta como o PRIMEIRO bloco do prompt, acima do histórico,
  // e manda repetir a pergunta que o histórico logo abaixo já responde. Medido
  // numa conversa real: o agente pediu o e-mail QUATRO vezes, com o cliente
  // respondendo três. (issue #510)
  //
  // A negação explícita está aqui porque dizer o que É não basta quando o erro
  // tem um atrator forte: a pergunta recém-feita é o texto mais fresco no
  // contexto do modelo.
  'Em `next_action`, escreva a ação que vem DEPOIS da resposta que você está ' +
  'esperando — nunca a pergunta que você acabou de fazer. Se o turno terminou ' +
  'perguntando, a próxima ação é o que fazer COM a resposta quando ela chegar. ' +
  DECLARACAO_INSTRUCTION +
  ' Sem texto fora do JSON.';

export async function insertCheckpoint(
  db: Queryable,
  input: { tenantId: string; leadId: string; jobId: string; content: CheckpointContent },
): Promise<void> {
  await guardServiceEffect();
  const boundary = currentExecutionBoundary();
  const valores = [
    input.tenantId,
    input.leadId,
    input.jobId,
    JSON.stringify(input.content.commitments),
    JSON.stringify(input.content.objections),
    input.content.next_action,
    input.content.rolling_summary,
    // NULL (não `'{}'`) quando o modelo não declarou: a coluna preserva a
    // distinção "não declarou" × "declarou que não havia nada" que o schema
    // sustenta em memória. Gravar um objeto vazio aqui jogaria fora, no
    // Postgres, a informação que o Zod tomou o cuidado de manter.
    input.content.declaracao === undefined ? null : JSON.stringify(input.content.declaracao),
    boundary?.conversation_id ?? null,
    boundary?.service_revision ?? null,
    boundary?.demanda_id ?? null,
    boundary?.demanda_revision ?? null,
  ];
  // (C01) O checkpoint é a memória que o próximo turno lê primeiro: gravado por
  // uma execução substituída, ele vira o "mais recente" e apaga o da execução
  // que de fato respondeu. O `guardServiceEffect` acima já confere o lease, mas
  // conferir e gravar são dois passos — aqui a posse entra no MESMO statement
  // (o predicado do `completeJob`), e sem ela nenhuma linha nasce.
  const job = currentExecutionJob();
  const claim = job !== null && job.id === input.jobId ? claimOfJob(job) : undefined;
  if (claim === undefined) {
    await db.query(
      `insert into lead_checkpoints (organization_id, contact_id, job_id, commitments, objections, next_action, rolling_summary, declaracao, conversation_id, service_revision, demanda_id, demanda_revision)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      valores,
    );
    return;
  }
  // Os casts são obrigatórios: em `insert … select`, parâmetro sem tipo vira
  // text, e text não entra em uuid/jsonb/bigint por atribuição.
  const gravado = await db.query(
    `insert into lead_checkpoints (organization_id, contact_id, job_id, commitments, objections, next_action, rolling_summary, declaracao, conversation_id, service_revision, demanda_id, demanda_revision)
     select $1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::jsonb, $6::text, $7::text, $8::jsonb, $9::uuid, $10::bigint, $11::uuid, $12::bigint
      where exists (
        select 1 from job_queue
         where id = $13 and status = 'running' and locked_by = $14 and locked_at = $15::timestamptz
      )`,
    [...valores, input.jobId, claim.worker_id, claim.acquired_at],
  );
  if (gravado.rowCount !== 1) throw new JobLeasePerdidoError(input.jobId);
}

/**
 * (C01) O fechamento respondeu, mas sem um checkpoint utilizável: sem JSON, JSON
 * inválido ou shape inválido. Classe própria para `conteudoDoFechamento` separar
 * esta falha da chamada que LANÇA (provedor, prazo, lease, fronteira), que segue o
 * caminho de sempre. As mensagens são as de antes: o `last_error` da fila e os
 * logs continuam dizendo o mesmo.
 */
export class FechamentoSemCheckpointError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'FechamentoSemCheckpointError';
  }
}

/**
 * Extrai e valida o JSON do fechamento. Tolerante a cerca de código e prosa em
 * volta (pega do primeiro '{' ao último '}'); inválido → erro SEM o texto do
 * modelo na mensagem (pode carregar PII da conversa) — o job re-tenta.
 */
export function parseCheckpointText(text: string): CheckpointContent {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new FechamentoSemCheckpointError(
      'fechamento do turno sem JSON de checkpoint — run re-tentado pela fila',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new FechamentoSemCheckpointError(
      'JSON de checkpoint inválido no fechamento do turno — run re-tentado pela fila',
    );
  }
  const parsed = checkpointContentSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.code}`)
      .join('; ');
    throw new FechamentoSemCheckpointError(
      `checkpoint do fechamento com shape inválido (${issues}) — run re-tentado pela fila`,
    );
  }
  return parsed.data;
}

/**
 * (C01) O FECHAMENTO DO TURNO QUE JÁ FALOU COM O LEAD NUNCA DEVOLVE O TURNO À FILA.
 *
 * O erro de `parseCheckpointText` devolvia o job inteiro à fila DEPOIS de as
 * mensagens terem saído; a nova tentativa refazia o turno do zero e o lead recebia
 * outra mensagem, com outras palavras (o recibo do `send_ledger` só barra conteúdo
 * igual). Medido no laboratório da C01 (rodada geral-1, 07/10/2026): 7 de 116
 * fechamentos (~6%) pararam sem o JSON — o modelo escreveu uma mensagem ao lead ou
 * devolveu texto vazio — e os 7 turnos mandaram uma mensagem a mais.
 *
 * Com resposta ao lead neste job: UMA nova chamada de fechamento, igual à primeira;
 * sem JSON de novo, o checkpoint MÍNIMO e o turno conclui. O mínimo é o do turno
 * anterior (compromissos, objeções e resumo, o que validar) com a pendência DESTE
 * turno, que ninguém registrou: o que a resposta prometeu ("te chamo amanhã às
 * 10h") se perdeu com o fechamento. Por isso a declaração não fica ausente — com
 * ela nula, `promessasEmAberto` dá zero e a apuração de responsável do Operador
 * nem roda — e leva UMA promessa sintética (`PROMESSA_DO_FECHAMENTO_FALHO`), que
 * faz o Operador apurar. A `next_action` do anterior não volta (já foi cumprida
 * por este, e repeti-la no topo do próximo prompt é o defeito do #510): no lugar
 * dela, retomar pela última resposta (`PROXIMA_ACAO_DO_FECHAMENTO_FALHO`). O aviso
 * na Central abre sempre que o mínimo é gravado (`inbound-turn.ts`).
 *
 * Sem resposta ao lead, nada muda: o erro sobe na primeira chamada e a fila refaz o
 * turno, que ainda não falou. Só a falha do PARSE entra aqui; a chamada que lança
 * sobe como antes, na primeira e na nova tentativa.
 */
export async function conteudoDoFechamento<T>(opcoes: {
  /** A chamada de fechamento: o texto do modelo (já tratado) e o resultado dela. */
  fechar: () => Promise<{ texto: string; chamada: T }>;
  /** O lead já recebeu (ou vai receber) mensagem deste job: refazer o turno mandaria outra. */
  leadTemResposta: boolean;
  /** O checkpoint do turno anterior; lido só se o mínimo for preciso. */
  anterior: () => Promise<unknown>;
}): Promise<{ content: CheckpointContent; chamada: T; minimo: boolean }> {
  const primeira = await opcoes.fechar();
  try {
    return { content: parseCheckpointText(primeira.texto), chamada: primeira.chamada, minimo: false };
  } catch (err) {
    if (!opcoes.leadTemResposta || !(err instanceof FechamentoSemCheckpointError)) throw err;
  }
  const segunda = await opcoes.fechar();
  try {
    return { content: parseCheckpointText(segunda.texto), chamada: segunda.chamada, minimo: false };
  } catch (err) {
    if (!(err instanceof FechamentoSemCheckpointError)) throw err;
  }
  return { content: checkpointMinimo(await opcoes.anterior()), chamada: segunda.chamada, minimo: true };
}

/**
 * (C01) A promessa sintética do checkpoint mínimo. Não diz o que foi prometido —
 * ninguém sabe, o fechamento falhou —, diz onde conferir. Vai ao briefing do
 * Operador e ao da passagem para pessoa; o Conversador não a lê.
 */
export const PROMESSA_DO_FECHAMENTO_FALHO =
  '(C01) o fechamento do turno falhou depois da resposta ao lead: conferir na conversa se ela prometeu retorno, horário ou verificação';

/**
 * (C01) A próxima ação do checkpoint mínimo. Vai ao prompt do próximo Conversador
 * (blocos "Checkpoint anterior" e "Estado do funil", `ritual.ts`) e à retomada da
 * escalação, que a copia: por isso fala só da conversa, sem nada interno (nem
 * equipe, nem falha, nem marca nossa) que ele possa repetir ao lead. Quem cuida da
 * falha é o aviso na Central.
 */
export const PROXIMA_ACAO_DO_FECHAMENTO_FALHO =
  'Retomar pela última resposta enviada e cumprir o que ela combinou com a pessoa (retorno, horário ou verificação).';

/** (C01) O checkpoint mínimo herdado do anterior: cada campo só se validar. */
function checkpointMinimo(anterior: unknown): CheckpointContent {
  const a = (anterior ?? {}) as Record<string, unknown>;
  const lista = (valor: unknown): string[] => {
    const lido = z.array(z.string()).safeParse(valor);
    return lido.success ? lido.data : [];
  };
  return {
    commitments: lista(a.commitments),
    objections: lista(a.objections),
    next_action: PROXIMA_ACAO_DO_FECHAMENTO_FALHO,
    rolling_summary: typeof a.rolling_summary === 'string' ? a.rolling_summary : '',
    declaracao: {
      intencoes: [],
      promessas: [{ o_que: PROMESSA_DO_FECHAMENTO_FALHO, prazo: null }],
      nada_a_declarar: false,
    },
  };
}
