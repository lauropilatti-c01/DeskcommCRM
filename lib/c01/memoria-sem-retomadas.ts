/**
 * (C01, junção da 1.86.0) A RETOMADA DO C54 NÃO É REPETIÇÃO.
 *
 * ─── O conflito ─────────────────────────────────────────────────────────────
 *
 * A 1.86 do autor semeia a régua de duplicata próxima (`near-dup.ts`) com o que
 * saiu para a conversa desde a última mensagem do cliente
 * (`corposEnviadosDesdeUltimaInbound`). Ela só deixa de fora a mensagem
 * `failed`. A mensagem que o CRM segura (`queued`/`sending`) entra.
 *
 * A nossa recuperação pelo `send_ledger` (C54, rodadas 3 a 6) conta essas
 * mensagens como pendentes do job (`estadoInicialDoJob().pendentes`) e as
 * retoma na re-execução pela MESMA chave (`findPendente`): o canal não
 * duplica, e a foto com legenda, que o vigia da sessão não reenvia direito,
 * sai inteira. Com a memória do autor, o `send_message` da re-execução com o
 * mesmo texto era suprimido antes de chegar ao ledger, e a retomada não
 * acontecia.
 *
 * ─── O que este arquivo faz ─────────────────────────────────────────────────
 *
 * Tira da memória o corpo de cada pendente que a re-execução ainda vai
 * retomar (uma ocorrência por pendente). O resto da memória fica como o autor
 * a montou: o que já foi entregue continua suprimindo a repetição.
 */
import type { Queryable } from "@/lib/agent-engine/queue/queue";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O corpo das mensagens gravadas para estas chaves do `send_ledger`. Pela PK
 * primeiro (o envio grava `messages.id = chave`); a `metadata->>'idempotency_key'`
 * fica para a chave que a PK não achou, como em `pgSendLedger().message`.
 */
export async function corposDasPendentes(
  db: Queryable,
  organizationId: string,
  chaves: readonly string[],
): Promise<string[]> {
  if (chaves.length === 0) return [];
  const corpos = new Map<string, string | null>();
  const uuids = chaves.filter((c) => UUID.test(c));
  if (uuids.length > 0) {
    const { rows } = await db.query<{ chave: string; body: string | null }>(
      "select id::text as chave, body from messages where organization_id=$1 and id = any($2::uuid[])",
      [organizationId, uuids],
    );
    for (const r of rows) corpos.set(r.chave.toLowerCase(), r.body);
  }
  const faltam = chaves.filter((c) => !corpos.has(c.toLowerCase()));
  if (faltam.length > 0) {
    const { rows } = await db.query<{ chave: string; body: string | null }>(
      "select metadata->>'idempotency_key' as chave, body from messages where organization_id=$1 and metadata->>'idempotency_key' = any($2::text[])",
      [organizationId, faltam],
    );
    for (const r of rows) if (!corpos.has(r.chave.toLowerCase())) corpos.set(r.chave.toLowerCase(), r.body);
  }
  return chaves
    .map((c) => corpos.get(c.toLowerCase()) ?? "")
    .filter((b) => b.trim() !== "");
}

/** A memória sem uma ocorrência de cada corpo pendente. Não muda a ordem do resto. */
export function semAsRetomadas(jaDito: readonly string[], pendentes: readonly string[]): string[] {
  const resto = [...jaDito];
  for (const p of pendentes) {
    const i = resto.indexOf(p);
    if (i >= 0) resto.splice(i, 1);
  }
  return resto;
}
