import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as SendLedger from "@/lib/agent-engine/edge/crm/send-ledger";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01) A RE-EXECUÇÃO COM FALHA NA POSIÇÃO 1 E SUCESSO NAS 2 E 3 — a regressão de
 * turno completo que a terceira revisão adversarial do Codex (03/10/2026) pediu para
 * o achado 1 (alto): o turno inteiro contra Postgres real, com modelo falso e um
 * canal falso que passa pelo `send_ledger` REAL (como o adapter WAHA faz) e um
 * handler de CRM falso que só registra o que entregou.
 *
 * O cenário: a execução anterior deixou no ledger a posição 1 'failed' (A), e as
 * posições 2 e 3 aceitas (B e C) — teto do turno 3. O job volta à fila; o modelo
 * regenera A, B e C. Antes, a execução partia de "3 enviadas" (a maior posição aceita),
 * as duas ferramentas de envio recusavam por `max_sends_per_turn` antes de consultar o
 * ledger, nada saía, nada falhava, e o job concluía com A sem entrega para sempre.
 * Agora a contagem é de entregas (2): A sai, na posição 4; B e C, já entregues,
 * não saem de novo.
 *
 * (Rodada 5) O cenário do achado 1 da QUARTA revisão: A aceita, B pendente (o CRM
 * segura a mensagem, `queued`) e C ainda não criada. A recuperação conta B como
 * enviada; a re-execução retoma o recibo de B pela mesma chave e o canal devolve
 * `sent` — antes isso contava DE NOVO, o teto fechava em 3 com duas mensagens e C era
 * omitida com o envio devolvendo sucesso. Agora as três saem, nenhuma duplicada, e o
 * teto continua valendo para a quarta.
 *
 * (Rodada 6) O cenário do achado 1 da QUINTA revisão: as pendências PREENCHEM o teto.
 * Foto 1 aceita (com a legenda), fotos 2 e 3 `queued` sem legenda — `enviadas = 3`.
 * Antes, `send_message` recusava por `max_sends_per_turn` antes de consultar o ledger,
 * e as duas fotos ficavam presas (o vigia da sessão pula mensagem sem corpo). Agora o
 * teto vale só para intenção nova: as duas pendentes são retomadas pela mesma chave,
 * nada novo sai, e a 4ª mensagem é recusada. O mesmo com um template pendente — e com
 * as duas mensagens de texto já aceitas que o modelo regenera antes dele.
 *
 * (Rodada 6, 2) O cenário do achado 3 da QUINTA revisão, com a cadeia de envio DE
 * VERDADE: a organização tem template de apresentação e a 1ª mensagem ao lead sai
 * emendada (`disclosureGate`, modo `inject`). O job cai depois do envio aceito e antes
 * do checkpoint (o modelo falha ao fechar); a fila o re-executa e o modelo regenera o
 * mesmo texto — agora sem emenda, porque já há envio aceito. Antes, o hash do ledger
 * era do corpo entregue e não casava: a resposta saía de novo. Agora a identidade é o
 * texto antes da emenda, e a re-execução reconhece o recibo. Aqui o turno roda DUAS
 * vezes de fato (a 1ª falha, a 2ª é a re-execução do mesmo job pela fila).
 *
 * (Rodada 7) O cenário do achado 1 da SEXTA revisão, o pior tipo: o fail-safe de
 * vocabulário interno RETOMANDO o que acabou de vetar. A execução anterior (a versão do
 * autor soltava o texto depois dos vetos) deixou o texto com vocabulário interno
 * `queued` no CRM; o teto está cheio; o modelo insiste no mesmo texto três vezes. Cada
 * chamada passa pelo teto porque o conteúdo é conhecido (retomada), a cadeia veta as
 * três, e o fail-safe manda a frase de espera pela cadeia — mas o `send` era o do
 * modelo, que com o plano da retomada mandava o texto vetado (ou a foto pendente)
 * marcado como frase de espera, e a frase não saía. Agora a frase tem um `send` só
 * dela: sai ela, e só ela; o texto vetado fica como estava.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://placeholder.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "placeholder-service";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "eeeeeeee-0000-4000-8000-000000000001";
const CONTACT = "eeeeeeee-0000-4000-8000-000000000002";
const SESSION = "eeeeeeee-0000-4000-8000-000000000003";
const CONV = "eeeeeeee-0000-4000-8000-000000000004";
const MSG = "eeeeeeee-0000-4000-8000-000000000005";
// (Rodada 6) A conexão do canal oficial, para o template: outra sessão e outra
// conversa do mesmo contato; o produto do catálogo com três fotos, para a foto.
const SESSION_META = "eeeeeeee-0000-4000-8000-000000000020";
const CONV_META = "eeeeeeee-0000-4000-8000-000000000021";
const MSG_META = "eeeeeeee-0000-4000-8000-000000000022";
const PRODUTO = "eeeeeeee-0000-4000-8000-000000000030";
const CODIGO_DO_PRODUTO = "MOTO-1";
const ARQUIVOS = [1, 2, 3].map((n) => `aaaaaaaa-0000-4000-8000-00000000000${n}.jpg`);
/** As fotos como `prepararFotosDoProduto` as deixa: copiadas para a pasta da conversa. */
const FOTOS = ARQUIVOS.map((arquivo) => ({
  storagePath: `${ORG}/${CONV}/catalogo-${arquivo}`,
  mime: "image/jpeg",
}));
const TEMPLATE = { name: "retomada", language: "pt_BR", values: { "1": "Lead" } };
const RENDERIZADO = "Oi Lead, tudo certo?";
/** (Rodada 6, 2) O template de apresentação da organização, emendado na 1ª mensagem ao lead. */
const APRESENTACAO = "Olá! Eu sou a assistente virtual da Recuperação.";
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";
const TETO = 3;

const A = "Oi! Vi que você perguntou sobre o plano.";
const B = "Ele inclui o material e o acesso à plataforma.";
const C = "Quer que eu te mande o link para começar?";
const D = "Posso te ajudar com mais alguma coisa?";

type Modules = {
  turno: typeof InboundTurn;
  ledger: typeof SendLedger;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

/** O que o CRM falso entregou (na ordem), e com que chave de idempotência. */
type Envio = { body: string; media?: { storagePath: string; mime: string }; template?: object };
let entregues: Array<Envio & { key: string }> = [];

const CHECKPOINT = JSON.stringify({
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "turno de teste",
});
const USO = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

type Chamada = { tool: string; input: Record<string, unknown> };
/** Modelo falso que manda A, B e C (uma por etapa) e depois encerra. */
function modeloQueRegeneraAsTres(textos: readonly string[] = [A, B, C]) {
  return modeloQueChama(textos.map((body) => ({ tool: "send_message", input: { body } })));
}
/**
 * Modelo falso que faz uma chamada de ferramenta por etapa, na ordem dada, e depois
 * encerra. Guarda o que o SDK lhe devolveu, um resultado por chamada de ferramenta (o
 * prompt de cada etapa repete os resultados anteriores).
 */
function modeloQueChama(chamadas: readonly Chamada[], opcoes: { caiNoCheckpoint?: boolean } = {}) {
  const estado = { etapas: 0, checkpoints: 0, resultados: new Map<string, string>() };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result")
          estado.resultados.set(String(parte.toolCallId), JSON.stringify(parte.output ?? parte));
      }
    }
    const ultima = msgs[msgs.length - 1];
    const pedeCheckpoint =
      ultima?.role === "user" &&
      Array.isArray(ultima.content) &&
      (ultima.content as Array<Record<string, unknown>>).some(
        (p) => p.type === "text" && p.text === m.turno.CHECKPOINT_INSTRUCTION,
      );
    if (pedeCheckpoint) {
      estado.checkpoints += 1;
      // (Rodada 6, 2) O modelo cai ao fechar o turno: o envio já saiu, o checkpoint
      // não existe, o job falha e a fila o re-executa.
      if (opcoes.caiNoCheckpoint) throw new Error("modelo caiu antes do checkpoint (teste)");
      return {
        content: [{ type: "text" as const, text: CHECKPOINT }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    estado.etapas += 1;
    const chamada = chamadas[estado.etapas - 1];
    if (chamada === undefined) {
      return {
        content: [{ type: "text" as const, text: "ok" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${estado.etapas}`,
          toolName: chamada.tool,
          input: JSON.stringify(chamada.input),
        },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
  return { doGenerate, estado };
}

/**
 * O canal falso passa pelo `send_ledger` REAL (como `WahaChannelAdapter.send` →
 * `sendTurnMessage` → `sendWithLedger`), com um handler de CRM que só registra a
 * entrega. É o ledger de verdade que decide `sent`/`already_sent` e a posição.
 */
function montaHandler(doGenerate: unknown) {
  const store = m.ledger.pgSendLedger(pool);
  return m.turno.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 8,
      maxSendsPerTurn: TETO,
      queuedRetryDelayMs: 1000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
    },
    log: m.createLogger(),
    registry: m.createFakeRegistry(doGenerate as never),
    // (Rodada 6) A cópia da foto do catálogo para a conversa é rede (Storage): aqui,
    // "copiou". O destino é o que `prepararFotosDoProduto` calcula — ver `FOTOS`.
    copiarFoto: async () => true,
    channel: () =>
      ({
        channel: "ledger-real",
        send: async (i: {
          tenantId: string;
          leadId: string | null;
          jobId: string;
          seq: number;
          body: string;
          media?: { storagePath: string; mime: string };
          template?: object;
          identidade?: string;
        }) => {
          const envio: Envio = {
            body: i.body,
            ...(i.media ? { media: i.media } : {}),
            ...(i.template ? { template: i.template } : {}),
          };
          const outcome = await m.ledger.sendWithLedger(
            store,
            {
              tenantId: i.tenantId,
              leadId: i.leadId,
              jobId: i.jobId,
              seq: i.seq,
              ...envio,
              // (Rodada 6, 2) A identidade do envio, quando o turno a declara: o adapter
              // real a repassa inteira ao `sendTurnMessage`, que a entrega ao ledger.
              ...(i.identidade !== undefined ? { identidade: i.identidade } : {}),
            },
            async (key, messageId) => {
              entregues.push({ ...envio, key });
              // A retomada de um recibo pendente reavalia a mensagem que o CRM já tem
              // (`messageId` é o id dela): o CRM falso a marca enviada, como o real
              // faria quando a sessão volta.
              await pool.query(
                "update messages set status = 'sent' where organization_id = $1 and id = $2",
                [ORG, messageId],
              );
              return { id: messageId, status: "sent" };
            },
          );
          if (outcome.kind === "blocked") return outcome;
          return {
            kind: outcome.kind,
            idempotencyKey: outcome.idempotencyKey,
            messageId: outcome.crmMessageId,
          };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => AGORA,
    sleep: async () => {},
  });
}

/** A conversa e a conexão do job: a do WAHA (padrão) ou a do canal oficial (template). */
type Alvo = { conversa: string; sessao: string; mensagem: string };
const WAHA: Alvo = { conversa: CONV, sessao: SESSION, mensagem: MSG };
const META: Alvo = { conversa: CONV_META, sessao: SESSION_META, mensagem: MSG_META };

async function rodaTurno(
  handler: ReturnType<typeof montaHandler>,
  evento: string,
  /** O que a execução ANTERIOR deixou no ledger deste job, gravado antes de o handler rodar. */
  antes: (jobId: string) => Promise<void>,
  alvo: Alvo = WAHA,
): Promise<{ erro: Error | null; jobId: string }> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: alvo.conversa,
      contact_id: CONTACT,
      channel_session_id: alvo.sessao,
      inbound_message_id: alvo.mensagem,
      crm_event_id: evento,
    },
    maxAttempts: 2,
  });
  await antes(job.id);
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "rec", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "rec" });
    await m.queue.completeJob(pool, claimed!.id, "rec");
    return { erro: null, jobId: job.id };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "rec", err);
    return { erro: err as Error, jobId: job.id };
  }
}

/**
 * (Rodada 6, 2) A re-execução do MESMO job pela fila, depois de `rodaTurno` o ter visto
 * falhar (`failJob` o devolve a `pending` com espera): a espera é zerada, o job é
 * reclamado e o handler roda de novo — com outro modelo falso, porque o primeiro
 * guarda o estado da 1ª execução.
 */
async function reexecuta(
  handler: ReturnType<typeof montaHandler>,
  jobId: string,
): Promise<{ erro: Error | null }> {
  await pool.query("update job_queue set status = 'done' where status = 'pending' and id <> $1", [
    jobId,
  ]);
  await pool.query("update job_queue set run_after = now() where id = $1", [jobId]);
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "rec", maxConcurrency: 1 });
  expect(claimed?.id).toBe(jobId);
  try {
    await handler(claimed!, pool, { workerId: "rec" });
    await m.queue.completeJob(pool, claimed!.id, "rec");
    return { erro: null };
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "rec", err);
    return { erro: err as Error };
  }
}

/** Um recibo como a execução anterior o deixou. Devolve a chave (id do recibo). */
async function recibo(
  jobId: string,
  seq: number,
  status: string,
  envio: string | Envio,
): Promise<string> {
  const conteudo = typeof envio === "string" ? { body: envio } : envio;
  const { rows } = await pool.query<{ id: string }>(
    `insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status)
     values ($1,$2,$3,$4,$5,$6) returning id`,
    [ORG, CONTACT, jobId, seq, m.ledger.hashDoConteudo(conteudo), status],
  );
  return rows[0]!.id;
}

/**
 * A mensagem que o CRM gravou para um recibo e ainda segura (`queued`): o canal a
 * entrega quando a sessão voltar. Texto, foto (sem legenda = `body` nulo, como o
 * handler grava) ou template, como `corpoDoEnvio` os manda ao handler.
 */
async function mensagemNaFila(
  chave: string,
  envio: string | Envio,
  alvo: Alvo = WAHA,
): Promise<string> {
  const conteudo = typeof envio === "string" ? { body: envio } : envio;
  const id = randomUUID();
  const tipo = conteudo.template ? "template" : conteudo.media ? "image" : "text";
  const t = conteudo.template as { name?: string; language?: string } | undefined;
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, media_storage_path, media_mime, template_name, template_language,
       sent_via, metadata)
     values ($1,$2,$3,$4,$5,$6,'outbound','queued',$7,$8,$9,$10,$11,'ai',$12::jsonb)`,
    [
      id,
      ORG,
      alvo.conversa,
      alvo.sessao,
      CONTACT,
      tipo,
      conteudo.body === "" && conteudo.media ? null : conteudo.body,
      conteudo.media?.storagePath ?? null,
      conteudo.media?.mime ?? null,
      t?.name ?? null,
      t?.language ?? null,
      JSON.stringify({ idempotency_key: chave }),
    ],
  );
  return id;
}

beforeAll(async () => {
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    ledger: await import("@/lib/agent-engine/edge/crm/send-ledger"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'c01-recuperacao-posicao-1','Recuperação','Recuperação')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Recuperação','+5511900000777') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, waha_session_name,
                                   status, webhook_secret_encrypted)
     values ($1,$2,'waha','c01-recuperacao','WORKING','\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group, last_inbound_at)
     values ($1,$2,$3,$4,'open',false,$5) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION, MENSAGEM_DO_CLIENTE_EM],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi, me conta do plano?','external_device',$6)
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT, MENSAGEM_DO_CLIENTE_EM],
  );
  // (Rodada 6) O produto com três fotos — caminhos na forma exata que a rota gera
  // (`fotoPertenceAoProduto`): `<org>/<produto>/<uuid>.jpg`.
  await pool.query(
    `insert into catalog_products (id, organization_id, codigo, nome, preco_cents, fotos)
     values ($1,$2,$3,'Moto de teste',1000000,$4::text[]) on conflict (id) do nothing`,
    [PRODUTO, ORG, CODIGO_DO_PRODUTO, ARQUIVOS.map((a) => `${ORG}/${PRODUTO}/${a}`)],
  );
  // (Rodada 6) A conexão do canal oficial e a conversa dela, para o template.
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id,
                                   meta_waba_id, status, webhook_secret_encrypted)
     values ($1,$2,'meta_cloud','111','333','WORKING','\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION_META, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group, last_inbound_at)
     values ($1,$2,$3,$4,'open',false,$5) on conflict (id) do nothing`,
    [CONV_META, ORG, CONTACT, SESSION_META, MENSAGEM_DO_CLIENTE_EM],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi, me conta do plano?','external_device',$6)
     on conflict (id) do nothing`,
    [MSG_META, ORG, CONV_META, SESSION_META, CONTACT, MENSAGEM_DO_CLIENTE_EM],
  );
  await pool.query(
    `insert into meta_templates (organization_id, waba_id, name, language, status, category,
                                 components, parameter_format, contract_hash)
     values ($1,'333',$2,$3,'APPROVED','MARKETING',
       '[{"type":"BODY","text":"Oi {{1}}, tudo certo?"}]'::jsonb,'POSITIONAL','h-aprovado')
     on conflict (organization_id, waba_id, name, language) do update set status = 'APPROVED'`,
    [ORG, TEMPLATE.name, TEMPLATE.language],
  );
  await pool.query(
    `with v as (
       insert into playbook_versions (organization_id, layer, content)
       select null, 'platform', E'## Identidade\nAssistente de teste.'
       where not exists (select 1 from playbook_pointers where organization_id is null and layer = 'platform')
       returning id)
     insert into playbook_pointers (organization_id, layer, version_id)
     select null, 'platform', id from v`,
  );
});

beforeEach(async () => {
  entregues = [];
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1 and direction = 'outbound'", [
    ORG,
  ]);
  // A janela do gate de spinning é por NÚMERO e atravessa os casos: sem limpá-la, o A
  // do terceiro caso casa com os A dos dois anteriores e volta `mass_identical`.
  await pool.query("delete from outbound_copies where organization_id = $1", [ORG]);
});

describe("turno completo — a re-execução com falha na posição 1 e sucesso nas 2 e 3 (achado 1 da terceira revisão)", () => {
  it("posição 1 'failed', 2 e 3 aceitas (teto 3): a re-execução entrega A na posição 4; B e C não saem de novo; o job conclui", async () => {
    const modelo = modeloQueRegeneraAsTres();
    const { erro, jobId } = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000006",
      async (id) => {
        await recibo(id, 1, "failed", A);
        await recibo(id, 2, "accepted", B);
        await recibo(id, 3, "accepted", C);
      },
    );
    expect(erro).toBeNull();

    // O cliente recebeu A — a mensagem que a execução anterior não conseguiu entregar
    // — e só ela. Antes: nada saía (as três chamadas recusadas por teto) e o job
    // concluía do mesmo jeito, com A perdida.
    expect(entregues.map((e) => e.body)).toEqual([A]);

    // No ledger: A aceita na posição 4; as posições antigas como estavam.
    const { rows } = await pool.query<{ seq: number; status: string; body_hash: string }>(
      "select seq, status, body_hash from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows.map((r) => [Number(r.seq), r.status])).toEqual([
      [1, "failed"],
      [2, "accepted"],
      [3, "accepted"],
      [4, "accepted"],
    ]);
    expect(rows[3]!.body_hash).toBe(m.ledger.hashDoConteudo({ body: A }));

    // O modelo pediu as três; depois de A o teto (3) está cheio e as outras duas
    // voltaram como `max_sends_per_turn` — nunca como falha de envio.
    expect(modelo.estado.etapas).toBe(4);
    expect(modelo.estado.checkpoints).toBe(1);
    const resultados = [...modelo.estado.resultados.values()];
    expect(resultados).toHaveLength(3);
    expect(resultados[0]).toMatch(/"status":"enviada"/);
    expect(resultados[1]).toMatch(/max_sends_per_turn/);
    expect(resultados[2]).toMatch(/max_sends_per_turn/);
    expect(resultados.join("\n")).not.toMatch(/envio_falhou/);
  });

  it("posição 1 'requested' sem mensagem (nunca chegou ao CRM), 2 e 3 aceitas: a re-execução RETOMA o recibo de A, na posição 1", async () => {
    const modelo = modeloQueRegeneraAsTres();
    let chaveDeA = "";
    const { erro, jobId } = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000007",
      async (id) => {
        await recibo(id, 1, "requested", A);
        await recibo(id, 2, "accepted", B);
        await recibo(id, 3, "accepted", C);
        const { rows } = await pool.query<{ id: string }>(
          "select id from send_ledger where job_id = $1 and seq = 1",
          [id],
        );
        chaveDeA = rows[0]!.id;
      },
    );
    expect(erro).toBeNull();
    // A saiu com a MESMA chave do recibo pendente: nenhuma posição nova.
    expect(entregues).toEqual([{ body: A, key: chaveDeA }]);
    const { rows } = await pool.query<{ seq: number; status: string }>(
      "select seq, status from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows.map((r) => [Number(r.seq), r.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
  });

  it("(rodada 5) A aceita, B pendente (o CRM segura a mensagem), C ainda não criada (teto 3): as três saem, nenhuma omitida nem duplicada, e a 4ª é recusada por teto", async () => {
    const modelo = modeloQueRegeneraAsTres([A, B, C, D]);
    let chaveDeB = "";
    let mensagemDeB = "";
    const { erro, jobId } = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000008",
      async (id) => {
        await recibo(id, 1, "accepted", A);
        chaveDeB = await recibo(id, 2, "queued", B);
        mensagemDeB = await mensagemNaFila(chaveDeB, B);
      },
    );
    expect(erro).toBeNull();

    // O CRM foi acionado duas vezes: para reavaliar B (a MESMA chave do recibo
    // pendente — a mensagem que ele já tinha) e para C, nova. A já estava entregue.
    // Antes: só B — a retomada contava de novo, o teto fechava em 3 e C era omitida.
    expect(entregues).toEqual([
      { body: B, key: chaveDeB },
      { body: C, key: expect.any(String) },
    ]);
    expect(entregues[1]!.key).not.toBe(chaveDeB);

    // No ledger: B aceita na SUA posição (2), com a mensagem que o CRM já tinha; C na 3.
    const { rows } = await pool.query<{
      seq: number;
      status: string;
      crm_message_id: string | null;
    }>(
      "select seq, status, crm_message_id from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows.map((r) => [Number(r.seq), r.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(rows[1]!.crm_message_id).toBe(mensagemDeB);

    // O cliente tem três mensagens deste job, uma vez cada.
    const { rows: mensagens } = await pool.query<{ body: string; status: string }>(
      "select body, status from messages where organization_id = $1 and direction = 'outbound' order by created_at",
      [ORG],
    );
    expect(mensagens).toEqual([{ body: B, status: "sent" }]);

    // O modelo pediu as quatro: A, B e C voltaram como enviadas; D, como teto cheio.
    expect(modelo.estado.etapas).toBe(5);
    expect(modelo.estado.checkpoints).toBe(1);
    const resultados = [...modelo.estado.resultados.values()];
    expect(resultados).toHaveLength(4);
    expect(resultados[0]).toMatch(/"status":"enviada"/);
    expect(resultados[1]).toMatch(/"status":"enviada"/);
    expect(resultados[2]).toMatch(/"status":"enviada"/);
    expect(resultados[3]).toMatch(/max_sends_per_turn/);
    expect(resultados.join("\n")).not.toMatch(/envio_falhou/);
  });
});

describe("(rodada 6) as pendências PREENCHEM o teto (achado 1 da quinta revisão)", () => {
  it("foto 1 aceita (com a legenda), fotos 2 e 3 `queued` sem legenda (teto 3): a re-execução retoma as duas pela mesma chave, nada novo sai, a 4ª é recusada e o job conclui", async () => {
    const modelo = modeloQueChama([
      { tool: "send_message", input: { body: A, produto_codigo: CODIGO_DO_PRODUTO } },
      { tool: "send_message", input: { body: D } },
    ]);
    let chave2 = "";
    let chave3 = "";
    let mensagem2 = "";
    let mensagem3 = "";
    const { erro, jobId } = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000009",
      async (id) => {
        await recibo(id, 1, "accepted", { body: A, media: FOTOS[0]! });
        chave2 = await recibo(id, 2, "queued", { body: "", media: FOTOS[1]! });
        mensagem2 = await mensagemNaFila(chave2, { body: "", media: FOTOS[1]! });
        chave3 = await recibo(id, 3, "queued", { body: "", media: FOTOS[2]! });
        mensagem3 = await mensagemNaFila(chave3, { body: "", media: FOTOS[2]! });
      },
    );
    expect(erro).toBeNull();

    // O CRM foi acionado SÓ para reavaliar as duas fotos que já tinha, pela chave de
    // cada recibo. Antes: nada — `send_message` recusava por teto antes do ledger, e
    // as duas fotos (sem corpo, que o vigia pula) ficavam presas para sempre.
    expect(entregues).toEqual([
      { body: "", media: FOTOS[1], key: chave2 },
      { body: "", media: FOTOS[2], key: chave3 },
    ]);

    // No ledger: as três aceitas, nas suas posições, com as mensagens que o CRM já tinha.
    const { rows } = await pool.query<{
      seq: number;
      status: string;
      crm_message_id: string | null;
    }>(
      "select seq, status, crm_message_id from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows.map((r) => [Number(r.seq), r.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(rows[1]!.crm_message_id).toBe(mensagem2);
    expect(rows[2]!.crm_message_id).toBe(mensagem3);

    // O cliente tem as duas fotos, enviadas uma vez cada; nenhuma mensagem nova.
    const { rows: mensagens } = await pool.query<{
      type: string;
      body: string | null;
      status: string;
    }>(
      "select type, body, status from messages where organization_id = $1 and direction = 'outbound' order by created_at",
      [ORG],
    );
    expect(mensagens).toEqual([
      { type: "image", body: null, status: "sent" },
      { type: "image", body: null, status: "sent" },
    ]);

    // Ao modelo: a resposta saiu (duas fotos retomadas); D, nova, recusada por teto —
    // nunca como falha de envio.
    expect(modelo.estado.etapas).toBe(3);
    expect(modelo.estado.checkpoints).toBe(1);
    const resultados = [...modelo.estado.resultados.values()];
    expect(resultados).toHaveLength(2);
    expect(resultados[0]).toMatch(/"status":"enviada"/);
    expect(resultados[0]).toMatch(/"fotos_enviadas":3/);
    expect(resultados[0]).not.toMatch(/aviso/);
    expect(resultados[1]).toMatch(/max_sends_per_turn/);
    expect(resultados.join("\n")).not.toMatch(/envio_falhou/);
  });

  it("A e B aceitas e o template `queued` (teto 3), no canal oficial: A e B voltam como já enviadas, o template é retomado pela mesma chave, um template com outros valores é recusado", async () => {
    const modelo = modeloQueChama([
      { tool: "send_message", input: { body: A } },
      { tool: "send_message", input: { body: B } },
      {
        tool: "send_template",
        input: {
          template_name: TEMPLATE.name,
          language: TEMPLATE.language,
          values: TEMPLATE.values,
        },
      },
      {
        tool: "send_template",
        input: {
          template_name: TEMPLATE.name,
          language: TEMPLATE.language,
          values: { "1": "Outro" },
        },
      },
    ]);
    let chaveDoTemplate = "";
    let mensagemDoTemplate = "";
    const { erro, jobId } = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000010",
      async (id) => {
        await recibo(id, 1, "accepted", A);
        await recibo(id, 2, "accepted", B);
        chaveDoTemplate = await recibo(id, 3, "queued", { body: RENDERIZADO, template: TEMPLATE });
        mensagemDoTemplate = await mensagemNaFila(
          chaveDoTemplate,
          { body: RENDERIZADO, template: TEMPLATE },
          META,
        );
      },
      META,
    );
    expect(erro).toBeNull();

    // Só o template foi ao CRM — reavaliado, pela chave do recibo pendente. A e B já
    // estavam aceitas (voltaram `already_sent`); o template novo nem chegou ao canal.
    expect(entregues).toEqual([{ body: RENDERIZADO, template: TEMPLATE, key: chaveDoTemplate }]);
    const { rows } = await pool.query<{
      seq: number;
      status: string;
      crm_message_id: string | null;
    }>(
      "select seq, status, crm_message_id from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows.map((r) => [Number(r.seq), r.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(rows[2]!.crm_message_id).toBe(mensagemDoTemplate);

    expect(modelo.estado.etapas).toBe(5);
    const resultados = [...modelo.estado.resultados.values()];
    expect(resultados).toHaveLength(4);
    expect(resultados[0]).toMatch(/"status":"enviada"/);
    expect(resultados[1]).toMatch(/"status":"enviada"/);
    expect(resultados[2]).toMatch(/"status":"enviada"/);
    expect(resultados[3]).toMatch(/max_sends_per_turn/);
    expect(resultados.join("\n")).not.toMatch(/envio_falhou/);
  });
});

describe("(rodada 6, 2) a apresentação automática emendada na 1ª mensagem (achado 3 da quinta revisão), com a cadeia de envio real", () => {
  // A organização publica um template de apresentação só para estes casos: com o
  // ponteiro no lugar, TODA 1ª mensagem ao lead sai emendada — por isso ele é retirado
  // depois, para os casos irmãos continuarem sem emenda.
  beforeEach(async () => {
    const { rows } = await pool.query<{ id: string }>(
      "insert into disclosure_template_versions (organization_id, body) values ($1, $2) returning id",
      [ORG, APRESENTACAO],
    );
    await pool.query(
      `insert into disclosure_template_pointers (organization_id, version_id) values ($1, $2)
       on conflict (organization_id) do update set version_id = excluded.version_id, updated_at = now()`,
      [ORG, rows[0]!.id],
    );
  });
  afterEach(async () => {
    await pool.query("delete from disclosure_template_pointers where organization_id = $1", [ORG]);
    await pool.query("delete from disclosure_template_versions where organization_id = $1", [ORG]);
  });

  it("1ª resposta com a apresentação emendada, envio aceito, o modelo cai antes do checkpoint; a re-execução regenera o mesmo texto → `already_sent`, nada duplicado, o job conclui", async () => {
    const emendado = `${APRESENTACAO}\n\n${A}`;
    const primeiro = modeloQueChama([{ tool: "send_message", input: { body: A } }], {
      caiNoCheckpoint: true,
    });
    const { erro: erroDaPrimeira, jobId } = await rodaTurno(
      montaHandler(primeiro.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000011",
      async () => {},
    );
    // A 1ª execução: a resposta saiu COM a apresentação na frente, foi aceita, e o job
    // caiu ao fechar — está na fila para a 2ª tentativa.
    expect(erroDaPrimeira?.message).toMatch(/modelo caiu antes do checkpoint/);
    expect(entregues.map((e) => e.body)).toEqual([emendado]);
    const depoisDaPrimeira = await pool.query<{ seq: number; status: string }>(
      "select seq, status from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(depoisDaPrimeira.rows.map((r) => [Number(r.seq), r.status])).toEqual([[1, "accepted"]]);
    const naFila = await pool.query<{ status: string; attempts: number }>(
      "select status, attempts from job_queue where id = $1",
      [jobId],
    );
    expect(naFila.rows[0]).toEqual({ status: "pending", attempts: 1 });

    // A re-execução: já há envio aceito ao lead, a cadeia não emenda, o modelo regenera A.
    const segundo = modeloQueChama([{ tool: "send_message", input: { body: A } }]);
    const { erro } = await reexecuta(montaHandler(segundo.doGenerate), jobId);
    expect(erro).toBeNull();

    // O CRM não foi acionado de novo: o cliente recebeu a resposta UMA vez. Antes, a
    // re-execução mandava A (sem a apresentação) numa posição nova.
    expect(entregues.map((e) => e.body)).toEqual([emendado]);
    const { rows } = await pool.query<{ seq: number; status: string; body_hash: string }>(
      "select seq, status, body_hash from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    // O recibo é do texto do modelo, não do corpo emendado: é o que a re-execução achou.
    expect(rows.map((r) => [Number(r.seq), r.status, r.body_hash])).toEqual([
      [1, "accepted", m.ledger.hashDoConteudo({ body: A })],
    ]);

    // Ao modelo da re-execução: a resposta "saiu" (já estava aceita), o turno fechou.
    expect(segundo.estado.etapas).toBe(2);
    expect(segundo.estado.checkpoints).toBe(1);
    const resultados = [...segundo.estado.resultados.values()];
    expect(resultados).toHaveLength(1);
    expect(resultados[0]).toMatch(/"status":"enviada"/);
    const concluido = await pool.query<{ status: string }>(
      "select status from job_queue where id = $1",
      [jobId],
    );
    expect(concluido.rows[0]).toEqual({ status: "done" });
  });

  it("a mesma coisa quando a 1ª execução deixou o recibo pendente (o CRM segurou a mensagem): a re-execução ainda é a 1ª ao lead, emenda de novo e retoma o MESMO recibo", async () => {
    // A execução anterior: a cadeia emendou, o canal segurou (`queued`), o job caiu. O
    // recibo tem a identidade do texto do modelo; a mensagem gravada tem o corpo emendado.
    const emendado = `${APRESENTACAO}\n\n${A}`;
    let chave = "";
    let mensagem = "";
    const modelo = modeloQueChama([{ tool: "send_message", input: { body: A } }]);
    const { erro, jobId } = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000012",
      async (id) => {
        chave = await recibo(id, 1, "queued", { body: A });
        mensagem = await mensagemNaFila(chave, { body: emendado });
      },
    );
    expect(erro).toBeNull();
    // Reavaliada pela MESMA chave, com o corpo emendado de novo (ainda não há envio aceito).
    expect(entregues).toEqual([{ body: emendado, key: chave }]);
    const { rows } = await pool.query<{
      seq: number;
      status: string;
      crm_message_id: string | null;
    }>(
      "select seq, status, crm_message_id from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows.map((r) => [Number(r.seq), r.status, r.crm_message_id])).toEqual([
      [1, "accepted", mensagem],
    ]);
    const { rows: mensagens } = await pool.query<{ body: string | null; status: string }>(
      "select body, status from messages where organization_id = $1 and direction = 'outbound'",
      [ORG],
    );
    expect(mensagens).toEqual([{ body: emendado, status: "sent" }]);
  });
});

describe("(rodada 7) o fail-safe de vocabulário interno com o teto cheio e uma pendência conhecida (achado 1 da sexta revisão)", () => {
  /** O texto com vocabulário interno que a versão anterior soltou e o CRM segura. */
  const VETADO = "Pelo crm_leads, o seu cadastro está ativo.";

  /** O que a passagem gravou e o que a Central mostra — como em `c01-fail-safe-turno-completo`. */
  async function estadoDaPassagem() {
    const { rows: contato } = await pool.query<{ force_human: boolean }>(
      "select force_human from contacts where organization_id = $1 and id = $2",
      [ORG, CONTACT],
    );
    const { rows: casos } = await pool.query<{ summary: string; source: string }>(
      "select summary, source from agent_cases where organization_id = $1 and conversation_id = $2",
      [ORG, CONV],
    );
    const { rows: central } = await pool.query<{ body: string | null }>(
      "select body from agent_inbox_items where organization_id = $1 and ref_id = $2",
      [ORG, CONV],
    );
    return { forceHuman: contato[0]!.force_human, casos, central };
  }

  /** Cada caso começa fora da passagem ao humano e sem caso aberto (o fail-safe grava os dois). */
  async function foraDaPassagem(): Promise<void> {
    await pool.query("update contacts set force_human = false where organization_id = $1 and id = $2", [ORG, CONTACT]);
    await pool.query(
      `update conversations
          set bot_silenced_until = null, status = 'open', last_handoff_at = null, last_handoff_reason = null
        where organization_id = $1 and id = $2`,
      [ORG, CONV],
    );
    await pool.query("delete from agent_case_events where organization_id = $1", [ORG]);
    await pool.query("delete from agent_cases where organization_id = $1", [ORG]);
    await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
    await pool.query("delete from passagens_de_atendimento where organization_id = $1", [ORG]);
  }
  beforeEach(foraDaPassagem);
  afterEach(foraDaPassagem);

  /** O que vale nos dois casos: só a frase saiu, por chave nova; a passagem e o caso estão gravados. */
  async function soAFraseSaiu(jobId: string, chaveDaPendencia: string, mensagemDaPendencia: string) {
    expect(entregues.map((e) => e.body)).toEqual([m.turno.FRASE_DE_ESPERA_PADRAO]);
    expect(entregues[0]!.media).toBeUndefined();
    expect(entregues[0]!.key).not.toBe(chaveDaPendencia);
    // A pendência ficou como estava: o CRM continua segurando a mensagem, o recibo continua `queued`.
    const { rows: pendencia } = await pool.query<{ status: string }>(
      "select status from messages where organization_id = $1 and id = $2",
      [ORG, mensagemDaPendencia],
    );
    expect(pendencia).toEqual([{ status: "queued" }]);
    const { rows } = await pool.query<{ seq: number; status: string; id: string; body_hash: string }>(
      "select seq, status, id, body_hash from send_ledger where organization_id = $1 and job_id = $2 order by seq",
      [ORG, jobId],
    );
    expect(rows.map((r) => [Number(r.seq), r.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "queued"],
      [4, "accepted"],
    ]);
    expect(rows[2]!.id).toBe(chaveDaPendencia);
    expect(rows[3]!.body_hash).toBe(m.ledger.hashDoConteudo({ body: m.turno.FRASE_DE_ESPERA_PADRAO }));
    // O caso carrega o texto vetado; a passagem está gravada; a Central sabe que o cliente foi avisado.
    const passagem = await estadoDaPassagem();
    expect(passagem.forceHuman).toBe(true);
    expect(passagem.casos).toEqual([{ summary: VETADO, source: "guardrail_autofallback" }]);
    expect(passagem.central).toHaveLength(1);
    expect(passagem.central[0]!.body).toMatch(/JÁ FOI avisado/);
  }

  it("o texto vetado está `queued` (teto 3 cheio) e o modelo insiste nele três vezes: sai SÓ a frase de espera; o texto vetado não é retomado nem reavaliado", async () => {
    const modelo = modeloQueChama([VETADO, VETADO, VETADO].map((body) => ({ tool: "send_message", input: { body } })));
    let chave = "";
    let mensagem = "";
    const { erro, jobId } = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000013",
      async (id) => {
        await recibo(id, 1, "accepted", A);
        await recibo(id, 2, "accepted", B);
        chave = await recibo(id, 3, "queued", VETADO);
        mensagem = await mensagemNaFila(chave, VETADO);
      },
    );
    expect(erro).toBeNull();
    await soAFraseSaiu(jobId, chave, mensagem);
    // As três chamadas passaram pelo teto (conteúdo conhecido) e foram vetadas; a 3ª
    // devolveu a passagem ao humano, e o laço parou ali.
    expect(modelo.estado.etapas).toBe(3);
    expect(modelo.estado.checkpoints).toBe(1);
    const resultados = [...modelo.estado.resultados.values()];
    expect(resultados).toHaveLength(3);
    expect(resultados[0]).toMatch(/internal_vocabulary_leak"/);
    expect(resultados[1]).toMatch(/internal_vocabulary_leak"/);
    expect(resultados[2]).toMatch(/internal_vocabulary_leak_handoff/);
    expect(resultados.join("\n")).not.toMatch(/max_sends_per_turn/);
  });

  it("a pendência é uma FOTO legada (hash só da legenda vazia, como a versão anterior gravava) e o modelo insiste no texto vetado com o produto: sai SÓ a frase; a foto não é retomada", async () => {
    const modelo = modeloQueChama(
      [VETADO, VETADO, VETADO].map((body) => ({
        tool: "send_message",
        input: { body, produto_codigo: CODIGO_DO_PRODUTO },
      })),
    );
    let chave = "";
    let mensagem = "";
    const { erro, jobId } = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "eeeeeeee-0000-4000-8000-000000000014",
      async (id) => {
        await recibo(id, 1, "accepted", A);
        await recibo(id, 2, "accepted", B);
        // O recibo legado da 2ª foto, sem legenda: `body_hash` = sha256("") — só a mensagem
        // gravada diz que foto é.
        chave = await recibo(id, 3, "queued", "");
        mensagem = await mensagemNaFila(chave, { body: "", media: FOTOS[1]! });
      },
    );
    expect(erro).toBeNull();
    await soAFraseSaiu(jobId, chave, mensagem);
    expect(modelo.estado.etapas).toBe(3);
    const resultados = [...modelo.estado.resultados.values()];
    expect(resultados[2]).toMatch(/internal_vocabulary_leak_handoff/);
  });
});
