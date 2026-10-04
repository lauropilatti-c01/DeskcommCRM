/**
 * (C01, -c01.3, item 3a) TRAVA "LINK PERMITIDO": SÓ SAI O LINK QUE TEM DE ONDE VIR.
 *
 * O defeito: o modelo montava link — trocava o `?nivel=` da página de matrícula,
 * inventava caminho, colava o endereço de outra ênfase — e nada conferia. O link
 * errado leva o lead à página errada (ou a nenhuma), e é dinheiro na mesa.
 *
 * A trava libera três origens, e só elas:
 * 1. o link que a base da empresa devolveu NESTE turno (`urlsDaBase`, o mesmo conjunto
 *    que o vocabulário interno já usa);
 * 2. o link que já foi mandado nesta conversa (por pessoa da equipe ou pelo agente),
 *    lido uma vez por turno (`lerLinksJaEnviados`);
 * 3. qualquer link de um domínio da lista da organização (`dominios`, o domínio ou
 *    subdomínio dele).
 *
 * Fora disso, o veto ensina: "consulte a base e use o link exato". Trava de CONTEÚDO:
 * contador e fail-safe da promessa semântica (`TRAVAS_DE_CONTEUDO_COM_FAIL_SAFE` em
 * `inbound-turn.ts`) — no limite, o texto não sai e a conversa passa à equipe.
 *
 * Conta como link: com esquema (`https://`), com `www.` e domínio solto em caixa baixa
 * com sufixo conhecido (`lp.exemplo.com.br/...`, que o WhatsApp transforma em link).
 * E-mail não é link. A comparação ignora o esquema, o `www.`, a caixa do domínio, a
 * pontuação final, a barra final e a barra da raiz antes de `?` ou `#`; caminho,
 * parâmetros e fragmento contam como estão.
 *
 * (Rodada 2) O reconhecedor (`trechosDeLink`) é um só para esta trava e para o divisor
 * de mensagens (`split-message.ts`): o que a trava confere é exatamente o que o divisor
 * não parte. O domínio solto leva o caminho, os parâmetros e o fragmento também sem
 * barra depois do domínio (`lp.exemplo.com.br?nivel=…`): antes a trava via só o domínio,
 * e a raiz liberada pela base liberava o parâmetro inventado, e o divisor partia o
 * endereço no `?` (achado 4 da 1ª revisão adversarial da -c01.3).
 */
import type { Queryable } from '../queue/queue';
import type { Gate } from './before-send';

const SUFIXOS = 'com|net|org|br|io|app|tv|me|info|biz|edu|gov|co|link|site|online|store|shop|dev|ai|ly';
const RE_COM_ESQUEMA = /\bhttps?:\/\/[^\s<>"]+/gi;
const RE_WWW = /(?<![\w.@/-])www\.[^\s<>"]+/gi;
// O domínio não começa no meio de outro (letra, ponto, hífen) nem depois de `@` (e-mail).
const RE_DOMINIO_SOLTO = new RegExp(
  `(?<![\\w.@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${SUFIXOS})\\b(?:[/?#][^\\s<>"]*)?`,
  'g',
);
const PONTUACAO_FINAL = /[.,;:!?)\]}'"»]+$/;

/** Um link no texto: o intervalo [ini, fim) e o endereço, sem a pontuação colada no fim. */
export interface LinkNoTexto {
  ini: number;
  fim: number;
  link: string;
}

/** Os links do texto, na ordem, com o lugar de cada um — o reconhecedor da trava e do divisor. */
export function trechosDeLink(texto: string): LinkNoTexto[] {
  const achados: Array<LinkNoTexto & { fimDoAchado: number }> = [];
  for (const re of [RE_COM_ESQUEMA, RE_WWW, RE_DOMINIO_SOLTO]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(texto)) !== null) {
      const ini = m.index;
      // Pedaço de um link já achado (o domínio dentro do `https://...`): não conta de novo.
      if (achados.some((a) => ini >= a.ini && ini < a.fimDoAchado)) continue;
      const link = m[0].replace(PONTUACAO_FINAL, '');
      if (link.length > 0) achados.push({ ini, fim: ini + link.length, fimDoAchado: ini + m[0].length, link });
    }
  }
  return achados.sort((a, b) => a.ini - b.ini).map(({ ini, fim, link }) => ({ ini, fim, link }));
}

/** Os links do texto, na ordem, sem a pontuação colada no fim. */
export function linksNoTexto(texto: string): string[] {
  return trechosDeLink(texto).map((t) => t.link);
}

function partes(link: string): { host: string; resto: string } {
  const semEsquema = link.replace(PONTUACAO_FINAL, '').replace(/^https?:\/\//i, '');
  const corte = semEsquema.search(/[/?#]/);
  const host = (corte === -1 ? semEsquema : semEsquema.slice(0, corte)).toLowerCase().replace(/^www\./, '');
  const resto = corte === -1 ? '' : semEsquema.slice(corte);
  // A barra da raiz antes de `?` ou `#` não muda o endereço (`exemplo.com.br/?x=1` é
  // `exemplo.com.br?x=1`); a de um caminho (`/plano/?x=1`) fica.
  return { host, resto: resto.replace(/\/+$/, '').replace(/^\/+(?=[?#])/, '') };
}

/** A forma de comparar: sem esquema, sem `www.`, domínio em minúsculas, sem barra final. */
export function normalizarLink(link: string): string {
  const { host, resto } = partes(link);
  return `${host}${resto}`;
}

/** O domínio do link, em minúsculas e sem `www.` (vai ao trace: nunca o caminho). */
export function dominioDoLink(link: string): string {
  return partes(link).host;
}

/** O domínio como a organização escreveu → a forma de comparar (`exemplo.com.br`). */
export function normalizarDominio(dominio: string): string {
  return dominioDoLink(dominio.trim()).replace(/^\*\./, '');
}

export interface LinkPermitidoArmado {
  /** Links liberados (base do turno + já enviados na conversa), já normalizados. */
  liberados: ReadonlySet<string>;
  /** Domínios liberados pela organização, já normalizados. */
  dominios: readonly string[];
}

export function linkLiberado(link: string, trava: LinkPermitidoArmado): boolean {
  if (trava.liberados.has(normalizarLink(link))) return true;
  const host = dominioDoLink(link);
  return trava.dominios.some((d) => d.length > 0 && (host === d || host.endsWith(`.${d}`)));
}

export const linkPermitidoGate: Gate = {
  name: 'link_permitido',
  evaluate: (ctx) => {
    const trava = ctx.travasDeEnvio?.linkPermitido;
    if (trava === undefined) return { pass: true };
    const fora = linksNoTexto(ctx.body).filter((l) => !linkLiberado(l, trava));
    if (fora.length === 0) return { pass: true };
    return {
      pass: false,
      code: 'link_nao_permitido',
      reason: renderVetoDeLink(fora),
      // Só o domínio no trace: o caminho pode carregar identificador.
      detail: { links: fora.length, dominios: [...new Set(fora.map(dominioDoLink))].join(',') },
    };
  },
};

/** O erro de ensino: qual link e o que fazer. */
export function renderVetoDeLink(fora: readonly string[]): string {
  const quais = fora.map((l) => `"${l}"`).join(', ');
  return (
    `A mensagem NÃO foi enviada: ${fora.length === 1 ? 'o link' : 'os links'} ${quais} não ` +
    `${fora.length === 1 ? 'veio' : 'vieram'} da base nem ${fora.length === 1 ? 'foi mandado' : 'foram mandados'} ` +
    'antes nesta conversa. Não monte nem altere endereço: consulte a base e use o link exato que ela ' +
    'devolver, ou responda sem link.'
  );
}

/**
 * Os links já mandados nesta conversa (por qualquer pessoa ou pelo agente), normalizados.
 * `null` quando a leitura falha: quem chama desarma a trava no turno (proteção a mais
 * não pode calar o agente).
 */
export async function lerLinksJaEnviados(
  db: Queryable,
  input: { tenantId: string; conversationId: string },
): Promise<Set<string> | null> {
  try {
    const { rows } = await db.query<{ body: string | null }>(
      `select body
         from messages
        where organization_id = $1
          and conversation_id = $2
          and direction = 'outbound'
          and body is not null
        order by created_at desc
        limit 500`,
      [input.tenantId, input.conversationId],
    );
    const links = new Set<string>();
    for (const row of rows) {
      if (typeof row.body !== 'string') continue;
      for (const link of linksNoTexto(row.body)) links.add(normalizarLink(link));
    }
    return links;
  } catch {
    return null;
  }
}
