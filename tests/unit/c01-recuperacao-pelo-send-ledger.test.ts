/**
 * (C01) RECUPERAÇÃO PELO `send_ledger` — a correção 3 do caso C54.
 *
 * O ledger identifica cada envio por (job, seq) e guarda o `body_hash`. Três
 * buracos deixavam a re-execução de um job (reaper, retry) falar errado:
 *
 *   a. `seq` recomeçava em 0 a cada execução: a primeira bolha nova caía na
 *      posição da primeira antiga;
 *   b. posição ocupada virava `already_sent` SEM comparar o conteúdo: texto novo
 *      numa posição velha sumia sem ninguém ver;
 *   c. nada reconhecia um texto já aceito quando ele chegava em posição nova:
 *      a re-execução repetia as bolhas que o canal já tinha entregado.
 *
 * Com a correção: a execução parte da maior posição ACEITA do job
 * (`posicaoInicialDoJob`, reconciliando recibos pendentes); conteúdo já aceito no
 * job volta `already_sent` em qualquer posição (dedup por conteúdo; foto e
 * template entram com a sua identidade, ver `c01-retry-nao-reenvia-foto-nem-
 * template`); posição ocupada por outro conteúdo vai para a primeira posição livre.
 *
 * O primeiro teste reproduz o C54 inteiro, com fila, lease e banco falsos: a 1ª
 * execução manda 2 bolhas e perde o lease; o reaper devolve o job; a 2ª produz
 * 3 bolhas — as 2 aceitas não saem de novo, a nova sai, e o checkpoint é só da
 * execução dona.
 */
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { insertCheckpoint } from "@/lib/agent-engine/agent/abertura/checkpoint";
import {
  pgSendLedger,
  posicaoInicialDoJob,
  sendWithLedger,
} from "@/lib/agent-engine/edge/crm/send-ledger";
import type { JobRow, Queryable } from "@/lib/agent-engine/queue/queue";
import {
  JobLeasePerdidoError,
  type CurrentServiceBoundary,
} from "@/lib/atendimento/fronteira";
import { guardServiceEffect, withServiceJob } from "@/lib/atendimento/fronteira-server";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";
const VISIBILIDADE_MS = 600_000;
const sha = (texto: string) => createHash("sha256").update(texto).digest("hex");

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

/**
 * Um Postgres de brinquedo com as tabelas que o caminho toca: `send_ledger`
 * (com a unicidade de (org, job, seq)), `messages`, `job_queue` (um job) e
 * `lead_checkpoints`. Responde ao SQL REAL do ledger, da cerca e do checkpoint.
 */
function bancoFalso() {
  const relogio = { agora: Date.parse("2026-09-28T12:00:00.000Z") };
  const instante = () => new Date(relogio.agora).toISOString();
  const job = { status: "running", locked_by: "w1" as string | null, locked_at: instante() as string | null };
  const claimInicial = job.locked_at!;
  const ledger: LinhaDoLedger[] = [];
  const messages: Array<{ id: string; status: string; idempotency_key: string; body: string }> = [];
  const checkpoints: Array<{ job_id: string; rolling_summary: string }> = [];

  const reaper = () => {
    if (job.status === "running" && job.locked_at && relogio.agora - Date.parse(job.locked_at) >= VISIBILIDADE_MS) {
      job.status = "pending";
      job.locked_by = null;
      job.locked_at = null;
    }
  };
  const pegar = (worker: string) => {
    job.status = "running";
    job.locked_by = worker;
    job.locked_at = instante();
    return job.locked_at;
  };
  const ehDono = (id: unknown, worker: unknown, adquiridoEm: unknown) =>
    id === JOB && job.status === "running" && job.locked_by === worker && job.locked_at === adquiridoEm;
  const violacao = () => Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });

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
    // (C01, rodada 3) recibo pendente com o mesmo conteúdo (`findPendente`).
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
    // (C01, rodada 4) as consultas do recibo LEGADO (hash só do texto): os recibos de um
    // hash e status dados, e a mensagem gravada. Este banco só conhece mensagens de
    // texto — foto e template daqui nasceram já com o hash novo, nunca são legado.
    if (s.startsWith("select * from send_ledger") && s.includes("body_hash=$3 and status = any($4::text[])")) {
      const [org, jobId, hash, status] = p as [string, string, string, string[]];
      const linhas = ledger.filter((l) => l.organization_id === org && l.job_id === jobId && l.body_hash === hash && status.includes(l.status)).sort((a, b) => a.seq - b.seq);
      return { rows: linhas, rowCount: linhas.length };
    }
    if (s.startsWith("select id,status,type,body,media_storage_path,template_name,template_language from messages")) {
      const [, key] = p as [string, string];
      const m = messages.find((x) => x.idempotency_key === key);
      return { rows: m ? [{ id: m.id, status: m.status, type: "text", body: m.body, media_storage_path: null, template_name: null, template_language: null }] : [], rowCount: m ? 1 : 0 };
    }
    if (s.startsWith("select id,status from messages")) {
      const [org, key] = p as [string, string];
      void org;
      const m = messages.find((x) => x.idempotency_key === key);
      return { rows: m ? [{ id: m.id, status: m.status }] : [], rowCount: m ? 1 : 0 };
    }
    if (s.includes("from job_queue where id=$1 and status='running'")) {
      const dono = ehDono(p[0], p[1], p[2]);
      return { rows: dono ? [{ lease: 1 }] : [], rowCount: dono ? 1 : 0 };
    }
    if (s.includes("from conversations c")) return { rows: [fronteira], rowCount: 1 };
    if (s.startsWith("insert into lead_checkpoints") && s.includes("where exists")) {
      const dono = ehDono(p[12], p[13], p[14]);
      if (dono) checkpoints.push({ job_id: String(p[2]), rolling_summary: String(p[6]) });
      return { rows: [], rowCount: dono ? 1 : 0 };
    }
    throw new Error(`SQL fora do roteiro do teste: ${s.slice(0, 80)}`);
  });

  return { relogio, job, claimInicial, reaper, pegar, ledger, messages, checkpoints, query, db: { query } as unknown as Queryable };
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

/**
 * O turno como ele manda: `seq` parte da posição inicial do job, avança a cada
 * envio e volta quando o ledger diz `already_sent` (não é mensagem física nova).
 * É o espelho de `enviarPeloCanal` em `inbound-turn.ts`; o teste de fiação
 * abaixo prende o original.
 */
async function turnoFalso(banco: ReturnType<typeof bancoFalso>, bolhas: string[]) {
  const store = pgSendLedger(banco.db);
  // O envio físico passa pela cerca, como `checkBoundary` no handler de mensagens.
  const canal = vi.fn(async (key: string, messageId: string, body: string) => {
    await guardServiceEffect();
    banco.messages.push({ id: messageId, status: "sent", idempotency_key: key, body });
    return { id: messageId, status: "sent" };
  });
  let seq = await posicaoInicialDoJob(banco.db, { tenantId: ORG, jobId: JOB });
  const posicaoInicial = seq;
  const resultados: string[] = [];
  for (const body of bolhas) {
    seq += 1;
    const r = await sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq, body }, (key, id) => canal(key, id, body));
    if (r.kind === "already_sent") seq -= 1;
    resultados.push(r.kind);
  }
  return { posicaoInicial, resultados, canal };
}

const checkpoint = (resumo: string) => ({ commitments: [], objections: [], next_action: null, rolling_summary: resumo });

describe("(C01) recuperação pelo send_ledger — o caso C54 inteiro", () => {
  it("1ª execução manda 2 bolhas e perde o lease; a 2ª manda só a nova; checkpoint é só da dona", async () => {
    const banco = bancoFalso();
    const A = "Oi! Vi que você se interessou pelo curso.";
    const B = "Posso te mandar o link da matrícula?";
    const C = "Fico à disposição para qualquer dúvida.";

    // ── 1ª execução (w1): duas bolhas saem, a terceira já não é dela ──
    await withServiceJob(banco.db, jobDe("w1", banco.claimInicial), async () => {
      const turno = await turnoFalso(banco, [A, B]);
      expect(turno.posicaoInicial).toBe(0);
      expect(turno.resultados).toEqual(["sent", "sent"]);
      banco.relogio.agora += VISIBILIDADE_MS + 1;
      banco.reaper();
      banco.pegar("w2");
      // A 3ª bolha e o checkpoint da execução substituída não acontecem (correção 1).
      await expect(turnoFalso(banco, [C])).rejects.toBeInstanceOf(JobLeasePerdidoError);
      await expect(
        insertCheckpoint(banco.db, { tenantId: ORG, leadId: LEAD, jobId: JOB, content: checkpoint("resumo VELHO da execução substituída") }),
      ).rejects.toBeInstanceOf(JobLeasePerdidoError);
    });
    expect(banco.messages.map((m) => m.body)).toEqual([A, B]);
    // O recibo da 3ª ficou 'requested' sem mensagem: a 2ª execução vai reconciliá-lo.
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "accepted"], [2, "accepted"], [3, "requested"]]);

    // ── 2ª execução (w2): o modelo produz as 3 bolhas de novo ──
    await withServiceJob(banco.db, jobDe("w2", banco.job.locked_at), async () => {
      const turno = await turnoFalso(banco, [A, B, C]);
      // Parte da última posição ACEITA (2), não de 0.
      expect(turno.posicaoInicial).toBe(2);
      // As duas aceitas não saem de novo; a nova sai.
      expect(turno.resultados).toEqual(["already_sent", "already_sent", "sent"]);
      expect(turno.canal).toHaveBeenCalledTimes(1);
      await insertCheckpoint(banco.db, { tenantId: ORG, leadId: LEAD, jobId: JOB, content: checkpoint("resumo da execução dona") });
    });

    // O lead recebeu cada texto UMA vez, na ordem.
    expect(banco.messages.map((m) => m.body)).toEqual([A, B, C]);
    // O ledger: 3 posições aceitas, cada uma com o hash do seu texto. A 3ª era o
    // recibo 'requested' que a execução substituída deixou (mesmo texto, nunca
    // chegou ao canal): foi reaproveitada e confirmada pela execução dona.
    expect(banco.ledger.map((l) => [l.seq, l.status, l.body_hash])).toEqual([
      [1, "accepted", sha(A)],
      [2, "accepted", sha(B)],
      [3, "accepted", sha(C)],
    ]);
    // Só o checkpoint da execução dona existe.
    expect(banco.checkpoints).toEqual([{ job_id: JOB, rolling_summary: "resumo da execução dona" }]);
  });

  it("texto NOVO numa posição ocupada vai para a próxima posição livre — nunca é descartado como already_sent", async () => {
    const banco = bancoFalso();
    await withServiceJob(banco.db, jobDe("w1", banco.claimInicial), async () => {
      const store = pgSendLedger(banco.db);
      const canal = vi.fn(async (key: string, id: string) => {
        banco.messages.push({ id, status: "sent", idempotency_key: key, body: "" });
        return { id, status: "sent" };
      });
      const envio = (seq: number, body: string) =>
        sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq, body }, canal);
      expect((await envio(1, "primeira versão")).kind).toBe("sent");
      // Uma execução que recomeçasse em 0 (o comportamento antigo) chega aqui com
      // texto diferente na posição 1.
      const r = await envio(1, "segunda versão, reescrita");
      expect(r.kind).toBe("sent");
      expect(canal).toHaveBeenCalledTimes(2);
      expect(banco.ledger.map((l) => [l.seq, l.status, l.body_hash])).toEqual([
        [1, "accepted", sha("primeira versão")],
        [2, "accepted", sha("segunda versão, reescrita")],
      ]);
      // E o MESMO texto na posição ocupada continua sendo repetição.
      expect((await envio(1, "primeira versão")).kind).toBe("already_sent");
      expect(canal).toHaveBeenCalledTimes(2);
    });
  });

  it("duas fotos com a mesma legenda e caminhos diferentes são duas mensagens; texto igual ao já aceito não sai de novo", async () => {
    const banco = bancoFalso();
    await withServiceJob(banco.db, jobDe("w1", banco.claimInicial), async () => {
      const store = pgSendLedger(banco.db);
      const canal = vi.fn(async (key: string, id: string) => {
        banco.messages.push({ id, status: "sent", idempotency_key: key, body: "" });
        return { id, status: "sent" };
      });
      const foto = { storagePath: "conversas/x/1.jpg", mime: "image/jpeg" };
      expect((await sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq: 1, body: "", media: foto }, canal)).kind).toBe("sent");
      expect((await sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq: 2, body: "", media: { ...foto, storagePath: "conversas/x/2.jpg" } }, canal)).kind).toBe("sent");
      expect(canal).toHaveBeenCalledTimes(2);
      // Texto puro igual a um já aceito, em posição nova: não sai de novo.
      expect((await sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq: 3, body: "Segue a foto" }, canal)).kind).toBe("sent");
      expect((await sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq: 4, body: "Segue a foto" }, canal)).kind).toBe("already_sent");
      expect(canal).toHaveBeenCalledTimes(3);
    });
  });

  it("texto NOVO sobre recibo 'requested' que nunca chegou ao canal reaproveita a posição (rotação)", async () => {
    const banco = bancoFalso();
    await withServiceJob(banco.db, jobDe("w1", banco.claimInicial), async () => {
      const store = pgSendLedger(banco.db);
      // 1ª tentativa: o canal caiu antes de aceitar — recibo fica 'requested', sem mensagem.
      await expect(
        sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq: 1, body: "texto da 1ª tentativa" }, async () => {
          throw new Error("canal fora");
        }),
      ).rejects.toThrow("canal fora");
      expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "requested"]]);
      // 2ª tentativa, texto reescrito, mesma posição: a posição é reaproveitada.
      const ok = vi.fn(async (key: string, id: string) => {
        banco.messages.push({ id, status: "sent", idempotency_key: key, body: "" });
        return { id, status: "sent" };
      });
      expect((await sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq: 1, body: "texto reescrito" }, ok)).kind).toBe("sent");
      expect(banco.ledger.map((l) => [l.seq, l.status, l.body_hash])).toEqual([[1, "accepted", sha("texto reescrito")]]);
    });
  });

  it("posição com 'failed' continua sendo reaproveitada pela rotação, mesmo com texto novo", async () => {
    const banco = bancoFalso();
    await withServiceJob(banco.db, jobDe("w1", banco.claimInicial), async () => {
      const store = pgSendLedger(banco.db);
      const falha = vi.fn(async (key: string, id: string) => {
        banco.messages.push({ id, status: "failed", idempotency_key: key, body: "" });
        return { id, status: "failed" };
      });
      const envio = (seq: number, body: string, canal: typeof falha) =>
        sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq, body }, canal);
      expect((await envio(1, "texto que falhou", falha)).kind).toBe("failed");
      const ok = vi.fn(async (key: string, id: string) => {
        banco.messages.push({ id, status: "sent", idempotency_key: key, body: "" });
        return { id, status: "sent" };
      });
      expect((await envio(1, "texto reescrito", ok)).kind).toBe("sent");
      expect(banco.ledger.map((l) => [l.seq, l.status, l.body_hash])).toEqual([[1, "accepted", sha("texto reescrito")]]);
    });
    // E a posição inicial de uma execução seguinte é a aceita.
    expect(await posicaoInicialDoJob(banco.db, { tenantId: ORG, jobId: JOB })).toBe(1);
  });

  it("posição inicial: reconcilia 'requested' cuja mensagem saiu e ignora o que não foi aceito", async () => {
    const banco = bancoFalso();
    const linha = (seq: number, status: string, hash: string, msg: string | null): LinhaDoLedger => ({
      id: randomUUID(), organization_id: ORG, contact_id: LEAD, job_id: JOB, seq, body_hash: hash, status, crm_message_id: msg, last_error: null,
    });
    banco.ledger.push(linha(1, "accepted", sha("a"), "m1"));
    // Crash entre o envio e a gravação: o recibo ficou 'requested', a mensagem existe.
    const pendente = linha(2, "requested", sha("b"), null);
    banco.ledger.push(pendente);
    banco.messages.push({ id: "m2", status: "delivered", idempotency_key: pendente.id, body: "b" });
    // Falhou de verdade: não conta.
    banco.ledger.push(linha(3, "failed", sha("c"), null));
    // 'requested' sem mensagem: nunca saiu, não conta.
    banco.ledger.push(linha(4, "requested", sha("d"), null));

    expect(await posicaoInicialDoJob(banco.db, { tenantId: ORG, jobId: JOB })).toBe(2);
    expect(banco.ledger.find((l) => l.seq === 2)).toMatchObject({ status: "accepted", crm_message_id: "m2" });
    expect(await posicaoInicialDoJob(banco.db, { tenantId: ORG, jobId: "55555555-5555-4555-8555-555555555555" })).toBe(0);
  });

  it("a fiação do turno: a posição parte do estado inicial do job e volta no already_sent; o canal só é chamado por um lugar", () => {
    const turno = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    // (C01, rodada 4) posição e contagem são dois números: `posicao` vai ao ledger como
    // `seq` do recibo; `seq` (a contagem do teto) só cresce quando algo de fato sai.
    expect(turno).toMatch(/const estadoInicial = preview\s*\?\s*\{ posicao: 0, enviadas: 0, pendentes: \[\], falhadas: \[\] \}\s*:\s*await estadoInicialDoJob\(pool, \{ tenantId, jobId: liveJob\(\)\.id \}\);/);
    expect(turno).toMatch(/let posicao = estadoInicial\.posicao;\s*let seq = estadoInicial\.enviadas;/);
    // (-c01.3, rodada 3) Entre o envio e a posição, a evidência de resposta (`registrarRespostaAoLead`).
    expect(turno).toMatch(/const falhada = falhadas\[0\];\s*const resultado = await liveChannel\(\)\.send\(\{ \.\.\.envio, seq: falhada\?\.seq \?\? posicao \+ 1 \}\);\n(?: {4}\/\/.*\n)* {4}registrarRespostaAoLead\(resultado\.kind\);\s*if \(resultado\.kind !== 'already_sent'\) \{\s*if \(falhada === undefined\) posicao \+= 1;\s*else if \(await posicaoFalhadaFoiOcupada\(pool, \{ tenantId, jobId: liveJob\(\)\.id, \.\.\.falhada \}\)\) \{\s*falhadas\.shift\(\);\s*if \(falhada\.seq > posicao\) posicao = falhada\.seq;\s*\}\s*if \(contaNoTeto\(resultado\)\) seq \+= 1;\s*\}/);
    // Posição e contagem só avançam dentro de `enviarPeloCanal`: nenhum outro `posicao += 1`
    // ou `seq += 1`, nenhum outro `.send(`.
    expect(turno.match(/posicao \+= 1/g)).toHaveLength(1);
    expect(turno.match(/seq \+= 1/g)).toHaveLength(1);
    expect(turno.match(/liveChannel\(\)\.send\(/g)).toHaveLength(1);
  });
});
