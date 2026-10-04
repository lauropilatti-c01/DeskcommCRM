import { randomUUID } from "node:crypto";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01, -c01.3, rodada 2) O LINK QUE A BASE RAG DEVOLVEU PASSA PELA TRAVA "LINK
 * PERMITIDO" — achado 5 (médio) da 1ª revisão adversarial do Codex da -c01.3
 * (04/10/2026), contra Postgres real (busca vetorial de verdade, com embedding falso),
 * modelo e canal falsos.
 *
 * O achado: a trava libera o link que a base devolveu NESTE turno (`urlsDaBase`), mas só
 * a consulta à base externa (`crm_query_external_data`) alimentava esse conjunto. O
 * resultado de `search_knowledge` (a base RAG do agente) ia ao modelo sem registrar as
 * URLs: o link recém-consultado, ainda não enviado e sem domínio liberado, era vetado;
 * em três tentativas a conversa ia à equipe sem necessidade.
 *
 * O que se prova, com a trava ligada na organização:
 *   - o modelo consulta a base RAG e manda o link EXATO que ela devolveu → sai;
 *   - o modelo consulta e manda o link alterado (outro `nivel`) → vetado, nada sai;
 *   - controle: sem a consulta no turno, o mesmo link é vetado (a liberação vem da busca).
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

const ORG = "a5a5a5a5-0000-4000-8000-000000000001";
const CONTACT = "a5a5a5a5-0000-4000-8000-000000000002";
const SESSION = "a5a5a5a5-0000-4000-8000-000000000003";
const CONV = "a5a5a5a5-0000-4000-8000-000000000004";
const MSG = "a5a5a5a5-0000-4000-8000-000000000005";
const AGENTE = "a5a5a5a5-0000-4000-8000-000000000006";
const VERSAO = "a5a5a5a5-0000-4000-8000-000000000007";
const FONTE = "a5a5a5a5-0000-4000-8000-000000000008";
const VERSAO_DA_BASE = "a5a5a5a5-0000-4000-8000-000000000009";
const TRECHO = "a5a5a5a5-0000-4000-8000-000000000010";
/** O instante do turno (dentro da janela horária do anti-ban) e o da mensagem do cliente, 5 min antes. */
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";

/** O link que está no material da base RAG, e o vizinho que o modelo inventaria. */
const LINK_DA_BASE = "https://lp.exemplo.com.br/plano-completo/?nivel=superior";
const LINK_ALTERADO = "https://lp.exemplo.com.br/plano-completo/?nivel=tecnico";

type Modules = {
  turno: typeof InboundTurn;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: Array<{ body: string }> = [];

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

/**
 * Modelo falso: (se `consulta`) busca na base RAG; depois manda a mensagem com `link`;
 * depois encerra. Guarda o texto de cada prompt (o resultado das ferramentas vem nele).
 */
function modelo(link: string, consulta: boolean) {
  const roteiro = [...(consulta ? ["busca"] : []), "envia"];
  const estado = { etapas: 0, prompts: [] as string[] };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    const ultima = msgs[msgs.length - 1];
    const ehCheckpoint =
      ultima?.role === "user" &&
      Array.isArray(ultima.content) &&
      (ultima.content as Array<Record<string, unknown>>).some(
        (p) => p.type === "text" && p.text === m.turno.CHECKPOINT_INSTRUCTION,
      );
    if (ehCheckpoint) return texto(CHECKPOINT);
    estado.prompts.push(JSON.stringify(opts.prompt));
    const etapa = roteiro[estado.etapas];
    estado.etapas += 1;
    if (etapa === undefined) return texto("pronto");
    return {
      content: [
        etapa === "busca"
          ? {
              type: "tool-call" as const,
              toolCallId: `c${estado.etapas}`,
              toolName: "search_knowledge",
              input: JSON.stringify({ query: "página de matrícula" }),
            }
          : {
              type: "tool-call" as const,
              toolCallId: `c${estado.etapas}`,
              toolName: "send_message",
              input: JSON.stringify({ body: `A matrícula é por aqui: ${link}` }),
            },
      ],
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
  return { doGenerate, estado };
}

function texto(t: string) {
  return {
    content: [{ type: "text" as const, text: t }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: USO,
    warnings: [],
  };
}

function montaHandler(doGenerate: unknown) {
  return m.turno.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      maxSteps: 8,
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
    // O embedding da pergunta é o mesmo do trecho: a busca vetorial o devolve.
    embed: (async () => ({
      embedding: Array(1536).fill(0.1),
      promptTokens: 0,
      model: "text-embedding-3-small",
    })) as never,
    channel: () =>
      ({
        channel: "captura",
        send: async (i: { body: string }) => {
          enviados.push({ body: i.body });
          return { kind: "sent", idempotencyKey: `k${enviados.length}`, messageId: `m${enviados.length}` };
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: true, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => AGORA,
    sleep: async () => {},
  });
}

async function rodaTurno(handler: ReturnType<typeof montaHandler>): Promise<Error | null> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION,
      inbound_message_id: MSG,
      crm_event_id: randomUUID(),
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "rag", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "rag" });
    await m.queue.completeJob(pool, claimed!.id, "rag");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "rag", err);
    return err as Error;
  }
}

beforeAll(async () => {
  m = {
    turno: await import("@/lib/agent-engine/agent/inbound-turn"),
    queue: await import("@/lib/agent-engine/queue/queue"),
    createLogger: (await import("@/lib/agent-engine/obs/logger")).createLogger,
    createFakeRegistry: (await import("@/lib/agent-engine/edge/llm/providers")).createFakeRegistry,
  };

  // A trava de link LIGADA na organização, sem domínio liberado.
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1,'c01-link-da-base-rag','Base RAG','Base RAG',
             '{"travas_de_envio": {"link_permitido": {"ligada": true}}}'::jsonb)
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead RAG','+5511900000780') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-rag-sessao','WORKING','\\x00'::bytea)
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
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi, onde faço a matrícula?','external_device',$6)
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT, MENSAGEM_DO_CLIENTE_EM],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1,$2,'Agente da base RAG','Você é um atendente de teste.','mcp_agent')
     on conflict (id) do nothing`,
    [AGENTE, ORG],
  );
  // O material da base RAG, com o link da página de matrícula no texto do trecho.
  await pool.query(
    "insert into ai_knowledge_sources(id,organization_id,agent_id,source_type,name,status) values($1,$2,$3,'faq','Matrícula','ready')",
    [FONTE, ORG, AGENTE],
  );
  await pool.query(
    "insert into ai_knowledge_versions(id,organization_id,agent_id,version_number,is_active) values($1,$2,$3,1,true)",
    [VERSAO_DA_BASE, ORG, AGENTE],
  );
  // O material aponta para o índice dele (0181): é por aí que a busca acha o trecho.
  await pool.query("update ai_knowledge_sources set active_kb_version_id = $1 where id = $2", [
    VERSAO_DA_BASE,
    FONTE,
  ]);
  await pool.query(
    "insert into ai_chunks(id,organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding,metadata) values($1::uuid,$2,$3,$4,0,$5,$1::text,12,array_fill(0.1::real,array[1536])::vector,'{}')",
    [TRECHO, ORG, FONTE, VERSAO_DA_BASE, `A matrícula do Plano Completo (nível superior) é feita em ${LINK_DA_BASE}.`],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at, max_steps,
                                    knowledge_source_ids)
     values ($1,$2,$3,1,'Você é um atendente de teste.','anthropic','claude-sonnet-4-6',$4,'published',now(),8,
             array[$5::uuid])
     on conflict (id) do nothing`,
    [VERSAO, ORG, AGENTE, SESSION, FONTE],
  );
  await pool.query(
    "update ai_agents set published_version_id = $1, active_kb_version_id = $2 where id = $3",
    [VERSAO, VERSAO_DA_BASE, AGENTE],
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
  enviados = [];
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query(
    "delete from messages where organization_id = $1 and direction = 'outbound'",
    [ORG],
  );
});

describe("(C01, -c01.3, rodada 2) o link que a base RAG devolveu passa pela trava 'link permitido'", () => {
  it("o modelo consulta a base RAG e manda o link EXATO que ela devolveu: a mensagem sai", async () => {
    const mod = modelo(LINK_DA_BASE, true);
    const erro = await rodaTurno(montaHandler(mod.doGenerate));

    expect(erro).toBeNull();
    // A busca devolveu o trecho com o link (a 2ª etapa o leu).
    expect(mod.estado.prompts[1]).toContain(LINK_DA_BASE);
    // Sem a correção: vetado como `link_nao_permitido`, e nada sai (`[]`).
    expect(enviados.map((e) => e.body)).toEqual([`A matrícula é por aqui: ${LINK_DA_BASE}`]);
    expect(mod.estado.prompts.join("\n")).not.toContain("link_nao_permitido");
  });

  it("o modelo consulta e manda o link ALTERADO (outro `nivel`): vetado, nada sai", async () => {
    const mod = modelo(LINK_ALTERADO, true);
    const erro = await rodaTurno(montaHandler(mod.doGenerate));

    expect(erro).toBeNull();
    expect(enviados).toEqual([]);
    expect(mod.estado.prompts[2]).toContain("link_nao_permitido");
  });

  it("controle: sem a consulta no turno, o mesmo link é vetado (a liberação vem da busca)", async () => {
    const mod = modelo(LINK_DA_BASE, false);
    const erro = await rodaTurno(montaHandler(mod.doGenerate));

    expect(erro).toBeNull();
    expect(enviados).toEqual([]);
    expect(mod.estado.prompts[1]).toContain("link_nao_permitido");
  });
});
