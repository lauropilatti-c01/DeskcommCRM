/**
 * (C01) RECIBO PENDENTE COM O MESMO CONTEÚDO RETOMA A IDENTIDADE, NÃO NASCE OUTRO —
 * achado 2 da segunda revisão adversarial do Codex (03/10/2026) sobre a correção 3
 * do caso C54 e a rodada 2.
 *
 * A busca por conteúdo (`findAccepted`) só reconhecia recibo ACEITO. Com a bolha A
 * `queued` na posição 1 (o canal segurou: sessão fora) e a bolha B aceita na 2, a
 * re-execução do job parte da posição 2 e, ao gerar A de novo, não a reconhece:
 * cria um recibo novo na posição 3 e manda A outra vez. O recibo original continua
 * pendente, e o watchdog entrega a A original depois — o cliente recebe A em dobro.
 *
 * Agora um recibo `requested`/`queued` com o MESMO conteúdo é retomado: o envio sai
 * com a MESMA chave de idempotência (o handler reavalia a mesma mensagem, como no
 * replay por posição), e se a mensagem já foi entregue nesse meio-tempo o ledger
 * a reconcilia e devolve `already_sent`. Nenhuma posição nova para conteúdo que já
 * tem recibo.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  pgSendLedger,
  posicaoInicialDoJob,
  sendWithLedger,
} from "@/lib/agent-engine/edge/crm/send-ledger";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";

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

interface Mensagem {
  id: string;
  status: string;
  idempotency_key: string;
  body: string;
}

/**
 * Um Postgres de brinquedo com `send_ledger` (unicidade de (org, job, seq)) e
 * `messages`, respondendo ao SQL REAL do ledger. O "handler" grava a mensagem com a
 * chave que recebeu e devolve o status que o canal mandar (`sent` ou `queued`); se a
 * chave já tem mensagem, reavalia a MESMA mensagem (é o que o handler real faz com
 * `queued`), em vez de criar outra.
 */
function bancoFalso() {
  const ledger: LinhaDoLedger[] = [];
  const messages: Mensagem[] = [];
  const violacao = () =>
    Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("insert into send_ledger")) {
      const [org, contato, jobId, seq, hash] = p as [string, string | null, string, number, string];
      if (ledger.some((l) => l.organization_id === org && l.job_id === jobId && l.seq === Number(seq))) throw violacao();
      const linha: LinhaDoLedger = { id: randomUUID(), organization_id: org, contact_id: contato, job_id: jobId, seq: Number(seq), body_hash: hash, status: "requested", crm_message_id: null, last_error: null };
      ledger.push(linha);
      return { rows: [{ id: linha.id }], rowCount: 1 };
    }
    if (s.startsWith("select * from send_ledger") && s.includes("and seq=$3")) {
      const [org, jobId, seq] = p as [string, string, number];
      const linha = ledger.find((l) => l.organization_id === org && l.job_id === jobId && l.seq === Number(seq));
      return { rows: linha ? [linha] : [], rowCount: linha ? 1 : 0 };
    }
    if (s.startsWith("select * from send_ledger") && s.includes("status='accepted' and body_hash=$3")) {
      const [org, jobId, hash] = p as [string, string, string];
      const linhas = ledger.filter((l) => l.organization_id === org && l.job_id === jobId && l.status === "accepted" && l.body_hash === hash).sort((a, b) => a.seq - b.seq);
      return { rows: linhas.slice(0, 1), rowCount: Math.min(1, linhas.length) };
    }
    if (s.startsWith("select * from send_ledger") && s.includes("status in ('requested','queued') and body_hash=$3")) {
      const [org, jobId, hash] = p as [string, string, string];
      const linhas = ledger.filter((l) => l.organization_id === org && l.job_id === jobId && (l.status === "requested" || l.status === "queued") && l.body_hash === hash).sort((a, b) => a.seq - b.seq);
      return { rows: linhas.slice(0, 1), rowCount: Math.min(1, linhas.length) };
    }
    if (s.startsWith("select coalesce(max(seq),0)+1 as seq from send_ledger")) {
      const [org, jobId] = p as [string, string];
      const seqs = ledger.filter((l) => l.organization_id === org && l.job_id === jobId).map((l) => l.seq);
      return { rows: [{ seq: (seqs.length ? Math.max(...seqs) : 0) + 1 }], rowCount: 1 };
    }
    if (s.startsWith("select seq,status from send_ledger")) {
      const [org, jobId] = p as [string, string];
      const linhas = ledger.filter((l) => l.organization_id === org && l.job_id === jobId).sort((a, b) => a.seq - b.seq);
      return { rows: linhas.map((l) => ({ seq: l.seq, status: l.status })), rowCount: linhas.length };
    }
    if (s.startsWith("update send_ledger set id=gen_random_uuid()")) {
      const [org, jobId, seq, hash] = p as [string, string, number, string];
      const linha = ledger.find((l) => l.organization_id === org && l.job_id === jobId && l.seq === Number(seq));
      if (!linha) return { rows: [], rowCount: 0 };
      Object.assign(linha, { id: randomUUID(), status: "requested", body_hash: hash, crm_message_id: null, last_error: null });
      return { rows: [{ id: linha.id }], rowCount: 1 };
    }
    if (s.startsWith("update send_ledger set status=$3")) {
      const [org, id, status, msgId, erro] = p as [string, string, string, string | null, string | null];
      const linha = ledger.find((l) => l.organization_id === org && l.id === id);
      if (linha) Object.assign(linha, { status, crm_message_id: msgId ?? linha.crm_message_id, last_error: erro });
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
  /** O que o canal responde ao handler para cada texto; padrão `sent`. */
  const respostaDoCanal = new Map<string, string>();
  const handler = vi.fn(async (key: string, messageId: string, body: string) => {
    const status = respostaDoCanal.get(body) ?? "sent";
    const existente = messages.find((m) => m.idempotency_key === key);
    if (existente) {
      existente.status = status; // reavaliação da MESMA mensagem
      return { id: existente.id, status };
    }
    messages.push({ id: messageId, status, idempotency_key: key, body });
    return { id: messageId, status };
  });
  /** Uma EXECUÇÃO do job, como o turno manda (espelho de `enviarPeloCanal`). */
  const execucao = async (textos: string[]) => {
    let seq = await posicaoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    const posicaoInicial = seq;
    const resultados: Array<{ kind: string; key: string }> = [];
    for (const body of textos) {
      seq += 1;
      const r = await sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq, body }, (key, id) => handler(key, id, body));
      if (r.kind === "already_sent") seq -= 1;
      resultados.push({ kind: r.kind, key: r.idempotencyKey });
    }
    return { posicaoInicial, resultados };
  };
  return { ledger, messages, respostaDoCanal, handler, execucao };
}

const A = "Oi! Vi que você perguntou sobre o plano.";
const B = "Ele custa o valor da tabela e inclui o material.";
const C = "Quer que eu te mande o link para começar?";

describe("(C01) recibo pendente com o mesmo conteúdo retoma a identidade", () => {
  it("A ficou `queued` na posição 1 e B aceita na 2: a re-execução retoma A com a MESMA chave, sem posição nova", async () => {
    const banco = bancoFalso();
    banco.respostaDoCanal.set(A, "queued"); // sessão fora: o canal segura a A
    const primeira = await banco.execucao([A, B]);
    expect(primeira.resultados.map((r) => r.kind)).toEqual(["queued", "sent"]);
    const chaveDaA = primeira.resultados[0]!.key;
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "queued"], [2, "accepted"]]);

    // Re-execução do job (reaper/retry): o modelo gera A, B e C de novo. A sessão voltou.
    banco.respostaDoCanal.delete(A);
    const segunda = await banco.execucao([A, B, C]);
    expect(segunda.posicaoInicial).toBe(2); // parte da maior ACEITA; a A pendente não conta
    expect(segunda.resultados.map((r) => r.kind)).toEqual(["sent", "already_sent", "sent"]);
    // A saiu pela MESMA chave (o handler reavaliou a mesma mensagem) …
    expect(segunda.resultados[0]!.key).toBe(chaveDaA);
    // … então existe UMA mensagem A, não duas, e o ledger tem 3 recibos (A, B, C), não 4.
    // A posição 3 fica vazia: o contador do turno avançou na A retomada (ela é uma
    // mensagem física desta execução) e a C caiu na 4. Posição vazia não é problema —
    // a próxima livre é sempre max+1 e a inicial é a maior aceita.
    expect(banco.messages.filter((m) => m.body === A)).toHaveLength(1);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "accepted"], [2, "accepted"], [4, "accepted"]]);
    expect(banco.handler).toHaveBeenCalledTimes(4); // A, B, A (reavaliada), C
  });

  it("o recibo pendente cuja mensagem foi entregue nesse meio-tempo é reconciliado e volta `already_sent`", async () => {
    const banco = bancoFalso();
    banco.respostaDoCanal.set(A, "queued");
    await banco.execucao([A]);
    // O watchdog entregou a A antes da re-execução: a mensagem está `sent`, o recibo ainda `queued`.
    banco.messages[0]!.status = "sent";
    const segunda = await banco.execucao([A, B]);
    expect(segunda.resultados.map((r) => r.kind)).toEqual(["already_sent", "sent"]);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "accepted"], [2, "accepted"]]);
    expect(banco.messages.filter((m) => m.body === A)).toHaveLength(1);
  });

  it("recibo `requested` sem mensagem (o handler nunca foi alcançado) é retomado com a mesma chave, não duplicado", async () => {
    const banco = bancoFalso();
    // 1ª execução: o handler caiu antes de gravar a mensagem — o recibo fica `requested`.
    const quebrado = banco.handler.getMockImplementation()!;
    banco.handler.mockImplementationOnce(async () => {
      throw new Error("handler fora");
    });
    await expect(banco.execucao([A])).rejects.toThrow("handler fora");
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "requested"]]);
    banco.handler.mockImplementation(quebrado);

    const segunda = await banco.execucao([A, B]);
    expect(segunda.resultados.map((r) => r.kind)).toEqual(["sent", "sent"]);
    expect(segunda.resultados[0]!.key).toBe(banco.ledger[0]!.id);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "accepted"], [2, "accepted"]]);
    expect(banco.messages).toHaveLength(2);
  });

  it("conteúdo diferente do pendente continua ganhando posição nova (não é repetição)", async () => {
    const banco = bancoFalso();
    banco.respostaDoCanal.set(A, "queued");
    await banco.execucao([A]);
    const segunda = await banco.execucao([C]);
    expect(segunda.resultados.map((r) => r.kind)).toEqual(["sent"]);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "queued"], [2, "accepted"]]);
  });
});
