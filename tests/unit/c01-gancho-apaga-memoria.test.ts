/**
 * (C01, -c01.7) GANCHO ANTES DO TURNO, `apagar_memoria`: o `#zerar` do celular de teste
 * recomeça a conversa e apaga a memória do contato (`lead_notes`), para a IA não ler a
 * memória antiga na resposta seguinte.
 *   1. o contrato guarda o campo (o -c01.6 o descartava, sem recusar a resposta);
 *   2. com a etiqueta de teste, as notas do contato são apagadas, na mesma instrução
 *      que confere a etiqueta, junto com o `gravar` e antes dele;
 *   3. recusa, sem apagar e com o motivo no log: contato sem a etiqueta, erro na
 *      leitura, a própria resposta pondo a etiqueta, o 1º envio do `segurar` que não sai;
 *   4. (-c01.15, revisão) a etiqueta sozinha não autoriza: o telefone do contato tem de
 *      estar na lista de teste do canal da mensagem (a mesma checagem do `#zerar` na
 *      entrada). Fora da lista, nada é apagado e a etiqueta nem é consultada.
 * A prova contra o Postgres (só aquele contato, só com a etiqueta) está no invariante
 * `tests/invariants/c01-gancho-antes-do-turno.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: vi.fn(async () => ({ status: "vetoed", code: "janela_fechada" })),
}));

import {
  CHAVE_NO_JOB,
  ETIQUETA_DO_CELULAR_DE_TESTE,
  respostaDoGanchoSchema,
  rodarGanchoAntesDoTurno,
  type GanchoAntesDoTurnoConfig,
} from "@/lib/agent-engine/agent/gancho-antes-do-turno";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const ENTRADA = "66666666-6666-4666-8666-666666666666";
const CONFIG: GanchoAntesDoTurnoConfig = { url: "http://gancho.teste/turno", segredo: "s3gr3do", prazoMs: 100 };
const AGORA = new Date("2026-10-07T12:00:00Z");
const PAYLOAD = { conversation_id: CONV, contact_id: CONTATO, channel_session_id: SESSAO, inbound_message_id: ENTRADA };

/** A resposta do porteiro ao `#zerar`, sem o texto de confirmação (`enviar: []`). */
const ZERAR = {
  acao: "segurar",
  motivo: "zerar-teste",
  enviar: [],
  gravar: { campos: { lembretes: null }, etiquetas_menos: ["flow-enviado"] },
  apagar_memoria: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Consulta {
  sql: string;
  params: unknown[];
}

const eOApagar = (sql: string) => sql.includes("delete from lead_notes");
const eALista = (sql: string) => sql.includes("left join channel_sessions s");

/** O telefone do contato (fictício) e a lista de teste do canal. */
const TELEFONE = "+5511900000001";
const NA_LISTA = { phone_number: "5511900000001", metadata: { ai_test_phone_numbers: [TELEFONE] } };

/** Um banco de mentira: responde o que o gancho lê e guarda o que ele escreve. */
function banco(
  apagar: { autorizado: boolean; apagadas: number } | "erro",
  lista: { phone_number: string | null; metadata: unknown } | null = NA_LISTA,
) {
  const consultas: Consulta[] = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (eALista(sql)) return { rows: lista === null ? [] : [lista], rowCount: lista === null ? 0 : 1 };
      if (eOApagar(sql)) {
        if (apagar === "erro") throw new Error("statement timeout");
        return { rows: [apagar], rowCount: 1 };
      }
      if (sql.includes("join demandas d")) return { rows: [{ id: "demanda-1", revision: "4" }], rowCount: 1 };
      if (sql.includes("from agent_cases")) return { rows: [{ id: "caso-1" }], rowCount: 1 };
      if (sql.includes("update agent_cases")) return { rows: [], rowCount: 2 };
      if (sql.includes("max(created_at)::text")) return { rows: [{ em: "2026-10-07 11:59:00+00" }], rowCount: 1 };
      if (sql.includes("from conversations c"))
        return { rows: [{ assignee_kind: null, assigned_to_user_id: null, last_inbound_at: null, provider: "meta" }], rowCount: 1 };
      if (sql.includes("from crm_leads"))
        return { rows: [{ id: "card-1", status: "open", etapa: "novo", custom_fields: {}, tags: [] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  return { db, consultas };
}

async function rodar(
  resposta: unknown,
  opcoes: {
    apagar?: { autorizado: boolean; apagadas: number } | "erro";
    lista?: { phone_number: string | null; metadata: unknown } | null;
    payload?: Record<string, unknown>;
  } = {},
) {
  const { db, consultas } = banco(opcoes.apagar ?? { autorizado: true, apagadas: 3 }, opcoes.lista);
  const pedidos: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      pedidos.push(String(init.body));
      return new Response(JSON.stringify(resposta), { status: 200 });
    }),
  );
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const desfecho = await rodarGanchoAntesDoTurno({
    pool: db as never,
    log,
    config: CONFIG,
    job: { id: "job-1", organization_id: ORG, payload: opcoes.payload ?? PAYLOAD, kind: "inbound_turn" } as unknown as JobRow,
    tenantId: ORG,
    contactId: CONTATO,
    conversationId: CONV,
    channelSessionId: SESSAO,
    inboundMessageId: ENTRADA,
    agentId: null,
    etiquetasDoContato: [],
    channel: { send: vi.fn() } as never,
    optedOutThisTurn: false,
    now: () => AGORA,
  });
  return { desfecho, consultas, pedidos, log };
}

const apagou = (consultas: Consulta[]) => consultas.filter((c) => eOApagar(c.sql));
const avisos = (log: { warn: ReturnType<typeof vi.fn> }) =>
  log.warn.mock.calls.filter(([msg]) => String(msg).includes("memória não apagada"));

describe("1. o contrato guarda `apagar_memoria`", () => {
  it("aceita com `segurar` e com `seguir`, e o valor chega à decisão", () => {
    const segurar = respostaDoGanchoSchema.safeParse(ZERAR);
    expect(segurar.success && segurar.data.apagar_memoria).toBe(true);
    const seguir = respostaDoGanchoSchema.safeParse({ acao: "seguir", apagar_memoria: true });
    expect(seguir.success && seguir.data.apagar_memoria).toBe(true);
  });

  it("valor que não é booleano é resposta fora do contrato", () => {
    expect(respostaDoGanchoSchema.safeParse({ ...ZERAR, apagar_memoria: "sim" }).success).toBe(false);
  });

  it("a etiqueta é a do celular de teste", () => {
    expect(ETIQUETA_DO_CELULAR_DE_TESTE).toBe("celular-de-teste");
  });
});

describe("2. com a etiqueta de teste, apaga as notas do contato", () => {
  it("`segurar`: apaga daquele contato, naquela organização, conferindo a etiqueta na mesma instrução", async () => {
    const { desfecho, consultas, log } = await rodar(ZERAR);
    expect(desfecho).toEqual({ fim: true });
    const [apagar, ...mais] = apagou(consultas);
    expect(mais).toEqual([]);
    expect(apagar?.params).toEqual([ORG, CONTATO, ETIQUETA_DO_CELULAR_DE_TESTE]);
    // A etiqueta é lida no banco, do contato e dos cards dele, e o apagar depende dela.
    expect(apagar?.sql).toMatch(/from contacts c, unnest\(c\.tags\)/);
    expect(apagar?.sql).toMatch(/from crm_leads l, unnest\(l\.tags\)/);
    expect(apagar?.sql).toMatch(/n\.organization_id = \$1 and n\.contact_id = \$2 and \(select ok from autorizado\)/);
    expect(log.info).toHaveBeenCalledWith("gancho antes do turno: memória do contato apagada (celular de teste)", { notas: 3 });
  });

  it("antes do `gravar`: a etiqueta conferida é a de antes desta resposta", async () => {
    const { consultas } = await rodar(ZERAR);
    const apagar = consultas.findIndex((c) => eOApagar(c.sql));
    const gravar = consultas.findIndex((c) => c.sql.includes("update crm_leads"));
    expect(apagar).toBeGreaterThan(-1);
    expect(gravar).toBeGreaterThan(apagar);
  });

  it("`seguir` também apaga, antes do modelo", async () => {
    const { desfecho, consultas } = await rodar({ acao: "seguir", apagar_memoria: true });
    expect(desfecho.fim).toBe(false);
    expect(apagou(consultas)).toHaveLength(1);
  });

  it("a re-execução repete a decisão anotada no job, com o apagar", async () => {
    const { consultas, pedidos } = await rodar(ZERAR, {
      payload: { ...PAYLOAD, [CHAVE_NO_JOB]: { situacao: "decidido", resposta: ZERAR, formulario: null, ate: null } },
    });
    expect(pedidos).toEqual([]);
    expect(apagou(consultas)).toHaveLength(1);
  });

  it("sem o campo, nada é apagado", async () => {
    const { consultas, log } = await rodar({ ...ZERAR, apagar_memoria: undefined });
    expect(apagou(consultas)).toEqual([]);
    expect(avisos(log)).toEqual([]);
  });
});

describe("3. recusa: nada é apagado, o log diz por quê (sem dado pessoal) e o turno segue", () => {
  it("contato sem a etiqueta de teste", async () => {
    const { desfecho, consultas, log } = await rodar(ZERAR, { apagar: { autorizado: false, apagadas: 0 } });
    expect(desfecho).toEqual({ fim: true });
    expect(avisos(log)).toEqual([
      ["gancho antes do turno: memória não apagada — contato sem a etiqueta de teste", { porque: "sem_etiqueta" }],
    ]);
    expect(log.info.mock.calls.some(([msg]) => String(msg).includes("memória do contato apagada"))).toBe(false);
    // O `gravar` do `#zerar` continua valendo.
    expect(consultas.some((c) => c.sql.includes("update crm_leads"))).toBe(true);
  });

  it("erro na leitura da etiqueta: não apaga, não derruba o turno", async () => {
    const { desfecho, consultas, log } = await rodar(ZERAR, { apagar: "erro" });
    expect(desfecho).toEqual({ fim: true });
    expect(avisos(log)).toEqual([
      ["gancho antes do turno: memória não apagada — a leitura da etiqueta falhou", { porque: "erro", erro: "Error" }],
    ]);
    expect(consultas.some((c) => c.sql.includes("update crm_leads"))).toBe(true);
  });

  it("a própria resposta põe a etiqueta de teste: não se autoriza (nem na re-execução)", async () => {
    const seAutoriza = {
      ...ZERAR,
      gravar: { ...ZERAR.gravar, etiquetas_mais: [" Celular-de-Teste "] },
    };
    const { consultas, log } = await rodar(seAutoriza);
    expect(apagou(consultas)).toEqual([]);
    expect(avisos(log)).toEqual([
      [
        "gancho antes do turno: memória não apagada — a própria resposta põe a etiqueta de teste",
        { porque: "etiqueta_na_resposta" },
      ],
    ]);
  });

  it("o 1º envio do `segurar` não sai: o turno vai ao modelo e nada é apagado (como o `gravar`)", async () => {
    const { desfecho, consultas } = await rodar({ ...ZERAR, enviar: [{ tipo: "texto", texto: "Conversa zerada." }] });
    expect(desfecho).toEqual({ fim: false });
    expect(apagou(consultas)).toEqual([]);
    expect(consultas.some((c) => c.sql.includes("update crm_leads"))).toBe(false);
  });
});

describe("4. (-c01.15, revisão) a etiqueta sozinha não autoriza: telefone na lista de teste do canal", () => {
  const recusaPelaLista = [
    "gancho antes do turno: memória não apagada — telefone fora da lista de teste do canal",
    { porque: "fora_da_lista_de_teste" },
  ];

  it("a lista é lida do canal da mensagem, para aquele contato naquela organização, antes do apagar", async () => {
    const { consultas } = await rodar(ZERAR);
    const lista = consultas.findIndex((c) => eALista(c.sql));
    const apagar = consultas.findIndex((c) => eOApagar(c.sql));
    expect(consultas[lista]?.params).toEqual([ORG, CONTATO, SESSAO]);
    expect(apagar).toBeGreaterThan(lista);
  });

  it("etiqueta sem a lista (o vigia põe a etiqueta em todo contato novo): nada é apagado e a etiqueta nem é consultada", async () => {
    const { desfecho, consultas, log } = await rodar(ZERAR, { lista: { phone_number: NA_LISTA.phone_number, metadata: {} } });
    expect(desfecho).toEqual({ fim: true });
    expect(apagou(consultas)).toEqual([]);
    expect(avisos(log)).toEqual([recusaPelaLista]);
    // O `gravar` do `#zerar` continua valendo.
    expect(consultas.some((c) => c.sql.includes("update crm_leads"))).toBe(true);
  });

  it("número fora da lista, contato sem telefone, ou canal/contato que não se acha: nada é apagado", async () => {
    for (const lista of [
      { phone_number: "+5511900000002", metadata: NA_LISTA.metadata },
      { phone_number: null, metadata: NA_LISTA.metadata },
      { phone_number: NA_LISTA.phone_number, metadata: null },
      null,
    ]) {
      const { consultas, log } = await rodar(ZERAR, { lista });
      expect(apagou(consultas)).toEqual([]);
      expect(avisos(log)).toEqual([recusaPelaLista]);
    }
  });

  it("na lista e com a etiqueta: apaga; na lista e sem a etiqueta: não apaga", async () => {
    const com = await rodar(ZERAR);
    expect(apagou(com.consultas)).toHaveLength(1);
    const sem = await rodar(ZERAR, { apagar: { autorizado: false, apagadas: 0 } });
    expect(avisos(sem.log)).toEqual([
      ["gancho antes do turno: memória não apagada — contato sem a etiqueta de teste", { porque: "sem_etiqueta" }],
    ]);
  });
});

describe("5. (-c01.15+zerar) o #zerar recomeça o atendimento, por último e só com a memória apagada", () => {
  const encerrou = (consultas: Consulta[]) => consultas.filter((c) => c.sql.includes("fn_demanda_encerrar"));
  const fechouCaso = (consultas: Consulta[]) => consultas.filter((c) => c.sql.includes("update agent_cases"));

  it("segurar com a memória apagada: fecha o caso sem turno e encerra a demanda, depois do apagar e do gravar", async () => {
    const { desfecho, consultas } = await rodar(ZERAR);
    expect(desfecho.fim).toBe(true);
    expect(fechouCaso(consultas)).toHaveLength(1);
    expect(fechouCaso(consultas)[0]!.params).toEqual(expect.arrayContaining(["caso-1", "cancelled"]));
    expect(encerrou(consultas)).toHaveLength(1);
    expect(encerrou(consultas)[0]!.params).toEqual([ORG, "demanda-1", "4"]);
    const i = (f: (c: Consulta) => boolean) => consultas.findIndex(f);
    expect(i((c) => c.sql.includes("fn_demanda_encerrar"))).toBeGreaterThan(i((c) => eOApagar(c.sql)));
    expect(i((c) => c.sql.includes("fn_demanda_encerrar"))).toBe(consultas.length - 1);
    // nada de turno de devolução nem envio
    expect(consultas.some((c) => /insert into job_queue|case_reply_turn/i.test(c.sql))).toBe(false);
  });

  it("sem a etiqueta, fora da lista ou com erro no apagar: o atendimento não recomeça", async () => {
    for (const opcoes of [
      { apagar: { autorizado: false, apagadas: 0 } },
      { lista: { phone_number: "5511900000009", metadata: { ai_test_phone_numbers: [TELEFONE] } } },
      { apagar: "erro" as const },
    ]) {
      const { consultas } = await rodar(ZERAR, opcoes);
      expect(encerrou(consultas)).toHaveLength(0);
      expect(fechouCaso(consultas)).toHaveLength(0);
    }
  });

  it("seguir com apagar_memoria: o modelo ainda roda neste turno, então o atendimento não recomeça", async () => {
    const { consultas } = await rodar({ acao: "seguir", apagar_memoria: true });
    expect(encerrou(consultas)).toHaveLength(0);
  });

  it("segurar sem apagar_memoria: nada muda no atendimento", async () => {
    const { consultas } = await rodar({ ...ZERAR, apagar_memoria: false });
    expect(encerrou(consultas)).toHaveLength(0);
    expect(fechouCaso(consultas)).toHaveLength(0);
  });
});
