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
