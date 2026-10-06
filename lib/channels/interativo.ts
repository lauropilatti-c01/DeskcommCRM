/**
 * (C01, -c01.5) MENSAGEM INTERATIVA: o que o canal deixa fazer, e como ela aparece na conversa.
 *
 * Três perguntas de quem está fora de `lib/channels/`, respondidas sem que ninguém
 * precise escrever o nome de um provider (invariante 1 de
 * `docs/doctrine/restricao-de-canal.md`):
 *
 *   1. Este canal ENVIA mensagem interativa (botão, lista, formulário)?
 *      Hoje só o canal oficial. O parceiro que espelha a Cloud API fica de fora
 *      de propósito: o adaptador dele não monta o corpo interativo, e dizer "sim"
 *      aqui seria prometer um envio que vira texto vazio.
 *   2. Qual é o TIPO do canal, no vocabulário de quem integra pelo gancho antes
 *      do turno (`lib/agent-engine/agent/gancho-antes-do-turno.ts`)? O canal
 *      oficial se chama `meta` lá fora; os outros saem com o nome que já têm.
 *   3. Que texto fica na conversa quando a pessoa responde um formulário?
 *
 * Fica fora da matriz de capabilities (`./capabilities.ts`) por escolha nossa:
 * entrar nela obrigaria a reescrever três testes do autor que conferem a
 * matriz inteira. As regras são as mesmas: provider desconhecido responde "não".
 */
import { chaveEDadoPessoal } from "@/lib/agent-engine/edge/crm/card-do-contato";

import { CHANNEL_PROVIDER_META } from "./capabilities";

/**
 * O texto neutro que a resposta de um formulário (WhatsApp Flows) recebe ao
 * entrar. Neutro de propósito: as checagens da entrada (descadastro, campanha,
 * palavra de passagem) leem o texto da mensagem, e as respostas marcadas no
 * formulário ("medo de investir", "atendente") não podem disparar nenhuma delas.
 * O original fica em `metadata.interactive`; quem troca este texto por um resumo
 * é o gancho antes do turno, depois das checagens.
 */
export const TEXTO_DA_RESPOSTA_DE_FORMULARIO = "Formulário respondido";

/** Quantas respostas do formulário o texto montado mostra, e o teto de cada valor. */
const TETO_DE_RESPOSTAS_NO_TEXTO = 30;
const TETO_DO_VALOR_NO_TEXTO = 200;

/**
 * O que o MODELO lê de uma resposta de formulário que ainda não tem resumo (o gancho
 * antes do turno falhou ou está desligado): o texto neutro e, abaixo dele, uma
 * resposta por linha (`chave: valor`), montadas do `response_json`, sem o
 * `flow_token` e sem a chave com nome de dado pessoal (`chaveEDadoPessoal`, o mesmo
 * filtro do card e do pedido ao gancho). Determinístico: a mesma resposta dá o mesmo
 * texto. Sem resposta legível, só o texto neutro.
 *
 * A linha da conversa continua com o texto neutro: quem lê isto é o contexto do
 * turno (`corpoDaMensagem`), e as checagens da entrada não o veem.
 */
export function textoDaRespostaDeFormulario(resposta: unknown): string {
  if (resposta === null || typeof resposta !== "object" || Array.isArray(resposta)) {
    return TEXTO_DA_RESPOSTA_DE_FORMULARIO;
  }
  const linhas: string[] = [];
  for (const [chave, valor] of Object.entries(resposta as Record<string, unknown>)) {
    if (linhas.length >= TETO_DE_RESPOSTAS_NO_TEXTO) break;
    if (chave === "flow_token" || chaveEDadoPessoal(chave)) continue;
    const texto = valorLegivel(valor);
    if (texto !== null) linhas.push(`${chave}: ${texto.slice(0, TETO_DO_VALOR_NO_TEXTO)}`);
  }
  return linhas.length === 0
    ? TEXTO_DA_RESPOSTA_DE_FORMULARIO
    : `${TEXTO_DA_RESPOSTA_DE_FORMULARIO}:\n${linhas.join("\n")}`;
}

function valorLegivel(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "string") return valor.trim() === "" ? null : valor.trim();
  if (typeof valor === "number" || typeof valor === "boolean") return String(valor);
  if (Array.isArray(valor) && valor.every((v) => ["string", "number", "boolean"].includes(typeof v))) {
    const t = valor.map((v) => String(v).trim()).filter((v) => v !== "").join(", ");
    return t === "" ? null : t;
  }
  return JSON.stringify(valor);
}

/** `true` quando o canal sabe entregar `interactive` (botão, lista, formulário). */
export function canalEnviaInterativo(provider: string | null | undefined): boolean {
  return provider === CHANNEL_PROVIDER_META;
}

/**
 * Tipo do canal no contrato do gancho antes do turno: `meta` para o oficial, o
 * próprio provider para os demais, `desconhecido` quando a linha não diz.
 */
export function tipoDoCanalParaIntegracao(provider: string | null | undefined): string {
  if (provider === CHANNEL_PROVIDER_META) return "meta";
  return provider && provider.trim() !== "" ? provider : "desconhecido";
}
