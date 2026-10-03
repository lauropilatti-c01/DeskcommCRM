/**
 * (C01) AS BOLHAS CONHECIDAS NÃO ENTRAM NA EMENDA — achado 3 (médio) da terceira
 * revisão adversarial do Codex (03/10/2026) sobre `aplicarTetoAsNovas` (rodada 3).
 *
 * A função ignorava as bolhas conhecidas ao CONTAR as novas, mas as incluía ao
 * EMENDAR a cauda: com A e B já entregues e uma vaga no teto, uma resposta
 * regenerada como [X, A, Y] dava `registradas = [false, true, false]` e virava uma
 * bolha só, "X+A+Y" — hash inédito para o ledger, então A saía de novo dentro dela.
 * A correção da rodada 3 só valia quando as conhecidas ficavam ANTES do ponto de
 * emenda.
 *
 * Agora as conhecidas ficam como estão, cada uma uma unidade no lugar em que
 * estavam (saem como `already_sent`), e só o conteúdo NOVO se emenda: [X, A, Y] com
 * uma vaga vira ["X\n\nY", A]. Sem bolha conhecida, continua o `splitForSend` com teto.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  aplicarTetoAsNovas,
  sendInBubbles,
  splitForSend,
} from "@/lib/agent-engine/agent/split-message";
import {
  conteudoRegistradoNoJob,
  pgSendLedger,
  posicaoInicialDoJob,
  sendWithLedger,
} from "@/lib/agent-engine/edge/crm/send-ledger";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";
const TETO = 3;

const A = "Oi! Vi que você perguntou sobre o plano.";
const B = "Ele inclui o material e o acesso à plataforma.";
const X = "Desculpe a demora para responder.";
const Y = "Quer que eu te mande o link para começar?";

interface LinhaDoLedger {
  id: string;
  organization_id: string;
  contact_id: string | null;
  job_id: string;
  seq: number;
  body_hash: string;
  status: string;
  crm_message_id: string | null;
  last_error: string | null;
}

/** Postgres de brinquedo respondendo ao SQL real do ledger (como nos testes irmãos). */
function bancoFalso() {
  const ledger: LinhaDoLedger[] = [];
  const messages: Array<{ id: string; status: string; idempotency_key: string; body: string }> = [];
  const violacao = () =>
    Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("insert into send_ledger")) {
      const [org, contato, jobId, seq, hash] = p as [string, string | null, string, number, string];
      if (
        ledger.some((l) => l.organization_id === org && l.job_id === jobId && l.seq === Number(seq))
      )
        throw violacao();
      const linha: LinhaDoLedger = {
        id: randomUUID(),
        organization_id: org,
        contact_id: contato,
        job_id: jobId,
        seq: Number(seq),
        body_hash: hash,
        status: "requested",
        crm_message_id: null,
        last_error: null,
      };
      ledger.push(linha);
      return { rows: [{ id: linha.id }], rowCount: 1 };
    }
    if (s.startsWith("select * from send_ledger") && s.includes("and seq=$3")) {
      const [org, jobId, seq] = p as [string, string, number];
      const linha = ledger.find(
        (l) => l.organization_id === org && l.job_id === jobId && l.seq === Number(seq),
      );
      return { rows: linha ? [linha] : [], rowCount: linha ? 1 : 0 };
    }
    if (
      s.startsWith("select * from send_ledger") &&
      s.includes("status='accepted' and body_hash=$3")
    ) {
      const [org, jobId, hash] = p as [string, string, string];
      const linhas = ledger
        .filter(
          (l) =>
            l.organization_id === org &&
            l.job_id === jobId &&
            l.status === "accepted" &&
            l.body_hash === hash,
        )
        .sort((a, b) => a.seq - b.seq);
      return { rows: linhas.slice(0, 1), rowCount: Math.min(1, linhas.length) };
    }
    if (
      s.startsWith("select * from send_ledger") &&
      s.includes("status in ('requested','queued') and body_hash=$3")
    ) {
      const [org, jobId, hash] = p as [string, string, string];
      const linhas = ledger
        .filter(
          (l) =>
            l.organization_id === org &&
            l.job_id === jobId &&
            (l.status === "requested" || l.status === "queued") &&
            l.body_hash === hash,
        )
        .sort((a, b) => a.seq - b.seq);
      return { rows: linhas.slice(0, 1), rowCount: Math.min(1, linhas.length) };
    }
    if (s.startsWith("select coalesce(max(seq),0)+1 as seq from send_ledger")) {
      const [org, jobId] = p as [string, string];
      const seqs = ledger
        .filter((l) => l.organization_id === org && l.job_id === jobId)
        .map((l) => l.seq);
      return { rows: [{ seq: (seqs.length ? Math.max(...seqs) : 0) + 1 }], rowCount: 1 };
    }
    if (s.startsWith("select seq,status from send_ledger")) {
      const [org, jobId] = p as [string, string];
      const linhas = ledger
        .filter((l) => l.organization_id === org && l.job_id === jobId)
        .sort((a, b) => a.seq - b.seq);
      return {
        rows: linhas.map((l) => ({ seq: l.seq, status: l.status })),
        rowCount: linhas.length,
      };
    }
    if (s.startsWith("update send_ledger set id=gen_random_uuid()")) {
      const [org, jobId, seq, hash] = p as [string, string, number, string];
      const linha = ledger.find(
        (l) => l.organization_id === org && l.job_id === jobId && l.seq === Number(seq),
      );
      if (!linha) return { rows: [], rowCount: 0 };
      Object.assign(linha, {
        id: randomUUID(),
        status: "requested",
        body_hash: hash,
        crm_message_id: null,
        last_error: null,
      });
      return { rows: [{ id: linha.id }], rowCount: 1 };
    }
    if (s.startsWith("update send_ledger set status=$3")) {
      const [org, id, status, msgId, erro] = p as [
        string,
        string,
        string,
        string | null,
        string | null,
      ];
      const linha = ledger.find((l) => l.organization_id === org && l.id === id);
      if (linha)
        Object.assign(linha, {
          status,
          crm_message_id: msgId ?? linha.crm_message_id,
          last_error: erro,
        });
      return { rows: [], rowCount: linha ? 1 : 0 };
    }
    if (s.startsWith("select id,status from messages")) {
      const [, key] = p as [string, string];
      const m = messages.find((x) => x.idempotency_key === key);
      return { rows: m ? [{ id: m.id, status: m.status }] : [], rowCount: m ? 1 : 0 };
    }
    throw new Error(`SQL fora do roteiro do teste: ${s.slice(0, 80)}`);
  });
  const db = { query } as unknown as Queryable;
  const store = pgSendLedger(db);
  const handler = vi.fn(async (key: string, messageId: string, body: string) => {
    const existente = messages.find((m) => m.idempotency_key === key);
    if (existente) return { id: existente.id, status: existente.status };
    messages.push({ id: messageId, status: "sent", idempotency_key: key, body });
    return { id: messageId, status: "sent" };
  });
  /** UMA execução do turno mandando `texto` em bolhas, com a sonda do ledger, como `inbound-turn.ts`. */
  const execucao = async (texto: string, enviadas: number) => {
    let seq = await posicaoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    const enviar = async (body: string) => {
      seq += 1;
      const r = await sendWithLedger(
        store,
        { tenantId: ORG, leadId: LEAD, jobId: JOB, seq, body },
        (key, id) => handler(key, id, body),
      );
      if (r.kind === "already_sent") seq -= 1;
      return r;
    };
    return sendInBubbles(texto, {
      enabled: true,
      maxChars: 600,
      maxBubbles: Math.max(1, TETO - enviadas),
      jaRegistrada: (bolha: string) =>
        conteudoRegistradoNoJob(db, { tenantId: ORG, jobId: JOB, body: bolha }),
      sleep: async () => {},
      jitter: () => 0,
      send: enviar,
    });
  };
  return { ledger, messages, handler, execucao };
}

describe("(C01) `aplicarTetoAsNovas` com bolhas conhecidas no meio das novas", () => {
  it("A conhecida entre X e Y, resta 1: só X e Y se emendam; A fica como unidade própria", () => {
    expect(aplicarTetoAsNovas([X, A, Y], [false, true, false], 1)).toEqual([`${X}\n\n${Y}`, A]);
  });

  it("A e B conhecidas intercaladas em quatro novas, restam 2: a 2ª nova leva as novas seguintes; A e B não entram em emenda nenhuma", () => {
    expect(
      aplicarTetoAsNovas([A, "p", B, "q", "r", "s"], [true, false, true, false, false, false], 2),
    ).toEqual([A, "p", B, "q\n\nr\n\ns"]);
    expect(aplicarTetoAsNovas(["p", A, "q", B, "r"], [false, true, false, true, false], 1)).toEqual(
      ["p\n\nq\n\nr", A, B],
    );
  });

  it("conhecida DEPOIS da emenda também fica inteira (o caso que a rodada 3 já cobria continua)", () => {
    expect(aplicarTetoAsNovas([A, B, "c", "d"], [true, true, false, false], 1)).toEqual([
      A,
      B,
      "c\n\nd",
    ]);
    expect(aplicarTetoAsNovas(["c", "d", A], [false, false, true], 1)).toEqual(["c\n\nd", A]);
  });

  it("nenhuma bolha conhecida: continua exatamente o `splitForSend` com teto, para qualquer teto", () => {
    const bolhas = ["a", "b", "c", "d", "e"];
    for (const teto of [0, 1, 2, 3, 4, 5, 6, Number.POSITIVE_INFINITY]) {
      expect(
        aplicarTetoAsNovas(
          bolhas,
          bolhas.map(() => false),
          teto,
        ),
      ).toEqual(splitForSend(bolhas.join("\n\n"), true, 600, teto));
    }
  });

  it("todas conhecidas, ou novas que cabem: nada muda", () => {
    expect(aplicarTetoAsNovas([A, B], [true, true], 1)).toEqual([A, B]);
    expect(aplicarTetoAsNovas([X, A, Y], [false, true, false], 2)).toEqual([X, A, Y]);
  });
});

describe("(C01) a re-execução com resposta regenerada em volta de uma bolha já entregue", () => {
  it("A e B entregues (teto 3, resta 1); a resposta nova é X, A, Y: o cliente recebe 'X+Y' uma vez e A não sai de novo", async () => {
    const banco = bancoFalso();
    // Primeira execução: A e B saíram e foram aceitas.
    expect((await banco.execucao(`${A}\n\n${B}`, 0)).kind).toBe("sent");
    expect(banco.messages.map((m) => m.body)).toEqual([A, B]);

    // Re-execução: o modelo regenerou a resposta com A no meio de texto novo.
    const r = await banco.execucao(`${X}\n\n${A}\n\n${Y}`, 2);
    // O que chegou ao cliente: A, B e UMA mensagem nova com X e Y. A não se repetiu
    // (antes: uma bolha "X+A+Y", com A dentro, de novo no aparelho do cliente).
    expect(banco.messages.map((m) => m.body)).toEqual([A, B, `${X}\n\n${Y}`]);
    // A última bolha da lista é A, repetição conhecida: é o que o envio devolve.
    expect(r.kind).toBe("already_sent");
    // Posições: 1 e 2 de antes, 3 para a bolha nova; A voltou do ledger como repetição.
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(banco.handler.mock.calls.map((c) => c[2])).toEqual([A, B, `${X}\n\n${Y}`]);
  });
});
