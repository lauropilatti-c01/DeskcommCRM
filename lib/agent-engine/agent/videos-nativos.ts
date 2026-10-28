/** V1/V3 C01: catálogo privado, desligado por padrão e sem dependência de DDL.
 * Nenhuma escolha comercial mora aqui. A configuração aprovada da organização
 * associa chaves a hashes de arquivos; os objetos ficam no bucket já existente.
 * O envio continua no handler comum, com seus guardas, assinatura curta e ledger.
 */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ChannelSendResult } from '../channel-adapter';
import type { Queryable } from '../queue/queue';
import { OK_KINDS } from './split-message';

const itemSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const policySchema = z.object({
  enabled: z.boolean(),
  flow_mp4: z.boolean().default(false),
  // (C01, 27/10) Público da resposta ao lead: sem `audience`, só os celulares de teste (lista vazia =
  // ninguém). Ligar para todos é explícito. Não vale para `flow_mp4` (acompanhamento, URL do operador).
  audience: z.enum(['somente_celulares_de_teste', 'todos']).default('somente_celulares_de_teste'),
  testPhones: z.array(z.string().regex(/^\+[1-9][0-9]{7,14}$/)).max(100).default([]),
  catalog: z.array(itemSchema).max(100),
}).strict().refine(p => new Set(p.catalog.map(v => v.key)).size === p.catalog.length);
export type PoliticaDeVideo = z.infer<typeof policySchema>;
const desligada = (): PoliticaDeVideo => ({ enabled: false, flow_mp4: false, audience: 'somente_celulares_de_teste', testPhones: [], catalog: [] });
/** Telefone em E.164 (`+55…`); `null` (contato sem telefone) só passa com público `todos`. */
export const videoParaOTelefone = (p: PoliticaDeVideo, telefone: string | null): boolean =>
  p.enabled && (p.audience === 'todos' || (telefone !== null && p.testPhones.includes(telefone)));
const BUCKET = 'whatsapp-media';
/** Limite conservador desta capacidade; não muda o limite geral do Inbox. Lauro, 27/10: 15 MB no WhatsApp. */
export const MAX_VIDEO_NATIVO_BYTES = 15_000_000;
export const MAX_LEGENDA_VIDEO = 1024;
export const legendaDoVideoValida = (body: string): boolean => !!body.trim() && body.length <= MAX_LEGENDA_VIDEO;
function politicaDoValor(raw: unknown): PoliticaDeVideo {
  const parsed = policySchema.safeParse(raw);
  return parsed.success ? parsed.data : desligada();
}

/** Mesma política para o executor inline; ausência/erro permanece OFF. */
export async function lerPoliticaDeVideoSupabase(admin: SupabaseClient, tenantId: string): Promise<PoliticaDeVideo> {
  try {
    const { data, error } = await admin.from('organizations').select('settings').eq('id', tenantId).maybeSingle();
    return error ? desligada() : politicaDoValor(data?.settings?.c01_native_videos);
  } catch { return desligada(); }
}

export async function lerPoliticaDeVideo(db: Queryable, tenantId: string): Promise<PoliticaDeVideo> {
  try {
    const { rows } = await db.query<{ policy: unknown }>(
      "select settings->'c01_native_videos' as policy from organizations where id = $1",
      [tenantId],
    );
    return politicaDoValor(rows[0]?.policy);
  } catch { return desligada(); }
}

export type VideoParaEnvio = { storagePath: string; mime: 'video/mp4'; type: 'video' };
/** No mesmo job, regenerar a legenda não transforma o mesmo arquivo em outro envio. */
export const IDENTIDADE_DA_LEGENDA_DO_VIDEO = '';
export type CopiarVideo = (source: string, destination: string, sha256: string) => Promise<boolean>;
type VideoPreparado = { ok: true; media: VideoParaEnvio } | { ok: false; code: string; message: string };
const recusado = (code: string, message: string): VideoPreparado => ({ ok: false, code, message });

/** Confere bytes, MIME e identidade. A extensão sozinha nunca prova um MP4. */
export function validarVideoMp4(bytes: Uint8Array, mime: string, sha256: string): boolean {
  if (mime.split(';')[0]?.trim().toLowerCase() !== 'video/mp4') return false;
  if (bytes.byteLength < 16 || bytes.byteLength > MAX_VIDEO_NATIVO_BYTES) return false;
  const b = Buffer.from(bytes);
  const boxSize = b.readUInt32BE(0);
  if (b.toString('ascii', 4, 8) !== 'ftyp' || boxSize < 16 || boxSize > b.length) return false;
  const brands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'avc1', 'mp41', 'mp42', 'M4V ']);
  if (!brands.has(b.toString('ascii', 8, 12))) return false;
  return createHash('sha256').update(b).digest('hex') === sha256;
}

/** Valida a origem antes de gravar a cópia imutável pertencente à conversa.
 * Em conflito, confere o objeto existente: 409 não é prova de identidade.
 */
export function copiarVideoNoStorage(): CopiarVideo {
  return async (source, destination, sha256) => {
    const storage = createAdminClient().storage.from(BUCKET);
    const downloaded = await storage.download(source);
    if (downloaded.error || !downloaded.data || downloaded.data.size > MAX_VIDEO_NATIVO_BYTES) return false;
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    if (!validarVideoMp4(bytes, downloaded.data.type, sha256)) return false;
    const uploaded = await storage.upload(destination, bytes, { contentType: 'video/mp4', upsert: false });
    if (!uploaded.error) return true;
    if (!/already exists|duplicate/i.test(uploaded.error.message) && String((uploaded.error as { statusCode?: string }).statusCode) !== '409') return false;
    const existing = await storage.download(destination);
    if (existing.error || !existing.data || existing.data.size > MAX_VIDEO_NATIVO_BYTES) return false;
    return validarVideoMp4(new Uint8Array(await existing.data.arrayBuffer()), existing.data.type, sha256);
  };
}

export async function prepararVideoNativo(
  db: Queryable, copiar: CopiarVideo,
  input: { tenantId: string; conversationId: string; chave: string; telefone?: string | null },
): Promise<VideoPreparado> {
  // IDs do turno, nunca segmentos escolhidos pelo modelo. Também protege fixtures
  // ou callers futuros que passem caminho em vez de identificador.
  if (!z.uuid().safeParse(input.tenantId).success || !z.uuid().safeParse(input.conversationId).success) {
    return recusado('video_destino_invalido', 'Não foi possível preparar o vídeo nesta conversa.');
  }
  const policy = await lerPoliticaDeVideo(db, input.tenantId);
  if (!videoParaOTelefone(policy, input.telefone ?? null)) return recusado('video_desligado', 'O envio de vídeo nativo está desligado. Não anuncie um vídeo anexado.');
  const item = policy.catalog.find(v => v.key === input.chave);
  if (!item) return recusado('video_nao_cadastrado', 'A chave não corresponde a um vídeo aprovado desta organização. Não anuncie um vídeo anexado.');
  const source = `${input.tenantId}/native-videos/${item.sha256}.mp4`;
  const destination = `${input.tenantId}/${input.conversationId}/video-${item.sha256}.mp4`;
  try {
    if (await copiar(source, destination, item.sha256)) {
      return { ok: true, media: { storagePath: destination, mime: 'video/mp4', type: 'video' } };
    }
  } catch { /* Falha de mídia nunca degrada para a legenda isolada. */ }
  return recusado('video_indisponivel', 'O vídeo não pôde ser preparado; nenhuma legenda foi enviada. Não diga que o vídeo chegou.');
}

/** Uma mensagem indivisível: nunca legenda seguida de um envio separado de vídeo. */
export async function enviarVideoComLegenda(
  body: string, media: VideoParaEnvio,
  enviar: (body: string, media: VideoParaEnvio) => Promise<ChannelSendResult>,
): Promise<ChannelSendResult> {
  if (!legendaDoVideoValida(body)) {
    return { kind: 'unavailable', reason: 'video_legenda_invalida: use de 1 a 1024 caracteres; nada foi enviado' };
  }
  return enviar(body, media);
}

/** (C01, -c01.12) Onde o vídeo entra entre as bolhas do turno (`null` = o vídeo): todas menos a última, o vídeo e a
 * última sozinha, que é a pergunta (Lauro, 28/10). Com uma bolha só, ela vai antes do vídeo. */
export const ordemComVideo = (bolhas: readonly string[]): Array<string | null> =>
  bolhas.length <= 1 ? [...bolhas, null] : [...bolhas.slice(0, -1), null, bolhas[bolhas.length - 1]!];

/** (C01, -c01.12) O texto em bolhas e o vídeo sem legenda (o texto do turno não vai mais como legenda), na
 * `ordemComVideo`. Para no primeiro desfecho que não é de sucesso, como `sendInBubbles`. */
export async function enviarComVideo<R extends { kind: string }>(
  bolhas: readonly string[],
  o: { enviarTexto: (bolha: string) => Promise<R>; enviarVideo: () => Promise<R>; pausa: (proxima: string | null) => Promise<void> },
): Promise<R> {
  let ultimo: R | undefined;
  const ordem = ordemComVideo(bolhas);
  for (let i = 0; i < ordem.length; i++) {
    if (i > 0) await o.pausa(ordem[i]!);
    ultimo = ordem[i] === null ? await o.enviarVideo() : await o.enviarTexto(ordem[i]!);
    if (!OK_KINDS.has(ultimo.kind)) return ultimo;
  }
  return ultimo!;
}
