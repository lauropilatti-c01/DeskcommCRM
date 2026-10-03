/**
 * (C01) A RECUPERAÇÃO CONTA ENTREGAS, NÃO POSIÇÃO — achado 1 (alto) da terceira
 * revisão adversarial do Codex (03/10/2026) sobre a recuperação pelo `send_ledger`
 * (C54, correção 3).
 *
 * O turno usava UM número (`seq`) para duas coisas: a posição do próximo recibo no
 * ledger e quantas mensagens o cliente já recebeu neste turno (o teto
 * `max_sends_per_turn`, os "já falei neste turno", o que resta para bolhas e fotos).
 * Na re-execução, `seq` recomeçava na MAIOR posição aceita. Com teto 3, chamadas
 * paralelas podiam deixar a posição 1 'failed' (ou 'requested' sem mensagem) e as 2 e 3
 * aceitas: a re-execução partia de 3, as duas ferramentas de envio recusavam por teto
 * ANTES de consultar ou retomar o recibo, e — como essa execução não registra `failed`
 * nem `runError` — o job concluía com a primeira mensagem sem entrega para sempre.
 *
 * Agora `estadoInicialDoJob` devolve os dois números: `posicao` (a maior aceita, dica
 * de posição para o ledger) e `enviadas` (aceitas depois da reconciliação, mais as
 * que o canal segura). O turno parte de `seq = enviadas` e leva `posicao` ao ledger.
 * A prova no turno inteiro, com Postgres real, está em
 * `tests/invariants/c01-recuperacao-com-falha-na-posicao-1.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  estadoInicialDoJob,
  hashDoConteudo,
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
const C = "Quer que eu te mande o link para começar?";

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
  const doJob = (org: string, jobId: string) =>
    ledger.filter((l) => l.organization_id === org && l.job_id === jobId);
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("insert into send_ledger")) {
      const [org, contato, jobId, seq, hash] = p as [string, string | null, string, number, string];
      if (doJob(org, jobId).some((l) => l.seq === Number(seq))) throw violacao();
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
      const linha = doJob(org, jobId).find((l) => l.seq === Number(seq));
      return { rows: linha ? [linha] : [], rowCount: linha ? 1 : 0 };
    }
    if (
      s.startsWith("select * from send_ledger") &&
      s.includes("status='accepted' and body_hash=$3")
    ) {
      const [org, jobId, hash] = p as [string, string, string];
      const linhas = doJob(org, jobId)
        .filter((l) => l.status === "accepted" && l.body_hash === hash)
        .sort((a, b) => a.seq - b.seq);
      return { rows: linhas.slice(0, 1), rowCount: Math.min(1, linhas.length) };
    }
    if (
      s.startsWith("select * from send_ledger") &&
      s.includes("status in ('requested','queued') and body_hash=$3")
    ) {
      const [org, jobId, hash] = p as [string, string, string];
      const linhas = doJob(org, jobId)
        .filter((l) => (l.status === "requested" || l.status === "queued") && l.body_hash === hash)
        .sort((a, b) => a.seq - b.seq);
      return { rows: linhas.slice(0, 1), rowCount: Math.min(1, linhas.length) };
    }
    if (s.startsWith("select coalesce(max(seq),0)+1 as seq from send_ledger")) {
      const [org, jobId] = p as [string, string];
      const seqs = doJob(org, jobId).map((l) => l.seq);
      return { rows: [{ seq: (seqs.length ? Math.max(...seqs) : 0) + 1 }], rowCount: 1 };
    }
    if (s.startsWith("select seq,status from send_ledger")) {
      const [org, jobId] = p as [string, string];
      const linhas = doJob(org, jobId).sort((a, b) => a.seq - b.seq);
      return {
        rows: linhas.map((l) => ({ seq: l.seq, status: l.status })),
        rowCount: linhas.length,
      };
    }
    if (s.startsWith("update send_ledger set id=gen_random_uuid()")) {
      const [org, jobId, seq, hash] = p as [string, string, number, string];
      const linha = doJob(org, jobId).find((l) => l.seq === Number(seq));
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
  /** Um recibo como a execução anterior o deixou, com (ou sem) a mensagem que o handler gravou. */
  const recibo = (seq: number, status: string, body: string, mensagem: string | null) => {
    const linha: LinhaDoLedger = {
      id: randomUUID(),
      organization_id: ORG,
      contact_id: LEAD,
      job_id: JOB,
      seq,
      body_hash: hashDoConteudo({ body }),
      status,
      crm_message_id: null,
      last_error: null,
    };
    ledger.push(linha);
    if (mensagem !== null) {
      const m = { id: randomUUID(), status: mensagem, idempotency_key: linha.id, body };
      messages.push(m);
      linha.crm_message_id = m.id;
    }
    return linha;
  };
  const handler = vi.fn(async (key: string, messageId: string, body: string) => {
    const existente = messages.find((m) => m.idempotency_key === key);
    if (existente) return { id: existente.id, status: existente.status };
    messages.push({ id: messageId, status: "sent", idempotency_key: key, body });
    return { id: messageId, status: "sent" };
  });
  /**
   * A re-execução do turno, como `inbound-turn.ts` agora faz: parte de
   * `estadoInicialDoJob`, recusa por teto quando `seq >= TETO` (ANTES de qualquer
   * consulta ao ledger, como as ferramentas), leva `posicao` ao ledger e conta em
   * `seq` o que de fato saiu. Devolve o que cada envio deu.
   */
  const reexecucao = async (textos: string[], contarPelaPosicao = false) => {
    const estado = await estadoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    let { posicao, enviadas: seq } = estado;
    // O defeito, documentado: a contagem partindo da maior posição aceita.
    if (contarPelaPosicao) seq = posicao;
    const saidas: string[] = [];
    for (const body of textos) {
      if (seq >= TETO) {
        saidas.push("recusado:max_sends_per_turn");
        continue;
      }
      posicao += 1;
      const r = await sendWithLedger(
        store,
        { tenantId: ORG, leadId: LEAD, jobId: JOB, seq: posicao, body },
        (key, id) => handler(key, id, body),
      );
      if (r.kind === "already_sent") posicao -= 1;
      else seq += 1;
      saidas.push(r.kind);
    }
    return { estado, saidas };
  };
  return { db, ledger, messages, handler, recibo, reexecucao };
}

describe("(C01) `estadoInicialDoJob`: posição e entregas são dois números", () => {
  it("posição 1 'failed', 2 e 3 aceitas: posição 3, DUAS enviadas (o número antigo dizia 3)", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "failed", A, "failed");
    banco.recibo(2, "accepted", B, "sent");
    banco.recibo(3, "accepted", C, "sent");
    expect(await estadoInicialDoJob(banco.db, { tenantId: ORG, jobId: JOB })).toEqual({
      posicao: 3,
      enviadas: 2,
      pendentes: [],
    });
    // A posição continua a de sempre.
    expect(await posicaoInicialDoJob(banco.db, { tenantId: ORG, jobId: JOB })).toBe(3);
  });

  it("'requested' sem mensagem (nunca chegou ao handler) não conta; 'requested' cuja mensagem saiu é reconciliado e conta", async () => {
    const banco = bancoFalso();
    const perdido = banco.recibo(1, "requested", A, null);
    const saiu = banco.recibo(2, "requested", B, "delivered");
    banco.recibo(3, "accepted", C, "sent");
    expect(await estadoInicialDoJob(banco.db, { tenantId: ORG, jobId: JOB })).toEqual({
      posicao: 3,
      enviadas: 2,
      pendentes: [],
    });
    expect(banco.ledger.find((l) => l.id === saiu.id)).toMatchObject({ status: "accepted" });
    expect(banco.ledger.find((l) => l.id === perdido.id)).toMatchObject({ status: "requested" });
  });

  it("o que o canal segura conta como enviada, mas não ocupa a posição: 'queued', e 'requested' com mensagem na fila do CRM", async () => {
    const banco = bancoFalso();
    const naFila = banco.recibo(1, "queued", A, "queued");
    banco.recibo(2, "accepted", B, "sent");
    const saindo = banco.recibo(3, "requested", C, "queued");
    expect(await estadoInicialDoJob(banco.db, { tenantId: ORG, jobId: JOB })).toEqual({
      posicao: 2,
      enviadas: 3,
      // (rodada 5) As chaves do que o canal segura, para a retomada não contar de novo.
      pendentes: [naFila.id, saindo.id],
    });
  });

  it("mensagem gravada como 'failed' não conta; job sem recibo é { 0, 0 }", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "requested", A, "failed");
    banco.recibo(2, "vetoed", B, null);
    expect(await estadoInicialDoJob(banco.db, { tenantId: ORG, jobId: JOB })).toEqual({
      posicao: 0,
      enviadas: 0,
      pendentes: [],
    });
    expect(
      await estadoInicialDoJob(banco.db, {
        tenantId: ORG,
        jobId: "55555555-5555-4555-8555-555555555555",
      }),
    ).toEqual({ posicao: 0, enviadas: 0, pendentes: [] });
  });
});

describe("(C01) a re-execução com falha na posição 1 e sucesso nas 2 e 3 (teto 3)", () => {
  it("posição 1 'failed': a re-execução manda A (posição 4) — não é recusada por teto; B e C, já entregues, não saem de novo", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "failed", A, "failed");
    banco.recibo(2, "accepted", B, "sent");
    banco.recibo(3, "accepted", C, "sent");

    const { estado, saidas } = await banco.reexecucao([A, B, C]);
    expect(estado).toEqual({ posicao: 3, enviadas: 2, pendentes: [] });
    // A saiu; depois dela o teto (3) está cheio — B e C nem precisam do ledger.
    expect(saidas).toEqual(["sent", "recusado:max_sends_per_turn", "recusado:max_sends_per_turn"]);
    expect(banco.handler.mock.calls.map((c) => c[2])).toEqual([A]);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "failed"],
      [2, "accepted"],
      [3, "accepted"],
      [4, "accepted"],
    ]);
  });

  it("posição 1 'requested' sem mensagem: a re-execução RETOMA o recibo de A (mesma chave, posição 1)", async () => {
    const banco = bancoFalso();
    const pendente = banco.recibo(1, "requested", A, null);
    banco.recibo(2, "accepted", B, "sent");
    banco.recibo(3, "accepted", C, "sent");

    const { saidas } = await banco.reexecucao([A, B, C]);
    expect(saidas).toEqual(["sent", "recusado:max_sends_per_turn", "recusado:max_sends_per_turn"]);
    expect(banco.handler.mock.calls.map((c) => [c[0], c[2]])).toEqual([[pendente.id, A]]);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
  });

  it("o defeito, documentado: contando pela posição (3), as três chamadas eram recusadas por teto e A ficava sem entrega", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "failed", A, "failed");
    banco.recibo(2, "accepted", B, "sent");
    banco.recibo(3, "accepted", C, "sent");
    const { saidas } = await banco.reexecucao([A, B, C], true);
    expect(saidas).toEqual([
      "recusado:max_sends_per_turn",
      "recusado:max_sends_per_turn",
      "recusado:max_sends_per_turn",
    ]);
    expect(banco.handler).not.toHaveBeenCalled();
  });
});

describe("(C01) a ligação no turno", () => {
  const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("o turno parte dos dois números e só `enviarPeloCanal` os move: a posição vai ao ledger, a contagem cresce quando algo sai", () => {
    expect(FONTE).toMatch(
      /const estadoInicial = preview\s*\?\s*\{ posicao: 0, enviadas: 0, pendentes: \[\] \}\s*:\s*await estadoInicialDoJob\(pool, \{ tenantId, jobId: liveJob\(\)\.id \}\);/,
    );
    expect(FONTE).toMatch(
      /let posicao = estadoInicial\.posicao;\s*let seq = estadoInicial\.enviadas;/,
    );
    expect(FONTE).toMatch(
      // (rodada 5) A contagem é por chave: `contaNoTeto` (ver `c01-recibo-retomado-conta-uma-vez`).
      /posicao \+= 1;\s*const resultado = await liveChannel\(\)\.send\(\{ \.\.\.envio, seq: posicao \}\);\s*if \(resultado\.kind === 'already_sent'\) posicao -= 1;\s*else if \(contaNoTeto\(resultado\)\) seq \+= 1;/,
    );
    expect(FONTE.match(/posicao \+= 1/g)).toHaveLength(1);
    expect(FONTE.match(/seq \+= 1/g)).toHaveLength(1);
  });

  it("tudo o que mede 'quantas mensagens o cliente recebeu' lê a contagem, não a posição", () => {
    // Teto nas duas ferramentas de envio, "já falei neste turno" (resposta obsoleta e
    // aviso da escalação), o que resta para bolhas e fotos, e a pergunta do roteiro.
    expect(FONTE.match(/if \(seq >= maxSendsPerTurn\) \{/g)).toHaveLength(2);
    expect(FONTE.match(/seq === 0/g)).toHaveLength(2);
    expect(FONTE.match(/maxSendsPerTurn - seq\b/g)).toHaveLength(3);
    expect(FONTE).toMatch(
      /perguntaDoRoteiroPodeSair\(\{ turnoDescartado: turnoDescartado \|\| passadoAoHumano, seq, maxSendsPerTurn \}\)/,
    );
    // E a posição não aparece em nenhuma dessas medidas.
    expect(FONTE).not.toMatch(/posicao >= maxSendsPerTurn|maxSendsPerTurn - posicao|posicao === 0/);
  });
});
