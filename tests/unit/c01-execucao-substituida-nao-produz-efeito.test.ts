/**
 * (C01) EXECUÇÃO SUBSTITUÍDA NÃO PRODUZ EFEITO — a correção 1 do caso C54.
 *
 * O lease de um job é (id, locked_by, locked_at). O reaper devolve à fila todo
 * job `running` cujo `locked_at` passou do visibility timeout, e outro worker o
 * pega. Até aqui a posse só era conferida no `completeJob`: a execução que
 * passou do prazo seguia mandando mensagem, abrindo caso, gravando checkpoint —
 * e só no fim descobria que tinha sido substituída. No C54, duas execuções do
 * mesmo turno falaram com o mesmo lead.
 *
 * O que este arquivo prova, com relógio e fila falsos:
 *   1. enquanto o lease é da execução, cada efeito passa;
 *   2. depois de o reaper devolver o job (e outro worker o pegar), NENHUM efeito
 *      sai — ferramentas mutáveis, checkpoint, caso, cron, passagem a humano —
 *      e o sinal de cancelamento da execução dispara com `JobLeasePerdidoError`;
 *   3. a execução que de fato segura o lease continua produzindo efeito: a cerca
 *      é de posse, não de tempo;
 *   4. o checkpoint é cercado no PRÓPRIO statement: se a posse mudar entre a
 *      conferência e o INSERT, nenhuma linha nasce;
 *   5. job sem claim (execução fora da fila) segue pelo caminho antigo.
 */
import { describe, expect, it, vi } from "vitest";

import { insertCheckpoint } from "@/lib/agent-engine/agent/abertura/checkpoint";
import { openCase } from "@/lib/agent-engine/agent/human-cases";
import { performHumanHandoff } from "@/lib/agent-engine/agent/human-handoff";
import { scheduleCronJob } from "@/lib/agent-engine/cron/scheduler";
import type { JobRow, Queryable } from "@/lib/agent-engine/queue/queue";
import {
  JobLeasePerdidoError,
  type CurrentServiceBoundary,
} from "@/lib/atendimento/fronteira";
import {
  guardServiceTools,
  sinalDaExecucao,
  withServiceJob,
} from "@/lib/atendimento/fronteira-server";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const VISIBILIDADE_MS = 600_000;

const fronteira: CurrentServiceBoundary = {
  organization_id: ORG,
  contact_id: LEAD,
  conversation_id: CONVERSA,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
  status: "ai_handling",
  demanda_fechada_em: null,
};

/** Os efeitos que o turno pode produzir através de ferramentas do modelo. */
const FERRAMENTAS_MUTAVEIS = [
  "send_message",
  "crm_update_lead",
  "update_lead_state",
  "crm_manage_tags",
  "save_lead_note",
  "open_human_case",
  "request_human_handoff",
  "schedule_followup",
] as const;

/**
 * Fila de um job só, com relógio falso. `reaper()` é o que o reaper real faz:
 * devolve à fila o job cujo lease venceu. `pegar(worker)` é o claim seguinte.
 * O banco falso responde à consulta de posse pelo MESMO predicado do
 * `completeJob` e anota toda escrita que chegar a acontecer.
 */
function filaFalsa() {
  const relogio = { agora: Date.parse("2026-09-28T12:00:00.000Z") };
  const instante = () => new Date(relogio.agora).toISOString();
  const linha = { id: JOB, status: "running", locked_by: "w1" as string | null, locked_at: instante() as string | null };
  const claimInicial = linha.locked_at!;

  const reaper = () => {
    if (
      linha.status === "running" &&
      linha.locked_at !== null &&
      relogio.agora - Date.parse(linha.locked_at) >= VISIBILIDADE_MS
    ) {
      linha.status = "pending";
      linha.locked_by = null;
      linha.locked_at = null;
    }
  };
  const pegar = (worker: string) => {
    linha.status = "running";
    linha.locked_by = worker;
    linha.locked_at = instante();
    return linha.locked_at;
  };
  const ehDono = (id: unknown, worker: unknown, adquiridoEm: unknown) =>
    linha.id === id &&
    linha.status === "running" &&
    linha.locked_by === worker &&
    linha.locked_at === adquiridoEm;

  const escritas: string[] = [];
  /** Quando ligado, a posse muda logo DEPOIS de a conferência responder "é dono". */
  const corrida = { trocarAposConferir: false };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("from job_queue where id=$1 and status='running'")) {
      const dono = ehDono(params[0], params[1], params[2]);
      if (dono && corrida.trocarAposConferir) {
        corrida.trocarAposConferir = false;
        pegar("w2");
      }
      return { rows: dono ? [{ lease: 1 }] : [], rowCount: dono ? 1 : 0 };
    }
    if (sql.includes("from conversations c")) return { rows: [fronteira], rowCount: 1 };
    if (sql.includes("insert into lead_checkpoints") && sql.includes("where exists")) {
      const dono = ehDono(params[12], params[13], params[14]);
      if (dono) escritas.push("insert into lead_checkpoints");
      return { rows: [], rowCount: dono ? 1 : 0 };
    }
    if (/^\s*(insert|update|delete|with)\b/i.test(sql)) {
      escritas.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      return { rows: [{ case_id: "caso-1", id: "cron-1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });

  return {
    relogio,
    linha,
    claimInicial,
    reaper,
    pegar,
    corrida,
    escritas,
    query,
    db: { query } as unknown as Queryable,
  };
}

function jobDe(worker: string | null, adquiridoEm: string | null): JobRow {
  return {
    id: JOB,
    organization_id: ORG,
    contact_id: LEAD,
    kind: "inbound_turn",
    payload: { service_boundary: fronteira },
    locked_by: worker,
    ...(adquiridoEm === null ? {} : { claim_acquired_at: adquiridoEm }),
  } as unknown as JobRow;
}

function ferramentasCercadas() {
  const chamadas: string[] = [];
  const definicoes = Object.fromEntries(
    [...FERRAMENTAS_MUTAVEIS, "get_lead_context"].map((nome) => [
      nome,
      {
        inputSchema: {} as never,
        execute: async () => {
          chamadas.push(nome);
          return { ok: true };
        },
      },
    ]),
  );
  const cercadas = guardServiceTools(definicoes as never)!;
  const executar = (nome: string) => cercadas[nome]!.execute!({}, {} as never);
  return { chamadas, executar };
}

const checkpoint = {
  commitments: [],
  objections: [],
  next_action: null,
  rolling_summary: "lead pediu o link do boleto",
};

const logMudo = { info() {}, warn() {}, error() {}, debug() {} } as never;

describe("(C01) execução substituída não produz efeito", () => {
  it("com o lease, todo efeito passa; depois do reaper, nenhum sai e o sinal da execução dispara", async () => {
    const fila = filaFalsa();
    await withServiceJob(fila.db, jobDe("w1", fila.claimInicial), async () => {
      const { chamadas, executar } = ferramentasCercadas();

      // 1. Dona do lease: cada ferramenta mutável executa, e o checkpoint grava.
      for (const nome of FERRAMENTAS_MUTAVEIS) await executar(nome);
      await insertCheckpoint(fila.db, { tenantId: ORG, leadId: LEAD, jobId: JOB, content: checkpoint });
      expect(chamadas).toEqual([...FERRAMENTAS_MUTAVEIS]);
      expect(fila.escritas).toEqual(["insert into lead_checkpoints"]);
      expect(sinalDaExecucao()?.aborted).toBe(false);

      // 2. O relógio passa do visibility timeout, o reaper devolve o job e outro
      //    worker o pega. A partir daqui esta execução foi substituída.
      fila.relogio.agora += VISIBILIDADE_MS + 1;
      fila.reaper();
      expect(fila.linha.status).toBe("pending");
      fila.pegar("w2");
      chamadas.length = 0;
      fila.escritas.length = 0;

      for (const nome of FERRAMENTAS_MUTAVEIS) {
        await expect(executar(nome)).rejects.toBeInstanceOf(JobLeasePerdidoError);
      }
      await expect(
        insertCheckpoint(fila.db, { tenantId: ORG, leadId: LEAD, jobId: JOB, content: checkpoint }),
      ).rejects.toBeInstanceOf(JobLeasePerdidoError);
      await expect(
        openCase(
          fila.db as never,
          { tenantId: ORG, conversationId: CONVERSA, agentId: null },
          { title: "t", summary: "s", blocker: "b" },
        ),
      ).rejects.toBeInstanceOf(JobLeasePerdidoError);
      await expect(
        scheduleCronJob(fila.db as never, ORG, {
          leadId: LEAD,
          spec: { kind: "at", at: new Date(fila.relogio.agora + 7_200_000) },
          staggerWindowMs: 0,
          now: () => fila.relogio.agora,
        }),
      ).rejects.toBeInstanceOf(JobLeasePerdidoError);
      await expect(
        performHumanHandoff(
          fila.db as never,
          { tenantId: ORG, leadId: LEAD, conversationId: CONVERSA },
          { reason: "teste", conversationSummary: "resumo", log: logMudo },
        ),
      ).rejects.toBeInstanceOf(JobLeasePerdidoError);

      // Nenhuma ferramenta mutável rodou, nenhuma escrita aconteceu.
      expect(chamadas).toEqual([]);
      expect(fila.escritas).toEqual([]);
      // Leitura continua liberada: não é efeito.
      await executar("get_lead_context");
      expect(chamadas).toEqual(["get_lead_context"]);

      // O freio das chamadas de modelo desta execução disparou com o motivo certo.
      const sinal = sinalDaExecucao()!;
      expect(sinal.aborted).toBe(true);
      expect(sinal.reason).toBeInstanceOf(JobLeasePerdidoError);
      expect((sinal.reason as Error).message).toBe(`job_lease_perdido:${JOB}`);
    });
  });

  it("a execução que pegou o job depois do reaper é a dona e produz efeito (cerca de posse, não de tempo)", async () => {
    const fila = filaFalsa();
    fila.relogio.agora += VISIBILIDADE_MS + 1;
    fila.reaper();
    const claimDoW2 = fila.pegar("w2")!;

    // A primeira execução (w1) tenta: nada.
    await withServiceJob(fila.db, jobDe("w1", fila.claimInicial), async () => {
      const { chamadas, executar } = ferramentasCercadas();
      await expect(executar("send_message")).rejects.toBeInstanceOf(JobLeasePerdidoError);
      expect(chamadas).toEqual([]);
    });
    // A segunda (w2), mesmo muito depois no relógio, é dona: tudo passa.
    fila.relogio.agora += 5 * 60_000;
    await withServiceJob(fila.db, jobDe("w2", claimDoW2), async () => {
      const { chamadas, executar } = ferramentasCercadas();
      await executar("send_message");
      await insertCheckpoint(fila.db, { tenantId: ORG, leadId: LEAD, jobId: JOB, content: checkpoint });
      expect(chamadas).toEqual(["send_message"]);
      expect(sinalDaExecucao()?.aborted).toBe(false);
    });
    expect(fila.escritas).toEqual(["insert into lead_checkpoints"]);
  });

  it("checkpoint: posse que muda entre a conferência e o INSERT não grava linha nenhuma", async () => {
    const fila = filaFalsa();
    await withServiceJob(fila.db, jobDe("w1", fila.claimInicial), async () => {
      fila.corrida.trocarAposConferir = true;
      await expect(
        insertCheckpoint(fila.db, { tenantId: ORG, leadId: LEAD, jobId: JOB, content: checkpoint }),
      ).rejects.toBeInstanceOf(JobLeasePerdidoError);
    });
    expect(fila.linha.locked_by).toBe("w2");
    expect(fila.escritas).toEqual([]);
    // O INSERT cercado foi tentado (é ele que devolve 0 linhas), e os parâmetros
    // de posse são os do claim desta execução — não os de agora.
    const insert = fila.query.mock.calls.find(([sql]) => String(sql).includes("insert into lead_checkpoints"));
    expect(insert).toBeDefined();
    expect(insert![1]!.slice(12)).toEqual([JOB, "w1", fila.claimInicial]);
  });

  it("job sem claim (execução fora da fila) não consulta posse e grava pelo caminho antigo", async () => {
    const fila = filaFalsa();
    await withServiceJob(fila.db, jobDe(null, null), async () => {
      const { chamadas, executar } = ferramentasCercadas();
      await executar("send_message");
      await insertCheckpoint(fila.db, { tenantId: ORG, leadId: LEAD, jobId: JOB, content: checkpoint });
      expect(chamadas).toEqual(["send_message"]);
    });
    expect(fila.escritas).toEqual(["insert into lead_checkpoints"]);
    const consultasDePosse = fila.query.mock.calls.filter(([sql]) => String(sql).includes("from job_queue"));
    expect(consultasDePosse).toEqual([]);
  });
});
