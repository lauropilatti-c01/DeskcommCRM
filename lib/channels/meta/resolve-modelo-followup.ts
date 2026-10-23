import { definicaoNaConexao, type ConsultaSql } from "../linha-do-espelho";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { hashDoCorpo } from "@/lib/api/idempotency";
import { renderTemplateBody } from "./render-template";
import { isStatusSendable } from "./template-binding";
import { deriveTemplateContract } from "./template-contract";

export type ModeloAprovadoFollowup =
  | {
      tipo: "modelo_aprovado";
      body: string;
      modelo: { name: string; language: string; values: Record<string, string> };
    }
  | { tipo: "recusado"; motivo: string };

/**
 * Um modelo aprovado do canal (`meta_templates.id`), pronto para sair NESTA
 * conexão. `null` = o id não é de modelo do canal nesta organização.
 *
 * O id aponta uma linha, mas quem vale é a definição da conexão da conversa
 * (`definicaoNaConexao`, a mesma regra do `send_template` do agente): dois números
 * podem espelhar o mesmo nome, e disparar a linha de outra conta é recusa certa.
 *
 * O fluxo não tem de onde tirar valor para variável, então modelo com `{{1}}` é
 * recusado com o motivo — mandar o marcador cru ao cliente seria pior.
 */
export async function resolveModeloAprovado(
  pool: Queryable,
  tenantId: string,
  channelSessionId: string,
  metaTemplateId: string,
  expectedContentHash?: string,
): Promise<ModeloAprovadoFollowup | null> {
  const { rows } = await pool.query<{ name: string; language: string }>(
    `select name, language from meta_templates where organization_id = $1 and id = $2 limit 1`,
    [tenantId, metaTemplateId],
  );
  const alvo = rows[0];
  if (alvo === undefined) return null;
  const consulta: ConsultaSql = {
    async query<R>(sql: string, params: unknown[]) {
      return { rows: (await pool.query(sql, params)).rows as R[] };
    },
  };
  const linha = await definicaoNaConexao<{
    id?: string;
    components: unknown;
    parameter_format: string;
    status: string;
  }>(consulta, [...(expectedContentHash ? ["id"] : []), "components", "parameter_format", "status"], {
    organizationId: tenantId,
    name: alvo.name,
    language: alvo.language,
    channelSessionId,
  });
  if (linha === null) {
    return {
      tipo: "recusado",
      motivo: `O modelo "${alvo.name}" não existe no número desta conversa.`,
    };
  }
  if (
    expectedContentHash &&
    (linha.id !== metaTemplateId ||
      hashDoCorpo({
        name: alvo.name,
        language: alvo.language,
        parameter_format: linha.parameter_format,
        components: linha.components,
      }) !== expectedContentHash)
  ) {
    return {
      tipo: "recusado",
      motivo: "O modelo diverge do ID ou do conteúdo aprovado para este retorno.",
    };
  }
  if (!isStatusSendable(linha.status)) {
    return {
      tipo: "recusado",
      motivo: `O modelo "${alvo.name}" está ${linha.status} na plataforma — só modelo aprovado pode ser enviado.`,
    };
  }
  const meta = {
    name: alvo.name,
    language: alvo.language,
    parameterFormat: linha.parameter_format,
  };
  const contrato = deriveTemplateContract({
    name: alvo.name,
    language: alvo.language,
    parameter_format: linha.parameter_format,
    components: linha.components as never,
  });
  if (contrato.slots.length > 0) {
    return {
      tipo: "recusado",
      motivo: `O modelo "${alvo.name}" tem variáveis, e o fluxo não tem de onde tirar os valores. Use um modelo sem variáveis.`,
    };
  }
  return {
    tipo: "modelo_aprovado",
    body: renderTemplateBody(linha.components, {}, meta),
    modelo: { name: alvo.name, language: alvo.language, values: {} },
  };
}
