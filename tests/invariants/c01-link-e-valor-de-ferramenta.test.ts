import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import { tool } from "ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { z } from "zod";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as McpTools from "@/lib/agent-engine/edge/crm/mcp-tools";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01, -c01.7) A TRAVA "LINK E VALOR DE FERRAMENTA" NO TURNO INTEIRO, contra Postgres
 * real (busca vetorial de verdade, com embedding falso), modelo e canal falsos.
 *
 * Com o interruptor ligado na organização (`org_guardrail_layers`), uma URL fixa na
 * configuração e uma mensagem nossa anterior com o botão do gancho (`?sid=`):
 *   - o link e o valor que a base RAG devolveu neste turno saem;
 *   - o link do botão anterior e a URL fixa saem sem consulta;
 *   - "12x" não é dinheiro: sai sem consulta;
 *   - o link alterado é vetado e nada sai;
 *   - três tentativas com valor inventado: nada do texto sai, só a frase de espera; o
 *     caso abre para a equipe e a conversa passa a uma pessoa. O valor inventado não
 *     aparece no log nem no trace gravado (só no caso, que é para a equipe ler);
 *   - interruptor desligado: a trava não faz nada.
 *
 * E a convivência com a `valor_em_dinheiro` (CRM-060), ligada pelo interruptor dela:
 *   - o preço do curso que veio da consulta às ofertas (base externa) neste turno é
 *     barrado por ela, mesmo com a nova ligada (a nova o liberaria);
 *   - o salário da base passa nas duas; o inventado é barrado pela nova.
 * A base externa é a ferramenta de verdade do turno (`crm_query_external_data`,
 * embrulhada pelo turno); só a montagem dela pelo MCP é trocada por uma falsa.
 *
 * (C01, -c01.8, CRM-085) E o que esta versão muda nas duas travas de texto:
 *   - o texto afirmável da base (salário, cupom) passa pela `valor_em_dinheiro` com a
 *     consulta no turno; com a marca falsa, sem consulta ou com o preço junto, barrado;
 *     o preço com o mesmo número do salário e a linha de preço marcada como afirmável
 *     (assunto fora da lista), barrados (1ª revisão independente);
 *   - sem o divisor de bolhas, a `texto_longo` veta acima de 700 caracteres uma vez e
 *     deixa sair na 2ª (estilo: sem caso, sem passagem); sem etapa para reescrever
 *     (`max_steps` 1, ou as consultas gastando as etapas), sai inteira depois do laço,
 *     só se nenhuma mensagem saiu no turno (duas chamadas paralelas: só a curta sai).
 *
 * Domínios, links e valores são fictícios, na forma dos reais (regra do C01.md).
 */

/** O que a consulta às ofertas devolve: o preço do curso, na forma do MCP. */
const RESULTADO_DAS_OFERTAS = {
  content: [
    {
      type: "text",
      text: JSON.stringify({ rows: [{ produto: "Plano anual", preco: 1997, parcela: "12x de R$ 166,42" }] }),
    },
  ],
};

/** O que a base externa falsa devolve no caso (padrão: as ofertas). */
let respostaDaBase: unknown = RESULTADO_DAS_OFERTAS;

vi.mock("@/lib/agent-engine/edge/crm/mcp-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof McpTools>()),
  buildMcpTurnTools: async () => ({
    tools: {
      crm_query_external_data: tool({
        description: "Consulta a base externa da organização.",
        inputSchema: z.object({ tabela: z.string() }),
        execute: async () => respostaDaBase,
      }),
    },
    toolIds: ["crm_query_external_data"],
    cleanup: async () => {},
  }),
}));

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

const ORG = "a7a7a7a7-0000-4000-8000-000000000001";
const CONTACT = "a7a7a7a7-0000-4000-8000-000000000002";
const SESSION = "a7a7a7a7-0000-4000-8000-000000000003";
const CONV = "a7a7a7a7-0000-4000-8000-000000000004";
const MSG = "a7a7a7a7-0000-4000-8000-000000000005";
const AGENTE = "a7a7a7a7-0000-4000-8000-000000000006";
const VERSAO = "a7a7a7a7-0000-4000-8000-000000000007";
const FONTE = "a7a7a7a7-0000-4000-8000-000000000008";
const VERSAO_DA_BASE = "a7a7a7a7-0000-4000-8000-000000000009";
const TRECHO = "a7a7a7a7-0000-4000-8000-000000000010";
const MSG_DO_GANCHO = "a7a7a7a7-0000-4000-8000-000000000011";
/** O instante do turno (dentro da janela horária do anti-ban) e o da mensagem do cliente, 5 min antes. */
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";
const GANCHO_EM = "2026-07-30T14:50:00Z";

const LINK_DA_BASE = "https://lp.exemplo.com.br/plano-completo/?nivel=superior";
const LINK_ALTERADO = "https://lp.exemplo.com.br/plano-completo/?nivel=tecnico";
const LINK_DO_BOTAO = "https://lp.exemplo.com.br/enfases/?canal=crm&sid=dc-ab12cd34&utm_source=crm";
const URL_FIXA = "https://ajuda.exemplo.com.br/duvidas";
const INTERRUPTOR = "trava:link_e_valor_de_ferramenta";
const INTERRUPTOR_DO_VALOR_EM_DINHEIRO = "trava:valor_em_dinheiro";

type Modules = {
  turno: typeof InboundTurn;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: Array<{ body: string }> = [];
let linhasDoLog: string[] = [];

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
 * Uma etapa do modelo falso: consultar a base RAG, consultar a base externa, mandar este
 * texto, ou (-c01.8) mandar vários textos na MESMA etapa (o SDK roda as chamadas em paralelo).
 */
type Etapa = { busca: string } | { base: string } | { envia: string } | { juntos: string[] };

/**
 * Modelo falso: segue o roteiro e depois encerra. Guarda o texto de cada prompt das
 * etapas (`prompts`) e de todos, inclusive o do checkpoint (`todos`): depois da última
 * tentativa o laço para, e só o checkpoint traz o resultado dela.
 */
function modelo(roteiro: Etapa[]) {
  const estado = { etapas: 0, prompts: [] as string[], todos: [] as string[] };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    estado.todos.push(JSON.stringify(opts.prompt));
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
    if ("juntos" in etapa) {
      return {
        content: etapa.juntos.map((body, k) => ({
          type: "tool-call" as const,
          toolCallId: `c${estado.etapas}-${k}`,
          toolName: "send_message",
          input: JSON.stringify({ body }),
        })),
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [
        "busca" in etapa
          ? {
              type: "tool-call" as const,
              toolCallId: `c${estado.etapas}`,
              toolName: "search_knowledge",
              input: JSON.stringify({ query: etapa.busca }),
            }
          : "base" in etapa
            ? {
                type: "tool-call" as const,
                toolCallId: `c${estado.etapas}`,
                toolName: "crm_query_external_data",
                input: JSON.stringify({ tabela: etapa.base }),
              }
            : {
                type: "tool-call" as const,
                toolCallId: `c${estado.etapas}`,
                toolName: "send_message",
                input: JSON.stringify({ body: etapa.envia }),
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
  const saidaDoLog = new Writable({
    write(pedaco, _codificacao, pronto) {
      linhasDoLog.push(String(pedaco));
      pronto();
    },
  });
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
    log: m.createLogger(saidaDoLog),
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

async function rodaTurno(handler: ReturnType<typeof montaHandler>, db: pg.Pool = pool): Promise<Error | null> {
  await db.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(db, ORG, {
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
  const [claimed] = await m.queue.claimJobs(db, { workerId: "lv", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, db, { workerId: "lv" });
    await m.queue.completeJob(db, claimed!.id, "lv");
    return null;
  } catch (err) {
    await m.queue.failJob(db, claimed!.id, "lv", err);
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

  // A URL fixa na configuração; o interruptor é a linha de `org_guardrail_layers` (beforeEach).
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, settings)
     values ($1,'c01-link-e-valor','Link e valor','Link e valor',
             jsonb_build_object('travas_de_envio',
               jsonb_build_object('link_e_valor_de_ferramenta', jsonb_build_object('urls', jsonb_build_array($2::text)))))
     on conflict (id) do nothing`,
    [ORG, `${URL_FIXA}/`],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead link e valor','+5511900000790') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1,$2,'c01-lv-sessao','WORKING','\\x00'::bytea)
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
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi, quanto ganha e onde faço a matrícula?','external_device',$6)
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION, CONTACT, MENSAGEM_DO_CLIENTE_EM],
  );
  await pool.query(
    `insert into ai_agents (id, organization_id, name, system_prompt, kind)
     values ($1,$2,'Agente link e valor','Você é um atendente de teste.','mcp_agent')
     on conflict (id) do nothing`,
    [AGENTE, ORG],
  );
  // O material da base RAG: o link da matrícula e o salário, como fato em texto.
  await pool.query(
    "insert into ai_knowledge_sources(id,organization_id,agent_id,source_type,name,status) values($1,$2,$3,'faq','Matrícula e salário','ready')",
    [FONTE, ORG, AGENTE],
  );
  await pool.query(
    "insert into ai_knowledge_versions(id,organization_id,agent_id,version_number,is_active) values($1,$2,$3,1,true)",
    [VERSAO_DA_BASE, ORG, AGENTE],
  );
  await pool.query("update ai_knowledge_sources set active_kb_version_id = $1 where id = $2", [
    VERSAO_DA_BASE,
    FONTE,
  ]);
  await pool.query(
    "insert into ai_chunks(id,organization_id,knowledge_source_id,kb_version_id,position,content,content_hash,token_count,embedding,metadata) values($1::uuid,$2,$3,$4,0,$5,$1::text,12,array_fill(0.1::real,array[1536])::vector,'{}')",
    [
      TRECHO,
      ORG,
      FONTE,
      VERSAO_DA_BASE,
      `A matrícula do Plano Completo é feita em ${LINK_DA_BASE}. ` +
        "O salário inicial do cargo é de R$ 6.638,64 (nível superior).",
    ],
  );
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                    provider, model, channel_session_id, status, published_at, max_steps,
                                    knowledge_source_ids, tool_ids)
     values ($1,$2,$3,1,'Você é um atendente de teste.','anthropic','claude-sonnet-4-6',$4,'published',now(),8,
             array[$5::uuid], array['crm_query_external_data'])
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
  linhasDoLog = [];
  respostaDaBase = RESULTADO_DAS_OFERTAS;
  await pool.query(
    `insert into org_guardrail_layers (organization_id, layer, enabled) values ($1, $2, true)
     on conflict (organization_id, layer) do update set enabled = true`,
    [ORG, INTERRUPTOR],
  );
  // A `valor_em_dinheiro` começa sem linha (e sem JSON): desligada, como na produção.
  await pool.query("delete from org_guardrail_layers where organization_id = $1 and layer = $2", [
    ORG,
    INTERRUPTOR_DO_VALOR_EM_DINHEIRO,
  ]);
  await pool.query("delete from before_send_traces where organization_id = $1", [ORG]);
  await pool.query("delete from agent_case_events where organization_id = $1", [ORG]);
  await pool.query("delete from agent_cases where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
  await pool.query("update contacts set force_human = false where organization_id = $1 and id = $2", [
    ORG,
    CONTACT,
  ]);
  await pool.query(
    `update conversations
        set bot_silenced_until = null, status = 'open', last_handoff_at = null, last_handoff_reason = null
      where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  await pool.query("delete from passagens_de_atendimento where organization_id = $1", [ORG]);
  // Só a mensagem do gancho fica entre as nossas: o que um caso mandou não libera o seguinte.
  await pool.query("delete from messages where organization_id = $1 and direction = 'outbound'", [ORG]);
  // A mensagem do gancho antes do turno: a capa no corpo, o link só no botão (`cta_url`).
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at, metadata)
     values ($1,$2,$3,$4,$5,'text','outbound','delivered','Oi! Confere as ênfases na página.','automation',$6,
             jsonb_build_object('interactive', jsonb_build_object(
               'type','cta_url',
               'body', jsonb_build_object('text','Oi! Confere as ênfases na página.'),
               'action', jsonb_build_object('name','cta_url','parameters',
                 jsonb_build_object('display_text','Abrir a página','url',$7::text)))))`,
    [MSG_DO_GANCHO, ORG, CONV, SESSION, CONTACT, GANCHO_EM, LINK_DO_BOTAO],
  );
});

describe("(C01, -c01.7) a trava 'link e valor de ferramenta' no turno inteiro", () => {
  it("consulta a base e manda o link e o valor EXATOS que voltaram: sai", async () => {
    const corpo = `O salário inicial é de R$ 6.638,64. A matrícula é por aqui: ${LINK_DA_BASE}.`;
    const mod = modelo([{ busca: "salário e matrícula" }, { envia: corpo }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();

    expect(mod.estado.prompts[1]).toContain("6.638,64");
    expect(enviados.map((e) => e.body)).toEqual([corpo]);
    expect(mod.estado.prompts.join("\n")).not.toContain("link_ou_valor_sem_consulta");
  });

  it("sem consulta: o link do botão do gancho (`?sid=`) e a URL fixa da configuração saem", async () => {
    const corpo = `Pode abrir de novo: ${LINK_DO_BOTAO} — e as dúvidas estão em ${URL_FIXA}`;
    const mod = modelo([{ envia: corpo }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();

    expect(enviados.map((e) => e.body)).toEqual([corpo]);
    expect(mod.estado.prompts.join("\n")).not.toContain("link_ou_valor_sem_consulta");
  });

  it("'12x' não é dinheiro: sai sem consulta", async () => {
    const corpo = "Dá para dividir em 12x no cartão, e são 60 metas.";
    const mod = modelo([{ envia: corpo }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual([corpo]);
  });

  it("consulta e manda o link ALTERADO (outro `nivel`): vetado, nada sai", async () => {
    const mod = modelo([{ busca: "matrícula" }, { envia: `A matrícula é por aqui: ${LINK_ALTERADO}` }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();

    expect(enviados).toEqual([]);
    expect(mod.estado.prompts[2]).toContain("link_ou_valor_sem_consulta");
    expect(mod.estado.prompts[2]).toContain("link que não veio de uma consulta neste turno");
  });

  it("três tentativas com valor inventado: nada do texto sai, a frase de espera sai, o caso abre e a conversa passa a uma pessoa; o valor não vai ao log nem ao trace", async () => {
    const tentativas = [
      "O salário inicial é de R$ 6.700.",
      "O salário inicial fica em R$ 6.700,00.",
      "O salário inicial é de uns 6.700 reais.",
    ];
    const mod = modelo([{ busca: "salário" }, ...tentativas.map((envia) => ({ envia }))]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();

    // O cliente recebeu UMA mensagem: a frase de espera. Nenhuma das três tentativas.
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain(m.turno.FRASE_DE_ESPERA_PADRAO);
    expect(enviados[0]!.body).not.toContain("6.700");

    // O modelo leu dois vetos de ensino e o terceiro como passagem; o laço parou ali.
    const prompts = mod.estado.todos.join("\n");
    expect(prompts).toContain("link_ou_valor_sem_consulta");
    expect(prompts).toContain("link_ou_valor_sem_consulta_handoff");
    expect(mod.estado.etapas).toBe(1 + tentativas.length);

    // O caso foi aberto pelo fail-safe, com o texto vetado como resumo (é para a equipe ler).
    const { rows: casos } = await pool.query<{ source: string; summary: string; title: string }>(
      "select source, summary, title from agent_cases where organization_id = $1 and conversation_id = $2",
      [ORG, CONV],
    );
    expect(casos).toHaveLength(1);
    expect(casos[0]!.source).toBe("guardrail_autofallback");
    expect(casos[0]!.summary).toBe(tentativas[2]);
    expect(casos[0]!.title).toContain("link ou valor que não veio de consulta");

    // A passagem a uma pessoa ficou gravada: o turno seguinte do lead não volta ao modelo.
    const { rows: contato } = await pool.query<{ force_human: boolean }>(
      "select force_human from contacts where organization_id = $1 and id = $2",
      [ORG, CONTACT],
    );
    expect(contato[0]!.force_human).toBe(true);

    // O trace gravado tem o veto (só as contagens), sem o valor.
    const { rows: traces } = await pool.query<{ trace: unknown; vetoed_code: string | null }>(
      "select trace, vetoed_code from before_send_traces where organization_id = $1 order by created_at",
      [ORG],
    );
    expect(traces.filter((t) => t.vetoed_code === "link_ou_valor_sem_consulta")).toHaveLength(3);
    const tudoGravado = JSON.stringify(traces);
    expect(tudoGravado).toContain('"valores":1');
    for (const trecho of ["6.700", "6700"]) {
      expect(tudoGravado, `trace com ${trecho}`).not.toContain(trecho);
      expect(linhasDoLog.join(""), `log com ${trecho}`).not.toContain(trecho);
    }
    // O log existe (o instrumento mediu algo) e registra o veto pelo código.
    expect(linhasDoLog.length).toBeGreaterThan(0);
    expect(linhasDoLog.join("")).toContain("link_ou_valor_sem_consulta");
  });

  it("interruptor DESLIGADO: a trava não faz nada (o valor inventado sai)", async () => {
    await pool.query(
      "update org_guardrail_layers set enabled = false where organization_id = $1 and layer = $2",
      [ORG, INTERRUPTOR],
    );
    const corpo = "O salário inicial é de R$ 6.700.";
    const mod = modelo([{ envia: corpo }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();

    expect(enviados.map((e) => e.body)).toEqual([corpo]);
    expect(mod.estado.prompts.join("\n")).not.toContain("link_ou_valor_sem_consulta");
  });
});

/** Os vetos gravados no trace deste caso: (trava, código). */
async function vetosGravados(): Promise<Array<[string | null, string | null]>> {
  const { rows } = await pool.query<{ vetoed_gate: string | null; vetoed_code: string | null }>(
    "select vetoed_gate, vetoed_code from before_send_traces where organization_id = $1 and vetoed_gate is not null order by created_at",
    [ORG],
  );
  return rows.map((r) => [r.vetoed_gate, r.vetoed_code]);
}

describe("(C01, -c01.7) convivência com a `valor_em_dinheiro` (CRM-060), no turno inteiro", () => {
  async function ligaValorEmDinheiro(): Promise<void> {
    await pool.query(
      `insert into org_guardrail_layers (organization_id, layer, enabled) values ($1, $2, true)
       on conflict (organization_id, layer) do update set enabled = true`,
      [ORG, INTERRUPTOR_DO_VALOR_EM_DINHEIRO],
    );
  }

  it("o preço do curso que veio das ofertas neste turno é barrado pela `valor_em_dinheiro`, mesmo com a nova ligada", async () => {
    await ligaValorEmDinheiro();
    const mod = modelo([{ base: "ofertas" }, { envia: "O plano anual sai por R$ 1.997,00." }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();

    // A consulta à base externa devolveu o preço (a 2ª etapa o leu), e a nova o liberaria.
    expect(mod.estado.prompts[1]).toContain("Plano anual");
    expect(enviados).toEqual([]);
    expect(await vetosGravados()).toEqual([["valor_em_dinheiro", "valor_em_dinheiro"]]);
  });

  it("controle: sem a `valor_em_dinheiro`, a nova solta o preço que veio da consulta (por isso o interruptor dela)", async () => {
    const corpo = "O plano anual sai por R$ 1.997,00.";
    const mod = modelo([{ base: "ofertas" }, { envia: corpo }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual([corpo]);
    expect(await vetosGravados()).toEqual([]);
  });

  it("o salário da base passa nas duas", async () => {
    await ligaValorEmDinheiro();
    const corpo = "O salário inicial é de R$ 6.638,64.";
    const mod = modelo([{ busca: "salário" }, { envia: corpo }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual([corpo]);
    expect(await vetosGravados()).toEqual([]);
  });

  it("o salário inventado é barrado pela nova", async () => {
    await ligaValorEmDinheiro();
    const mod = modelo([{ busca: "salário" }, { envia: "O salário inicial é de R$ 6.700." }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
    expect(enviados).toEqual([]);
    expect(await vetosGravados()).toEqual([["link_e_valor_de_ferramenta", "link_ou_valor_sem_consulta"]]);
  });
});

describe("(C01, revisão B1) o erro da base externa não libera o que o modelo inventou", () => {
  it("vetado, o modelo consulta a base com o valor e o link no nome da coluna; o erro volta com eles, e a 2ª tentativa é vetada de novo", async () => {
    // O erro como a base externa o devolve (sem `isError`), no formato do MCP.
    const erro = {
      erro: "pedido_invalido",
      mensagem: "algum campo ou operador não existe nessa tabela. Confira com crm_describe_external_data.",
      detalhe: "coluna_inexistente:salario R$ 6.700 https://lp.exemplo.com.br/salario-inventado",
    };
    respostaDaBase = { content: [{ type: "text", text: JSON.stringify(erro) }], structuredContent: erro };
    const corpo = "O salário inicial é de R$ 6.700. Detalhes: https://lp.exemplo.com.br/salario-inventado";
    const mod = modelo([{ envia: corpo }, { base: "salario R$ 6.700 https://lp.exemplo.com.br/salario-inventado" }, { envia: corpo }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();

    // A consulta voltou com o erro, e o modelo o leu (a 3ª etapa o tem).
    expect(mod.estado.prompts[2]).toContain("coluna_inexistente");
    // Sem a correção: a 2ª tentativa sai, liberada pelo próprio erro.
    expect(enviados).toEqual([]);
    expect(await vetosGravados()).toEqual([
      ["link_e_valor_de_ferramenta", "link_ou_valor_sem_consulta"],
      ["link_e_valor_de_ferramenta", "link_ou_valor_sem_consulta"],
    ]);
  });
});

/** O resultado da consulta à base externa com estas linhas, na forma do MCP (`content` e `structuredContent`). */
function linhasDaBase(linhas: Array<Record<string, unknown>>) {
  const r = { tabela: "fatos_do_agente", linhas, linhas_devolvidas: linhas.length };
  return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
}

describe("(C01, -c01.8) o texto afirmável da base passa pela `valor_em_dinheiro`; o preço do curso não (CRM-085), no turno inteiro", () => {
  const SALARIO =
    "Na Empresa Exemplo, o salário base de nível técnico é de R$ 7.412,35 no regime administrativo.";
  const CUPOM = "Pra pagamento no cartão ou à vista, consigo um cupom de 5%: é só digitar o código no campo de cupom.";

  async function ligaValorEmDinheiro(): Promise<void> {
    await pool.query(
      `insert into org_guardrail_layers (organization_id, layer, enabled) values ($1, $2, true)
       on conflict (organization_id, layer) do update set enabled = true`,
      [ORG, INTERRUPTOR_DO_VALOR_EM_DINHEIRO],
    );
  }

  it("consulta os fatos e manda o salário e o cupom afirmáveis com o texto da base: sai", async () => {
    await ligaValorEmDinheiro();
    respostaDaBase = linhasDaBase([
      { chave: "salario", assunto: "salario", texto_para_o_lead: SALARIO, pode_afirmar: true },
      { chave: "cupom", assunto: "desconto", texto_para_o_lead: CUPOM, pode_afirmar: true },
    ]);
    const corpo = `${SALARIO}\n\n${CUPOM}`;
    const mod = modelo([{ base: "fatos" }, { envia: corpo }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual([corpo]);
    expect(await vetosGravados()).toEqual([]);
  });

  it("o mesmo cupom de linha com a marca de afirmar falsa é barrado", async () => {
    await ligaValorEmDinheiro();
    respostaDaBase = linhasDaBase([{ chave: "cupom", assunto: "desconto", texto_para_o_lead: CUPOM, pode_afirmar: false }]);
    const mod = modelo([{ base: "fatos" }, { envia: CUPOM }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
    expect(enviados).toEqual([]);
    expect(await vetosGravados()).toEqual([["valor_em_dinheiro", "valor_em_dinheiro"]]);
  });

  it("sem consulta neste turno (o cupom só numa mensagem já enviada), barrado", async () => {
    await ligaValorEmDinheiro();
    // (Junção da 1.86) `created_at` junto com `sent_at`: a mensagem é ANTERIOR à do
    // cliente. Sem ele, o `now()` a punha depois da inbound do cenário, e a memória da
    // quase-duplicata do autor (`corposEnviadosDesdeUltimaInbound`, que lê `created_at`)
    // suprimia o envio antes de a trava do valor ser avaliada.
    await pool.query(
      `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
         type, direction, status, body, sent_via, sent_at, created_at)
       values ($1,$2,$3,$4,$5,'text','outbound','delivered',$6,'ai',$7,$7)`,
      [randomUUID(), ORG, CONV, SESSION, CONTACT, CUPOM, GANCHO_EM],
    );
    const mod = modelo([{ envia: CUPOM }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
    expect(enviados).toEqual([]);
    expect(await vetosGravados()).toEqual([["valor_em_dinheiro", "valor_em_dinheiro"]]);
  });

  it("o preço do curso que veio junto, numa linha de oferta, continua barrado", async () => {
    await ligaValorEmDinheiro();
    respostaDaBase = linhasDaBase([
      { chave: "salario", assunto: "salario", texto_para_o_lead: SALARIO, pode_afirmar: true },
      { produto: "Plano anual", preco_total: 1997, pode_afirmar: true, condicao: "Aberta até 31/10." },
    ]);
    const mod = modelo([{ base: "fatos e ofertas" }, { envia: `${SALARIO} O plano anual sai por R$ 1.997,00.` }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
    expect(enviados).toEqual([]);
    expect(await vetosGravados()).toEqual([["valor_em_dinheiro", "valor_em_dinheiro"]]);
  });

  // (1ª revisão da -c01.8) Os furos reproduzidos pela revisão independente.
  it("o preço com o mesmo número do salário, ao lado da frase do salário, é barrado", async () => {
    await ligaValorEmDinheiro();
    respostaDaBase = linhasDaBase([
      { chave: "salario", assunto: "salario", texto_para_o_lead: SALARIO, pode_afirmar: true },
    ]);
    const mod = modelo([{ base: "fatos" }, { envia: `${SALARIO} O preço do curso é de R$ 7.412,35.` }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
    expect(enviados).toEqual([]);
    expect(await vetosGravados()).toEqual([["valor_em_dinheiro", "valor_em_dinheiro"]]);
  });

  it("linha de preço marcada como afirmável, com assunto fora da lista, não libera", async () => {
    await ligaValorEmDinheiro();
    const PRECO = "O curso custa R$ 997 no cartão.";
    respostaDaBase = linhasDaBase([{ chave: "preco", assunto: "preco", texto_para_o_lead: PRECO, pode_afirmar: true }]);
    const mod = modelo([{ base: "fatos" }, { envia: PRECO }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
    expect(enviados).toEqual([]);
    expect(await vetosGravados()).toEqual([["valor_em_dinheiro", "valor_em_dinheiro"]]);
  });
});

describe("(C01, -c01.8) 'até 700 caracteres' com o divisor de bolhas desligado (CRM-085), no turno inteiro", () => {
  const FRASE = "O curso é online e você estuda no seu horário, com metas para cada dia. ";
  // Um texto por caso: o mesmo corpo em casos seguidos cairia na trava de repetição em massa.
  const comTamanho = (n: number, frase = FRASE) => frase.repeat(Math.ceil(n / frase.length)).slice(0, n - 1) + "!";

  async function ligaTextoLongo(ligada: boolean): Promise<void> {
    await pool.query(
      ligada
        ? `update organizations set settings = jsonb_set(settings, '{travas_de_envio,texto_longo}', '{"ligada": true}')
            where id = $1`
        : `update organizations set settings = settings #- '{travas_de_envio,texto_longo}' where id = $1`,
      [ORG],
    );
  }

  it("701 caracteres: o 1º veto ensina; a 2ª tentativa sai inteira, sem caso nem passagem", async () => {
    await ligaTextoLongo(true);
    try {
      const longo = comTamanho(701);
      expect([...longo]).toHaveLength(701);
      const mod = modelo([{ envia: longo }, { envia: longo }]);
      expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();

      expect(mod.estado.prompts[1]).toContain("Reescreva em até 700 caracteres, numa mensagem só");
      expect(enviados.map((e) => e.body)).toEqual([longo]);
      const vetos = await vetosGravados();
      expect(vetos.length).toBeGreaterThan(0);
      expect(vetos.every(([trava]) => trava === "texto_longo")).toBe(true);
      expect(linhasDoLog.join("")).toContain("trava de estilo no limite");
      const { rows: casos } = await pool.query("select 1 from agent_cases where organization_id = $1", [ORG]);
      expect(casos).toEqual([]);
      const { rows: contato } = await pool.query<{ force_human: boolean }>(
        "select force_human from contacts where organization_id = $1 and id = $2",
        [ORG, CONTACT],
      );
      expect(contato[0]!.force_human).toBe(false);
    } finally {
      await ligaTextoLongo(false);
    }
  });

  /** Publica uma versão igual à do teste com `max_steps = n` (a publicada é imutável); `null` volta à original. */
  async function maxSteps(n: number | null): Promise<void> {
    if (n === null) {
      await pool.query("update ai_agents set published_version_id = $1 where id = $2", [VERSAO, AGENTE]);
      return;
    }
    const versao = `a7a7a7a7-0000-4000-8000-${String(100 + n).padStart(12, "0")}`;
    await pool.query(
      `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt,
                                      provider, model, channel_session_id, status, published_at, max_steps,
                                      knowledge_source_ids, tool_ids)
       values ($1,$2,$3,$4,'Você é um atendente de teste.','anthropic','claude-sonnet-4-6',$5,'published',now(),$6,
               array[$7::uuid], array['crm_query_external_data'])
       on conflict (id) do nothing`,
      [versao, ORG, AGENTE, 100 + n, SESSION, n, FONTE],
    );
    await pool.query("update ai_agents set published_version_id = $1 where id = $2", [versao, AGENTE]);
  }
  /** O veto de estilo sem etapa para reescrever: a mensagem sai inteira, sem caso, sem frase de espera, sem passagem. */
  async function saiInteiraSemPassagem(corpo: string): Promise<void> {
    expect(enviados.map((e) => e.body)).toEqual([corpo]);
    const vetos = await vetosGravados();
    expect(vetos.length).toBeGreaterThan(0);
    expect(vetos.every(([trava]) => trava === "texto_longo")).toBe(true);
    expect(linhasDoLog.join("")).toContain("trava de estilo sem etapa para reescrever");
    const { rows: casos } = await pool.query("select 1 from agent_cases where organization_id = $1", [ORG]);
    expect(casos).toEqual([]);
    const { rows: contato } = await pool.query<{ force_human: boolean }>(
      "select force_human from contacts where organization_id = $1 and id = $2",
      [ORG, CONTACT],
    );
    expect(contato[0]!.force_human).toBe(false);
  }

  it("max_steps = 1: o veto cai na única etapa; a mensagem sai inteira, sem caso nem passagem", async () => {
    await ligaTextoLongo(true);
    await maxSteps(1);
    try {
      const longo = comTamanho(701, "O cronograma diz o que estudar em cada meta, e você segue no seu ritmo. ");
      const mod = modelo([{ envia: longo }]);
      expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
      expect(mod.estado.etapas).toBe(1);
      await saiInteiraSemPassagem(longo);
    } finally {
      await maxSteps(null);
      await ligaTextoLongo(false);
    }
  });

  it("as consultas gastam as etapas e o veto cai na última: a mensagem sai inteira, sem caso nem passagem", async () => {
    await ligaTextoLongo(true);
    await maxSteps(3);
    respostaDaBase = linhasDaBase([]);
    try {
      const longo = comTamanho(701, "Os simulados são comentados e cronometrados, no estilo da banca da prova. ");
      const mod = modelo([{ base: "fatos" }, { base: "ofertas" }, { envia: longo }]);
      expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
      expect(mod.estado.etapas).toBe(3);
      await saiInteiraSemPassagem(longo);
    } finally {
      await maxSteps(null);
      await ligaTextoLongo(false);
    }
  });

  it("duas chamadas na mesma etapa (paralelas), a curta sai e a longa é vetada: só a curta sai, sem caso nem passagem (2ª revisão)", async () => {
    await ligaTextoLongo(true);
    await maxSteps(1);
    try {
      const curta = "Oi! Já te mando o resumo do curso.";
      const longa = comTamanho(701, "As metas mostram o que estudar e quais questões resolver em cada dia. ");
      const mod = modelo([{ juntos: [curta, longa] }]);
      // Duas chamadas paralelas seguram uma conexão cada na serialização do número: o pool
      // do turno tem o tamanho padrão do `pg` na produção (10), não o de 2 deste arquivo.
      const comoNaProducao = new pg.Pool({
        connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
        max: 10,
      });
      try {
        expect(await rodaTurno(montaHandler(mod.doGenerate), comoNaProducao)).toBeNull();
      } finally {
        await comoNaProducao.end();
      }
      expect(mod.estado.etapas).toBe(1);
      expect(enviados.map((e) => e.body)).toEqual([curta]);
      expect(linhasDoLog.join("")).not.toContain("trava de estilo sem etapa para reescrever");
      const { rows: casos } = await pool.query("select 1 from agent_cases where organization_id = $1", [ORG]);
      expect(casos).toEqual([]);
      const { rows: contato } = await pool.query<{ force_human: boolean }>(
        "select force_human from contacts where organization_id = $1 and id = $2",
        [ORG, CONTACT],
      );
      expect(contato[0]!.force_human).toBe(false);
    } finally {
      await maxSteps(null);
      await ligaTextoLongo(false);
    }
  });

  it("700 caracteres saem de primeira", async () => {
    await ligaTextoLongo(true);
    try {
      const corpo = comTamanho(700, "Cada meta mostra o que estudar, qual aula assistir e quais questões resolver hoje. ");
      const mod = modelo([{ envia: corpo }]);
      expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
      expect(enviados.map((e) => e.body)).toEqual([corpo]);
      expect(await vetosGravados()).toEqual([]);
    } finally {
      await ligaTextoLongo(false);
    }
  });

  it("com a trava desligada, nada muda: 701 caracteres saem de primeira", async () => {
    const corpo = comTamanho(701, "As aulas ficam gravadas e você assiste quando puder, no celular ou no computador. ");
    const mod = modelo([{ envia: corpo }]);
    expect(await rodaTurno(montaHandler(mod.doGenerate))).toBeNull();
    expect(enviados.map((e) => e.body)).toEqual([corpo]);
    expect(await vetosGravados()).toEqual([]);
  });
});
