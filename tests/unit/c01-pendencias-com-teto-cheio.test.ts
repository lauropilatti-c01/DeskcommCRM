/**
 * (C01) PENDÊNCIAS QUE PREENCHEM O TETO FICAM SEM RECUPERAÇÃO — achado 1 (alto) da
 * quinta revisão adversarial do Codex (03/10/2026) sobre a recuperação pelo
 * `send_ledger` (rodada 6, correção 1).
 *
 * `estadoInicialDoJob` conta em `enviadas` o recibo pendente cuja mensagem o CRM
 * segura (`queued`): o canal vai entregá-la. Com teto 3, 1 foto aceita e 2 fotos
 * `queued` sem legenda, a re-execução partia de `seq = 3` — e `send_message` e
 * `send_template` recusavam por `max_sends_per_turn` ANTES de consultar o ledger, que
 * retomaria as pendentes pela mesma chave. O vigia da sessão
 * (`session-reconciler.ts`) não as pega: só chama `/api/sendText` e pula a mensagem
 * com `body` nulo — que é o que uma foto sem legenda é. As duas fotos ficavam presas
 * para sempre, e o job concluía normalmente.
 *
 * Agora o teto vale só para intenção NOVA. Com o teto cheio e pendência da
 * recuperação por retomar (`porRetomar`), a ferramenta planeja as mensagens físicas
 * do envio e pergunta ao ledger quais ele já conhece (`conteudoRegistradoNoJob`,
 * agora também pelo recibo legado de foto e template): as conhecidas saem — retomada
 * ou confirmação, pela mesma chave —, as novas ficam de fora com aviso ao modelo, e
 * um envio sem nada conhecido é recusado como sempre. Esvaziado o `porRetomar`, o
 * teto cheio recusa de cara, sem consulta. `enviarComFotos` ganhou a mesma sonda
 * (`jaRegistrada`) para a foto conhecida que vem depois de o teto fechar no meio do
 * envio. A prova no turno inteiro, com Postgres real, está em
 * `tests/invariants/c01-recuperacao-com-falha-na-posicao-1.test.ts`.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  enviarComFotos,
  LIMITE_DA_LEGENDA,
  type FotoParaEnvio,
} from "@/lib/agent-engine/agent/fotos-do-produto";
import { OK_KINDS, sendInBubbles, splitForSend } from "@/lib/agent-engine/agent/split-message";
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

const FOTOS: FotoParaEnvio[] = [1, 2, 3, 4].map((n) => ({
  storagePath: `conversas/x/foto-${n}.jpg`,
  mime: "image/jpeg",
}));
const TRES = FOTOS.slice(0, 3);

type Template = { name: string; language: string; values: Record<string, string> };
const TEMPLATE: Template = { name: "retomada", language: "pt_BR", values: { "1": "Lead" } };
const RENDERIZADO = "Oi Lead, tudo certo?";

type Envio = { body: string; media?: FotoParaEnvio; template?: Template };

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
            type: m.envio.template ? "template" : m.envio.media ? "image" : "text",
            body: m.envio.body === "" && m.envio.media ? null : m.envio.body,
            media_storage_path: m.envio.media?.storagePath ?? null,
            template_name: m.envio.template?.name ?? null,
            template_language: m.envio.template?.language ?? null,
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
  const recibo = (
    seq: number,
    status: string,
    envio: Envio,
    mensagem: string | null,
    hash = hashDoConteudo(envio),
  ) => {
    const linha: LinhaDoLedger = {
      id: randomUUID(),
      organization_id: ORG,
      contact_id: LEAD,
      job_id: JOB,
      seq,
      body_hash: hash,
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
  /** O recibo gravado pela versão do autor: hash só do texto, para foto e template também. */
  const reciboLegado = (seq: number, status: string, envio: Envio, mensagem: string | null) =>
    recibo(seq, status, envio, mensagem, createHash("sha256").update(envio.body).digest("hex"));
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
   * `estadoInicialDoJob`, conta em `seq` uma vez por chave e guarda em `porRetomar` as
   * pendências da recuperação ainda não retomadas; com o teto cheio, `send_message` e
   * `send_template` só deixam passar o que o ledger já conhece. `antiga` é o defeito,
   * documentado: a pré-checagem recusava por teto antes de consultar o ledger, e
   * `enviarComFotos` não tinha a sonda.
   */
  const turno = async (antiga = false) => {
    const estado = await estadoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    let { posicao } = estado;
    let seq = estado.enviadas;
    const contadas = new Set<string>(estado.pendentes);
    const porRetomar = new Set<string>(estado.pendentes);
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
      porRetomar.delete(r.idempotencyKey);
      saidas.push(r);
      return r;
    };
    const tetoCheio = () => seq >= TETO;
    const conhecido = (envio: Envio) =>
      conteudoRegistradoNoJob(db, { tenantId: ORG, jobId: JOB, ...envio });
    const recusa = { status: "recusado:max_sends_per_turn" };
    /** O plano do `send_message` com o teto cheio (ver `planejarRetomada` no turno). */
    const planejar = async (texto: string, fotos: readonly FotoParaEnvio[]) => {
      const naturais = splitForSend(texto, true, 600);
      const bolhas: Envio[] = (naturais.length === 0 ? [texto] : naturais).map((body) => ({
        body,
      }));
      const [capa, ...demais] = fotos;
      const plano: Envio[] =
        capa === undefined
          ? bolhas
          : texto.length <= LIMITE_DA_LEGENDA
            ? [{ body: texto, media: capa }, ...demais.map((media) => ({ body: "", media }))]
            : [...bolhas, ...fotos.map((media) => ({ body: "", media }))];
      const conhecidas: Envio[] = [];
      let novas = 0;
      for (const m of plano) {
        if (await conhecido(m)) conhecidas.push(m);
        else novas += 1;
      }
      return { conhecidas, novas };
    };
    const sendMessage = async (
      body: string,
      fotos: readonly FotoParaEnvio[] = [],
    ): Promise<{ status: string; aviso?: string }> => {
      if (tetoCheio() && (antiga || porRetomar.size === 0)) return recusa;
      const retomada = tetoCheio() ? await planejar(body, fotos) : null;
      if (retomada !== null && retomada.conhecidas.length === 0) return recusa;
      let r: SendOutcome | undefined;
      if (retomada !== null) {
        for (const m of retomada.conhecidas) {
          r = await enviar(m);
          if (!OK_KINDS.has(r.kind)) break;
        }
      } else {
        r = await enviarComFotos(body, fotos, {
          sleep: async () => {},
          jitter: () => 0,
          restantes: () => TETO - seq,
          ...(antiga
            ? {}
            : {
                jaRegistrada: (foto: FotoParaEnvio, legenda: string) =>
                  conhecido({ body: legenda, media: foto }),
              }),
          enviarFoto: (foto, legenda) => enviar({ body: legenda, media: foto }),
          enviarTexto: (texto) =>
            sendInBubbles(texto, {
              enabled: true,
              maxChars: 600,
              maxBubbles: Math.max(1, TETO - seq),
              jaRegistrada: (bolha: string) => conhecido({ body: bolha }),
              sleep: async () => {},
              jitter: () => 0,
              send: (bolha: string) => enviar({ body: bolha }),
            }),
        });
      }
      return {
        status: r!.kind,
        ...(retomada !== null && retomada.novas > 0
          ? { aviso: `${retomada.novas} parte(s) nova(s) desta resposta NÃO saíram` }
          : {}),
      };
    };
    const sendTemplate = async (template: Template, rendered: string): Promise<string> => {
      if (tetoCheio() && (antiga || porRetomar.size === 0)) return recusa.status;
      if (tetoCheio() && !(await conhecido({ body: rendered, template }))) return recusa.status;
      return (await enviar({ body: rendered, template })).kind;
    };
    return {
      estado,
      saidas,
      sendMessage,
      sendTemplate,
      seq: () => seq,
      posicao: () => posicao,
      porRetomar,
    };
  };
  return {
    db,
    ledger,
    messages,
    handler,
    recibo,
    reciboLegado,
    turno,
    reavaliarComo: (f: (status: string) => string) => {
      aoReavaliar = f;
    },
  };
}

const chaves = (saidas: SendOutcome[]) => saidas.map((s) => s.idempotencyKey);
const RECUSA = { status: "recusado:max_sends_per_turn" };

describe("(C01) `conteudoRegistradoNoJob` reconhece foto e template — pelo hash novo e pelo recibo legado", () => {
  const consulta = (banco: ReturnType<typeof bancoFalso>, envio: Envio) =>
    conteudoRegistradoNoJob(banco.db, { tenantId: ORG, jobId: JOB, ...envio });

  it("foto aceita, foto pendente e template pendente: conhecidos; outra foto, outra legenda, outros valores: não", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "accepted", { body: T, media: FOTOS[0]! }, "sent");
    banco.recibo(2, "queued", { body: "", media: FOTOS[1]! }, "queued");
    banco.recibo(3, "queued", { body: RENDERIZADO, template: TEMPLATE }, "queued");
    expect(await consulta(banco, { body: T, media: FOTOS[0]! })).toBe(true);
    expect(await consulta(banco, { body: "", media: FOTOS[1]! })).toBe(true);
    expect(await consulta(banco, { body: RENDERIZADO, template: TEMPLATE })).toBe(true);
    expect(await consulta(banco, { body: "", media: FOTOS[2]! })).toBe(false);
    expect(await consulta(banco, { body: "", media: FOTOS[0]! })).toBe(false);
    expect(await consulta(banco, { body: T })).toBe(false);
    expect(
      await consulta(banco, {
        body: "Oi Outro, tudo certo?",
        template: { ...TEMPLATE, values: { "1": "Outro" } },
      }),
    ).toBe(false);
  });

  it("recibo LEGADO (hash só do texto) de foto e de template, confirmado pela mensagem gravada: conhecido — como `sendWithLedger` o retoma", async () => {
    const banco = bancoFalso();
    banco.reciboLegado(1, "queued", { body: "", media: FOTOS[1]! }, "queued");
    banco.reciboLegado(2, "accepted", { body: RENDERIZADO, template: TEMPLATE }, "sent");
    expect(await consulta(banco, { body: "", media: FOTOS[1]! })).toBe(true);
    expect(await consulta(banco, { body: RENDERIZADO, template: TEMPLATE })).toBe(true);
    // O mesmo hash legado, outra foto: a mensagem gravada desmente — não é ela.
    expect(await consulta(banco, { body: "", media: FOTOS[2]! })).toBe(false);
    // Outro texto: nada.
    expect(await consulta(banco, { body: D })).toBe(false);
  });

  it("recibo legado sem mensagem gravada não confirma nada", async () => {
    const banco = bancoFalso();
    banco.reciboLegado(1, "requested", { body: "", media: FOTOS[1]! }, null);
    expect(await consulta(banco, { body: "", media: FOTOS[1]! })).toBe(false);
  });
});

describe("(C01) o cenário do Codex: 1 foto aceita (com a legenda), 2 fotos `queued` sem legenda, teto 3", () => {
  const cenario = (banco: ReturnType<typeof bancoFalso>) => {
    banco.recibo(1, "accepted", { body: T, media: FOTOS[0]! }, "sent");
    const k2 = banco.recibo(2, "queued", { body: "", media: FOTOS[1]! }, "queued").id;
    const k3 = banco.recibo(3, "queued", { body: "", media: FOTOS[2]! }, "queued").id;
    return { k2, k3 };
  };

  it("a re-execução retoma as duas pendentes pela mesma chave; nada novo sai; a 4ª mensagem é recusada por teto", async () => {
    const banco = bancoFalso();
    const { k2, k3 } = cenario(banco);
    const t = await banco.turno();
    // A recuperação conta as três: o teto está cheio ANTES do primeiro envio.
    expect(t.estado).toEqual({ posicao: 1, enviadas: 3, pendentes: [k2, k3], falhadas: [] });

    // O modelo regenera a mesma resposta: texto + as três fotos.
    expect(await t.sendMessage(T, TRES)).toEqual({ status: "sent" });
    // Foto 1 confirmada (já aceita); fotos 2 e 3 RETOMADAS, com a chave de cada recibo.
    expect(t.saidas.map((s) => s.kind)).toEqual(["already_sent", "sent", "sent"]);
    expect(chaves(t.saidas).slice(1)).toEqual([k2, k3]);
    // O CRM só foi acionado para reavaliar as duas mensagens que já tinha.
    expect(banco.handler.mock.calls.map((c) => [c[0], c[2].media?.storagePath])).toEqual([
      [k2, FOTOS[1]!.storagePath],
      [k3, FOTOS[2]!.storagePath],
    ]);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(banco.messages).toHaveLength(3);
    expect(banco.messages.map((m) => m.status)).toEqual(["sent", "sent", "sent"]);
    // Nenhuma posição nova, nenhuma contagem nova; as pendências foram todas retomadas.
    expect(t.seq()).toBe(TETO);
    expect(t.porRetomar.size).toBe(0);
    // A 4ª mensagem é intenção nova: recusada de cara, sem tocar o canal.
    expect(await t.sendMessage(D)).toEqual(RECUSA);
    expect(banco.handler).toHaveBeenCalledTimes(2);
  });

  it("a resposta regenerada traz uma 4ª foto nova: as pendentes saem, a nova fica de fora e o modelo é avisado", async () => {
    const banco = bancoFalso();
    const { k2, k3 } = cenario(banco);
    const t = await banco.turno();
    const r = await t.sendMessage(T, FOTOS);
    expect(r.status).toBe("sent");
    expect(r.aviso).toMatch(/^1 parte\(s\) nova\(s\)/);
    expect(chaves(t.saidas).slice(1)).toEqual([k2, k3]);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(banco.messages).toHaveLength(3);
    expect(banco.handler.mock.calls.map((c) => c[2].media?.storagePath)).not.toContain(
      FOTOS[3]!.storagePath,
    );
  });

  it("nada conhecido com o teto cheio: recusa sem tocar o canal — e as pendências continuam à espera de quem as retome", async () => {
    const banco = bancoFalso();
    const { k2, k3 } = cenario(banco);
    const t = await banco.turno();
    // O modelo regenerou OUTRO texto, sem as fotos: intenção nova.
    expect(await t.sendMessage(D)).toEqual(RECUSA);
    expect(banco.handler).not.toHaveBeenCalled();
    expect([...t.porRetomar]).toEqual([k2, k3]);
    // Na mesma execução, a resposta certa ainda retoma as duas.
    expect(await t.sendMessage(T, TRES)).toEqual({ status: "sent" });
    expect(chaves(t.saidas).slice(1)).toEqual([k2, k3]);
  });

  it("outro texto, mas as mesmas fotos: as duas pendentes saem (a identidade delas é a foto sem legenda); a capa com a legenda nova fica de fora, com aviso", async () => {
    const banco = bancoFalso();
    const { k2, k3 } = cenario(banco);
    const t = await banco.turno();
    const r = await t.sendMessage(D, TRES);
    expect(r.status).toBe("sent");
    expect(r.aviso).toMatch(/^1 parte\(s\) nova\(s\)/);
    expect(chaves(t.saidas)).toEqual([k2, k3]);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(banco.messages).toHaveLength(3);
  });

  it("o canal continua segurando as duas (`queued` de novo): retomadas e contadas uma vez; a 4ª segue recusada", async () => {
    const banco = bancoFalso();
    const { k2, k3 } = cenario(banco);
    banco.reavaliarComo(() => "queued");
    const t = await banco.turno();
    expect(await t.sendMessage(T, TRES)).toEqual({ status: "queued" });
    expect(chaves(t.saidas).slice(1)).toEqual([k2, k3]);
    expect(t.seq()).toBe(TETO);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "accepted"],
      [2, "queued"],
      [3, "queued"],
    ]);
    expect(await t.sendMessage(D)).toEqual(RECUSA);
  });

  it("o defeito, documentado: a pré-checagem antiga recusava antes de consultar o ledger e as duas fotos ficavam presas, com o job concluindo normalmente", async () => {
    const banco = bancoFalso();
    cenario(banco);
    const t = await banco.turno(true);
    expect(await t.sendMessage(T, TRES)).toEqual(RECUSA);
    expect(banco.handler).not.toHaveBeenCalled();
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "accepted"],
      [2, "queued"],
      [3, "queued"],
    ]);
  });
});

describe("(C01) o mesmo para o template pendente e para as bolhas de texto", () => {
  it("A e B aceitas, template na fila (teto 3): o template é retomado pela mesma chave; outros valores são recusados; esvaziada a lista, recusa de cara", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "accepted", { body: A }, "sent");
    banco.recibo(2, "accepted", { body: B }, "sent");
    const k = banco.recibo(3, "queued", { body: RENDERIZADO, template: TEMPLATE }, "queued").id;
    const t = await banco.turno();
    expect(t.estado).toEqual({ posicao: 2, enviadas: 3, pendentes: [k], falhadas: [] });

    // O template com OUTROS valores é intenção nova: recusado, sem tocar o canal.
    const outro = { ...TEMPLATE, values: { "1": "Outro" } };
    expect(await t.sendTemplate(outro, "Oi Outro, tudo certo?")).toBe(RECUSA.status);
    expect(banco.handler).not.toHaveBeenCalled();
    // O mesmo template: retomado.
    expect(await t.sendTemplate(TEMPLATE, RENDERIZADO)).toBe("sent");
    expect(chaves(t.saidas)).toEqual([k]);
    expect(banco.handler.mock.calls.map((c) => [c[0], c[2].template?.name])).toEqual([
      [k, "retomada"],
    ]);
    expect(banco.ledger.map((l) => [l.seq, l.status])).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(t.seq()).toBe(TETO);
    // Sem pendência por retomar, o teto cheio recusa de cara — inclusive o MESMO
    // template de novo (já saiu; o modelo não tem o que retomar).
    expect(await t.sendTemplate(TEMPLATE, RENDERIZADO)).toBe(RECUSA.status);
    expect(banco.handler).toHaveBeenCalledTimes(1);
  });

  it("o defeito, documentado: o template pendente era recusado por teto e ficava na fila", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "accepted", { body: A }, "sent");
    banco.recibo(2, "accepted", { body: B }, "sent");
    banco.recibo(3, "queued", { body: RENDERIZADO, template: TEMPLATE }, "queued");
    const t = await banco.turno(true);
    expect(await t.sendTemplate(TEMPLATE, RENDERIZADO)).toBe(RECUSA.status);
    expect(banco.handler).not.toHaveBeenCalled();
  });

  it("A aceita, B e C na fila (teto 3): a re-execução retoma B e C; a bolha nova D fica de fora, com aviso", async () => {
    const banco = bancoFalso();
    banco.recibo(1, "accepted", { body: A }, "sent");
    const kB = banco.recibo(2, "queued", { body: B }, "queued").id;
    const kC = banco.recibo(3, "queued", { body: C }, "queued").id;
    const t = await banco.turno();
    expect(t.estado.enviadas).toBe(3);
    const r = await t.sendMessage(`${A}\n\n${B}\n\n${C}\n\n${D}`);
    expect(r.status).toBe("sent");
    expect(r.aviso).toMatch(/^1 parte\(s\) nova\(s\)/);
    expect(t.saidas.map((s) => s.kind)).toEqual(["already_sent", "sent", "sent"]);
    expect(chaves(t.saidas).slice(1)).toEqual([kB, kC]);
    expect(banco.messages.map((m) => m.envio.body)).toEqual([A, B, C]);
    expect(banco.messages.map((m) => m.status)).toEqual(["sent", "sent", "sent"]);
    expect(t.seq()).toBe(TETO);
  });

  it("sem pendente nenhum, nada muda: o teto cheio recusa de cara, e o que cabe sai como sempre", async () => {
    const banco = bancoFalso();
    const t = await banco.turno();
    expect(t.estado).toEqual({ posicao: 0, enviadas: 0, pendentes: [], falhadas: [] });
    expect(await t.sendMessage(T, TRES)).toEqual({ status: "sent" });
    expect(banco.messages).toHaveLength(3);
    expect(t.seq()).toBe(TETO);
    expect(await t.sendMessage(D)).toEqual(RECUSA);
    // Nem o que já saiu passa de novo: sem pendência, a consulta ao ledger não acontece.
    expect(await t.sendMessage(T, TRES)).toEqual(RECUSA);
    expect(banco.handler).toHaveBeenCalledTimes(3);
  });
});

describe("(C01) `enviarComFotos` com a sonda: a foto conhecida passa sem vaga no teto", () => {
  type Saida = { kind: string; foto?: string; legenda?: string; texto?: string };
  const monta = (conhecidas: readonly string[], vagas: number, sonda = true) => {
    const enviados: Saida[] = [];
    const opts = {
      sleep: async () => {},
      jitter: () => 0,
      restantes: () => vagas - enviados.length,
      enviarFoto: async (foto: FotoParaEnvio, legenda: string) => {
        enviados.push({ kind: "sent", foto: foto.storagePath, legenda });
        return { kind: "sent" };
      },
      enviarTexto: async (texto: string) => {
        enviados.push({ kind: "sent", texto });
        return { kind: "sent" };
      },
      ...(sonda
        ? { jaRegistrada: async (foto: FotoParaEnvio) => conhecidas.includes(foto.storagePath) }
        : {}),
    };
    return { enviados, opts };
  };

  it("teto fecha depois da capa; a foto 2 é nova (fica de fora) e a 3 é conhecida (sai, retomando a chave)", async () => {
    const { enviados, opts } = monta([FOTOS[2]!.storagePath], 1);
    const r = await enviarComFotos(T, TRES, opts);
    expect(r.kind).toBe("sent");
    expect(enviados).toEqual([
      { kind: "sent", foto: FOTOS[0]!.storagePath, legenda: T },
      { kind: "sent", foto: FOTOS[2]!.storagePath, legenda: "" },
    ]);
  });

  it("sem a sonda (o comportamento do autor), a primeira foto que não cabe encerra o envio — a 3 não sai", async () => {
    const { enviados, opts } = monta([FOTOS[2]!.storagePath], 1, false);
    await enviarComFotos(T, TRES, opts);
    expect(enviados).toEqual([{ kind: "sent", foto: FOTOS[0]!.storagePath, legenda: T }]);
  });

  it("com vaga para todas, a sonda não muda nada: as três saem, na ordem", async () => {
    const { enviados, opts } = monta([FOTOS[2]!.storagePath], 3);
    await enviarComFotos(T, TRES, opts);
    expect(enviados.map((e) => e.foto)).toEqual(TRES.map((f) => f.storagePath));
  });

  it("sem vaga nenhuma desde o início, só o texto sai (como no teste do autor): a entrada com o teto cheio é da retomada do turno", async () => {
    const { enviados, opts } = monta(
      TRES.map((f) => f.storagePath),
      0,
    );
    await enviarComFotos(T, TRES, opts);
    expect(enviados).toEqual([{ kind: "sent", texto: T }]);
  });

  it("para no primeiro desfecho que não é de sucesso, com ou sem vaga", async () => {
    const { enviados, opts } = monta(
      TRES.map((f) => f.storagePath),
      0,
    );
    let n = 0;
    const r = await enviarComFotos(T, TRES, {
      ...opts,
      restantes: () => 3,
      enviarFoto: async (foto: FotoParaEnvio, legenda: string) => {
        n += 1;
        enviados.push({ kind: n === 2 ? "failed" : "sent", foto: foto.storagePath, legenda });
        return { kind: n === 2 ? "failed" : "sent" };
      },
    });
    expect(r.kind).toBe("failed");
    expect(enviados).toHaveLength(2);
  });
});

describe("(C01) a ligação no turno, no envio com fotos e no ledger", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const FOTOS_TS = readFileSync("lib/agent-engine/agent/fotos-do-produto.ts", "utf8");
  const LEDGER = readFileSync("lib/agent-engine/edge/crm/send-ledger.ts", "utf8");
  const VIGIA = readFileSync("lib/agent-engine/edge/crm/session-reconciler.ts", "utf8");

  it("o turno guarda as pendências por retomar e as risca no ponto comum do envio", () => {
    expect(TURNO).toMatch(/const porRetomar = new Set<string>\(estadoInicial\.pendentes\);/);
    expect(TURNO).toMatch(
      /if \(contaNoTeto\(resultado\)\) seq \+= 1;\s*\}[\s\S]{0,200}?if \(resultado\.kind !== 'unavailable'\) porRetomar\.delete\(resultado\.idempotencyKey\);/,
    );
  });

  it("as duas ferramentas de envio só recusam de cara sem pendência por retomar; com ela, consultam o ledger antes de recusar", () => {
    expect(TURNO.match(/if \(tetoCheio\(\) && porRetomar\.size === 0\)/g)).toHaveLength(2);
    // send_template: o template renderizado, com nome, idioma e valores (a identidade do ledger).
    expect(TURNO).toMatch(
      /tetoCheio\(\) &&\s*!\(await conhecido\(\{ body: rendered, template: \{ name: template_name, language, values \} \}\)\)/,
    );
    // send_message: o plano depois das fotos, a recusa sem nada conhecido, e o `send` que manda só as conhecidas.
    expect(TURNO).toMatch(
      /const retomada = tetoCheio\(\) \? await planejarRetomada\(body, fotosDoProduto\) : null;\s*if \(retomada !== null && retomada\.conhecidas\.length === 0\) return recusaPorTeto\(\);/,
    );
    expect(TURNO).toMatch(
      /if \(retomada !== null\) return enviarSoAsConhecidas\(retomada\.conhecidas, \{ enviar, sleep, jitter \}\);/,
    );
    // O plano vem DEPOIS de preparar as fotos: elas entram nele.
    expect(TURNO.indexOf("const retomada = tetoCheio()")).toBeGreaterThan(
      TURNO.indexOf("fotosQueFaltaram = preparadas.tinha - preparadas.fotos.length;"),
    );
    // E o modelo é avisado do que ficou de fora.
    expect(TURNO).toMatch(
      /retomada !== null && retomada\.novas > 0 \? \[avisoDaRetomada\(retomada\.novas\)\]/,
    );
  });

  it("o plano reproduz `enviarComFotos`: legenda na capa e demais sem legenda; texto acima do teto de legenda sai em bolhas e todas as fotos sem legenda", () => {
    expect(TURNO).toMatch(
      /texto\.length <= LIMITE_DA_LEGENDA\s*\? \[\{ body: texto, media: capa \}, \.\.\.demais\.map\(\(media\) => \(\{ body: '', media \}\)\)\]\s*: \[\.\.\.bolhas, \.\.\.fotos\.map\(\(media\) => \(\{ body: '', media \}\)\)\];/,
    );
    expect(FOTOS_TS).toMatch(/const legendaCabe = body\.length <= LIMITE_DA_LEGENDA;/);
    expect(FOTOS_TS).toMatch(/for \(const foto of legendaCabe \? demais : fotos\)/);
  });

  it("`enviarComFotos` recebe a sonda do turno e deixa a foto conhecida passar sem vaga", () => {
    expect(TURNO).toMatch(
      /restantes: \(\) => maxSendsPerTurn - seq,[\s\S]{0,400}?jaRegistrada: \(foto, legenda\) => conhecido\(\{ body: legenda, media: foto \}\)/,
    );
    expect(FOTOS_TS).toMatch(
      /jaRegistrada\?: \(foto: FotoParaEnvio, legenda: string\) => Promise<boolean>;/,
    );
    expect(FOTOS_TS).toMatch(
      /if \(!cabeMaisUma\(\) && !\(await conhecida\(foto, ''\)\)\) continue;/,
    );
  });

  it("`conteudoRegistradoNoJob` consulta também o recibo legado, nos três status que `sendWithLedger` reconhece", () => {
    expect(LEDGER).toMatch(
      /return \(await reciboLegado\(store, intent, \["accepted", "requested", "queued"\]\)\) !== null;/,
    );
  });

  it("o fato que torna a correção necessária: o vigia da sessão pula a mensagem sem corpo e só reenvia texto", () => {
    // Se o autor ensinar o vigia a reenviar foto, esta correção perde a urgência,
    // não a razão: a retomada pela mesma chave continua sendo o caminho sem duplicata.
    expect(VIGIA).toMatch(
      /if \(chatId === null \|\| m\.body === null\) \{\s*log\.warn\('watchdog: queued sem destino\/corpo — pulada'/,
    );
    expect(VIGIA).toMatch(/\/api\/sendText/);
    expect(VIGIA).not.toMatch(/\/api\/sendImage/);
  });
});
