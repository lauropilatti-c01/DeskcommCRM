/**
 * (C01, -c01.15) O PEDIDO AO GANCHO LEVA `celular_de_teste`.
 *
 * O canal da produção está aberto (modo `open`): qualquer contato fala com a IA, e o
 * porteiro precisa saber, para o `#zerar` e o `apagar_memoria`, se quem escreve é um
 * celular de teste. O pedido passa a levar sempre `celular_de_teste: boolean`:
 *   - verdadeiro só com o telefone na lista de teste do canal do job E a etiqueta, no
 *     contato ou num card dele — a régua única de `lib/c01/celular-de-teste.ts`, a mesma
 *     do `#zerar` na entrada (`zerar-celular-de-teste.ts`);
 *   (1) lido no servidor a cada pedido, no canal do job e na organização do job;
 *   (2) `false` em qualquer erro de leitura, nunca `true` por falta de dado;
 *   (3) lido ANTES da chamada: a etiqueta que a resposta grava não muda o valor do turno.
 * O telefone em si nunca vai no pedido. Telefones, ids e etiquetas são fictícios.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-engine/guardrails/before-send", () => ({
  runBeforeSend: vi.fn(async () => ({ status: "vetoed", code: "janela_fechada" })),
}));

import { rodarGanchoAntesDoTurno, type GanchoAntesDoTurnoConfig } from "@/lib/agent-engine/agent/gancho-antes-do-turno";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import { passaNaConferenciaDoCelularDeTeste } from "@/lib/c01/celular-de-teste";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONV = "33333333-3333-4333-8333-333333333333";
const SESSAO = "44444444-4444-4444-8444-444444444444";
const ENTRADA = "66666666-6666-4666-8666-666666666666";
const CONFIG: GanchoAntesDoTurnoConfig = { url: "http://gancho.teste/turno", segredo: "s3gr3do", prazoMs: 100 };
const AGORA = new Date("2026-10-15T12:00:00Z");
const PAYLOAD = { conversation_id: CONV, contact_id: CONTATO, channel_session_id: SESSAO, inbound_message_id: ENTRADA };

/** O contato guarda o número sem o "+"; a lista do canal, com DDI: a régua compara só os dígitos. */
const TELEFONE = "5511900000001";
const LISTA = { ai_test_phone_numbers: ["+5511900000001"] };
const ETIQUETA = "celular-de-teste";

afterEach(() => {
  vi.unstubAllGlobals();
});

const eOCelular = (sql: string) => sql.includes("as etiquetas") && sql.includes("from contacts ct");

interface Linha {
  phone_number: string | null;
  metadata: unknown;
  etiquetas: unknown[] | null;
}

/** Um banco de mentira; `celular` é a linha lida pela conferência (ou um erro). */
function banco(celular: () => Linha | null | "erro") {
  const eventos: string[] = [];
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (eOCelular(sql)) {
        eventos.push("celular");
        const linha = celular();
        if (linha === "erro") throw new Error("statement timeout");
        return { rows: linha === null ? [] : [linha], rowCount: linha === null ? 0 : 1 };
      }
      if (sql.includes("update crm_leads")) eventos.push("gravar");
      if (sql.includes("max(created_at)::text")) return { rows: [{ em: "2026-10-15 11:59:00+00" }], rowCount: 1 };
      if (sql.includes("from conversations c"))
        return { rows: [{ assignee_kind: null, assigned_to_user_id: null, last_inbound_at: null, provider: "meta" }], rowCount: 1 };
      if (sql.includes("from crm_leads"))
        return { rows: [{ id: "card-1", status: "open", etapa: "novo", custom_fields: {}, tags: [] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  return { db, eventos, consultas };
}

async function rodar(b: ReturnType<typeof banco>, resposta: unknown = { acao: "seguir" }) {
  const pedidos: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      b.eventos.push("gancho");
      pedidos.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(resposta), { status: 200 });
    }),
  );
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  await rodarGanchoAntesDoTurno({
    pool: b.db as never,
    log,
    config: CONFIG,
    job: { id: "job-1", organization_id: ORG, payload: PAYLOAD, kind: "inbound_turn" } as unknown as JobRow,
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
  return pedidos;
}

const comLinha = (linha: Linha | null | "erro") => banco(() => linha);

describe("a régua do celular de teste (a mesma do `#zerar`)", () => {
  const conferir = (telefone: string | null, metadataDoCanal: unknown, etiquetas: unknown[]) =>
    passaNaConferenciaDoCelularDeTeste({ telefone, metadataDoCanal, etiquetas });

  it("lista + etiqueta → verdadeiro; só a etiqueta, só a lista ou nenhuma → falso", () => {
    expect(conferir(TELEFONE, LISTA, [ETIQUETA])).toBe(true);
    expect(conferir(TELEFONE, {}, [ETIQUETA])).toBe(false);
    expect(conferir(TELEFONE, LISTA, ["outra"])).toBe(false);
    expect(conferir(TELEFONE, {}, [])).toBe(false);
  });

  it("a etiqueta compara como o banco (sem espaço nas pontas, sem diferença de maiúsculas); o número, só os dígitos", () => {
    expect(conferir("+55 11 90000-0001", LISTA, [" Celular-de-Teste "])).toBe(true);
    expect(conferir("5511900000002", LISTA, [ETIQUETA])).toBe(false);
    expect(conferir(null, LISTA, [ETIQUETA])).toBe(false);
  });
});

describe("(1) o pedido leva `celular_de_teste`, lido no servidor, no canal do job e na organização", () => {
  it("lista + etiqueta (no contato ou num card) → verdadeiro", async () => {
    const [pedido] = await rodar(comLinha({ phone_number: TELEFONE, metadata: LISTA, etiquetas: ["novo", ETIQUETA] }));
    expect(pedido?.celular_de_teste).toBe(true);
  });

  it("só a etiqueta → falso; só a lista → falso; nenhuma → falso", async () => {
    for (const linha of [
      { phone_number: TELEFONE, metadata: {}, etiquetas: [ETIQUETA] },
      { phone_number: TELEFONE, metadata: LISTA, etiquetas: [] },
      { phone_number: TELEFONE, metadata: {}, etiquetas: [] },
    ]) {
      const [pedido] = await rodar(comLinha(linha));
      expect(pedido?.celular_de_teste).toBe(false);
    }
  });

  it("a leitura é a da organização do job, do contato e do canal do job; etiquetas do contato e dos cards", async () => {
    const b = comLinha({ phone_number: TELEFONE, metadata: LISTA, etiquetas: [ETIQUETA] });
    await rodar(b);
    const [leitura, ...mais] = b.consultas.filter((c) => eOCelular(c.sql));
    expect(mais).toEqual([]);
    expect(leitura?.params).toEqual([ORG, CONTATO, SESSAO]);
    expect(leitura?.sql).toMatch(/from channel_sessions s where s\.organization_id = \$1 and s\.id = \$3/);
    expect(leitura?.sql).toMatch(/from crm_leads l, unnest\(l\.tags\) as t\(tag\)\s+where l\.organization_id = \$1 and l\.contact_id = \$2/);
    expect(leitura?.sql).toMatch(/where ct\.organization_id = \$1 and ct\.id = \$2/);
  });

  it("sempre presente, e o pedido continua sem o telefone", async () => {
    const [pedido] = await rodar(comLinha({ phone_number: TELEFONE, metadata: LISTA, etiquetas: [ETIQUETA] }));
    expect(Object.hasOwn(pedido ?? {}, "celular_de_teste")).toBe(true);
    const corpo = JSON.stringify(pedido);
    expect(corpo).not.toContain("900000001");
    expect(corpo).not.toContain("ai_test_phone_numbers");
  });

  it("uma régua só: o gancho e o `#zerar` usam `lib/c01/celular-de-teste.ts`, sem conferência própria", () => {
    const gancho = readFileSync("lib/agent-engine/agent/gancho-antes-do-turno.ts", "utf8");
    const zerar = readFileSync("lib/c01/zerar-celular-de-teste.ts", "utf8");
    expect(gancho).toMatch(/return passaNaConferenciaDoCelularDeTeste\(\{/);
    expect(gancho).toMatch(/!telefoneNaListaDeTeste\(lido\.phone_number, lido\.metadata\)/);
    expect(zerar).toMatch(/!telefoneNaListaDeTeste\(contato\.phone_number,/);
    expect(zerar).toMatch(/temEtiquetaDeTeste\(contato\.tags\)/);
    for (const fonte of [gancho, zerar]) {
      expect(fonte).not.toMatch(/numeroPodeTestar\(|lerNumerosDeTeste\(/);
      expect(fonte).not.toMatch(/function temEtiquetaDeTeste/);
    }
  });
});

describe("(2) `false` em qualquer erro de leitura, nunca `true` por falta de dado", () => {
  it("a leitura falha: falso, e o pedido sai assim mesmo (o turno não para)", async () => {
    const pedidos = await rodar(comLinha("erro"));
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.celular_de_teste).toBe(false);
  });

  it("contato que não se acha, canal sem metadados, etiquetas nulas ou fora do formato: falso", async () => {
    for (const linha of [
      null,
      { phone_number: TELEFONE, metadata: null, etiquetas: [ETIQUETA] },
      { phone_number: TELEFONE, metadata: LISTA, etiquetas: null },
      { phone_number: TELEFONE, metadata: { ai_test_phone_numbers: "+5511900000001" }, etiquetas: [ETIQUETA] },
      { phone_number: TELEFONE, metadata: { ai_test_phone_numbers: ["5511900000001"] }, etiquetas: [ETIQUETA] },
      { phone_number: TELEFONE, metadata: LISTA, etiquetas: [{ tag: ETIQUETA }] },
    ]) {
      const [pedido] = await rodar(comLinha(linha as Linha | null));
      expect(pedido?.celular_de_teste).toBe(false);
    }
  });
});

describe("(3) lido ANTES da chamada: a etiqueta gravada no turno não muda o valor do turno", () => {
  it("a resposta grava a etiqueta: o pedido deste turno saiu falso; só o próximo turno lê verdadeiro", async () => {
    let etiquetas: string[] = [];
    const b = banco(() => ({ phone_number: TELEFONE, metadata: LISTA, etiquetas }));
    // O mesmo banco nos dois turnos: o `gravar` da resposta põe a etiqueta nele.
    const original = b.db.query.getMockImplementation()!;
    b.db.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const r = await original(sql, params);
      if (sql.includes("update crm_leads")) etiquetas = [ETIQUETA];
      return r;
    });
    const gravaAEtiqueta = { acao: "seguir", gravar: { etiquetas_mais: [ETIQUETA] } };

    const [primeiro] = await rodar(b, gravaAEtiqueta);
    expect(primeiro?.celular_de_teste).toBe(false);
    // A leitura veio antes da chamada, e a gravação depois dela.
    expect(b.eventos.indexOf("celular")).toBeLessThan(b.eventos.indexOf("gancho"));
    expect(b.eventos.indexOf("gravar")).toBeGreaterThan(b.eventos.indexOf("gancho"));

    const [segundo] = await rodar(b, { acao: "seguir" });
    expect(segundo?.celular_de_teste).toBe(true);
  });
});
