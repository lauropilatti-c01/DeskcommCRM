/** Leitura mínima para conciliação; nunca confirma compra nem modifica o CRM. */
import type pg from "pg";
import { z } from "zod";

export const MAX_SNAPSHOT_ROWS = 20_000;
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const uuid = z.uuid();
const date = z.iso.datetime({ offset: true });
const snapshotSchema = z
  .object({
    schema: z.literal(1),
    complete: z.literal(true),
    organization_id: uuid,
    collected_at: date,
    contacts: z
      .array(
        z
          .object({
            id: uuid,
            organization_id: uuid,
            phone_number: z.string().max(64).nullable(),
            email: z.string().max(320).nullable(),
          })
          .strict(),
      )
      .max(MAX_SNAPSHOT_ROWS),
    opportunities: z
      .array(
        z
          .object({
            id: uuid,
            organization_id: uuid,
            contact_id: uuid.nullable(),
            status: z.enum(["open", "won", "lost"]),
            created_at: date,
            custom_fields: z
              .object({
                produto_chave: z.string().max(500).nullable(),
                plano_oferecido: z.string().max(500).nullable(),
              })
              .strict(),
            product_keys: z.array(z.never()).length(0),
          })
          .strict(),
      )
      .max(MAX_SNAPSHOT_ROWS),
  })
  .strict();

// Todas as pessoas são necessárias: duplicidade de telefone/e-mail impede
// conciliação automática. Todas as oportunidades preservam ambiguidade/replay.
// O limite + 1 detecta truncamento; nunca anunciamos esse recorte como completo.
const SQL = `WITH pessoas AS MATERIALIZED (
  SELECT id, organization_id, phone_number, email FROM contacts
  WHERE organization_id = $1 ORDER BY id LIMIT $2
), negocios AS MATERIALIZED (
  SELECT id, organization_id, contact_id, status, created_at,
    jsonb_build_object('produto_chave', custom_fields->'produto_chave',
      'plano_oferecido', custom_fields->'plano_oferecido') AS custom_fields,
    '[]'::jsonb AS product_keys
  FROM crm_leads WHERE organization_id = $1 ORDER BY id LIMIT $2
)
SELECT jsonb_build_object('schema', 1, 'complete', true, 'organization_id', $1::uuid,
  'collected_at', now(),
  'contacts', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM pessoas p), '[]'::jsonb),
  'opportunities', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM negocios n), '[]'::jsonb)
) AS snapshot`;

export async function lerRetratoFinanceiro(pool: pg.Pool, organizationId: string) {
  let db: pg.PoolClient | undefined;
  let discard = false;
  try {
    uuid.parse(organizationId);
    db = await pool.connect();
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET LOCAL statement_timeout = '20s'");
    await db.query("SET LOCAL lock_timeout = '3s'");
    // Se a conexão não puder enxergar a organização inteira, RLS deve dar
    // erro, nunca ocultar linhas e transformar um retrato parcial em completo.
    await db.query("SET LOCAL row_security = off");
    const result = await db.query<{ snapshot: unknown }>(SQL, [
      organizationId,
      MAX_SNAPSHOT_ROWS + 1,
    ]);
    if (result.rows.length !== 1) throw new Error("incomplete");
    const photo = snapshotSchema.parse(result.rows[0]!.snapshot);
    const age = Date.now() - Date.parse(photo.collected_at);
    if (
      photo.organization_id !== organizationId ||
      age < -5_000 ||
      age > 120_000 ||
      Buffer.byteLength(JSON.stringify({ data: photo })) > MAX_SNAPSHOT_BYTES
    )
      throw new Error("incomplete");
    for (const collection of [photo.contacts, photo.opportunities]) {
      if (
        new Set(collection.map((row) => row.id)).size !== collection.length ||
        collection.some((row) => row.organization_id !== organizationId)
      )
        throw new Error("incomplete");
    }
    return photo;
  } catch {
    discard = true;
    throw new Error("financial_snapshot_unavailable");
  } finally {
    if (db) {
      let rollbackFailed = false;
      try {
        await db.query("ROLLBACK");
      } catch {
        discard = true;
        rollbackFailed = true;
      }
      // Não devolver ao pool uma conexão com transação/estado incerto.
      if (discard) db.release(new Error("financial_snapshot_connection_discarded"));
      else db.release();
      if (rollbackFailed) throw new Error("financial_snapshot_unavailable");
    }
  }
}
