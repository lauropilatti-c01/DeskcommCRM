/**
 * (C01, -c01.7) PAINÉIS DA OPERAÇÃO: o que o serviço do gancho antes do turno manda
 * para a tela `/app/ai/paineis` mostrar, só para leitura.
 *
 * O Deskcomm não sabe o que há nos painéis: título, descrição, seções, rótulos e
 * textos vêm todos do serviço (`GET <AGENT_PRE_TURN_HOOK_URL>/paineis`, ver
 * `buscar.ts`). Aqui só se lê a resposta.
 *
 * ## O contrato (versão 1)
 *
 * ```json
 * { "contrato": 1,
 *   "paineis": [{ "id", "titulo", "descricao", "atualizado_em",
 *     "secoes": [
 *       { "titulo", "texto", "tipo": "mensagens",
 *         "mensagens": [{ "rotulo", "quando", "texto", "botao" }] },
 *       { "titulo", "texto", "tipo": "tabela", "colunas": ["…"], "linhas": [["…"]] } ] }] }
 * ```
 *
 * A leitura é tolerante: campo que falta ou vem com o tipo errado vira vazio, não
 * erro (o serviço evolui separado do Deskcomm). Seção de tipo que esta versão não
 * conhece vira `desconhecido`, e a tela mostra só um aviso discreto. Só a raiz que
 * não é objeto recusa a resposta inteira.
 *
 * Todo texto é texto puro: a tela nunca o interpreta como HTML ou markdown.
 */
import { z } from "zod";

/** Texto do serviço: texto fica, número e sim/não viram texto, o resto vira vazio. */
const texto = z
  .union([z.string(), z.number().transform(String), z.boolean().transform(String)])
  .catch("");

const objeto = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Lista do serviço: o que não é lista vira lista vazia. */
const lista = <T extends z.ZodType>(item: T) => z.array(item).catch([]);

const mensagemSchema = z
  .object({ rotulo: texto, quando: texto, texto: texto, botao: texto })
  .catch({ rotulo: "", quando: "", texto: "", botao: "" });

const secaoSchema = z
  .object({
    titulo: texto,
    texto: texto,
    tipo: texto,
    mensagens: lista(mensagemSchema),
    colunas: lista(texto),
    linhas: lista(lista(texto)),
  })
  .catch({ titulo: "", texto: "", tipo: "", mensagens: [], colunas: [], linhas: [] });

const painelSchema = z
  .object({
    id: texto,
    titulo: texto,
    descricao: texto,
    atualizado_em: texto,
    secoes: lista(secaoSchema),
  })
  .catch({ id: "", titulo: "", descricao: "", atualizado_em: "", secoes: [] });

const respostaSchema = z.object({
  contrato: z.number().nullable().catch(null),
  paineis: lista(painelSchema),
});

export interface MensagemPronta {
  rotulo: string;
  quando: string;
  texto: string;
  /** Vazio = a mensagem não tem botão. */
  botao: string;
}

export type SecaoDoPainel =
  | { tipo: "mensagens"; titulo: string; texto: string; mensagens: MensagemPronta[] }
  | { tipo: "tabela"; titulo: string; texto: string; colunas: string[]; linhas: string[][] }
  /** Tipo que esta versão do Deskcomm não sabe mostrar (`tipoRecebido` como veio). */
  | { tipo: "desconhecido"; titulo: string; texto: string; tipoRecebido: string };

export interface Painel {
  id: string;
  titulo: string;
  descricao: string;
  /** Como veio do serviço (ISO-8601); a tela formata. Vazio = não informado. */
  atualizado_em: string;
  secoes: SecaoDoPainel[];
}

/** O que a tela mostra quando não há painel para mostrar. */
export type EstadoSemPaineis =
  | "desligado" // sem gancho configurado nesta instalação
  | "sem_paineis" // o serviço respondeu 404: não oferece painéis
  | "recusado" // 401/403: a assinatura não confere
  | "indisponivel" // rede, prazo ou status fora de 2xx
  | "formato" // corpo que não é JSON, ou JSON cuja raiz não é objeto
  | "grande_demais"; // mais de 2 MB

export interface PaineisLidos {
  contrato: number | null;
  paineis: Painel[];
}

function secaoTipada(s: z.infer<typeof secaoSchema>): SecaoDoPainel {
  const tipo = s.tipo.trim().toLowerCase();
  if (tipo === "mensagens") {
    return { tipo: "mensagens", titulo: s.titulo, texto: s.texto, mensagens: s.mensagens };
  }
  if (tipo === "tabela") {
    return { tipo: "tabela", titulo: s.titulo, texto: s.texto, colunas: s.colunas, linhas: s.linhas };
  }
  return { tipo: "desconhecido", titulo: s.titulo, texto: s.texto, tipoRecebido: s.tipo };
}

/** A resposta do serviço, lida. `null` só quando a raiz não é um objeto JSON. */
export function lerPaineis(json: unknown): PaineisLidos | null {
  if (!objeto(json)) return null;
  const lido = respostaSchema.parse(json);
  return {
    contrato: lido.contrato,
    paineis: lido.paineis.map((p) => ({ ...p, secoes: p.secoes.map(secaoTipada) })),
  };
}

/**
 * "Atualizado em" no idioma e no fuso de quem olha. Data que não se lê vira
 * `null` (a tela não mostra a linha), nunca o texto cru do serviço.
 */
export function dataDoPainel(iso: string, tagDoIdioma: string, fuso: string): string | null {
  const bruto = iso.trim();
  if (bruto === "") return null;
  const instante = new Date(bruto);
  if (Number.isNaN(instante.getTime())) return null;
  return new Intl.DateTimeFormat(tagDoIdioma, { dateStyle: "short", timeStyle: "short", timeZone: fuso }).format(
    instante,
  );
}
