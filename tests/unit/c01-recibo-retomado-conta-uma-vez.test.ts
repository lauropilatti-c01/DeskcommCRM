/**
 * (C01) O RECIBO PENDENTE RETOMADO CONTA UMA VEZ SÓ — achado 1 (alto) da quarta
 * revisão adversarial do Codex (03/10/2026) sobre a recuperação pelo `send_ledger`
 * (rodada 4, correção 1).
 *
 * `estadoInicialDoJob` já soma em `enviadas` o recibo `requested`/`queued` cuja
 * mensagem o CRM segura (`queued`/`sending`): o canal vai entregá-la. Na re-execução,
 * `sendWithLedger` RETOMA esse recibo pela mesma chave (ramo `pendente`) e devolve
 * `sent` ou `queued`, nunca `already_sent` — e `enviarPeloCanal` fazia `seq += 1`: a
 * mesma mensagem contava duas vezes. Com teto 3, foto 1 aceita e foto 2 pendente, o
 * retry entregava a foto 2, chegava a `seq = 3` com só duas mensagens, `enviarComFotos`
 * omitia a foto 3 e devolvia sucesso; envios seguintes eram recusados por teto antes
 * da hora.
 *
 * Agora `estadoInicialDoJob` devolve também as CHAVES dos recibos que contou como
 * pendentes (`pendentes`), e o turno conta por chave: um desfecho cuja chave já foi
 * contada não incrementa `seq`. A prova no turno inteiro, com Postgres real, está em
 * `tests/invariants/c01-recuperacao-com-falha-na-posicao-1.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { enviarComFotos, type FotoParaEnvio } from "@/lib/agent-engine/agent/fotos-do-produto";
import { sendInBubbles } from "@/lib/agent-engine/agent/split-message";
import {
  conteudoRegistradoNoJob,
  estadoInicialDoJob,
  hashDoConteudo,
  pgSendLedger,
  sendWithLedger,
  type SendOutcome,
} from "@/lib/agent-engine/edge/crm/send-ledger";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";
const TETO = 3;

const T = "Essa é a moto que você pediu. Seguem as fotos.";
const A = "Oi! Vi que você perguntou sobre o plano.";
const B = "Ele inclui o material e o acesso à plataforma.";
const C = "Quer que eu te mande o link para começar?";
const D = "Posso te ajudar com mais alguma coisa?";

const FOTOS: FotoParaEnvio[] = [1, 2, 3].map((n) => ({
  storagePath: `conversas/x/foto-${n}.jpg`,
  mime: "image/jpeg",
}));

type Envio = { body: string; media?: FotoParaEnvio };

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
  const messages: Array<{ id: string; status: string; idempotency_key: string; envio: Envio }> = [];
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
    if (
      s.startsWith("select * from send_ledger") &&
      s.includes("body_hash=$3 and status = any($4::text[])")
    ) {
      const [org, jobId, hash, status] = p as [string, string, string, string[]];
      const linhas = doJob(org, jobId)
        .filter((l) => l.body_hash === hash && status.includes(l.status))
        .sort((a, b) => a.seq - b.seq);
      return { rows: linhas, rowCount: linhas.length };
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
    if (
      s.startsWith(
        "select id,status,type,body,media_storage_path,template_name,template_language from messages",
      )
    ) {
      const [, key] = p as [string, string];
      const m = messages.find((x) => x.idempotency_key === key);
      if (!m) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            id: m.id,
            status: m.status,
            type: m.envio.media ? "image" : "text",
            body: m.envio.body,
            media_storage_path: m.envio.media?.storagePath ?? null,
            template_name: null,
            template_language: null,
          },
        ],
        rowCount: 1,
      };
    }
    throw new Error(`SQL fora do roteiro do teste: ${s.slice(0, 80)}`);
  });
  const db = { query } as unknown as Queryable;
  const store = pgSendLedger(db);
  /** Um recibo como a execução anterior o deixou, com (ou sem) a mensagem que o handler gravou. */
  const recibo = (seq: number, status: string, envio: Envio, mensagem: string | null) => {
    const linha: LinhaDoLedger = {
      id: randomUUID(),
      organization_id: ORG,
      contact_id: LEAD,
      job_id: JOB,
      seq,
      body_hash: hashDoConteudo(envio),
      status,
      crm_message_id: null,
      last_error: null,
    };
    ledger.push(linha);
    if (mensagem !== null) {
      const m = { id: randomUUID(), status: mensagem, idempotency_key: linha.id, envio };
      messages.push(m);
      linha.crm_message_id = m.id;
    }
    return linha;
  };
  /** O que o CRM responde quando o handler reavalia uma mensagem já gravada (`queued` → `sent`, por padrão). */
  let aoReavaliar: (status: string) => string = () => "sent";
  const handler = vi.fn(async (key: string, messageId: string, envio: Envio) => {
    const existente = messages.find((m) => m.idempotency_key === key);
    if (existente) {
      existente.status = aoReavaliar(existente.status);
      return { id: existente.id, status: existente.status };
    }
    messages.push({ id: messageId, status: "sent", idempotency_key: key, envio });
    return { id: messageId, status: "sent" };
  });
  /**
   * A re-execução do turno, como `inbound-turn.ts` agora faz: parte de
   * `estadoInicialDoJob`, leva `posicao` ao ledger e conta em `seq` o que saiu — UMA
   * vez por chave, começando pelas chaves dos pendentes que a recuperação já contou.
   * `contarRetomadas` é o defeito, documentado: todo desfecho que não é `already_sent`
   * conta, inclusive o recibo retomado.
   */
  const turno = async (contarRetomadas = false) => {
    const estado = await estadoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    let { posicao } = estado;
    let seq = estado.enviadas;
    const contadas = new Set<string>(contarRetomadas ? [] : estado.pendentes);
    const contaNoTeto = (r: SendOutcome): boolean => {
      if (contadas.has(r.idempotencyKey)) return false;
      contadas.add(r.idempotencyKey);
      return true;
    };
    const saidas: SendOutcome[] = [];
    const enviar = async (envio: Envio): Promise<SendOutcome> => {
      posicao += 1;
      const r = await sendWithLedger(
        store,
        { tenantId: ORG, leadId: LEAD, jobId: JOB, seq: posicao, ...envio },
        (key, id) => handler(key, id, envio),
      );
      if (r.kind === "already_sent") posicao -= 1;
      else if (contaNoTeto(r)) seq += 1;
      saidas.push(r);
      return r;
    };
    /** `send_message` do turno: recusa por teto ANTES do ledger, como a ferramenta. */
    const sendMessage = async (body: string, fotos: readonly FotoParaEnvio[] = []) => {
      if (seq >= TETO) return "recusado:max_sends_per_turn";
      const r = await enviarComFotos(body, fotos, {
        sleep: async () => {},
        jitter: () => 0,
        restantes: () => TETO - seq,
        enviarFoto: (foto, legenda) => enviar({ body: legenda, media: foto }),
        enviarTexto: (texto) =>
          sendInBubbles(texto, {
            enabled: true,
            maxChars: 600,
            maxBubbles: Math.max(1, TETO - seq),
            jaRegistrada: (bolha: string) =>
              conteudoRegistradoNoJob(db, { tenantId: ORG, jobId: JOB, body: bolha }),
            sleep: async () => {},
            jitter: () => 0,
            send: (bolha: string) => enviar({ body: bolha }),
          }),
      });
      return r.kind;
    };
    return {
      estado,
      saidas,
      sendMessage,
      seq: () => seq,
      posicao: () => posicao,
    };
  };
  return {
    db,
    ledger,
    messages,
    handler,
    recibo,
    turno,
    reavaliarComo: (f: (status: string) => string) => {
      aoReavaliar = f;
    },
  };
}

const chaves = (saidas: SendOutcome[]) =>
  saidas.map((s) => ("idempotencyKey" in s ? s.idempotencyKey : null));

describe("(C01) `estadoInicialDoJob` devolve as chaves dos pendentes que contou", () => {
  it("'queued' com mensagem na fila e 'requested' com mensagem 'sending': contam e saem em `pendentes`; aceito, reconciliado, perdido e falhado não — e o falhado (rodada 7) vira 'failed' e sai em `falhadas`", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "accepted", { body: A }, "sent");
    const naFila = banco.recibo(2, "queued", { body: B }, "queued");
    const reconciliado = banco.recibo(3, "requested", { body: C }, "delivered");
    const saindo = banco.recibo(4, "requested", { body: D }, "sending");
    banco.recibo(5, "requested", { body: T }, null);
    const falhado = banco.recibo(6, "requested", { body: `${T}!` }, "failed");
    expect(await estadoInicialDoJob(banco.db, { tenantId: ORG, jobId: JOB })).toEqual({
      posicao: 3,
      enviadas: 4,
      pendentes: [naFila.id, saindo.id],
      // (rodada 7) O pendente cuja mensagem o CRM marcou `failed` é reconciliado como
      // 'failed' e a posição fica a reaproveitar (achado 2 da sexta revisão).
      falhadas: [{ seq: 6, chave: falhado.id }],
    });
    expect(banco.ledger.find((l) => l.id === reconciliado.id)).toMatchObject({
      status: "accepted",
    });
    expect(banco.ledger.find((l) => l.id === falhado.id)).toMatchObject({ status: "failed" });
  });

  it("job sem recibo, ou só com aceitos: `pendentes` vazio", async () => {
    const banco = bancoFalso();
    expect(await estadoInicialDoJob(banco.db, { tenantId: ORG, jobId: JOB })).toEqual({
      posicao: 0,
      enviadas: 0,
      pendentes: [],
      falhadas: [],
    });
    banco.recibo(1, "accepted", { body: A }, "sent");
    expect(await estadoInicialDoJob(banco.db, { tenantId: ORG, jobId: JOB })).toEqual({
      posicao: 1,
      enviadas: 1,
      pendentes: [],
      falhadas: [],
    });
  });
});

describe("(C01) o cenário do Codex: foto 1 aceita, foto 2 pendente, foto 3 ainda não criada (teto 3)", () => {
  it("a re-execução entrega a foto 3: a foto 2 retomada não conta de novo, nenhuma é omitida nem duplicada, e a 4ª mensagem é recusada por teto", async () => {
    const banco = bancoFalso();
    // Execução anterior: a foto 1 saiu com a legenda; a foto 2 ficou na fila do CRM
    // (sessão fora) e o turno caiu antes da foto 3.
    banco.recibo(1, "accepted", { body: T, media: FOTOS[0]! }, "sent");
    const pendente = banco.recibo(2, "queued", { body: "", media: FOTOS[1]! }, "queued");

    const t = await banco.turno();
    expect(t.estado).toEqual({ posicao: 1, enviadas: 2, pendentes: [pendente.id], falhadas: [] });

    // O modelo regenera a mesma resposta: texto + as três fotos.
    expect(await t.sendMessage(T, FOTOS)).toBe("sent");
    // Foto 1 já saiu; foto 2 é a MESMA mensagem retomada (mesma chave); foto 3 é nova.
    expect(t.saidas.map((s) => s.kind)).toEqual(["already_sent", "sent", "sent"]);
    expect(chaves(t.saidas)[1]).toBe(pendente.id);
    // O cliente recebe três mensagens deste job, uma vez cada: o handler só foi
    // chamado para a foto 2 (reavaliada) e para a foto 3 (nova).
    expect(
      banco.handler.mock.calls.map((c) => [c[0] === pendente.id, c[2].media?.storagePath]),
    ).toEqual([
      [true, FOTOS[1]!.storagePath],
      [false, FOTOS[2]!.storagePath],
    ]);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    // A contagem fecha em 3 = três mensagens reais; o teto continua valendo para a 4ª.
    expect(t.seq()).toBe(TETO);
    expect(await t.sendMessage(D)).toBe("recusado:max_sends_per_turn");
    expect(banco.messages).toHaveLength(3);
  });

  it("o defeito, documentado: contando a retomada, `seq` chegava a 3 com duas mensagens, a foto 3 era omitida e o envio devolvia sucesso", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "accepted", { body: T, media: FOTOS[0]! }, "sent");
    const pendente = banco.recibo(2, "queued", { body: "", media: FOTOS[1]! }, "queued");

    const t = await banco.turno(true);
    expect(await t.sendMessage(T, FOTOS)).toBe("sent");
    expect(t.saidas.map((s) => s.kind)).toEqual(["already_sent", "sent"]);
    expect(banco.handler.mock.calls.map((c) => c[0])).toEqual([pendente.id]);
    expect(t.seq()).toBe(TETO);
    expect(banco.messages).toHaveLength(2);
    expect(banco.ledger.map((l) => l.seq)).toEqual([1, 2]);
  });
});

describe("(C01) o mesmo com bolhas de texto, e com o canal que continua segurando", () => {
  it("A aceita, B na fila, C nova: a re-execução manda C; B retomada (mesma chave) não conta; D é recusada", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "accepted", { body: A }, "sent");
    const pendente = banco.recibo(2, "queued", { body: B }, "queued");

    const t = await banco.turno();
    expect(await t.sendMessage(`${A}\n\n${B}\n\n${C}`)).toBe("sent");
    expect(t.saidas.map((s) => s.kind)).toEqual(["already_sent", "sent", "sent"]);
    expect(chaves(t.saidas)[1]).toBe(pendente.id);
    expect(banco.messages.map((m) => m.envio.body)).toEqual([A, B, C]);
    expect(t.seq()).toBe(TETO);
    expect(await t.sendMessage(D)).toBe("recusado:max_sends_per_turn");
  });

  it("o canal continua segurando B (`queued` de novo): contada uma vez na recuperação, não conta mais — nem na segunda tentativa da mesma execução", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "accepted", { body: A }, "sent");
    const pendente = banco.recibo(2, "queued", { body: B }, "queued");
    banco.reavaliarComo(() => "queued");

    const t = await banco.turno();
    expect(await t.sendMessage(B)).toBe("queued");
    expect(await t.sendMessage(B)).toBe("queued");
    expect(chaves(t.saidas)).toEqual([pendente.id, pendente.id]);
    // Duas tentativas, a mesma mensagem, UMA contagem (a da recuperação): sobra uma vaga.
    expect(t.seq()).toBe(2);
    expect(await t.sendMessage(C)).toBe("sent");
    expect(t.seq()).toBe(TETO);
    // B segue na posição 2 (o canal a entrega quando a sessão voltar); C ganha uma
    // posição nova. A dica de posição avançou nas duas retomadas, então C cai na 4: a
    // lacuna é inofensiva (a próxima livre é `max + 1`, e a posição inicial da
    // re-execução é a maior aceita), como documentado desde a rodada 4.
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "accepted"],
      [2, "queued"],
      [4, "accepted"],
    ]);
    expect(banco.messages.map((m) => m.envio.body)).toEqual([A, B, C]);
  });

  it("sem pendente nenhum, nada muda: cada desfecho novo conta uma vez, como sempre", async () => {
    const banco = bancoFalso();
    const t = await banco.turno();
    expect(t.estado).toEqual({ posicao: 0, enviadas: 0, pendentes: [], falhadas: [] });
    expect(await t.sendMessage(`${A}\n\n${B}\n\n${C}\n\n${D}`)).toBe("sent");
    // Teto 3: quatro bolhas novas viram três mensagens (a última leva D junto).
    expect(banco.messages.map((m) => m.envio.body)).toEqual([A, B, `${C}\n\n${D}`]);
    expect(t.seq()).toBe(TETO);
    expect(await t.sendMessage(T)).toBe("recusado:max_sends_per_turn");
  });
});

describe("(C01) a ligação no turno", () => {
  const FONTE = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("o turno parte das chaves já contadas e só incrementa `seq` para uma chave nova (ou sem chave: `unavailable`)", () => {
    expect(FONTE).toMatch(
      /const estadoInicial = preview\s*\?\s*\{ posicao: 0, enviadas: 0, pendentes: \[\], falhadas: \[\] \}\s*:\s*await estadoInicialDoJob\(pool, \{ tenantId, jobId: liveJob\(\)\.id \}\);/,
    );
    expect(FONTE).toMatch(/const contadas = new Set<string>\(estadoInicial\.pendentes\);/);
    expect(FONTE).toMatch(
      /const contaNoTeto = \(resultado: ChannelSendResult\): boolean => \{\s*if \(resultado\.kind === 'unavailable'\) return true;\s*if \(contadas\.has\(resultado\.idempotencyKey\)\) return false;\s*contadas\.add\(resultado\.idempotencyKey\);\s*return true;\s*\};/,
    );
    // (-c01.3, rodada 3) Entre o envio e a posição, a evidência de resposta (`registrarRespostaAoLead`).
    expect(FONTE).toMatch(
      /const falhada = falhadas\[0\];\s*const resultado = await liveChannel\(\)\.send\(\{ \.\.\.envio, seq: falhada\?\.seq \?\? posicao \+ 1 \}\);\n(?: {4}\/\/.*\n)* {4}registrarRespostaAoLead\(resultado\.kind\);\s*if \(resultado\.kind !== 'already_sent'\) \{\s*if \(falhada === undefined\) posicao \+= 1;\s*else if \(await posicaoFalhadaFoiOcupada\(pool, \{ tenantId, jobId: liveJob\(\)\.id, \.\.\.falhada \}\)\) \{\s*falhadas\.shift\(\);\s*if \(falhada\.seq > posicao\) posicao = falhada\.seq;\s*\}\s*if \(contaNoTeto\(resultado\)\) seq \+= 1;\s*\}/,
    );
    expect(FONTE.match(/seq \+= 1/g)).toHaveLength(1);
  });
});
