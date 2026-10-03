/**
 * (C01) A RE-EXECUÇÃO DO JOB PRESERVA A DIVISÃO DAS BOLHAS — achado 1 da segunda
 * revisão adversarial do Codex (03/10/2026) sobre a correção 3 do caso C54.
 *
 * A posição recuperada do job (`posicaoInicialDoJob`) também dimensionava quantas
 * bolhas cabiam no envio: com teto 3, uma resposta dividida em A, B e C que falhou
 * depois de entregar A e B recomeçava em seq=2, e o MESMO texto passava por
 * `splitForSend` com `maxBubbles=1` — virava uma bolha só, "A+B+C", com hash novo que
 * o ledger não reconhecia. A e B chegavam de novo ao cliente, junto com C.
 *
 * Agora `sendInBubbles` fatia primeiro (divisão natural) e pergunta ao ledger, bolha a
 * bolha, o que já tem recibo (`jaRegistrada` → `conteudoRegistradoNoJob`); o teto do
 * turno (`aplicarTetoAsNovas`) vale só para as bolhas novas. As conhecidas saem
 * pela mesma identidade (`already_sent`, ou recibo pendente retomado) e não contam.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { aplicarTetoAsNovas, sendInBubbles, splitForSend } from "@/lib/agent-engine/agent/split-message";
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
const C = "Quer que eu te mande o link para começar?";
const TEXTO = `${A}\n\n${B}\n\n${C}`;

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
  /** Textos em que o handler cai (transporte fora) — uma vez cada. */
  const cairEm = new Set<string>();
  const handler = vi.fn(async (key: string, messageId: string, body: string) => {
    if (cairEm.delete(body)) throw new Error("handler fora");
    const existente = messages.find((m) => m.idempotency_key === key);
    if (existente) return { id: existente.id, status: existente.status };
    messages.push({ id: messageId, status: "sent", idempotency_key: key, body });
    return { id: messageId, status: "sent" };
  });
  /**
   * UMA execução do turno mandando `texto` em bolhas, como `inbound-turn.ts` faz:
   * `seq` parte da posição recuperada, `maxBubbles` é o que resta do teto, e a
   * sonda `jaRegistrada` pergunta ao ledger (quando `comSonda`).
   */
  const execucao = async (texto: string, comSonda: boolean) => {
    let seq = await posicaoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    const enviar = async (body: string) => {
      seq += 1;
      const r = await sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq, body }, (key, id) => handler(key, id, body));
      if (r.kind === "already_sent") seq -= 1;
      return r;
    };
    return sendInBubbles(texto, {
      enabled: true,
      maxChars: 600,
      maxBubbles: Math.max(1, TETO - seq),
      ...(comSonda
        ? { jaRegistrada: (bolha: string) => conteudoRegistradoNoJob(db, { tenantId: ORG, jobId: JOB, body: bolha }) }
        : {}),
      sleep: async () => {},
      jitter: () => 0,
      send: enviar,
    });
  };
  return { ledger, messages, handler, cairEm, execucao };
}

describe("(C01) o teto vale só para as bolhas novas — `aplicarTetoAsNovas`", () => {
  it("sem bolha conhecida é exatamente o `splitForSend` com teto, para qualquer teto", () => {
    const bolhas = ["a", "b", "c", "d", "e"];
    for (const teto of [0, 1, 2, 3, 4, 5, 6, Number.POSITIVE_INFINITY]) {
      expect(aplicarTetoAsNovas(bolhas, bolhas.map(() => false), teto)).toEqual(
        splitForSend(bolhas.join("\n\n"), true, 600, teto),
      );
    }
  });

  it("A e B conhecidas, C nova, resta 1: a divisão fica como era — A, B, C", () => {
    expect(aplicarTetoAsNovas([A, B, C], [true, true, false], 1)).toEqual([A, B, C]);
  });

  it("A conhecida, três novas, restam 2: a 2ª nova leva o resto junto — e a conhecida não entra na conta", () => {
    expect(aplicarTetoAsNovas(["a", "b", "c", "d"], [true, false, false, false], 2)).toEqual(["a", "b", "c\n\nd"]);
  });

  it("novas cabem no que resta: nada muda; teto sem sentido (<1) também não corta", () => {
    expect(aplicarTetoAsNovas(["a", "b"], [false, false], 2)).toEqual(["a", "b"]);
    expect(aplicarTetoAsNovas(["a", "b", "c"], [false, false, false], 0)).toEqual(["a", "b", "c"]);
  });
});

describe("(C01) a re-execução do job não repete A e B ao mandar C", () => {
  it("teto 3; A e B entregues e C caiu no handler: a re-execução manda A, B, C de novo pela mesma divisão — só C sai", async () => {
    const banco = bancoFalso();
    banco.cairEm.add(C);
    await expect(banco.execucao(TEXTO, true)).rejects.toThrow("handler fora");
    expect(banco.messages.map((m) => m.body)).toEqual([A, B]);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "accepted"], [2, "accepted"], [3, "requested"]]);

    const r = await banco.execucao(TEXTO, true);
    expect(r.kind).toBe("sent");
    // O cliente recebeu A, B e C UMA vez cada — nenhuma bolha "A+B+C".
    expect(banco.messages.map((m) => m.body)).toEqual([A, B, C]);
    // A e B voltaram do ledger como repetição; C retomou o recibo pendente da posição 3.
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "accepted"], [2, "accepted"], [3, "accepted"]]);
    // Handler: A, B, C (caiu), C.
    expect(banco.handler.mock.calls.map((c) => c[2])).toEqual([A, B, C, C]);
  });

  it("SEM a sonda (o comportamento antigo), o mesmo cenário manda 'A+B+C' numa bolha nova: a prova do defeito", async () => {
    const banco = bancoFalso();
    banco.cairEm.add(C);
    await expect(banco.execucao(TEXTO, false)).rejects.toThrow("handler fora");
    await banco.execucao(TEXTO, false);
    // Com teto 3 e posição recuperada 2 só "cabia" 1 bolha: o texto inteiro saiu junto.
    expect(banco.messages.map((m) => m.body)).toEqual([A, B, TEXTO]);
  });

  it("texto DIFERENTE na re-execução respeita o que resta do teto: três parágrafos novos viram uma mensagem", async () => {
    const banco = bancoFalso();
    banco.cairEm.add(C);
    await expect(banco.execucao(TEXTO, true)).rejects.toThrow("handler fora");
    const outro = "Desculpe a demora.\n\nO plano inclui tudo isso.\n\nPosso te mandar o link?";
    await banco.execucao(outro, true);
    // Duas aceitas antes + UMA nova = teto 3; os três parágrafos novos saem juntos.
    expect(banco.messages.map((m) => m.body)).toEqual([A, B, outro]);
  });
});

describe("(C01) a ligação no turno", () => {
  const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("`sendInBubbles` do turno pergunta ao ledger por bolha (fora do preview, que não tem job)", () => {
    const i = FONTE.indexOf("enviarTexto: (texto) =>");
    expect(i).toBeGreaterThan(-1);
    const bloco = FONTE.slice(i, FONTE.indexOf("send: (bubble) => enviar(bubble)", i));
    expect(bloco).toMatch(/maxBubbles: Math\.max\(1, maxSendsPerTurn - seq\)/);
    expect(bloco).toMatch(
      /\.\.\.\(preview\s*\?\s*\{\}\s*:\s*\{\s*jaRegistrada: \(bolha: string\) =>\s*conteudoRegistradoNoJob\(pool, \{ tenantId, jobId: liveJob\(\)\.id, body: bolha \}\),/,
    );
    expect(FONTE).toMatch(/import \{ conteudoRegistradoNoJob, estadoInicialDoJob \} from '\.\.\/edge\/crm\/send-ledger';/);
  });
});
