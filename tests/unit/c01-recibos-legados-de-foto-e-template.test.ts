/**
 * (C01) RECIBOS LEGADOS DE FOTO E TEMPLATE — achado 2 (alto) da terceira revisão
 * adversarial do Codex (03/10/2026) sobre a identidade do conteúdo (`hashDoConteudo`,
 * rodada 2).
 *
 * A versão do autor grava em `send_ledger.body_hash` o SHA-256 só do texto, para todo
 * envio: a legenda da foto, o texto renderizado do template. A rodada 2 passou a
 * incluir a mídia e os parâmetros do template no hash, mas `findAccepted` e
 * `findPendente` só procuravam pelo hash novo. Numa instalação atualizada com um job
 * no meio (a troca de versão no laboratório e na produção passa exatamente por aí),
 * a foto ou o template já aceitos não eram reconhecidos e ganhavam outro recibo; um
 * envio `queued` ganhava outra identidade enquanto a mensagem original seguia
 * pendente. Duplicata na troca de versão, repetindo exatamente o conteúdo original.
 *
 * Agora, quando o hash novo não encontra nada e o envio é foto ou template, o ledger
 * procura pelo hash legado (só o texto) e confirma cada candidato pela mensagem
 * gravada — tipo, caminho da mídia, nome e idioma do template — antes de reaproveitar
 * a identidade (`reciboLegado`). Texto puro tem o hash de sempre e não muda.
 *
 * Os recibos deste teste são gravados como a `main` os grava: `sha256(body)`.
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
/** O hash da `main`: só o texto, para qualquer tipo de envio. */
const hashDaMain = (body: string) => createHash("sha256").update(body).digest("hex");

const TEXTO = "Oi Ana, tudo certo?";
const LEGENDA = "Caneca por R$ 49";
const FOTO_1 = { storagePath: `${ORG}/conv/caneca-1.jpg`, mime: "image/jpeg" };
const FOTO_2 = { storagePath: `${ORG}/conv/caneca-2.jpg`, mime: "image/jpeg" };
const FOTO_3 = { storagePath: `${ORG}/conv/caneca-3.jpg`, mime: "image/jpeg" };
const FOTO_9 = { storagePath: `${ORG}/conv/outra-caneca.jpg`, mime: "image/jpeg" };
const TEMPLATE = { name: "retomada", language: "pt_BR", values: { "1": "Ana" } };

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
  type: string;
  body: string | null;
  media_storage_path: string | null;
  template_name: string | null;
  template_language: string | null;
}
type Conteudo = { body: string; media?: typeof FOTO_1; template?: typeof TEMPLATE };

/** Postgres de brinquedo respondendo ao SQL real do ledger, inclusive às consultas do legado. */
function bancoFalso() {
  const ledger: LinhaDoLedger[] = [];
  const messages: Mensagem[] = [];
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
    // (C01, rodada 4) os recibos de um hash e status dados — a consulta do legado.
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
    // (C01, rodada 4) a mensagem gravada, nas colunas que identificam o conteúdo.
    if (
      s.startsWith(
        "select id,status,type,body,media_storage_path,template_name,template_language from messages",
      )
    ) {
      const [, key] = p as [string, string];
      const m = messages.find((x) => x.idempotency_key === key);
      return { rows: m ? [{ ...m }] : [], rowCount: m ? 1 : 0 };
    }
    throw new Error(`SQL fora do roteiro do teste: ${s.slice(0, 90)}`);
  });
  const db = { query } as unknown as Queryable;
  const store = pgSendLedger(db);

  /** Um recibo como a `main` o deixou, com a mensagem que o handler gravou. */
  const legado = (
    seq: number,
    status: "accepted" | "queued",
    c: Conteudo,
    mensagem: "sent" | "queued" | "nenhuma" = "sent",
  ) => {
    const linha: LinhaDoLedger = {
      id: randomUUID(),
      organization_id: ORG,
      contact_id: LEAD,
      job_id: JOB,
      seq,
      body_hash: hashDaMain(c.body),
      status,
      crm_message_id: null,
      last_error: null,
    };
    ledger.push(linha);
    if (mensagem === "nenhuma") return linha;
    const m: Mensagem = {
      id: randomUUID(),
      status: mensagem,
      idempotency_key: linha.id,
      type: c.template ? "template" : c.media ? "image" : "text",
      // Foto sem legenda vai sem `body` (o handler grava null).
      body: c.body === "" && c.media ? null : c.body,
      media_storage_path: c.media?.storagePath ?? null,
      // Nome e idioma só são gravados quando a mensagem é marcada enviada.
      template_name: c.template && mensagem === "sent" ? c.template.name : null,
      template_language: c.template && mensagem === "sent" ? c.template.language : null,
    };
    messages.push(m);
    linha.crm_message_id = m.id;
    return linha;
  };

  /** O handler do CRM: reavalia a mesma chave (a sessão voltou: `sent`) ou grava uma mensagem nova. */
  const handler = vi.fn(async (key: string, messageId: string, c: Conteudo) => {
    const existente = messages.find((m) => m.idempotency_key === key);
    if (existente) {
      existente.status = "sent";
      if (c.template)
        Object.assign(existente, {
          template_name: c.template.name,
          template_language: c.template.language,
        });
      return { id: existente.id, status: "sent" };
    }
    messages.push({
      id: messageId,
      status: "sent",
      idempotency_key: key,
      type: c.template ? "template" : c.media ? "image" : "text",
      body: c.body === "" && c.media ? null : c.body,
      media_storage_path: c.media?.storagePath ?? null,
      template_name: c.template?.name ?? null,
      template_language: c.template?.language ?? null,
    });
    return { id: messageId, status: "sent" };
  });

  /** A re-execução do turno mandando `conteudos`, como `enviarPeloCanal` faz. */
  const reexecucao = async (conteudos: Conteudo[]) => {
    let seq = await posicaoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    const saidas = [];
    for (const c of conteudos) {
      seq += 1;
      const r = await sendWithLedger(
        store,
        { tenantId: ORG, leadId: LEAD, jobId: JOB, seq, ...c },
        (key, id) => handler(key, id, c),
      );
      if (r.kind === "already_sent") seq -= 1;
      saidas.push(r);
    }
    return saidas;
  };
  return { ledger, messages, handler, legado, reexecucao };
}

describe("(C01) a troca de versão: recibos de foto e template gravados pela `main` são reconhecidos", () => {
  it("foto aceita, foto sem legenda aceita, foto sem legenda a caminho e template aceito: nenhum ganha outro recibo; o texto puro segue igual", async () => {
    const banco = bancoFalso();
    const texto = banco.legado(1, "accepted", { body: TEXTO });
    const foto1 = banco.legado(2, "accepted", { body: LEGENDA, media: FOTO_1 });
    const foto2 = banco.legado(3, "accepted", { body: "", media: FOTO_2 });
    // A sessão estava fora: a 3ª foto ficou `queued`, com a mensagem pendente no CRM.
    const foto3 = banco.legado(4, "queued", { body: "", media: FOTO_3 }, "queued");
    // O template renderiza EXATAMENTE o texto da posição 1: na `main`, o mesmo hash.
    const template = banco.legado(5, "accepted", { body: TEXTO, template: TEMPLATE });
    expect(new Set(banco.ledger.map((l) => l.body_hash)).size).toBe(3); // TEXTO (×2), LEGENDA, "" (×2)

    const saidas = await banco.reexecucao([
      { body: TEXTO },
      { body: LEGENDA, media: FOTO_1 },
      { body: "", media: FOTO_2 },
      { body: "", media: FOTO_3 },
      { body: TEXTO, template: TEMPLATE },
    ]);

    // Cada envio reencontrou o SEU recibo — pela identidade de sempre (texto) ou pelo
    // hash legado confirmado na mensagem gravada (fotos e template).
    expect(saidas.map((r) => r.kind)).toEqual([
      "already_sent",
      "already_sent",
      "already_sent",
      "sent",
      "already_sent",
    ]);
    expect(saidas.map((r) => r.idempotencyKey)).toEqual([
      texto.id,
      foto1.id,
      foto2.id,
      foto3.id,
      template.id,
    ]);
    // A foto a caminho retomou a identidade: o handler reavaliou a MESMA chave, e só ela.
    expect(banco.handler.mock.calls.map((c) => c[0])).toEqual([foto3.id]);
    // Nenhuma posição nova; a 4ª virou aceita.
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
      [4, "accepted"],
      [5, "accepted"],
    ]);
    expect(banco.messages).toHaveLength(5);
  });

  it("o hash legado não basta: a mesma legenda com OUTRA foto, outro texto renderizado e outro template com o mesmo texto são envios novos", async () => {
    const banco = bancoFalso();
    banco.legado(1, "accepted", { body: TEXTO });
    banco.legado(2, "accepted", { body: LEGENDA, media: FOTO_1 });
    banco.legado(3, "accepted", { body: TEXTO, template: TEMPLATE });

    const saidas = await banco.reexecucao([
      // Mesma legenda, outro arquivo: outra foto.
      { body: LEGENDA, media: FOTO_9 },
      // Mesmo template, outros valores: outro texto renderizado.
      { body: "Oi Bia, tudo certo?", template: { ...TEMPLATE, values: { "1": "Bia" } } },
      // Outro template que por acaso renderiza o mesmo texto: outro envio (o nome não bate).
      { body: TEXTO, template: { ...TEMPLATE, name: "boas_vindas" } },
    ]);

    expect(saidas.map((r) => r.kind)).toEqual(["sent", "sent", "sent"]);
    expect(banco.handler).toHaveBeenCalledTimes(3);
    // Nasceram nas posições seguintes, já com a identidade NOVA do conteúdo.
    const novas = banco.ledger.filter((l) => l.seq > 3).sort((a, b) => a.seq - b.seq);
    expect(novas.map((l) => [l.seq, l.status])).toEqual([
      [4, "accepted"],
      [5, "accepted"],
      [6, "accepted"],
    ]);
    expect(novas[0]!.body_hash).toBe(hashDoConteudo({ body: LEGENDA, media: FOTO_9 }));
    expect(novas[0]!.body_hash).not.toBe(hashDaMain(LEGENDA));
  });

  it("recibo legado sem mensagem gravada não confirma nada: o envio segue o caminho normal", async () => {
    const banco = bancoFalso();
    // `requested` que nunca chegou ao handler (crash antes da gravação), na versão antiga.
    const linha: LinhaDoLedger = {
      id: randomUUID(),
      organization_id: ORG,
      contact_id: LEAD,
      job_id: JOB,
      seq: 1,
      body_hash: hashDaMain(LEGENDA),
      status: "requested",
      crm_message_id: null,
      last_error: null,
    };
    banco.ledger.push(linha);

    const [saida] = await banco.reexecucao([{ body: LEGENDA, media: FOTO_1 }]);
    // Posição 1 ocupada por recibo que nunca saiu e com "outro" hash: reaproveitada
    // (rotate), como sempre foi — a foto sai uma vez.
    expect(saida!.kind).toBe("sent");
    expect(banco.ledger).toHaveLength(1);
    expect(banco.ledger[0]).toMatchObject({
      seq: 1,
      status: "accepted",
      body_hash: hashDoConteudo({ body: LEGENDA, media: FOTO_1 }),
    });
  });

  it("texto puro não passa pelo legado: o hash é o de sempre e as consultas são as de sempre", async () => {
    const banco = bancoFalso();
    banco.legado(1, "accepted", { body: TEXTO });
    const [saida] = await banco.reexecucao([{ body: TEXTO }]);
    expect(saida!.kind).toBe("already_sent");
    expect(hashDoConteudo({ body: TEXTO })).toBe(hashDaMain(TEXTO));
  });
});
