/**
 * (C01, -c01.14) TRAVA "CONSULTE ANTES DE ENVIAR", LIGADA POR AGENTE.
 *
 * O defeito (medido na C01, 14/10/2026): um modelo que não raciocina antes de agir
 * escrevia a resposta sem consultar a base externa, ou chamava a consulta e o
 * `send_message` no MESMO passo — e a mensagem saía sem o que a base devolveria. A
 * instrução pedia a consulta; nada conferia.
 *
 * A trava confere o que o modelo LEU ao escrever: as mensagens que o AI SDK entrega ao
 * `execute` do `send_message` (`options.messages` — as que abriram o passo, sem o passo
 * que contém a chamada). Só conta o resultado de `crm_query_external_data` da tabela
 * configurada, sem erro, que já estava ali. A consulta pedida no mesmo passo do envio
 * não conta: o modelo escreveu sem tê-la lido.
 *
 * Só é cobrada enquanto o contato não teve essa consulta: feita num turno anterior (o
 * registro de cada chamada de ferramenta em `api_audit_log`, pela execução do contato em
 * `job_queue`), o turno passa sem ela — senão "obrigado" e "como pago?" voltariam ao
 * modelo em todo turno. Quando a fila ou o registro já foram podados pela retenção, a
 * trava cobra a consulta de novo, uma vez.
 *
 * Interruptor POR AGENTE, em `organizations.settings.travas_de_envio`:
 *
 *   { "consulta_antes_de_enviar": { "agentes": ["<id do agente>"], "tabela": "<tabela>" } }
 *
 * Sem a chave, sem a tabela, com a lista vazia ou com outro agente: desarmada, nada muda.
 *
 * Trava de ESTILO (`TRAVAS_DE_ESTILO` em `inbound-turn.ts`): o 1º veto ensina; no 2º ela
 * se desarma no turno e a mensagem sai como está. Consultar é o caminho certo, não
 * condição para a pessoa receber resposta.
 */
import { z } from 'zod';

import type { Queryable } from '../queue/queue';
import type { Gate } from './before-send';
import { resultadoComErro } from './link-e-valor-de-ferramenta';

/** A ferramenta de consulta à base externa (a mesma `FERRAMENTA_DA_BASE` do turno). */
export const FERRAMENTA_DE_CONSULTA = 'crm_query_external_data';

/** O que a organização ligou: os agentes e a tabela. */
export interface ConsultaAntesDeEnviarDaOrg {
  agentes: readonly string[];
  tabela: string;
}

const configSchema = z
  .object({ agentes: z.array(z.string()).optional(), tabela: z.string().optional() })
  .passthrough();

/**
 * Pura: o valor da chave `consulta_antes_de_enviar` → o que vale. `null` = desligada
 * (chave ausente, sem tabela ou sem agente); `invalida` = o valor não tem a forma certa
 * (só esta trava fica desligada).
 */
export function interpretarConsultaAntesDeEnviar(valor: unknown): {
  consulta: ConsultaAntesDeEnviarDaOrg | null;
  invalida: boolean;
} {
  if (valor === null || valor === undefined) return { consulta: null, invalida: false };
  const lido = configSchema.safeParse(valor);
  if (!lido.success) return { consulta: null, invalida: true };
  const tabela = normalizarTabela(lido.data.tabela ?? '');
  const agentes = (lido.data.agentes ?? []).map((a) => a.trim()).filter((a) => a.length > 0);
  if (tabela === '' || agentes.length === 0) return { consulta: null, invalida: false };
  return { consulta: { agentes, tabela }, invalida: false };
}

/** O nome da tabela sem o agrupamento ("c01.tabela" → "tabela"), sem aspas, minúsculo. */
export function normalizarTabela(tabela: string): string {
  const semAspas = tabela.trim().replace(/"/g, '');
  return semAspas.slice(semAspas.lastIndexOf('.') + 1).toLowerCase();
}

/** A saída de ferramenta, como o AI SDK a guarda na mensagem, é erro? */
function saidaComErro(parte: { output?: unknown; result?: unknown }): boolean {
  const saida = parte.output as { type?: unknown; value?: unknown } | undefined;
  if (saida === undefined || saida === null || typeof saida !== 'object') {
    return parte.result === undefined || resultadoComErro(parte.result);
  }
  switch (saida.type) {
    case 'json':
      return resultadoComErro(saida.value);
    case 'text': {
      if (typeof saida.value !== 'string') return false;
      try {
        return resultadoComErro(JSON.parse(saida.value));
      } catch {
        return false;
      }
    }
    case 'content':
      return resultadoComErro({ content: saida.value });
    default:
      // 'error-text', 'error-json', 'execution-denied' e o que vier de novo.
      return true;
  }
}

/**
 * Pura: as mensagens que o modelo leu ao escrever têm um resultado sem erro da consulta
 * à `tabela`? Casa a chamada (`tool-call`, com a tabela no `input`) com o resultado dela
 * (`tool-result`, pelo `toolCallId`).
 */
export function leuConsultaDaTabela(mensagens: readonly unknown[] | undefined, tabela: string): boolean {
  if (!Array.isArray(mensagens)) return false;
  const alvo = normalizarTabela(tabela);
  const chamadas = new Set<string>();
  for (const m of mensagens) {
    const conteudo = (m as { role?: unknown; content?: unknown } | null)?.content;
    if ((m as { role?: unknown }).role !== 'assistant' || !Array.isArray(conteudo)) continue;
    for (const p of conteudo as Array<Record<string, unknown> | null>) {
      if (p?.type !== 'tool-call' || p.toolName !== FERRAMENTA_DE_CONSULTA) continue;
      const entrada = (p.input ?? p.args) as { tabela?: unknown } | undefined;
      if (typeof entrada?.tabela === 'string' && normalizarTabela(entrada.tabela) === alvo && typeof p.toolCallId === 'string') {
        chamadas.add(p.toolCallId);
      }
    }
  }
  if (chamadas.size === 0) return false;
  for (const m of mensagens) {
    const conteudo = (m as { role?: unknown; content?: unknown } | null)?.content;
    if ((m as { role?: unknown }).role !== 'tool' || !Array.isArray(conteudo)) continue;
    for (const p of conteudo as Array<Record<string, unknown> | null>) {
      if (p?.type !== 'tool-result' || typeof p.toolCallId !== 'string' || !chamadas.has(p.toolCallId)) continue;
      if (!saidaComErro(p as { output?: unknown; result?: unknown })) return true;
    }
  }
  return false;
}

/**
 * O contato já teve, num turno anterior, a consulta sem erro à `tabela`? (A consulta que
 * voltou sem linha conta: a base foi lida.) Exclui a execução atual: numa nova tentativa
 * do mesmo turno, o modelo não leu a consulta da tentativa anterior.
 */
export async function consultaJaFeitaComOContato(
  db: Queryable,
  args: { organizationId: string; contactId: string; jobIdAtual: string; tabela: string },
): Promise<boolean> {
  const { rows } = await db.query<{ feita: boolean }>(
    `select exists (
       select 1 from api_audit_log a
        where a.organization_id = $1
          and a.action = 'mcp.tool_called'
          and a.metadata->>'tool_name' = $5
          and (a.metadata->>'success' = 'true' or a.metadata->>'motivo' = 'nenhuma_linha')
          and lower(regexp_replace(replace(coalesce(a.metadata->'args'->>'tabela', ''), '"', ''), '^.*\\.', '')) = $4
          and a.request_id in (select j.id::text from job_queue j
                                where j.organization_id = $1 and j.contact_id = $2 and j.id <> $3)
     ) as feita`,
    [args.organizationId, args.contactId, args.jobIdAtual, normalizarTabela(args.tabela), FERRAMENTA_DE_CONSULTA],
  );
  return rows[0]?.feita === true;
}

export const consultaAntesDeEnviarGate: Gate = {
  name: 'consulta_antes_de_enviar',
  evaluate: (ctx) => {
    const armada = ctx.travasDeEnvio?.consultaAntesDeEnviar;
    if (armada === undefined || armada.leu) return { pass: true };
    return {
      pass: false,
      code: 'consulta_antes_de_enviar',
      reason: renderVetoDeConsulta(armada.tabela),
    };
  },
};

/** O erro de ensino. */
export function renderVetoDeConsulta(tabela: string): string {
  return (
    `A mensagem NÃO foi enviada: você ainda não leu a consulta à tabela ${tabela}. ` +
    `Chame ${FERRAMENTA_DE_CONSULTA} nessa tabela, ESPERE o resultado e só depois escreva a resposta com o que ` +
    'ela devolveu. Não chame a consulta e o send_message no mesmo passo.'
  );
}
