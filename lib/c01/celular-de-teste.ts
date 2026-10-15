/**
 * (C01, -c01.15) A CONFERÊNCIA DO CELULAR DE TESTE, uma régua só.
 *
 * Um contato é celular de teste quando as DUAS coisas valem:
 *   (a) o telefone dele está na lista de teste do canal da mensagem
 *       (`channel_sessions.metadata.ai_test_phone_numbers`, a de pré-lançamento, lida por
 *       `lerNumerosDeTeste` e comparada por `numeroPodeTestar`, só os dígitos, qualquer
 *       que seja o modo do canal) — a autorização do administrador;
 *   (b) o contato, ou um card dele, tem a etiqueta `ETIQUETA_DO_CELULAR_DE_TESTE`.
 *
 * A etiqueta sozinha não autoriza: etiqueta é coisa que qualquer automação ou pessoa da
 * equipe põe num contato. Quem usa esta régua:
 *   - o `#zerar` na entrada, antes do bloqueio (`zerar-celular-de-teste.ts`);
 *   - o `apagar_memoria` do gancho antes do turno (`apagarMemoriaDoContato`);
 *   - o `celular_de_teste` do pedido ao gancho (`lerCelularDeTeste`, em
 *     `gancho-antes-do-turno.ts`), que o porteiro exige para o `#zerar` e o apagar.
 * Só funções puras: cada chamador lê os dados com o cliente de banco que tem.
 */
import { lerNumerosDeTeste, numeroPodeTestar } from "@/lib/ai/elegibilidade/pre-go-live";

/** A etiqueta do celular de teste, comparada já normalizada (`lower(btrim(tag))`). */
export const ETIQUETA_DO_CELULAR_DE_TESTE = "celular-de-teste";

/** (a) O telefone do contato na lista de teste do canal. Sem telefone ou sem lista: não. */
export function telefoneNaListaDeTeste(telefone: string | null | undefined, metadataDoCanal: unknown): boolean {
  return numeroPodeTestar(telefone, lerNumerosDeTeste(metadataDoCanal));
}

/** (b) A etiqueta numa lista de etiquetas (do contato ou de um card), como o banco compara. */
export function temEtiquetaDeTeste(tags: readonly unknown[] | null | undefined): boolean {
  return (tags ?? []).some(
    (tag) => typeof tag === "string" && tag.trim().toLowerCase() === ETIQUETA_DO_CELULAR_DE_TESTE,
  );
}

/** As duas juntas: (a) e (b). `etiquetas` = as do contato e as dos cards dele. */
export function passaNaConferenciaDoCelularDeTeste(dados: {
  telefone: string | null | undefined;
  metadataDoCanal: unknown;
  etiquetas: readonly unknown[] | null | undefined;
}): boolean {
  return telefoneNaListaDeTeste(dados.telefone, dados.metadataDoCanal) && temEtiquetaDeTeste(dados.etiquetas);
}
