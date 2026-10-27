/** C01: biblioteca de imagens que vão junto da página de pagamento. Desligada por padrão.
 *
 * A fonte é a biblioteca do crm-agentico (`lab/imagens/biblioteca.yaml`), publicada em
 * `organizations.settings.c01_imagens` pelo `publicar.py`. A Marina não escolhe a imagem:
 * o sistema anexa quando o texto que vai sair leva um link que a consulta `agente_pagina`
 * desta resposta devolveu para um plano da ficha. A imagem é uma mensagem própria, sem
 * legenda, antes do texto, e conta no teto de mensagens do turno. Sem vaga, sem arquivo
 * válido ou com qualquer dúvida, sai só o texto, e o motivo vai ao log.
 * Contrato e casos: docs/c01/biblioteca-de-imagens.md.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import { linksNoTexto, normalizarLink } from '../guardrails/link-permitido';
import type { Queryable } from '../queue/queue';
import { OK_KINDS } from './split-message';

export const MAX_IMAGEM_BYTES = 5 * 1024 * 1024;
const MAX_LADO = 4096;
const BUCKET = 'whatsapp-media';
const CHAVE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA = /^[a-f0-9]{64}$/;
const MIME = z.enum(['image/png', 'image/jpeg']);
// 600 em unidades UTF-16 (o `.length` do JS), não em code points; só espaços não conta.
const DESCRICAO = z.string().refine(d => d.trim().length > 0 && d.length <= 600);
const EXTENSAO = { 'image/png': 'png', 'image/jpeg': 'jpg' } as const;
export const AUDIENCIA_RESTRITA = 'somente_celulares_de_teste';

const itemSchema = z.object({
  key: z.string().regex(CHAVE),
  version: z.number().int().min(1),
  sha256: z.string().regex(SHA),
  mime: MIME,
  bytes: z.number().int().min(1).max(MAX_IMAGEM_BYTES),
  width: z.number().int().min(1).max(MAX_LADO),
  height: z.number().int().min(1).max(MAX_LADO),
  triggers: z.array(z.literal('pagina_de_pagamento')).min(1).max(1),
  position: z.literal('antes_do_texto'),
  frequency: z.enum(['sempre', 'primeira_vez']),
  plans: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,199}$/)).min(1).max(100).refine(p => new Set(p).size === p.length),
  description: DESCRICAO,
}).strict();
const policySchema = z.object({
  enabled: z.boolean(),
  audience: z.enum([AUDIENCIA_RESTRITA, 'todos']),
  connectionId: z.uuid().nullable(),
  testPhones: z.array(z.string().regex(/^\+[1-9]\d{7,14}$/)).max(100).refine(t => new Set(t).size === t.length),
  items: z.array(itemSchema).max(100),
  /** Versões anteriores já publicadas: só para retomar o que o ledger já tem e para o histórico.
   * Nunca elegíveis para envio novo; podem repetir plano das atuais. */
  previous: z.array(itemSchema).max(100).optional(),
}).strict().superRefine((p, ctx) => {
  if (new Set(p.items.map(i => i.key)).size !== p.items.length) ctx.addIssue({ code: 'custom', message: 'key repetida' });
  const triplas = [...p.items, ...(p.previous ?? [])].map(i => `${i.key}|${i.version}|${i.sha256}`);
  if (new Set(triplas).size !== triplas.length) ctx.addIssue({ code: 'custom', message: 'versão anterior repetida ou igual à atual' });
  const ocupado = new Set<string>();
  for (const i of p.items) for (const t of i.triggers) for (const plano of i.plans) {
    if (ocupado.has(`${t}|${plano}`)) ctx.addIssue({ code: 'custom', message: `duas imagens para ${t} no plano ${plano}` });
    ocupado.add(`${t}|${plano}`);
  }
  if (p.enabled && p.connectionId === null) ctx.addIssue({ code: 'custom', message: 'ligada sem connectionId' });
  if (p.enabled && p.audience === AUDIENCIA_RESTRITA && p.testPhones.length === 0)
    ctx.addIssue({ code: 'custom', message: 'público restrito sem celulares de teste' });
});
export type PoliticaDeImagens = z.infer<typeof policySchema>;
export type ItemDeImagem = z.infer<typeof itemSchema>;
const desligada = (): PoliticaDeImagens => ({ enabled: false, audience: AUDIENCIA_RESTRITA, connectionId: null, testPhones: [], items: [] });

/** O contrato aceita esta configuração como está (ligada ou desligada)? */
export const politicaValida = (raw: unknown): boolean => policySchema.safeParse(raw).success;

/** Ausente, inválida ou ilegível = desligada. */
export function politicaDeImagens(raw: unknown): PoliticaDeImagens {
  const parsed = policySchema.safeParse(raw);
  return parsed.success ? parsed.data : desligada();
}

/** A política que vale neste turno: só resposta ao lead (`eTurnoDeResposta`) e a prévia. O
 * acompanhamento automático (`followup_turn`) fica fora do contrato, então nem lê a política. */
export async function politicaDoTurno(
  turno: { resposta: boolean; preview: boolean }, ler: () => Promise<PoliticaDeImagens>,
): Promise<PoliticaDeImagens> {
  return turno.resposta || turno.preview ? ler() : desligada();
}

export async function lerPoliticaDeImagens(db: Queryable, tenantId: string): Promise<PoliticaDeImagens> {
  try {
    const { rows } = await db.query<{ policy: unknown }>(
      "select settings->'c01_imagens' as policy from organizations where id = $1",
      [tenantId],
    );
    return politicaDeImagens(rows[0]?.policy);
  } catch { return desligada(); }
}

/** A consulta à página precisa trazer plano e links mesmo se o modelo pediu menos colunas. */
export function completarConsultaDaPagina(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const a = input as Record<string, unknown>;
  if (a.tabela !== 'agente_pagina' || (a.schema !== undefined && a.schema !== 'c01') || !Array.isArray(a.colunas)) return input;
  return { ...a, colunas: [...new Set([...a.colunas, 'enfase_id', 'plano_id', 'pode_afirmar', 'link_cartao', 'link_sem_cartao'])] };
}

export type PaginaConsultada = { planoId: string; enfaseId: string; urls: string[] };

/** As páginas que a consulta `agente_pagina` desta resposta devolveu, pela conexão aprovada.
 * Mesmo envelope que `ofertasDaConsultaC01`; repetido aqui para não mudar quem já usa aquela. */
export function paginasDaConsulta(input: unknown, output: unknown, connectionId: string | null): PaginaConsultada[] {
  if (!connectionId || !input || typeof input !== 'object' || !output || typeof output !== 'object') return [];
  const envelope = output as Record<string, unknown>;
  if (envelope.isError) return [];
  let r: unknown = envelope.structuredContent ?? envelope;
  if (!envelope.structuredContent && Array.isArray(envelope.content)) {
    const partes = envelope.content.filter((p: { type?: string }) => p?.type === 'text');
    if (partes.length !== 1 || typeof partes[0]?.text !== 'string') return [];
    try { r = JSON.parse(partes[0].text); } catch { return []; }
  }
  const res = r as Record<string, unknown> | null;
  if (!res || typeof res !== 'object' || res.erro || res.isError || res.truncado || res.schema !== 'c01'
    || res.tabela !== 'agente_pagina' || (res.conexao as { id?: string })?.id !== connectionId || !Array.isArray(res.linhas)) return [];
  const filtros = Array.isArray((input as Record<string, unknown>).filtros) ? (input as { filtros: Record<string, unknown>[] }).filtros : [];
  const enfases = filtros.filter(f => f.coluna === 'enfase_id' && f.operador === 'eq' && typeof f.valor === 'string').map(f => f.valor as string);
  if (new Set(enfases).size !== 1) return [];
  const enfaseId = enfases[0]!;
  return res.linhas.flatMap((raw: unknown) => {
    const row = raw as Record<string, unknown> | null;
    if (!row || typeof row !== 'object' || row.pode_afirmar !== true || row.enfase_id !== enfaseId) return [];
    if (typeof row.plano_id !== 'string' || !row.plano_id) return [];
    const urls = [row.link_cartao, row.link_sem_cartao].filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u));
    return urls.length ? [{ planoId: row.plano_id, enfaseId, urls }] : [];
  });
}

/** Telefone do contato no formato dos celulares de teste (+ e só dígitos). */
export const telefoneE164 = (raw: string | null | undefined): string | null => {
  const digitos = String(raw ?? '').replace(/\D/g, '');
  return digitos.length >= 8 ? `+${digitos}` : null;
};

/** O texto cita a URL exata (mesma normalização da trava de link): `…/vitalicio` não casa com `…/vitalicio-anual`. */
export function citaAlgumLink(corpo: string, urls: readonly string[]): boolean {
  const noTexto = new Set(linksNoTexto(corpo).map(normalizarLink));
  return urls.some(u => noTexto.has(normalizarLink(u)));
}

/** A ênfase gravada no card (`produto_chave`, a mesma chave que `agente_pagina.enfase_id`).
 * Vazio ou ausente = card sem ênfase, que não contradiz nada. */
export function enfaseDoCard(card: { campos: Record<string, unknown> } | null): string | null {
  const v = card?.campos.produto_chave;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export type Escolha =
  | { item: ItemDeImagem; pagina: PaginaConsultada }
  | { item: null; motivo: string };

/** Qual imagem vai junto deste texto, ou por que nenhuma vai. `motivo: 'sem_pagina'` é o caso comum. */
export function escolherImagem(input: {
  politica: PoliticaDeImagens; paginas: readonly PaginaConsultada[]; corpo: string;
  /** `false` = card ilegível: na dúvida, a imagem não vai. */
  telefone: string | null; enfaseDoCard?: string | null | false;
}): Escolha {
  const { politica: p } = input;
  if (!p.enabled) return { item: null, motivo: 'desligada' };
  if (p.audience === AUDIENCIA_RESTRITA && (!input.telefone || !p.testPhones.includes(input.telefone)))
    return { item: null, motivo: 'fora_dos_celulares_de_teste' };
  const citadas = input.paginas.filter(pg => citaAlgumLink(input.corpo, pg.urls));
  if (citadas.length === 0) return { item: null, motivo: 'sem_pagina' };
  if (input.enfaseDoCard === false) return { item: null, motivo: 'card_ilegivel' };
  if (input.enfaseDoCard && citadas.some(pg => pg.enfaseId !== input.enfaseDoCard))
    return { item: null, motivo: 'card_contradiz_consulta' };
  const achadas = new Map<string, { item: ItemDeImagem; pagina: PaginaConsultada }>();
  for (const pg of citadas) for (const item of p.items)
    if (item.triggers.includes('pagina_de_pagamento') && item.plans.includes(pg.planoId)) achadas.set(item.key, { item, pagina: pg });
  if (achadas.size === 0) return { item: null, motivo: 'plano_sem_imagem' };
  if (achadas.size > 1) return { item: null, motivo: 'mais_de_uma_imagem' };
  return [...achadas.values()][0]!;
}

/** O que o canal recebe: o mesmo formato da foto do catálogo (o handler já sabe mandar). */
export type ImagemParaEnvio = { storagePath: string; mime: 'image/png' | 'image/jpeg' };
export type ImagemEscolhida = { key: string; version: number; sha256: string; description: string; media: ImagemParaEnvio };
type Versao = Pick<ItemDeImagem, 'version' | 'sha256' | 'mime' | 'description'>;

export const origemNaBiblioteca = (org: string, v: Pick<Versao, 'sha256' | 'mime'>): string =>
  `${org}/biblioteca-imagens/${v.sha256}.${EXTENSAO[v.mime]}`;
export const destinoNaConversa = (org: string, conv: string, key: string, v: Pick<Versao, 'sha256' | 'mime'>): string =>
  `${org}/${conv}/imagem-${key}-${v.sha256}.${EXTENSAO[v.mime]}`;
const MARCA_NO_CAMINHO = /\/imagem-([a-z0-9][a-z0-9-]{0,62})-([a-f0-9]{64})\.(png|jpg)$/;

/** O que vai a `metadata.c01_imagem` da mensagem: a versão que saiu, com a descrição dela. */
export const retratoDaImagem = (i: ImagemEscolhida): { key: string; version: number; sha256: string; description: string } =>
  ({ key: i.key, version: i.version, sha256: i.sha256, description: i.description });

const escolhida = (org: string, conv: string, key: string, v: Versao): ImagemEscolhida => ({
  key, version: v.version, sha256: v.sha256, description: v.description,
  media: { storagePath: destinoNaConversa(org, conv, key, v), mime: v.mime },
});

/** Versão fixada: se a execução já registrou uma versão desta imagem no ledger (aceita ou
 * pendente), a retomada manda a mesma, mesmo que a v2 tenha sido publicada no meio.
 * `conhecida` = o ledger já tem esta identidade. */
export async function versaoDaTentativa(
  politica: PoliticaDeImagens, item: ItemDeImagem, ids: { tenantId: string; conversationId: string },
  jaNoJob: (media: ImagemParaEnvio) => Promise<boolean>,
): Promise<{ imagem: ImagemEscolhida; conhecida: boolean }> {
  const atual = escolhida(ids.tenantId, ids.conversationId, item.key, item);
  if (await jaNoJob(atual.media)) return { imagem: atual, conhecida: true };
  for (const anterior of (politica.previous ?? []).filter(v => v.key === item.key && v.sha256 !== item.sha256)) {
    const candidata = escolhida(ids.tenantId, ids.conversationId, item.key, anterior);
    if (await jaNoJob(candidata.media)) return { imagem: candidata, conhecida: true };
  }
  return { imagem: atual, conhecida: false };
}

/** `primeira_vez`: o registro da conversa inteira (não só o que a Marina lê), qualquer versão. */
export async function jaRecebeuNaConversa(db: Queryable, ids: { tenantId: string; conversationId: string }, key: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from messages where organization_id = $1 and conversation_id = $2 and direction = 'outbound'
       and media_storage_path like $3 and status <> 'failed' limit 1`,
    [ids.tenantId, ids.conversationId, `${ids.tenantId}/${ids.conversationId}/imagem-${key}-%`],
  );
  return rows.length > 0;
}

/** Confere bytes, assinatura do formato e identidade. A extensão sozinha não prova nada. */
export function validarImagem(bytes: Uint8Array, mime: string, sha256: string): boolean {
  const tipo = mime.split(';')[0]?.trim().toLowerCase();
  if (bytes.byteLength < 8 || bytes.byteLength > MAX_IMAGEM_BYTES) return false;
  const b = Buffer.from(bytes);
  const png = b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (!((tipo === 'image/png' && png) || (tipo === 'image/jpeg' && jpeg))) return false;
  return createHash('sha256').update(b).digest('hex') === sha256;
}

export type CopiarImagem = (origem: string, destino: string, sha256: string, mime: string) => Promise<boolean>;

/** Copia da biblioteca para a pasta da conversa, sem sobrescrever; conflito confere os bytes. */
export function copiarImagemNoStorage(): CopiarImagem {
  return async (origem, destino, sha256, mime) => {
    const storage = createAdminClient().storage.from(BUCKET);
    const baixado = await storage.download(origem);
    if (baixado.error || !baixado.data || baixado.data.size > MAX_IMAGEM_BYTES) return false;
    const bytes = new Uint8Array(await baixado.data.arrayBuffer());
    // O tipo do Storage pode vir genérico; vale o mime aprovado na ficha, conferido pela assinatura.
    if (!validarImagem(bytes, mime, sha256)) return false;
    const subiu = await storage.upload(destino, bytes, { contentType: mime, upsert: false });
    if (!subiu.error) return true;
    if (!/already exists|duplicate/i.test(subiu.error.message) && String((subiu.error as { statusCode?: string }).statusCode) !== '409') return false;
    const existente = await storage.download(destino);
    if (existente.error || !existente.data || existente.data.size > MAX_IMAGEM_BYTES) return false;
    return validarImagem(new Uint8Array(await existente.data.arrayBuffer()), mime, sha256);
  };
}

const versoesDa = (politica: PoliticaDeImagens, key: string): ItemDeImagem[] =>
  [...politica.items, ...(politica.previous ?? [])].filter(v => v.key === key);

export async function prepararImagem(
  copiar: CopiarImagem, ids: { tenantId: string; conversationId: string }, imagem: ImagemEscolhida, politica: PoliticaDeImagens,
): Promise<{ ok: true } | { ok: false; motivo: string }> {
  if (!z.uuid().safeParse(ids.tenantId).success || !z.uuid().safeParse(ids.conversationId).success)
    return { ok: false, motivo: 'destino_invalido' };
  const versao = versoesDa(politica, imagem.key).find(v => v.version === imagem.version && v.sha256 === imagem.sha256);
  if (!versao) return { ok: false, motivo: 'versao_desconhecida' };
  try {
    if (await copiar(origemNaBiblioteca(ids.tenantId, versao), imagem.media.storagePath, versao.sha256, versao.mime)) return { ok: true };
  } catch { /* falha de mídia: sai só o texto */ }
  return { ok: false, motivo: 'arquivo_indisponivel' };
}

/** A imagem antes do texto, contando no teto. Sem vaga para a imagem E para todas as bolhas
 * do texto, ela não sai (o teto e o texto ficam como seriam). Devolve o desfecho que para a
 * resposta inteira (bloqueio, canal fora, como nas fotos) ou `null` para o texto seguir;
 * falha registrada da imagem não segura a página. */
export async function enviarImagemAntes<R extends { kind: string }>(
  imagem: ImagemEscolhida,
  o: {
    restantes: () => number; bolhasDoTexto: number; jaRegistrada?: () => Promise<boolean>;
    enviarImagem: () => Promise<R>; sleep: (ms: number) => Promise<void>; jitter: () => number;
    registrar: (desfecho: string, extra?: Record<string, unknown>) => void;
  },
): Promise<R | null> {
  const conhecida = (await o.jaRegistrada?.()) === true;
  if (!conhecida && o.restantes() < o.bolhasDoTexto + 1) {
    o.registrar('sem_vaga', { restantes: o.restantes(), bolhas: o.bolhasDoTexto });
    return null;
  }
  const r = await o.enviarImagem();
  if (r.kind === 'blocked' || r.kind === 'unavailable') return r;
  o.registrar(OK_KINDS.has(r.kind) ? 'enviada' : 'falhou', { kind: r.kind, key: imagem.key, version: imagem.version });
  await o.sleep(o.jitter());
  return null;
}

export type ImagemPreparada = { imagem: ImagemEscolhida; links: readonly string[] };
type Log = (msg: string, extra: Record<string, unknown>) => void;

/** A ligação do turno, antes da cadeia: escolhe, aplica `primeira_vez`, fixa a versão e prepara o
 * arquivo. `null` = sai só o texto (o motivo vai ao log; `sem_pagina` é o caso comum e não loga). */
export async function prepararImagemDaResposta(o: {
  politica: PoliticaDeImagens; paginas: readonly PaginaConsultada[]; corpo: string; telefone: string | null;
  /** Lida aqui, não no início do turno: `update_lead_field` do próprio turno pode ter mudado o card. */
  lerEnfaseDoCard: () => Promise<string | null | false>; ids: { tenantId: string; conversationId: string };
  jaRecebeu: (key: string) => Promise<boolean>; jaNoJob: (media: ImagemParaEnvio) => Promise<boolean>;
  copiar: CopiarImagem; log: Log;
}): Promise<ImagemPreparada | null> {
  const escolha = await escolherComCard(o);
  if (escolha.item === null) {
    if (escolha.motivo !== 'sem_pagina') o.log('imagem da página não vai', { motivo: escolha.motivo });
    return null;
  }
  const { imagem, conhecida } = await versaoDaTentativa(o.politica, escolha.item, o.ids, o.jaNoJob);
  // Tentativa já registrada (aceita ou pendente): a mesma identidade volta ao ledger, que reconcilia
  // sem novo envio. Nem `primeira_vez` (a própria linha dela contaria) nem nova cópia (o arquivo já
  // está na conversa; origem ausente agora não pode largar o recibo pendente).
  if (conhecida) return { imagem, links: escolha.pagina.urls };
  // Leitura que falha conta como "já recebeu": na dúvida, não repete.
  if (escolha.item.frequency === 'primeira_vez' && await o.jaRecebeu(escolha.item.key).catch(() => true)) {
    o.log('imagem da página não vai', { motivo: 'ja_recebeu', key: escolha.item.key });
    return null;
  }
  const preparada = await prepararImagem(o.copiar, o.ids, imagem, o.politica);
  if (!preparada.ok) {
    o.log('imagem da página não vai', { motivo: preparada.motivo, key: imagem.key, version: imagem.version });
    return null;
  }
  return { imagem, links: escolha.pagina.urls };
}

/** A escolha com o card lido na hora; sem página citada, nem lê o card. */
export async function escolherComCard(o: {
  politica: PoliticaDeImagens; paginas: readonly PaginaConsultada[]; corpo: string; telefone: string | null;
  lerEnfaseDoCard: () => Promise<string | null | false>;
}): Promise<Escolha> {
  const sem = escolherImagem(o);
  if (sem.item === null) return sem;
  return escolherImagem({ ...o, enfaseDoCard: await o.lerEnfaseDoCard().catch(() => false as const) });
}

/** A ligação do turno, depois da cadeia: a imagem só vai se o link da consulta sobreviveu no texto final. */
export async function enviarImagemDaPagina<R extends { kind: string }>(
  preparada: ImagemPreparada | null, textoFinal: string,
  o: Omit<Parameters<typeof enviarImagemAntes<R>>[1], 'enviarImagem' | 'jaRegistrada'> & {
    enviar: (corpo: string, media: ImagemParaEnvio) => Promise<R>; conhecido: (media: ImagemParaEnvio) => Promise<boolean>;
  },
): Promise<R | null> {
  if (preparada === null || !citaAlgumLink(textoFinal, preparada.links)) return null;
  const { imagem } = preparada;
  return enviarImagemAntes(imagem, { ...o, jaRegistrada: () => o.conhecido(imagem.media), enviarImagem: () => o.enviar('', imagem.media) });
}

/** O retrato vai em qualquer envio daquela mídia, inclusive o da retomada com o teto cheio. */
export const retratoDoEnvio = (preparada: ImagemPreparada | null, media: unknown): { c01Imagem?: ReturnType<typeof retratoDaImagem> } =>
  preparada && media && typeof media === 'object' && 'storagePath' in media && media.storagePath === preparada.imagem.media.storagePath
    ? { c01Imagem: retratoDaImagem(preparada.imagem) } : {};

const ESTADO: Record<string, string> = { sent: 'aceita', delivered: 'entregue', read: 'entregue', failed: 'falhou' };

const retratoSchema = itemSchema.pick({ key: true, version: true, sha256: true, description: true });

/** Como a imagem enviada pelo atendimento aparece no histórico da Marina. Nunca como mídia do cliente.
 * A descrição vem do retrato gravado na própria mensagem (`metadata.c01_imagem`), não da ficha atual;
 * retrato ausente ou que não bate com o caminho = sem descrição. */
export function marcaDaImagemEnviada(
  row: { direction: string; media_storage_path: string | null; status?: string | null; c01_imagem?: unknown },
): string | null {
  if (row.direction !== 'outbound' || !row.media_storage_path) return null;
  const m = MARCA_NO_CAMINHO.exec(row.media_storage_path);
  if (!m) return null;
  const [, key, sha] = m;
  const r = retratoSchema.safeParse(row.c01_imagem);
  const estado = ESTADO[row.status ?? ''] ?? 'enviando';
  return r.success && r.data.key === key && r.data.sha256 === sha
    ? `[Você mandou esta imagem antes do link (imagem ${key}, v${r.data.version}, ${estado}): ${r.data.description}]`
    : `[Você mandou a imagem ${key} antes do link (${estado}); a descrição desta versão não ficou registrada.]`;
}

/** A marca vale para qualquer organização com caminho `imagem-<key>-<sha>`. */
export const eImagemDaBiblioteca = (path: string | null | undefined): boolean => !!path && MARCA_NO_CAMINHO.test(path);
