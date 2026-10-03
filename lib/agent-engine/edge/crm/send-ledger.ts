import { ApiError } from "@/lib/api/types";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Queryable } from "../../queue/queue";

export type SendLedgerStatus = "requested" | "accepted" | "queued" | "vetoed" | "failed";
export type SendOutcome =
  | { kind: "sent"; idempotencyKey: string; crmMessageId: string }
  | {
      kind: "already_sent" | "queued" | "failed";
      idempotencyKey: string;
      crmMessageId: string | null;
    }
  | { kind: "blocked"; idempotencyKey: string };
type Intent = {
  tenantId: string;
  leadId: string | null;
  jobId: string;
  seq: number;
  body: string;
  /**
   * (C01) Presentes = não é texto puro (template renderizado, foto com legenda).
   * Entram na identidade do conteúdo (`hashDoConteudo`): duas fotos com a mesma
   * legenda (ou legenda vazia) e caminhos diferentes são duas mensagens; a MESMA
   * foto, ou o MESMO template com os mesmos valores, gerados de novo pela
   * re-execução do job, são repetição e não saem duas vezes.
   */
  template?: object;
  media?: object;
};
type Row = {
  id: string;
  status: SendLedgerStatus;
  crm_message_id: string | null;
  /**
   * (C01) As lojas reais devolvem os dois; dublês antigos não. Sem `body_hash`
   * a posição ocupada é tratada como antes: mesmo conteúdo.
   */
  body_hash?: string | null;
  seq?: number | string;
};
interface LedgerStore {
  create(input: Intent, hash: string): Promise<string>;
  find(input: Intent): Promise<Row | null>;
  rotate(input: Intent, hash: string): Promise<string>;
  message(org: string, key: string): Promise<{ id: string; status: string } | null>;
  update(
    org: string,
    key: string,
    status: SendLedgerStatus,
    id: string | null,
    error: string | null,
  ): Promise<void>;
  /** (C01) Recibo ACEITO deste job com o mesmo conteúdo, em qualquer posição. */
  findAccepted?(input: Intent, hash: string): Promise<Row | null>;
  /**
   * (C01) Recibo PENDENTE (`requested`/`queued`) deste job com o mesmo conteúdo, em
   * qualquer posição: identidade a retomar, nunca a duplicar.
   */
  findPendente?(input: Intent, hash: string): Promise<Row | null>;
  /** (C01) A primeira posição livre do job (maior ocupada + 1). */
  nextSeq?(input: Intent): Promise<number>;
}
/** (C01) Quantas vezes procurar posição livre antes de desistir (corrida entre execuções). */
const TENTATIVAS_DE_POSICAO = 5;
/** (C01) JSON com as chaves em ordem, em toda profundidade: a mesma mídia ou os mesmos valores dão o mesmo texto. */
function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`;
  if (valor !== null && typeof valor === "object") {
    const o = valor as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(valor) ?? "null";
}
/**
 * (C01) A identidade do CONTEÚDO de um envio, gravada em `body_hash` e usada para
 * reconhecer, em qualquer posição do job, o que o canal já aceitou.
 *
 * Texto puro: o hash do texto, como sempre (os recibos já gravados continuam
 * válidos). Foto e template: a mídia (caminho e tipo) ou o template (nome, idioma
 * e valores) entram no hash, com um prefixo que os separa do texto. Sem isso a
 * re-execução de um job (reaper, retry) mandava de novo a foto e o template que o
 * canal já tinha aceitado — a deduplicação só via texto — e uma foto com a
 * legenda X colidia com o texto X (achado 1 da revisão adversarial, 03/10/2026).
 */
export function hashDoConteudo(input: Pick<Intent, "body" | "template" | "media">): string {
  const h = createHash("sha256");
  if (input.template !== undefined) h.update("template\u0000").update(canonico(input.template)).update("\u0000");
  if (input.media !== undefined) h.update("media\u0000").update(canonico(input.media)).update("\u0000");
  return h.update(input.body).digest("hex");
}
/**
 * (C01) Conteúdo novo numa posição ocupada vai para a primeira posição livre.
 * Nunca é descartado como `already_sent`: o recibo da posição é de OUTRA mensagem.
 */
async function criarNaProximaPosicao(
  store: LedgerStore & Required<Pick<LedgerStore, "nextSeq">>,
  input: Intent,
  hash: string,
): Promise<string> {
  for (let tentativa = 0; tentativa < TENTATIVAS_DE_POSICAO; tentativa++) {
    const seq = await store.nextSeq(input);
    try {
      return await store.create({ ...input, seq }, hash);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "23505"))
        throw error;
    }
  }
  throw new Error("send_ledger_sem_posicao_livre");
}
/**
 * (C01) Cria o recibo na posição pedida ou resolve a colisão com o que já a ocupa
 * (o bloco que sempre esteve inline em `sendWithLedger`; saiu para uma função
 * quando a retomada do recibo pendente ganhou o outro ramo).
 */
async function ocuparPosicao(
  store: LedgerStore,
  input: Intent,
  hash: string,
): Promise<{ kind: "key"; key: string } | { kind: "outcome"; outcome: SendOutcome }> {
  let key: string;
  try {
    key = await store.create(input, hash);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "23505"))
      throw error;
    const prior = await store.find(input);
    if (!prior) throw new Error("send_ledger_missing");
    key = prior.id;
    // (C01) Posição ocupada por OUTRO conteúdo é mensagem nova, não repetição:
    // antes virava `already_sent` e o texto novo sumia sem ninguém ver (C54).
    // A posição é reaproveitada (rotate, como `failed` sempre foi) quando o seu
    // recibo nunca chegou ao canal; se chegou (aceito, vetado, em voo), o texto
    // novo vai para a primeira posição livre.
    const outroConteudo = prior.body_hash != null && prior.body_hash !== hash;
    if (outroConteudo && store.nextSeq) {
      const reaproveitavel =
        prior.status === "failed" ||
        (prior.status !== "accepted" &&
          prior.status !== "vetoed" &&
          (await store.message(input.tenantId, prior.id)) === null);
      key = reaproveitavel
        ? await store.rotate(input, hash)
        : await criarNaProximaPosicao(
            store as LedgerStore & Required<Pick<LedgerStore, "nextSeq">>,
            input,
            hash,
          );
    } else {
      if (prior.status === "accepted")
        return {
          kind: "outcome",
          outcome: { kind: "already_sent", idempotencyKey: key, crmMessageId: prior.crm_message_id },
        };
      if (prior.status === "vetoed") return { kind: "outcome", outcome: { kind: "blocked", idempotencyKey: key } };
      if (prior.status === "failed") key = await store.rotate(input, hash);
    }
  }
  return { kind: "key", key };
}
/** Inline e daemon compartilham identidade (job,seq), reconciliação e mensagem.
 * Página/worker perdido não cria uma segunda intenção. queued é reavaliado pelo
 * handler com o MESMO id; somente sent/delivered/read confirmam entrega. */
export async function sendWithLedger(
  store: LedgerStore,
  input: Intent,
  send: (key: string, messageId: string) => Promise<{ id: string; status: string }>,
): Promise<SendOutcome> {
  const hash = hashDoConteudo(input);
  // (C01) Recuperação pelo CONTEÚDO (caso C54): a re-execução do mesmo job
  // (reaper, retry) gera as bolhas de novo, em posições novas. O que o canal já
  // aceitou com este exato conteúdo — texto, foto ou template — não sai duas
  // vezes, qualquer que seja a posição.
  if (store.findAccepted) {
    const aceito = await store.findAccepted(input, hash);
    if (aceito)
      return { kind: "already_sent", idempotencyKey: aceito.id, crmMessageId: aceito.crm_message_id };
  }
  let key: string;
  let existing: { id: string; status: string } | null | undefined;
  // (C01) Recibo PENDENTE com o mesmo conteúdo (achado 2 da segunda revisão
  // adversarial): a identidade é retomada — o envio sai com a MESMA chave e o
  // handler reavalia a mesma mensagem, como no replay por posição — em vez de
  // nascer outra posição para um conteúdo que o canal talvez já tenha segurado
  // (`queued`) e vá entregar: era o cliente recebendo a mesma bolha duas vezes.
  // Se a mensagem foi entregue nesse meio-tempo, o recibo é reconciliado aqui.
  const pendente = store.findPendente ? await store.findPendente(input, hash) : null;
  if (pendente) {
    key = pendente.id;
    existing = await store.message(input.tenantId, key);
    if (existing && ["sent", "delivered", "read"].includes(existing.status)) {
      await store.update(input.tenantId, key, "accepted", existing.id, null);
      return { kind: "already_sent", idempotencyKey: key, crmMessageId: existing.id };
    }
  } else {
    const posicao = await ocuparPosicao(store, input, hash);
    if (posicao.kind !== "key") return posicao.outcome;
    key = posicao.key;
    existing = await store.message(input.tenantId, key);
  }
  let message = existing;
  if (!message || message.status === "queued") {
    try {
      message = await send(key, existing?.id ?? key);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        await store.update(input.tenantId, key, "vetoed", null, "handler 403");
        return { kind: "blocked", idempotencyKey: key };
      }
      throw error;
    }
  }
  const status: SendLedgerStatus = ["sent", "delivered", "read"].includes(message.status)
    ? "accepted"
    : message.status === "failed"
      ? "failed"
      : "queued";
  await store.update(
    input.tenantId,
    key,
    status,
    message.id,
    status === "failed" ? "handler marcou a mensagem como failed" : null,
  );
  return status === "accepted"
    ? { kind: "sent", idempotencyKey: key, crmMessageId: message.id }
    : { kind: status, idempotencyKey: key, crmMessageId: message.id };
}
/**
 * (C01) Este conteúdo já tem recibo neste job — aceito, ou pendente a retomar?
 * Quem fatia a resposta em bolhas pergunta isto para CADA bolha antes de aplicar o
 * teto do turno ao que falta (achado 1 da segunda revisão adversarial): a bolha
 * conhecida mantém a divisão e a identidade; o teto vale só para as novas. Só lê.
 */
export async function conteudoRegistradoNoJob(
  db: Queryable,
  input: { tenantId: string; jobId: string } & Pick<Intent, "body" | "media" | "template">,
): Promise<boolean> {
  const store = pgSendLedger(db);
  const hash = hashDoConteudo(input);
  const intent: Intent = { ...input, leadId: null, seq: 0 };
  if ((await store.findAccepted!(intent, hash)) !== null) return true;
  return (await store.findPendente!(intent, hash)) !== null;
}
/** Reconcilia um recibo já existente sem criar intenção nem chamar o canal.
 * Consumidores determinísticos consultam isto antes dos gates de um NOVO envio. */
export async function reconcileAcceptedSend(
  db: Queryable, input: { tenantId: string; jobId: string; seq: number },
): Promise<boolean> {
  const store = pgSendLedger(db);
  const prior = await store.find({ ...input, leadId: null, body: "" });
  if (!prior) return false;
  if (prior.status === "accepted") return true;
  const message = await store.message(input.tenantId, prior.id);
  if (!message || !["sent", "delivered", "read"].includes(message.status)) return false;
  await store.update(input.tenantId, prior.id, "accepted", message.id, null);
  return true;
}
/**
 * (C01) De onde a execução parte: a maior posição ACEITA do job, depois de
 * reconciliar os recibos que ficaram em 'requested'/'queued' (crash entre o envio
 * e a gravação). Até aqui `seq` recomeçava em 0 a cada execução, e a primeira
 * bolha nova da re-execução caía na posição da primeira antiga (C54). Posições
 * com 'failed' ou 'vetoed' acima da aceita seguem reaproveitáveis pelos ramos de
 * colisão. 0 em job sem envio aceito.
 */
export async function posicaoInicialDoJob(
  db: Queryable,
  input: { tenantId: string; jobId: string },
): Promise<number> {
  const { rows } = await db.query<{ seq: number | string; status: SendLedgerStatus }>(
    "select seq,status from send_ledger where organization_id=$1 and job_id=$2 order by seq",
    [input.tenantId, input.jobId],
  );
  let maior = 0;
  for (const row of rows) {
    const seq = Number(row.seq);
    const aceito =
      row.status === "accepted" ||
      ((row.status === "requested" || row.status === "queued") &&
        (await reconcileAcceptedSend(db, { ...input, seq })));
    if (aceito && seq > maior) maior = seq;
  }
  return maior;
}
export function pgSendLedger(db: Queryable): LedgerStore {
  return {
    async create(i, hash) {
      const { rows } = await db.query<{ id: string }>(
        "insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash) values ($1, $2, $3, $4, $5) returning id",
        [i.tenantId, i.leadId, i.jobId, i.seq, hash],
      );
      if (!rows[0]) throw new Error("send_ledger_insert_missing");
      return rows[0].id;
    },
    async find(i) {
      const { rows } = await db.query<Row>(
        "select * from send_ledger where organization_id=$1 and job_id=$2 and seq=$3",
        [i.tenantId, i.jobId, i.seq],
      );
      return rows[0] ?? null;
    },
    async rotate(i, hash) {
      const { rows } = await db.query<{ id: string }>(
        "update send_ledger set id=gen_random_uuid(),status='requested',body_hash=$4,crm_message_id=null,last_error=null,updated_at=now() where organization_id=$1 and job_id=$2 and seq=$3 returning id",
        [i.tenantId, i.jobId, i.seq, hash],
      );
      if (!rows[0]) throw new Error("send_ledger_rotation_missing");
      return rows[0].id;
    },
    async message(org, key) {
      const { rows } = await db.query<{ id: string; status: string }>(
        "select id,status from messages where organization_id=$1 and metadata->>'idempotency_key'=$2 limit 1",
        [org, key],
      );
      return rows[0] ?? null;
    },
    async update(org, key, status, id, error) {
      await db.query(
        "update send_ledger set status=$3,crm_message_id=coalesce($4,crm_message_id),last_error=$5,updated_at=now() where organization_id=$1 and id=$2",
        [org, key, status, id, error],
      );
    },
    async findAccepted(i, hash) {
      const { rows } = await db.query<Row>(
        "select * from send_ledger where organization_id=$1 and job_id=$2 and status='accepted' and body_hash=$3 order by seq limit 1",
        [i.tenantId, i.jobId, hash],
      );
      return rows[0] ?? null;
    },
    async findPendente(i, hash) {
      const { rows } = await db.query<Row>(
        "select * from send_ledger where organization_id=$1 and job_id=$2 and status in ('requested','queued') and body_hash=$3 order by seq limit 1",
        [i.tenantId, i.jobId, hash],
      );
      return rows[0] ?? null;
    },
    async nextSeq(i) {
      const { rows } = await db.query<{ seq: number | string }>(
        "select coalesce(max(seq),0)+1 as seq from send_ledger where organization_id=$1 and job_id=$2",
        [i.tenantId, i.jobId],
      );
      return Number(rows[0]?.seq ?? 1);
    },
  };
}
export function supabaseSendLedger(db: SupabaseClient): LedgerStore {
  return {
    async create(i, hash) {
      const { data, error } = await db
        .from("send_ledger")
        .insert({
          organization_id: i.tenantId,
          contact_id: i.leadId,
          job_id: i.jobId,
          seq: i.seq,
          body_hash: hash,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    },
    async find(i) {
      const { data, error } = await db
        .from("send_ledger")
        .select("id,status,crm_message_id,body_hash,seq")
        .eq("organization_id", i.tenantId)
        .eq("job_id", i.jobId)
        .eq("seq", i.seq)
        .maybeSingle();
      if (error) throw error;
      return data as Row | null;
    },
    async rotate(i, hash) {
      const { data, error } = await db
        .from("send_ledger")
        .update({
          id: crypto.randomUUID(),
          status: "requested",
          body_hash: hash,
          crm_message_id: null,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("organization_id", i.tenantId)
        .eq("job_id", i.jobId)
        .eq("seq", i.seq)
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    },
    async message(org, key) {
      const { data, error } = await db
        .from("messages")
        .select("id,status")
        .eq("organization_id", org)
        .eq("metadata->>idempotency_key", key)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async update(org, key, status, id, errorText) {
      const { error } = await db
        .from("send_ledger")
        .update({
          status,
          ...(id ? { crm_message_id: id } : {}),
          last_error: errorText,
          updated_at: new Date().toISOString(),
        })
        .eq("organization_id", org)
        .eq("id", key);
      if (error) throw error;
    },
    async findAccepted(i, hash) {
      const { data, error } = await db
        .from("send_ledger")
        .select("id,status,crm_message_id,body_hash,seq")
        .eq("organization_id", i.tenantId)
        .eq("job_id", i.jobId)
        .eq("status", "accepted")
        .eq("body_hash", hash)
        .order("seq")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Row | null;
    },
    async findPendente(i, hash) {
      const { data, error } = await db
        .from("send_ledger")
        .select("id,status,crm_message_id,body_hash,seq")
        .eq("organization_id", i.tenantId)
        .eq("job_id", i.jobId)
        .in("status", ["requested", "queued"])
        .eq("body_hash", hash)
        .order("seq")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as Row | null;
    },
    async nextSeq(i) {
      const { data, error } = await db
        .from("send_ledger")
        .select("seq")
        .eq("organization_id", i.tenantId)
        .eq("job_id", i.jobId)
        .order("seq", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return Number((data as { seq?: number | string } | null)?.seq ?? 0) + 1;
    },
  };
}
/** Resultado do turno sem importar runtime/env; ausência de envio é terminal explícito. */
export async function resultadoDoEnvioDoFollowup(
  db: Queryable,
  org: string,
  job: string,
): Promise<{ kind: "sent" } | { kind: "skipped"; reason: string }> {
  const { rows } = await db.query<{ status: string }>(
    "select status from send_ledger where organization_id=$1 and job_id=$2",
    [org, job],
  );
  if (!rows.length)
    return {
      kind: "skipped",
      reason: "O assistente concluiu este passo sem enviar uma mensagem. Revise o próximo passo.",
    };
  if (rows.every((row) => row.status === "vetoed"))
    return { kind: "skipped", reason: "O envio foi recusado pelas regras do atendimento." };
  if (rows.some((row) => row.status !== "accepted")) throw new Error("followup_message_not_sent");
  return { kind: "sent" };
}
