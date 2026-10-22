/**
 * (C01, -c01.15) PASSAGEM DESLIGADA: o agente não passa a conversa a uma pessoa.
 *
 * A tela do agente tem o interruptor "ferramenta de passagem" (`handoff_tool_enabled`).
 * No autor ele só tira a ferramenta `request_human_handoff` do modelo; o pedido do
 * cliente por uma pessoa (palavra-chave), os fail-safes das travas e o `passar_a_equipe`
 * do gancho continuavam silenciando a conversa para sempre (`performHumanHandoff`:
 * `force_human`, `bot_silenced_until = 'infinity'`). Na C01 a equipe atende pelos casos
 * (`agent_cases`), não pela conversa: com a IA calada, o cliente ficava sem resposta até
 * alguém devolver o atendimento à mão.
 *
 * Com a passagem desligada (a versão publicada com `handoff_tool_enabled === false`):
 *   - o pedido de uma pessoa abre um caso e a IA segue, dizendo que vai verificar e já
 *     retorna (`BLOCO_DO_PEDIDO_DE_PESSOA_SEM_PASSAGEM`);
 *   - o retorno de `open_human_case` e os blocos de caso e de transparência mandam
 *     "vou verificar e já te retorno" e proíbem "ficou registrado";
 *   - os fail-safes abrem caso e mandam `FRASE_DE_VERIFICACAO` pela cadeia de envio,
 *     sem silêncio.
 * Com a passagem ligada nada muda. Opt-out ("parar"), bloqueio e as restrições de envio
 * também não mudam.
 */
import type pg from 'pg';

import { moverLeadParaEtapaDeHandoff } from '@/lib/leads/handoff-stage-move';
import { createAdminClient } from '@/lib/supabase/admin';

import type { Logger } from '@/lib/agent-engine/obs/logger';
import { openCase } from '@/lib/agent-engine/agent/human-cases';
import type { Queryable } from '@/lib/agent-engine/queue/queue';

/** A versão publicada do agente tem a ferramenta de passagem desligada. Sem agente: ligada (o de hoje). */
export function passagemDesligada(agente: { handoffToolEnabled: boolean } | null | undefined): boolean {
  return agente !== null && agente !== undefined && agente.handoffToolEnabled === false;
}

/**
 * O que o cliente lê quando a resposta do modelo não pode sair (trava de conteúdo no
 * limite, vocabulário interno, corte do laço, falha na última tentativa) e a passagem
 * está desligada. Verdadeira: o caso foi aberto antes dela. Passa pela cadeia de envio
 * como a frase de espera (janela de 24 h, bloqueio, LGPD, ritmo); se não puder sair,
 * não sai.
 */
export const FRASE_DE_VERIFICACAO = 'Vou verificar pra você e já te retorno.';

/** O bloco do turno quando o cliente pediu uma pessoa e o caso já foi aberto pelo sistema. */
export const BLOCO_DO_PEDIDO_DE_PESSOA_SEM_PASSAGEM =
  '## O cliente pediu para falar com uma pessoa\n' +
  'O cliente pediu para falar com uma pessoa, e o caso para a equipe JÁ foi aberto (não abra outro). ' +
  'Responda que vai verificar e já retorna (ex.: "vou verificar e já te retorno"), sem dizer que chamou, ' +
  'transferiu ou passou a conversa para alguém, sem prometer prazo ou resultado e sem vender neste turno.';

/** O retorno de `open_human_case` ao modelo com a passagem desligada (no lugar da expectativa da equipe). */
export const RETORNO_DO_CASO_SEM_PASSAGEM =
  'caso aberto; diga ao lead que vai verificar e já retorna ("vou verificar e já te retorno"), sem prometer ' +
  'prazo ou resultado e sem dizer que ficou registrado; continue a conversa normalmente.';

/** O mesmo, quando a conversa já tinha caso aberto e a dúvida nova entrou nele (`registrarDuvidaNoCasoAberto`). */
export const RETORNO_DO_CASO_JA_ABERTO_SEM_PASSAGEM =
  'já existe um caso aberto para esta conversa e esta dúvida foi juntada a ele (não abra outro); diga ao lead que ' +
  'vai verificar e já retorna ("vou verificar e já te retorno"), sem prometer prazo ou resultado e sem dizer que ' +
  'ficou registrado; continue a conversa normalmente.';

/** Os estados de caso aberto (os mesmos de `OPEN_STATUSES` em human-cases.ts, que não é exportado). */
const ESTADOS_DE_CASO_ABERTO = ['awaiting_human', 'awaiting_lead'] as const;

/** O texto da nota com a dúvida nova, no mesmo formato do caso (`buildCaseSummary`). */
export function notaDaDuvidaNova(duvida: { title: string; summary: string; blocker: string }): string {
  return `Dúvida nova do lead (o caso já estava aberto): ${duvida.title}\n${duvida.summary}\nBloqueio: ${duvida.blocker}`;
}

/**
 * (C01, -c01.16) A dúvida nova com o caso já aberto entra NO caso aberto.
 *
 * Medido no laboratório em 20/10/2026 (teste-base da Marina v26, cartão do caso aberto): o
 * modelo chamava `open_human_case` para a segunda dúvida, `openCase` recusava
 * (`case_already_open`, um caso aberto por conversa) e o retorno mandava o modelo dizer
 * "vou verificar". A dúvida não chegava a ninguém: o caso só tinha a primeira pergunta.
 *
 * Agora ela vira uma nota do agente (`agent_noted`, o mesmo registro de
 * `registrarNotaDoAgente`) no caso aberto mais recente da conversa, e só depois o modelo
 * ouve o "vou verificar". A guarda de estado está no próprio statement, com a linha do caso
 * travada (`for update`): se uma pessoa estiver fechando o caso ao mesmo tempo, a nota espera
 * o fechamento, o estado é relido e o caso fechado não recebe nota (revisão independente da
 * -c01.16: sem a trava, a leitura via o caso ainda aberto e a dúvida caía num caso resolvido). Devolve o id do caso, ou null se nenhum caso estava aberto (fechou entre a
 * recusa e a nota): aí o chamador tenta abrir de novo.
 *
 * Caso em `awaiting_lead` (a equipe esperava o cliente) volta a `awaiting_human` no mesmo
 * statement: a dúvida nova é pendência da equipe (revisão da junção da 1.86.0, achado 2).
 */
export async function registrarDuvidaNoCasoAberto(
  db: Queryable,
  tenantId: string,
  conversationId: string,
  duvida: { title: string; summary: string; blocker: string },
): Promise<string | null> {
  const { rows } = await db.query<{ case_id: string }>(
    `with aberto as (
       select c.id
         from agent_cases c
        where c.organization_id = $1 and c.conversation_id = $2 and c.status = any($4::text[])
        order by c.opened_at desc
        limit 1
        for update
     ),
     -- (Revisão da junção da 1.86.0, achado 2) O caso que esperava o cliente volta à
     -- equipe: há uma pergunta nova dele sem resposta. Mesma transição do
     -- provide_case_update (awaiting_lead -> awaiting_human), que a fila e o painel de
     -- resposta contam como pendência. Caso que já esperava a equipe não muda.
     volta_a_equipe as (
       update agent_cases c
          set status = 'awaiting_human', updated_at = now()
         from aberto
        where c.id = aberto.id and c.status = 'awaiting_lead'
     )
     insert into agent_case_events (organization_id, case_id, kind, actor_kind, body)
     select $1::uuid, aberto.id, 'agent_noted', 'agent', $3::text
       from aberto
     returning case_id`,
    [tenantId, conversationId, notaDaDuvidaNova(duvida), ESTADOS_DE_CASO_ABERTO],
  );
  return rows[0]?.case_id ?? null;
}

/**
 * `CASES_SYSTEM_BLOCK` com a passagem desligada. O de sempre proíbe "vou verificar e
 * voltar" (-c01.3, item 4); aqui é o contrário: com o caso aberto, a frase certa é "vou
 * verificar e já te retorno", e "ficou registrado/anotado" é que sai.
 */
export const CASES_SYSTEM_BLOCK_SEM_PASSAGEM =
  '## Casos para um humano de retaguarda\n' +
  'Quando você NÃO conseguir resolver o pedido do lead sozinho (liberar acesso, corrigir algo num ' +
  'sistema, uma decisão que exige uma pessoa), use a tool open_human_case — você CONTINUA conversando ' +
  'com o lead, não silencia. NUNCA diga ao lead que vai verificar sem antes chamar open_human_case. ' +
  'Quando um caso estiver esperando informação do cliente e você já a obteve na conversa, use ' +
  'provide_case_update para devolver ao responsável. Ao avisar o lead que abriu o caso, NUNCA narre a ' +
  'causa técnica ou interna (erro de sistema, falha de confirmação, nome de ferramenta, log ou qualquer ' +
  'diagnóstico) — isso é assunto técnico e não vai pro cliente. `title`/`summary`/`blocker` são só para o ' +
  'humano. Com o caso aberto, diga ao lead, em linguagem simples, que vai verificar e já retorna ("vou ' +
  'verificar e já te retorno"), sem prometer prazo nem resultado e sem dizer que chamou, transferiu ou ' +
  'passou a conversa para alguém. Nunca diga que o pedido "ficou registrado" ou "anotado".';

/** `TRANSPARENCIA_SYSTEM_BLOCK` com a passagem desligada: a mesma proibição de narrar problema interno. */
export const TRANSPARENCIA_SYSTEM_BLOCK_SEM_PASSAGEM =
  '## Nunca narre problema interno ao lead\n' +
  'Em QUALQUER mensagem — abrindo caso ou não — NUNCA diga ao lead que "houve um problema/erro no ' +
  'sistema", "falha na confirmação", "erro técnico" ou qualquer variação que admita que algo deu errado ' +
  'do lado interno. Isso vale mesmo quando você está incerto do resultado de uma ferramenta ou algo ' +
  'falhou sem você entender o motivo. O lead não precisa do diagnóstico: quando não der para resolver ' +
  'agora, abra o caso (quando você tiver a ferramenta de caso) e diga que vai verificar e já retorna ' +
  '("vou verificar e já te retorno"), sem prometer prazo nem resultado; ou pergunte de novo o que falta. ' +
  'Nunca diga que o pedido "ficou registrado" ou "anotado", nem que "a equipe vai te avisar" — e nunca ' +
  'admita que "o sistema" ou "a confirmação" teve um problema.';

/** Em que pé ficou a frase do fail-safe (o mesmo tipo de `DesfechoDaFraseDeEspera`, em `inbound-turn.ts`). */
type DesfechoDaFrase = 'entregue' | 'a_caminho' | 'pendente' | 'nao_sai';

/**
 * O que o modelo lê sobre a frase do fail-safe com a passagem desligada — o par de
 * `AVISO_AO_MODELO_POR_DESFECHO`, sem "a conversa passou a uma pessoa": ela não passou.
 */
export const AVISO_AO_MODELO_SEM_PASSAGEM: Record<DesfechoDaFrase, string> = {
  entregue: `O cliente recebeu "${FRASE_DE_VERIFICACAO}" e um caso foi aberto para a equipe.`,
  a_caminho: `Um caso foi aberto para a equipe; o canal entrega "${FRASE_DE_VERIFICACAO}" quando a sessão voltar.`,
  pendente: `Um caso foi aberto para a equipe; "${FRASE_DE_VERIFICACAO}" não pôde sair ao cliente agora.`,
  nao_sai: 'Um caso foi aberto para a equipe; o cliente pediu para não receber mensagens e nada sai a ele.',
};

/**
 * (-c01.15, revisão) O que o modelo lê quando o fail-safe abre o caso e NÃO manda a frase: algo
 * deste turno já chegou ao cliente, e a frase de verificação depois da resposta seria outra
 * mensagem fora de hora (ou a mesma frase lida duas vezes).
 */
export const AVISO_AO_MODELO_SEM_FRASE_SEM_PASSAGEM =
  'Um caso foi aberto para a equipe; o cliente já recebeu mensagem deste turno e nada mais sai a ele agora.';

/** O aviso de última tentativa das travas de conteúdo, sem "a conversa passa a uma pessoa". */
export const AVISO_DE_ULTIMA_TENTATIVA_SEM_PASSAGEM =
  'Esta é a ÚLTIMA tentativa: se a próxima versão repetir o problema, a mensagem não sai, um caso é ' +
  `aberto para a equipe e o cliente recebe só "${FRASE_DE_VERIFICACAO}".`;

/** A recusa das ferramentas de envio depois da frase do fail-safe, com a passagem desligada. */
export const RECUSA_DEPOIS_DA_VERIFICACAO =
  `O turno já foi encerrado com "${FRASE_DE_VERIFICACAO}" e um caso aberto para a equipe. ` +
  'NÃO envie mais nada — encerre o turno agora.';

/**
 * O fim do `blocker` dos casos dos fail-safes com a passagem desligada: no lugar da
 * frase de espera e da passagem, a frase de verificação, e a IA continua na conversa.
 */
export function fimDoBloqueioSemPassagem(oQue: string): string {
  return (
    `Aberto automaticamente: ${oQue}. A passagem de atendimento está desligada neste agente: o sistema ` +
    `manda "${FRASE_DE_VERIFICACAO}" ao cliente (a entrega aparece na conversa) e a IA continua na ` +
    'conversa; uma pessoa precisa verificar e responder.'
  );
}

/**
 * (C01, -c01.15) A trava "consulte antes de enviar" é de ESTILO (`TRAVAS_DE_ESTILO`: no 2º
 * veto a mensagem sai sem a consulta). Com a passagem desligada ela vale como trava de
 * CONTEÚDO (`TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE`): no limite de vetos a mensagem não sai,
 * abre caso e o cliente recebe `FRASE_DE_VERIFICACAO`. O nome legível vai ao caso.
 */
export const CONSULTA_ANTES_DE_ENVIAR = 'consulta_antes_de_enviar';
export const NOME_DA_CONSULTA_ANTES_DE_ENVIAR = 'resposta sem a consulta à base que vem antes';

/** Trava de estilo que, com a passagem desligada, conta como de conteúdo. */
export function estiloViraConteudo(codigo: string, semPassagem: boolean): boolean {
  return semPassagem && codigo === CONSULTA_ANTES_DE_ENVIAR;
}

/** Teto do pedido do cliente no resumo do caso (a fala literal, como na passagem). */
const TETO_DO_PEDIDO = 1000;

export const TITULO_DO_CASO_DO_PEDIDO_DE_PESSOA = 'Cliente pediu para falar com uma pessoa';
export const BLOQUEIO_DO_CASO_DO_PEDIDO_DE_PESSOA =
  'Aberto automaticamente: o cliente pediu para falar com uma pessoa. A passagem de atendimento está ' +
  'desligada neste agente: a IA continua na conversa e diz ao cliente que vai verificar e já retorna. ' +
  'Uma pessoa precisa verificar e responder.';

/** O resumo do caso: o que o cliente escreveu, nas palavras dele (é para a equipe, nunca para log). */
export function resumoDoPedidoDePessoa(pendentes: readonly string[]): string {
  const fala = pendentes
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => `"${t}"`)
    .join('\n');
  const texto = `O cliente pediu para falar com uma pessoa. O que ele escreveu:\n${fala}`;
  return texto.length <= TETO_DO_PEDIDO ? texto : `${texto.slice(0, TETO_DO_PEDIDO - 1)}…`;
}

/**
 * Abre o caso do pedido de uma pessoa (passagem desligada) e move o card para a etapa de
 * passagem, se a organização tiver (best-effort, como `moverParaHandoffBestEffort`).
 * `case_already_open` é sucesso: o pedido está com a equipe do mesmo jeito. Erro de banco
 * sobe (o job re-tenta): sem caso, "vou verificar" seria promessa sem ninguém.
 */
export async function abrirCasoDoPedidoDePessoa(
  pool: pg.Pool,
  ids: { tenantId: string; leadId: string; conversationId: string; agentId: string | null },
  opts: {
    pendentes: readonly string[];
    contextSnapshot?: Record<string, unknown>;
    titulo?: string;
    resumo?: string;
    bloqueio?: string;
    motivoDaEtapa?: string;
    /** `agent_cases.source`: o pedido do cliente é 'agent'; o fail-safe do sistema, 'guardrail_autofallback'. */
    origem?: 'agent' | 'guardrail_autofallback';
    log: Pick<Logger, 'info' | 'warn'>;
  },
): Promise<{ jaHavia: boolean }> {
  const caso = await openCase(
    pool,
    { tenantId: ids.tenantId, conversationId: ids.conversationId, agentId: ids.agentId },
    {
      title: opts.titulo ?? TITULO_DO_CASO_DO_PEDIDO_DE_PESSOA,
      summary: opts.resumo ?? resumoDoPedidoDePessoa(opts.pendentes),
      blocker: opts.bloqueio ?? BLOQUEIO_DO_CASO_DO_PEDIDO_DE_PESSOA,
      source: opts.origem ?? 'agent',
      ...(opts.contextSnapshot !== undefined ? { contextSnapshot: opts.contextSnapshot } : {}),
    },
  );
  if (!caso.ok && caso.error.code !== 'case_already_open') {
    throw new Error(`caso do pedido de uma pessoa não aberto: ${caso.error.code}`);
  }
  // O cliente do banco nasce dentro da promessa: se ele falhar ao nascer, vira o mesmo aviso
  // best-effort, e não um erro depois de o caso já estar aberto.
  void Promise.resolve()
    .then(() =>
      moverLeadParaEtapaDeHandoff(createAdminClient(), {
        organizationId: ids.tenantId,
        leadId: ids.leadId,
        reason: opts.motivoDaEtapa ?? 'pedido_de_pessoa_sem_passagem',
      }),
    )
    .catch((err: unknown) => {
      opts.log.warn('moverLeadParaEtapaDeHandoff falhou (best-effort, caso humano)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  return { jaHavia: !caso.ok };
}

/** O caso do orçamento de IA esgotado com a passagem desligada (a IA para, a conversa não cala). */
export const TITULO_DO_CASO_POR_ORCAMENTO = 'Teto de gasto com IA atingido — a IA parou de responder';
export const BLOQUEIO_DO_CASO_POR_ORCAMENTO =
  'Aberto automaticamente: o teto de gasto mensal com IA foi atingido e a IA parou de responder. ' +
  'A passagem de atendimento está desligada neste agente: a conversa não foi silenciada. ' +
  'Uma pessoa precisa responder o cliente ou ajustar o teto em Uso de IA › Orçamento.';
