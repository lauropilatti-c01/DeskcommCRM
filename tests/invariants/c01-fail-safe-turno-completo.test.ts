import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as InboundTurn from "@/lib/agent-engine/agent/inbound-turn";
import type * as Providers from "@/lib/agent-engine/edge/llm/providers";
import type * as Queue from "@/lib/agent-engine/queue/queue";
import type * as ObsLogger from "@/lib/agent-engine/obs/logger";

/**
 * (C01) O FAIL-SAFE DE VOCABULÁRIO INTERNO NO TURNO COMPLETO — as regressões
 * comportamentais que a revisão adversarial do Codex (03/10/2026) pediu para os
 * achados 2 e 3 da trava 4b, rodando o turno inteiro contra Postgres real, com
 * modelo e canal falsos (o mesmo harness de `agent-send-template-turn.test.ts`).
 *
 * Os testes unitários `c01-trava-do-fail-safe-vale-para-todo-envio` e
 * `c01-aviso-de-espera-indisponivel-re-tenta` provam as peças e prendem a ligação
 * pelo código. Aqui o que se prova é o efeito, do jeito que o cliente o sentiria:
 *
 *   - achado 2: um modelo que vaza vocabulário interno três vezes e, na etapa
 *     seguinte, tenta `send_template` — o template NÃO chega ao cliente, e a etapa
 *     seguinte nem acontece (o laço para no fail-safe);
 *   - achado 3: o canal está indisponível quando a frase de espera sai — o turno
 *     NÃO fecha como se o cliente tivesse sido avisado: o job falha e volta à fila.
 *
 * Canal Cloud API (`meta_cloud`) de propósito: é o único em que a ferramenta
 * `send_template` existe. A mensagem do cliente tem 5 minutos — a janela de 24 h
 * está aberta e o texto livre passa pelo gate `messaging_window`; o que o barra é
 * o vocabulário interno (snake_case), e só ele.
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

const ORG = "dddddddd-0000-4000-8000-000000000001";
const CONTACT = "dddddddd-0000-4000-8000-000000000002";
const SESSION_META = "dddddddd-0000-4000-8000-000000000003";
const CONV = "dddddddd-0000-4000-8000-000000000004";
const MSG = "dddddddd-0000-4000-8000-000000000005";
/** O instante do turno (dentro da janela horária do anti-ban) e o da mensagem do cliente, 5 min antes. */
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";

interface EnvioCapturado {
  body: string;
  template?: { name: string; language: string; values: Record<string, string> };
}

type Modules = {
  turno: typeof InboundTurn;
  queue: typeof Queue;
  createLogger: typeof ObsLogger.createLogger;
  createFakeRegistry: typeof Providers.createFakeRegistry;
};
let m: Modules;

let enviados: EnvioCapturado[] = [];
/** Como o canal responde ao envio neste teste (o adapter real traduz transporte fora em `unavailable`). */
let respostaDoCanal: () => unknown = () => ({ kind: "sent", idempotencyKey: "k", messageId: "m1" });

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

/** Três respostas diferentes (o anti-blast não as confunde), cada uma com um identificador snake_case. */
const VAZAMENTOS = [
  "O campo lead_status da sua ficha aparece como novo.",
  "Pelo crm_leads, o seu cadastro está ativo.",
  "A tabela lead_notes mostra o seu último contato.",
];

/**
 * Modelo falso que vaza vocabulário interno três vezes e, se ganhar uma 4ª etapa,
 * tenta mandar um template. Conta as etapas do laço (fora a chamada de checkpoint)
 * e guarda cada resultado de ferramenta que o SDK lhe devolveu.
 */
function modeloQueVazaEDepoisTentaTemplate() {
  const estado = { etapas: 0, checkpoints: 0, resultados: [] as string[] };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result") estado.resultados.push(JSON.stringify(parte.output ?? parte));
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
      return {
        content: [{ type: "text" as const, text: CHECKPOINT }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    estado.etapas += 1;
    const chamada =
      estado.etapas <= VAZAMENTOS.length
        ? { toolName: "send_message", input: { body: VAZAMENTOS[estado.etapas - 1] } }
        : { toolName: "send_template", input: { template_name: "retomada", language: "pt_BR", values: { "1": "Ana" } } };
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: `c${estado.etapas}`,
          toolName: chamada.toolName,
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

function montaHandler(doGenerate: unknown) {
  return m.turno.createInboundTurnHandler({
    crmCfg: { supabase: {} as never },
    llmCfg: { anthropicApiKey: "fake" } as never,
    knobs: {
      historyLimit: 10,
      maxContextTokens: 1000,
      notesIndexMaxTokens: 500,
      // Teto folgado de propósito: quem tem de parar o laço é o fail-safe, não o teto.
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
    channel: () =>
      ({
        channel: "captura",
        send: async (i: EnvioCapturado) => {
          enviados.push(i);
          return respostaDoCanal();
        },
        sessionHealth: async () => ({ healthy: true, status: "WORKING" }),
        capabilities: () => ({ freeform: false, media: true, audio: true }),
        costPerMessage: () => ({ currency: "BRL", cents: 0 }),
      }) as never,
    clock: () => AGORA,
    sleep: async () => {},
  });
}

async function rodaTurno(handler: ReturnType<typeof montaHandler>, evento: string): Promise<Error | null> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION_META,
      inbound_message_id: MSG,
      crm_event_id: evento,
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "fs", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, pool, { workerId: "fs" });
    await m.queue.completeJob(pool, claimed!.id, "fs");
    return null;
  } catch (err) {
    await m.queue.failJob(pool, claimed!.id, "fs", err);
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

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1,'c01-fail-safe-turno','Fail-safe Turno','Fail-safe Turno')
     on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, phone_number)
     values ($1,$2,'Lead Fail-safe','+5511900000888') on conflict (id) do nothing`,
    [CONTACT, ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, provider, meta_phone_number_id,
                                   meta_waba_id, status, webhook_secret_encrypted)
     values ($1,$2,'meta_cloud','111','333','WORKING','\\x00'::bytea)
     on conflict (id) do nothing`,
    [SESSION_META, ORG],
  );
  // `last_inbound_at` é o que o gate `messaging_window` lê (não a tabela de
  // mensagens): 5 MINUTOS antes do turno, a janela de 24 h está aberta e o texto
  // livre passa — o que barra o modelo aqui é só o vocabulário interno.
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group, last_inbound_at)
     values ($1,$2,$3,$4,'open',false,$5) on conflict (id) do nothing`,
    [CONV, ORG, CONTACT, SESSION_META, MENSAGEM_DO_CLIENTE_EM],
  );
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','oi, meu cadastro está ativo?','external_device',$6)
     on conflict (id) do nothing`,
    [MSG, ORG, CONV, SESSION_META, CONTACT, MENSAGEM_DO_CLIENTE_EM],
  );
  await pool.query(
    `insert into meta_templates (organization_id, waba_id, name, language, status, category,
                                 components, parameter_format, contract_hash)
     values ($1,'333','retomada','pt_BR','APPROVED','MARKETING',
       '[{"type":"BODY","text":"Oi {{1}}, tudo certo?"}]'::jsonb,'POSITIONAL','h-aprovado')
     on conflict (organization_id, waba_id, name, language) do update set status = 'APPROVED'`,
    [ORG],
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
  respostaDoCanal = () => ({ kind: "sent", idempotencyKey: "k", messageId: "m1" });
  // Cada caso começa sem caso aberto e sem recibo: o fail-safe abre o seu.
  await pool.query("delete from agent_case_events where organization_id = $1", [ORG]);
  await pool.query("delete from agent_cases where organization_id = $1", [ORG]);
  await pool.query("delete from send_ledger where organization_id = $1", [ORG]);
});

describe("turno completo — o fail-safe de vocabulário interno (achados 2 e 3 do Codex)", () => {
  it("3 vetos → frase de espera UMA vez, caso aberto, e o template da etapa seguinte NÃO sai porque a etapa não existe", async () => {
    const modelo = modeloQueVazaEDepoisTentaTemplate();
    const erro = await rodaTurno(montaHandler(modelo.doGenerate), "dddddddd-0000-4000-8000-000000000006");
    expect(erro).toBeNull();

    // O cliente recebeu UMA mensagem: a frase de espera (o disclosure da 1ª mensagem
    // pode vir antes dela). Nenhum dos três textos vazados, nenhum template.
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain(m.turno.FRASE_DE_ESPERA_PADRAO);
    expect(enviados[0]!.template).toBeUndefined();
    for (const vazado of VAZAMENTOS) expect(enviados[0]!.body).not.toContain(vazado);

    // O laço parou no fail-safe: três etapas, e a 4ª (o template) nunca foi pedida ao modelo.
    expect(modelo.estado.etapas).toBe(VAZAMENTOS.length);
    expect(modelo.estado.checkpoints).toBe(1);
    // O modelo leu os dois primeiros vetos como ensino e o terceiro como passagem.
    const resultados = modelo.estado.resultados.join("\n");
    expect(resultados).toMatch(/internal_vocabulary_leak_handoff/);
    expect(resultados).toMatch(/O cliente recebeu uma frase de espera/);
    expect(resultados).not.toMatch(/turno_passado_ao_humano/);

    // Uma pessoa foi acionada: o caso existe, aberto pelo fail-safe, com o texto vetado como resumo.
    const { rows: casos } = await pool.query<{ source: string; summary: string }>(
      "select source, summary from agent_cases where organization_id = $1 and conversation_id = $2",
      [ORG, CONV],
    );
    expect(casos).toHaveLength(1);
    expect(casos[0]!.source).toBe("guardrail_autofallback");
    expect(casos[0]!.summary).toBe(VAZAMENTOS[2]);
  });

  it("canal indisponível na frase de espera → o turno NÃO fecha como avisado: o job falha e volta à fila", async () => {
    respostaDoCanal = () => ({ kind: "unavailable", reason: "CrmTransportError" });
    const modelo = modeloQueVazaEDepoisTentaTemplate();
    const erro = await rodaTurno(montaHandler(modelo.doGenerate), "dddddddd-0000-4000-8000-000000000007");

    // A tentativa da frase aconteceu (e só ela), mas o canal não a aceitou…
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain(m.turno.FRASE_DE_ESPERA_PADRAO);
    // …então o turno termina em erro, como o envio normal faz com `unavailable`:
    // o worker falha o job e a fila re-tenta — a frase sai na re-execução, com a
    // mesma identidade no ledger. Antes, o turno fechava "ok" e o cliente ficava mudo.
    expect(erro).not.toBeNull();
    expect(erro!.message).toMatch(/frase de espera não enviada: canal indisponível \(CrmTransportError\)/);
    // Sem checkpoint: o turno não chegou ao fechamento.
    expect(modelo.estado.checkpoints).toBe(0);
    expect(modelo.estado.etapas).toBe(VAZAMENTOS.length);
    // O que o modelo leu não afirma entrega.
    const resultados = modelo.estado.resultados.join("\n");
    expect(resultados).not.toMatch(/O cliente recebeu uma frase de espera/);
    // E o job não terminou como 'done'.
    const { rows } = await pool.query<{ status: string }>(
      "select status from job_queue where organization_id = $1 and kind = 'inbound_turn' order by created_at desc limit 1",
      [ORG],
    );
    expect(rows[0]!.status).not.toBe("done");
  });
});
