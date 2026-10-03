import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";

import type * as HumanHandoff from "@/lib/agent-engine/agent/human-handoff";
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
 *     NÃO fecha como se o cliente tivesse sido avisado: o job falha e volta à fila;
 *   - rodada 3, achado 3 (segunda revisão): `send_template` e o 3º vazamento pedidos
 *     na MESMA etapa (o SDK executa as ferramentas da etapa em paralelo). O template
 *     passa pela trava de entrada antes de o fail-safe ligar, espera a consulta do
 *     modelo aprovado e, quando chega ao ponto comum, a passagem já aconteceu: é
 *     barrado ali, sob a serialização — só a frase de espera chega ao cliente;
 *   - rodada 5, achado 2 (quarta revisão): o fail-safe PERSISTE a passagem
 *     (`performHumanHandoff`). Num pipeline sem etapa de passagem, a próxima mensagem
 *     do cliente e o retry do job não voltam ao modelo — e, quando a frase de espera
 *     não saiu, a Central lê que o cliente NÃO foi avisado;
 *   - rodada 6, achado 2 (quinta revisão): `performHumanHandoff` é at-least-once com
 *     escritas separadas e `force_human` primeiro. A gravação ganha UMA nova tentativa
 *     imediata (`gravarPassagemComNovaTentativa`): a 1ª escrita falhando uma vez, a
 *     passagem sai inteira e o job conclui. Falhando as duas vezes no meio, a passagem
 *     fica INCOMPLETA (`force_human` sem o silêncio da conversa nem o aviso na Central),
 *     o job falha e o retry seria pulado em `isLeadInHandoff`: é o limite herdado,
 *     documentado — o caso aberto antes é o registro que uma pessoa lê.
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
/** A mensagem SEGUINTE do cliente (rodada 5): chega depois do fail-safe e acorda outro turno. */
const MSG_SEGUINTE = "dddddddd-0000-4000-8000-000000000015";
/** O instante do turno (dentro da janela horária do anti-ban) e o da mensagem do cliente, 5 min antes. */
const AGORA = new Date("2026-07-30T15:00:00Z");
const MENSAGEM_DO_CLIENTE_EM = "2026-07-30T14:55:00Z";

interface EnvioCapturado {
  body: string;
  template?: { name: string; language: string; values: Record<string, string> };
}

type Modules = {
  turno: typeof InboundTurn;
  isLeadInHandoff: typeof HumanHandoff.isLeadInHandoff;
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

const TEMPLATE = { template_name: "retomada", language: "pt_BR", values: { "1": "Ana" } };
/** O que um modelo que NÃO vaza responderia à mensagem seguinte do cliente. */
const RESPOSTA_NORMAL =
  "Oi! Seu cadastro está ativo, sim. Quer que eu te explique os próximos passos?";

/**
 * Modelo falso que vaza vocabulário interno três vezes e, se ganhar uma 4ª etapa,
 * tenta mandar um template. Conta as etapas do laço (fora a chamada de checkpoint)
 * e guarda cada resultado de ferramenta que o SDK lhe devolveu.
 *
 * (C01, rodada 3) Com `templateJuntoDoTerceiroVazamento`, a 3ª etapa pede DUAS
 * ferramentas — `send_template` primeiro e o 3º vazamento depois —, que o SDK executa
 * em paralelo: é a corrida do achado 3 da segunda revisão.
 */
function modeloQueVazaEDepoisTentaTemplate(
  opcoes: { templateJuntoDoTerceiroVazamento?: boolean } = {},
) {
  const estado = { etapas: 0, checkpoints: 0, resultados: [] as string[] };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
    for (const msg of msgs) {
      if (!Array.isArray(msg.content)) continue;
      for (const parte of msg.content as Array<Record<string, unknown>>) {
        if (parte.type === "tool-result")
          estado.resultados.push(JSON.stringify(parte.output ?? parte));
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
    const template = { toolName: "send_template", input: TEMPLATE };
    const chamadas =
      estado.etapas <= VAZAMENTOS.length
        ? [
            ...(opcoes.templateJuntoDoTerceiroVazamento && estado.etapas === VAZAMENTOS.length
              ? [template]
              : []),
            { toolName: "send_message", input: { body: VAZAMENTOS[estado.etapas - 1] } },
          ]
        : [template];
    return {
      content: chamadas.map((chamada, i) => ({
        type: "tool-call" as const,
        toolCallId: `c${estado.etapas}-${i}`,
        toolName: chamada.toolName,
        input: JSON.stringify(chamada.input),
      })),
      finishReason: { unified: "tool-calls" as const, raw: undefined },
      usage: USO,
      warnings: [],
    };
  };
  return { doGenerate, estado };
}

/**
 * (C01, rodada 5) Modelo que responde normalmente: uma `send_message` limpa e fim.
 * É o que atenderia a mensagem seguinte do cliente se o turno chegasse ao modelo.
 */
function modeloQueRespondeNormal() {
  const estado = { etapas: 0, checkpoints: 0 };
  const doGenerate = async (opts: { prompt?: unknown }) => {
    const msgs = (opts.prompt ?? []) as Array<{ role: string; content?: unknown }>;
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
    if (estado.etapas > 1) {
      return {
        content: [{ type: "text" as const, text: "" }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: USO,
        warnings: [],
      };
    }
    return {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "n1",
          toolName: "send_message",
          input: JSON.stringify({ body: RESPOSTA_NORMAL }),
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

async function rodaTurno(
  handler: ReturnType<typeof montaHandler>,
  evento: string,
  /** O banco que o HANDLER usa (a fila continua no `pool`): o teste da corrida o embrulha para segurar uma consulta. */
  bancoDoHandler: pg.Pool = pool,
  /** A mensagem do cliente que acorda este turno (rodada 5: a seguinte, depois do fail-safe). */
  inboundMessageId: string = MSG,
): Promise<Error | null> {
  await pool.query("update job_queue set status = 'done' where status = 'pending'");
  const { job } = await m.queue.enqueueJob(pool, ORG, {
    kind: "inbound_turn",
    leadId: CONTACT,
    payload: {
      conversation_id: CONV,
      contact_id: CONTACT,
      channel_session_id: SESSION_META,
      inbound_message_id: inboundMessageId,
      crm_event_id: evento,
    },
    maxAttempts: 1,
  });
  const [claimed] = await m.queue.claimJobs(pool, { workerId: "fs", maxConcurrency: 1 });
  expect(claimed?.id).toBe(job.id);
  try {
    await handler(claimed!, bancoDoHandler, { workerId: "fs" });
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
    isLeadInHandoff: (await import("@/lib/agent-engine/agent/human-handoff")).isLeadInHandoff,
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
  // (rodada 5) …e fora da passagem ao humano: o fail-safe de um caso grava
  // `force_human` + silêncio durável, e o turno seguinte do mesmo lead seria pulado.
  await pool.query(
    "update contacts set force_human = false where organization_id = $1 and id = $2",
    [ORG, CONTACT],
  );
  await pool.query(
    `update conversations
        set bot_silenced_until = null, status = 'open', last_handoff_at = null, last_handoff_reason = null
      where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  await pool.query("delete from agent_inbox_items where organization_id = $1", [ORG]);
  await pool.query("delete from passagens_de_atendimento where organization_id = $1", [ORG]);
  await pool.query("delete from messages where organization_id = $1 and id = $2", [
    ORG,
    MSG_SEGUINTE,
  ]);
});

/** O que a passagem gravou — o que `isLeadInHandoff` lê e o que a Central mostra. */
async function estadoDaPassagem() {
  const { rows: contato } = await pool.query<{ force_human: boolean }>(
    "select force_human from contacts where organization_id = $1 and id = $2",
    [ORG, CONTACT],
  );
  const { rows: conversa } = await pool.query<{
    silenciada: boolean;
    last_handoff_reason: string | null;
  }>(
    `select (bot_silenced_until is not null and bot_silenced_until > now()) as silenciada, last_handoff_reason
       from conversations where organization_id = $1 and id = $2`,
    [ORG, CONV],
  );
  const { rows: central } = await pool.query<{ kind: string; title: string; body: string | null }>(
    "select kind, title, body from agent_inbox_items where organization_id = $1 and ref_id = $2 order by created_at",
    [ORG, CONV],
  );
  const { rows: passagens } = await pool.query<{ n: string }>(
    "select count(*)::text as n from passagens_de_atendimento where organization_id = $1",
    [ORG],
  );
  return {
    forceHuman: contato[0]!.force_human,
    silenciada: conversa[0]!.silenciada,
    motivo: conversa[0]!.last_handoff_reason,
    emHandoff: await m.isLeadInHandoff(pool, ORG, CONTACT),
    central,
    passagens: Number(passagens[0]!.n),
  };
}

/**
 * (Rodada 6) O banco do handler que FALHA as primeiras `vezes` consultas cujo texto
 * contém `trecho` (a falha de rede ou de banco entre as escritas da passagem, tornada
 * determinística) e depois deixa passar. A fila continua no `pool` de verdade.
 */
function bancoQueFalha(trecho: string, vezes: number): { banco: pg.Pool; falhas: () => number } {
  let falhas = 0;
  const banco = new Proxy(pool, {
    get(alvo, prop) {
      if (prop === "query") {
        return async (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].includes(trecho) && falhas < vezes) {
            falhas += 1;
            throw new Error(`banco indisponível nesta escrita (teste, falha ${falhas})`);
          }
          return (alvo.query as (...a: unknown[]) => unknown)(...args);
        };
      }
      const valor = Reflect.get(alvo, prop, alvo) as unknown;
      return typeof valor === "function"
        ? (valor as (...a: unknown[]) => unknown).bind(alvo)
        : valor;
    },
  }) as pg.Pool;
  return { banco, falhas: () => falhas };
}

/** A mensagem seguinte do cliente, gravada DEPOIS do fail-safe (é a inbound mais nova da conversa). */
async function clienteEscreveDeNovo(): Promise<void> {
  await pool.query(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_via, sent_at)
     values ($1,$2,$3,$4,$5,'text','inbound','delivered','e então, consegue me ajudar?','external_device',$6)`,
    [MSG_SEGUINTE, ORG, CONV, SESSION_META, CONTACT, AGORA.toISOString()],
  );
}

describe("turno completo — o fail-safe de vocabulário interno (achados 2 e 3 do Codex)", () => {
  it("3 vetos → frase de espera UMA vez, caso aberto, e o template da etapa seguinte NÃO sai porque a etapa não existe", async () => {
    const modelo = modeloQueVazaEDepoisTentaTemplate();
    const erro = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "dddddddd-0000-4000-8000-000000000006",
    );
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

    // (rodada 5) E a passagem ao humano está GRAVADA, não só na closure: é o que o
    // início do próximo turno lê. A Central tem o aviso, com o desfecho da frase
    // ("JÁ FOI avisado", porque o canal aceitou) e o motivo legível.
    const passagem = await estadoDaPassagem();
    expect(passagem.forceHuman).toBe(true);
    expect(passagem.silenciada).toBe(true);
    expect(passagem.emHandoff).toBe(true);
    expect(passagem.motivo).toBe(m.turno.MOTIVO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO);
    expect(passagem.central).toHaveLength(1);
    expect(passagem.central[0]!.kind).toBe("handoff");
    expect(passagem.central[0]!.title).toBe(m.turno.TITULO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO);
    expect(passagem.central[0]!.body).toContain(m.turno.MOTIVO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO);
    expect(passagem.central[0]!.body).toMatch(/JÁ FOI avisado/);
    // Sem linha em `passagens_de_atendimento`: nenhuma origem do vocabulário fechado
    // (CHECK do banco) descreve este caminho sem mentir — limite documentado.
    expect(passagem.passagens).toBe(0);
  });

  it("(rodada 5) a mensagem SEGUINTE do cliente, num pipeline sem etapa de passagem, NÃO volta ao modelo: a passagem gravada pula o turno", async () => {
    // 1º turno: o fail-safe. A etapa de passagem não existe neste tenant (e o
    // `createAdminClient` do best-effort nem tem Supabase aqui): o que segura o
    // turno seguinte tem de ser o que ficou no banco.
    const vazador = modeloQueVazaEDepoisTentaTemplate();
    expect(
      await rodaTurno(montaHandler(vazador.doGenerate), "dddddddd-0000-4000-8000-000000000016"),
    ).toBeNull();
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain(m.turno.FRASE_DE_ESPERA_PADRAO);

    // O cliente escreve de novo, e o turno dele acorda com um modelo que responderia
    // normalmente. Antes desta rodada ele respondia: `openCase` não grava
    // `force_human` nem `bot_silenced_until`.
    await clienteEscreveDeNovo();
    const normal = modeloQueRespondeNormal();
    const erro = await rodaTurno(
      montaHandler(normal.doGenerate),
      "dddddddd-0000-4000-8000-000000000017",
      pool,
      MSG_SEGUINTE,
    );
    expect(erro).toBeNull();

    // Nenhuma chamada ao modelo, nada enviado: a pessoa da equipe é quem responde.
    expect(normal.estado.etapas).toBe(0);
    expect(normal.estado.checkpoints).toBe(0);
    expect(enviados).toHaveLength(1);
    expect(enviados.map((e) => e.body)).not.toContain(RESPOSTA_NORMAL);
    expect((await estadoDaPassagem()).emHandoff).toBe(true);
    // Um caso só, um aviso só na Central: o turno pulado não repete nada.
    const { rows: casos } = await pool.query<{ n: string }>(
      "select count(*)::text as n from agent_cases where organization_id = $1 and conversation_id = $2",
      [ORG, CONV],
    );
    expect(Number(casos[0]!.n)).toBe(1);
    expect((await estadoDaPassagem()).central).toHaveLength(1);
  });

  it("canal indisponível na frase de espera → o turno NÃO fecha como avisado: o job falha e volta à fila", async () => {
    respostaDoCanal = () => ({ kind: "unavailable", reason: "CrmTransportError" });
    const modelo = modeloQueVazaEDepoisTentaTemplate();
    const erro = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "dddddddd-0000-4000-8000-000000000007",
    );

    // A tentativa da frase aconteceu (e só ela), mas o canal não a aceitou…
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain(m.turno.FRASE_DE_ESPERA_PADRAO);
    // …então o turno termina em erro, como o envio normal faz com `unavailable`:
    // o worker falha o job. Antes, o turno fechava "ok" e o cliente ficava mudo.
    // (rodada 5) O erro não promete mais que a re-execução manda a frase: com a
    // passagem gravada, o retry é pulado (lead em handoff) — ver o caso seguinte.
    expect(erro).not.toBeNull();
    expect(erro!.message).toMatch(
      /frase de espera não enviada: canal indisponível \(CrmTransportError\)/,
    );
    expect(erro!.message).not.toMatch(/re-tentado pela fila/);
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

    // (rodada 5) A passagem está gravada MESMO com a frase pendente ("aviso que
    // falha NÃO impede a passagem", a doutrina do autor), e a Central diz a verdade
    // a quem assume: o cliente NÃO foi avisado, e por quê.
    const passagem = await estadoDaPassagem();
    expect(passagem.forceHuman).toBe(true);
    expect(passagem.emHandoff).toBe(true);
    expect(passagem.central).toHaveLength(1);
    expect(passagem.central[0]!.body).toMatch(/O cliente NÃO foi avisado/);
    expect(passagem.central[0]!.body).toMatch(/O canal recusou a mensagem de aviso/);
    expect(passagem.central[0]!.body).not.toMatch(/JÁ FOI avisado/);
  });

  it("(rodada 5) o retry depois do fail-safe com a frase pendente NÃO volta ao modelo nem reenvia: a passagem já está com a pessoa, e a Central sabe que o cliente não foi avisado", async () => {
    respostaDoCanal = () => ({ kind: "unavailable", reason: "CrmTransportError" });
    const vazador = modeloQueVazaEDepoisTentaTemplate();
    expect(
      await rodaTurno(montaHandler(vazador.doGenerate), "dddddddd-0000-4000-8000-000000000018"),
    ).not.toBeNull();
    expect(enviados).toHaveLength(1);
    expect(vazador.estado.etapas).toBe(VAZAMENTOS.length);

    // A fila re-executa o job da MESMA mensagem; o canal voltou. Antes desta rodada o
    // retry chegava ao modelo e a frase só saía se ele vazasse três vezes de novo.
    respostaDoCanal = () => ({ kind: "sent", idempotencyKey: "k", messageId: "m1" });
    const retry = modeloQueVazaEDepoisTentaTemplate();
    expect(
      await rodaTurno(montaHandler(retry.doGenerate), "dddddddd-0000-4000-8000-000000000019"),
    ).toBeNull();
    expect(retry.estado.etapas).toBe(0);
    expect(enviados).toHaveLength(1); // nada novo saiu — limite documentado: a frase pendente não é reenviada

    const passagem = await estadoDaPassagem();
    expect(passagem.emHandoff).toBe(true);
    expect(passagem.central).toHaveLength(1);
    expect(passagem.central[0]!.body).toMatch(/O cliente NÃO foi avisado/);
  });

  it("(rodada 3) `send_template` e o 3º vazamento na MESMA etapa: o template passa pela trava de entrada antes do fail-safe e é barrado no ponto comum — só a frase sai", async () => {
    // A corrida, encenada: a consulta do modelo aprovado (`meta_templates`) do
    // `send_template` fica SEGURA até a frase de espera sair pelo canal. É o atraso
    // que o Codex descreveu (consulta ou gate demorando enquanto a outra ferramenta
    // da etapa liga o fail-safe), tornado determinístico. Teto de 3 s para o teste
    // falhar com asserção legível, e não por tempo, se a frase nunca sair.
    const ordem: string[] = [];
    let liberaOTemplate: () => void = () => {};
    const fraseSaiu = new Promise<void>((resolve) => {
      liberaOTemplate = resolve;
    });
    respostaDoCanal = () => {
      const ultimo = enviados[enviados.length - 1]!;
      if (ultimo.template) ordem.push("template_enviado");
      else if (ultimo.body.includes(m.turno.FRASE_DE_ESPERA_PADRAO)) {
        ordem.push("frase_enviada");
        liberaOTemplate();
      } else ordem.push("texto_enviado");
      return { kind: "sent", idempotencyKey: "k", messageId: "m1" };
    };
    const banco = new Proxy(pool, {
      get(alvo, prop) {
        if (prop === "query") {
          return async (...args: unknown[]) => {
            if (typeof args[0] === "string" && args[0].includes("from meta_templates")) {
              ordem.push("template_consultado");
              await Promise.race([fraseSaiu, new Promise((r) => setTimeout(r, 3000))]);
              ordem.push("template_definido");
            }
            return (alvo.query as (...a: unknown[]) => unknown)(...args);
          };
        }
        const valor = Reflect.get(alvo, prop, alvo) as unknown;
        return typeof valor === "function"
          ? (valor as (...a: unknown[]) => unknown).bind(alvo)
          : valor;
      },
    }) as pg.Pool;

    const modelo = modeloQueVazaEDepoisTentaTemplate({ templateJuntoDoTerceiroVazamento: true });
    const erro = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "dddddddd-0000-4000-8000-000000000008",
      banco,
    );
    expect(erro).toBeNull();

    // A corrida aconteceu como descrita: o template pediu a consulta ANTES de a frase
    // sair (passou pela trava de entrada com `passadoAoHumano` ainda falso) e só a
    // teve de volta DEPOIS.
    expect(ordem.slice(0, 3)).toEqual([
      "template_consultado",
      "frase_enviada",
      "template_definido",
    ]);

    // E ainda assim o cliente recebeu UMA mensagem: a frase de espera. Antes, o template
    // seguia ao canal depois dela (`ordem` terminava em `template_enviado`).
    expect(ordem).not.toContain("template_enviado");
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain(m.turno.FRASE_DE_ESPERA_PADRAO);
    expect(enviados[0]!.template).toBeUndefined();

    // Três etapas, as duas ferramentas da 3ª na mesma etapa; a 4ª não existe.
    expect(modelo.estado.etapas).toBe(VAZAMENTOS.length);
    expect(modelo.estado.checkpoints).toBe(1);
    // O modelo leu o template como barrado pela passagem (veto traduzido), não como enviado.
    const resultados = modelo.estado.resultados.join("\n");
    expect(resultados).toMatch(/internal_vocabulary_leak_handoff/);
    expect(resultados).toMatch(/turno_passado_ao_humano/);
    expect(resultados).not.toMatch(/template enviado/);

    // Uma pessoa foi acionada uma vez só.
    const { rows: casos } = await pool.query<{ source: string }>(
      "select source from agent_cases where organization_id = $1 and conversation_id = $2",
      [ORG, CONV],
    );
    expect(casos).toHaveLength(1);
    expect(casos[0]!.source).toBe("guardrail_autofallback");
  });
});

describe("(rodada 6) a gravação da passagem com uma nova tentativa imediata (achado 2 da quinta revisão)", () => {
  it("a 1ª escrita (`force_human`) falha uma vez: a nova tentativa grava a passagem inteira, o job conclui sem erro e a Central tem o aviso", async () => {
    const { banco, falhas } = bancoQueFalha("update contacts set force_human = true", 1);
    const modelo = modeloQueVazaEDepoisTentaTemplate();
    const erro = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "dddddddd-0000-4000-8000-000000000020",
      banco,
    );
    expect(erro).toBeNull();
    expect(falhas()).toBe(1);

    // O cliente recebeu a frase de espera, uma vez; nenhum texto vazado.
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain(m.turno.FRASE_DE_ESPERA_PADRAO);

    // A passagem está inteira, como se nada tivesse falhado.
    const passagem = await estadoDaPassagem();
    expect(passagem.forceHuman).toBe(true);
    expect(passagem.silenciada).toBe(true);
    expect(passagem.emHandoff).toBe(true);
    expect(passagem.motivo).toBe(m.turno.MOTIVO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO);
    expect(passagem.central).toHaveLength(1);
    expect(passagem.central[0]!.title).toBe(m.turno.TITULO_DA_PASSAGEM_POR_VOCABULARIO_INTERNO);
    expect(passagem.central[0]!.body).toMatch(/JÁ FOI avisado/);

    // O modelo foi mandado encerrar, como sempre; o turno fechou com checkpoint.
    expect(modelo.estado.etapas).toBe(VAZAMENTOS.length);
    expect(modelo.estado.checkpoints).toBe(1);
    expect(modelo.estado.resultados.join("\n")).toMatch(/internal_vocabulary_leak_handoff/);
  });

  it("a 2ª escrita (a conversa) falha nas duas tentativas: `force_human` fica gravado sem o silêncio nem o aviso, o job falha, o caso é o registro — e o retry seria pulado (limite herdado, documentado)", async () => {
    // `last_handoff_reason = $4` só existe no UPDATE da conversa de `performHumanHandoff`.
    const { banco, falhas } = bancoQueFalha("last_handoff_reason = $4", 2);
    const modelo = modeloQueVazaEDepoisTentaTemplate();
    const erro = await rodaTurno(
      montaHandler(modelo.doGenerate),
      "dddddddd-0000-4000-8000-000000000021",
      banco,
    );
    // O erro não some: o job falha com a segunda falha (não há terceira tentativa).
    expect(erro?.message).toMatch(/banco indisponível nesta escrita \(teste, falha 2\)/);
    expect(falhas()).toBe(2);

    // O cliente recebeu a frase de espera; uma pessoa foi acionada pelo caso, aberto antes.
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.body).toContain(m.turno.FRASE_DE_ESPERA_PADRAO);
    const { rows: casos } = await pool.query<{ source: string }>(
      "select source from agent_cases where organization_id = $1 and conversation_id = $2",
      [ORG, CONV],
    );
    expect(casos).toHaveLength(1);
    expect(casos[0]!.source).toBe("guardrail_autofallback");

    // O que fica: a passagem INCOMPLETA — a 1ª escrita pegou (o lead está fora do
    // automático), as seguintes não. É exatamente o que a propriedade do autor deixa;
    // `isLeadInHandoff` já é verdadeiro, então a re-execução deste job não a refaria.
    const passagem = await estadoDaPassagem();
    expect(passagem.forceHuman).toBe(true);
    expect(passagem.silenciada).toBe(false);
    expect(passagem.motivo).toBeNull();
    expect(passagem.central).toHaveLength(0);
    expect(passagem.emHandoff).toBe(true);
    expect(await m.isLeadInHandoff(pool, ORG, CONTACT)).toBe(true);
  });
});
