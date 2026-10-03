/**
 * (C01) A RE-EXECUÇÃO DO JOB NÃO REENVIA FOTO NEM TEMPLATE JÁ ACEITOS — achado 1 da
 * revisão adversarial do Codex (03/10/2026) sobre a correção 3 do caso C54.
 *
 * A correção 3 fez a execução partir da maior posição ACEITA do job e reconhecer,
 * em qualquer posição, o texto que o canal já aceitou (`findAccepted` por
 * `body_hash`). Mas o hash era só do texto, e a deduplicação valia só para texto
 * puro: uma foto ou um template aceitos na posição 1 eram gerados de novo pela
 * re-execução (reaper, retry) na posição 2, com chave nova, e saíam outra vez.
 * Antes da correção 3, o replay reencontrava o recibo na posição 1 — a correção
 * fechou um buraco (texto) e abriu outro (foto e template).
 *
 * Agora a identidade do conteúdo (`hashDoConteudo`) inclui a mídia (caminho e
 * tipo) ou o template (nome, idioma e valores), com prefixo que os separa do
 * texto: a MESMA foto e o MESMO template não saem duas vezes; duas fotos com a
 * mesma legenda e caminhos diferentes continuam sendo duas mensagens; e uma foto
 * com a legenda X não colide mais com o texto X. Texto puro mantém o hash de
 * sempre: os recibos já gravados continuam válidos.
 */
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  hashDoConteudo,
  pgSendLedger,
  posicaoInicialDoJob,
  sendWithLedger,
} from "@/lib/agent-engine/edge/crm/send-ledger";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";
const sha = (texto: string) => createHash("sha256").update(texto).digest("hex");

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

interface Envio {
  body: string;
  media?: { storagePath: string; mime: string };
  template?: { name: string; language: string; values: Record<string, string> };
}

/**
 * Um Postgres de brinquedo com `send_ledger` (unicidade de (org, job, seq)) e
 * `messages`, respondendo ao SQL REAL do ledger. O canal grava a mensagem como o
 * handler faria e devolve `sent`.
 */
function bancoFalso() {
  const ledger: LinhaDoLedger[] = [];
  const messages: Array<{ id: string; status: string; idempotency_key: string; envio: Envio }> = [];
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
  const canal = vi.fn(async (key: string, messageId: string, envio: Envio) => {
    messages.push({ id: messageId, status: "sent", idempotency_key: key, envio });
    return { id: messageId, status: "sent" };
  });
  /**
   * Uma EXECUÇÃO do job, como o turno manda: `seq` parte da posição inicial do
   * job, avança a cada envio e volta quando o ledger diz `already_sent`
   * (espelho de `enviarPeloCanal` em `inbound-turn.ts`).
   */
  const execucao = async (envios: Envio[]) => {
    let seq = await posicaoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    const posicaoInicial = seq;
    const resultados: string[] = [];
    for (const envio of envios) {
      seq += 1;
      const r = await sendWithLedger(store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq, ...envio }, (key, id) => canal(key, id, envio));
      if (r.kind === "already_sent") seq -= 1;
      resultados.push(r.kind);
    }
    return { posicaoInicial, resultados };
  };
  return { ledger, messages, store, canal, execucao };
}

const FOTO_1 = { storagePath: `${ORG}/conversa/catalogo-moto-frente.jpg`, mime: "image/jpeg" };
const FOTO_2 = { storagePath: `${ORG}/conversa/catalogo-moto-lado.jpg`, mime: "image/jpeg" };
const TEMPLATE = { name: "retomada", language: "pt_BR", values: { "1": "Ana" } };

describe("(C01) a re-execução do job não reenvia foto nem template já aceitos", () => {
  it("fotos do produto: a 1ª execução manda texto + 2 fotos; a 2ª gera tudo de novo e só a bolha nova sai", async () => {
    const banco = bancoFalso();
    const texto = "Olha a moto que você pediu:";
    const nova = "Quer agendar uma visita?";
    // 1ª execução: a legenda vai na capa, a 2ª foto sem legenda (como `enviarComFotos`).
    const primeira = await banco.execucao([{ body: texto, media: FOTO_1 }, { body: "", media: FOTO_2 }]);
    expect(primeira.resultados).toEqual(["sent", "sent"]);
    expect(banco.canal).toHaveBeenCalledTimes(2);
    // O lease cai; o reaper devolve o job; a 2ª execução regenera as mesmas fotos e mais uma bolha.
    const segunda = await banco.execucao([{ body: texto, media: FOTO_1 }, { body: "", media: FOTO_2 }, { body: nova }]);
    expect(segunda.posicaoInicial).toBe(2);
    expect(segunda.resultados).toEqual(["already_sent", "already_sent", "sent"]);
    // O canal recebeu cada foto UMA vez; a 2ª execução só mandou a bolha nova.
    expect(banco.canal).toHaveBeenCalledTimes(3);
    expect(banco.messages.map((m) => m.envio)).toEqual([
      { body: texto, media: FOTO_1 },
      { body: "", media: FOTO_2 },
      { body: nova },
    ]);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "accepted"], [2, "accepted"], [3, "accepted"]]);
  });

  it("template: o mesmo template com os mesmos valores não sai de novo; com outro valor é outra mensagem", async () => {
    const banco = bancoFalso();
    const corpo = "Oi Ana, tudo certo?";
    expect((await banco.execucao([{ body: corpo, template: TEMPLATE }])).resultados).toEqual(["sent"]);
    // Re-execução: mesmo template, mesmos valores (a ordem das chaves não importa).
    const repetido = await banco.execucao([
      { body: corpo, template: { values: { "1": "Ana" }, language: "pt_BR", name: "retomada" } },
    ]);
    expect(repetido.resultados).toEqual(["already_sent"]);
    expect(banco.canal).toHaveBeenCalledTimes(1);
    // Outro valor = outro texto para o cliente: sai.
    const outro = await banco.execucao([{ body: "Oi Bia, tudo certo?", template: { ...TEMPLATE, values: { "1": "Bia" } } }]);
    expect(outro.resultados).toEqual(["sent"]);
    expect(banco.canal).toHaveBeenCalledTimes(2);
  });

  it("duas fotos com a MESMA legenda (vazia) e caminhos diferentes continuam sendo duas mensagens", async () => {
    const banco = bancoFalso();
    const r = await banco.execucao([{ body: "", media: FOTO_1 }, { body: "", media: FOTO_2 }]);
    expect(r.resultados).toEqual(["sent", "sent"]);
    expect(banco.canal).toHaveBeenCalledTimes(2);
    // E os dois recibos têm identidades diferentes no ledger.
    expect(new Set(banco.ledger.map((l) => l.body_hash)).size).toBe(2);
  });

  it("foto com a legenda X não colide com o texto X: na mesma posição é outro conteúdo e vai para a posição livre", async () => {
    const banco = bancoFalso();
    const X = "Segue a foto da moto.";
    // Texto X aceito na posição 1.
    expect((await sendWithLedger(banco.store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq: 1, body: X }, (k, id) => banco.canal(k, id, { body: X }))).kind).toBe("sent");
    // Uma execução que recomeçasse em 0 (comportamento antigo) chega à posição 1 com a FOTO legendada X.
    const foto = { body: X, media: FOTO_1 };
    const r = await sendWithLedger(banco.store, { tenantId: ORG, leadId: LEAD, jobId: JOB, seq: 1, ...foto }, (k, id) => banco.canal(k, id, foto));
    // Não é repetição do texto: a foto sai, na próxima posição livre.
    expect(r.kind).toBe("sent");
    expect(banco.canal).toHaveBeenCalledTimes(2);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([[1, "accepted"], [2, "accepted"]]);
    expect(banco.ledger[1]!.body_hash).not.toBe(sha(X));
  });

  it("a identidade do conteúdo: texto puro mantém o hash do texto; foto e template entram com prefixo próprio", () => {
    const X = "Segue a foto da moto.";
    // Compatível com os recibos já gravados: texto puro é sha256(texto), como sempre.
    expect(hashDoConteudo({ body: X })).toBe(sha(X));
    // Foto, template e texto com o mesmo corpo são três identidades.
    const foto = hashDoConteudo({ body: X, media: FOTO_1 });
    const template = hashDoConteudo({ body: X, template: TEMPLATE });
    expect(new Set([sha(X), foto, template]).size).toBe(3);
    // A mesma foto, o mesmo hash; outro caminho ou outro tipo, outro hash.
    expect(hashDoConteudo({ body: X, media: { mime: FOTO_1.mime, storagePath: FOTO_1.storagePath } })).toBe(foto);
    expect(hashDoConteudo({ body: X, media: FOTO_2 })).not.toBe(foto);
    expect(hashDoConteudo({ body: X, media: { ...FOTO_1, mime: "image/png" } })).not.toBe(foto);
    // A ordem das chaves dos valores do template não muda a identidade; outro valor muda.
    const dois = { name: "x", language: "pt_BR", values: { "2": "b", "1": "a" } };
    expect(hashDoConteudo({ body: X, template: dois })).toBe(hashDoConteudo({ body: X, template: { ...dois, values: { "1": "a", "2": "b" } } }));
    expect(hashDoConteudo({ body: X, template: { ...dois, values: { "1": "a", "2": "c" } } })).not.toBe(hashDoConteudo({ body: X, template: dois }));
  });
});
