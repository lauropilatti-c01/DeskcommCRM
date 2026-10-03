/**
 * (C01) A IDENTIDADE DO ENVIO NO LEDGER É O TEXTO ANTES DA EMENDA DA APRESENTAÇÃO —
 * achado 3 (médio) da quinta revisão adversarial do Codex (03/10/2026) sobre a
 * recuperação pelo `send_ledger` (rodada 6, correção 2).
 *
 * A apresentação automática (`disclosureGate`, modo `inject`) emenda a 1ª mensagem ao
 * lead: `prependDisclosure` põe o template na frente do corpo, separado por linha em
 * branco. A emenda depende de um estado que o próprio envio muda — "é o 1º outbound"
 * é `send_ledger` sem recibo aceito para o contato. O hash do ledger era do corpo
 * ENTREGUE (pós-cadeia): na re-execução do job, com o envio já aceito, a cadeia não
 * emenda, o corpo entregue é outro, o hash não casava com o recibo, a posição avançava
 * e a resposta saía de novo. Na `main` o replay por posição reaproveitava o recibo.
 *
 * Agora quem monta o envio declara a identidade (`Intent.identidade`): o turno sabe com
 * que corpo a cadeia começou (o texto do modelo com os ajustes de estilo da organização,
 * pelas mesmas duas funções que a cadeia usa — `comoACadeiaComeca`) e, para cada
 * mensagem física, tira a emenda que `finalBody` tem a mais (`identidadeDoEnvio`). O
 * hash é da identidade; o canal recebe o corpo emendado. Fatiada em bolhas, a
 * apresentação vira bolha própria e fica como está. A cadeia (`before-send.ts`) não
 * mudou. A prova no turno inteiro, com Postgres real e a cadeia de verdade, está em
 * `tests/invariants/c01-recuperacao-com-falha-na-posicao-1.test.ts` (rodada 6, 2).
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { FotoParaEnvio } from "@/lib/agent-engine/agent/fotos-do-produto";
import { OK_KINDS, splitForSend } from "@/lib/agent-engine/agent/split-message";
import {
  conteudoRegistradoNoJob,
  estadoInicialDoJob,
  hashDoConteudo,
  pgSendLedger,
  sendWithLedger,
  type SendOutcome,
} from "@/lib/agent-engine/edge/crm/send-ledger";
import { aplicarAjustesDeEstilo } from "@/lib/agent-engine/guardrails/ajustes-de-estilo-da-org";
import {
  bodyContainsDisclosure,
  prependDisclosure,
} from "@/lib/agent-engine/guardrails/disclosure/template";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const JOB = "44444444-4444-4444-8444-444444444444";
const TETO = 3;

const APRESENTACAO = "Olá! Eu sou a assistente virtual da C01.";
const A = "Oi! Vi que você perguntou sobre o plano.";
const B = "Ele inclui o material e o acesso à plataforma.";
const C = "Quer que eu te mande o link para começar?";
const COM_TRAVESSAO = "O plano inclui o material — e o acesso à plataforma.";

const FOTOS: FotoParaEnvio[] = [1, 2].map((n) => ({
  storagePath: `conversas/x/foto-${n}.jpg`,
  mime: "image/jpeg",
}));

type Envio = { body: string; media?: FotoParaEnvio; identidade?: string };

/**
 * Espelho de `identidadeDoEnvio` (inbound-turn.ts). O texto é conferido contra a
 * fonte nos pins, mais abaixo: mudou lá, muda aqui.
 */
const identidadeDoEnvio = (
  corpo: string,
  finalBody: string,
  antes: string,
): { identidade?: string } => {
  if (finalBody === antes || !finalBody.endsWith(antes)) return {};
  const emenda = finalBody.slice(0, finalBody.length - antes.length);
  if (!corpo.startsWith(emenda) || corpo.length === emenda.length) return {};
  return { identidade: corpo.slice(emenda.length) };
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
            body: m.envio.body === "" && m.envio.media ? null : m.envio.body,
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
  /** O que o CRM responde quando o handler reavalia uma mensagem já gravada (`queued` → `sent`). */
  let aoReavaliar: (status: string) => string = () => "sent";
  /** O status com que o CRM grava uma mensagem NOVA (`sent` por padrão; `queued` = segurou). */
  let aoGravar = "sent";
  const handler = vi.fn(async (key: string, messageId: string, envio: Envio) => {
    const existente = messages.find((m) => m.idempotency_key === key);
    if (existente) {
      existente.status = aoReavaliar(existente.status);
      return { id: existente.id, status: existente.status };
    }
    messages.push({ id: messageId, status: aoGravar, idempotency_key: key, envio });
    return { id: messageId, status: aoGravar };
  });
  /** "1º outbound ao contato", como `countPriorAcceptedSends`: nenhum recibo aceito do contato. */
  const primeiroOutbound = () =>
    !ledger.some(
      (l) => l.organization_id === ORG && l.contact_id === LEAD && l.status === "accepted",
    );
  /**
   * Uma execução do turno, como `inbound-turn.ts` agora faz: a cadeia de envio emenda a
   * apresentação na 1ª mensagem ao lead (`disclosureGate`, `inject`), o `send` fatia o
   * corpo emendado em bolhas (ou o põe na legenda da capa) e cada mensagem física vai ao
   * ledger com a identidade sem a emenda. `antiga` é o defeito, documentado: a identidade
   * era o corpo entregue.
   */
  const execucao = async (o: {
    textos: readonly string[];
    fotos?: readonly FotoParaEnvio[];
    fatiar?: boolean;
    ajustes?: { sem_travessao_longo: boolean };
    antiga?: boolean;
  }) => {
    const estado = await estadoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    let { posicao } = estado;
    let seq = estado.enviadas;
    const contadas = new Set<string>(estado.pendentes);
    const saidas: Array<SendOutcome & { corpo: string }> = [];
    const enviar = async (envio: Envio): Promise<SendOutcome> => {
      posicao += 1;
      const r = await sendWithLedger(
        store,
        { tenantId: ORG, leadId: LEAD, jobId: JOB, seq: posicao, ...envio },
        (key, id) => handler(key, id, envio),
      );
      if (r.kind === "already_sent") posicao -= 1;
      else if (!contadas.has(r.idempotencyKey)) {
        contadas.add(r.idempotencyKey);
        seq += 1;
      }
      saidas.push({ ...r, corpo: envio.body });
      return r;
    };
    const ajustes = o.ajustes ?? { sem_travessao_longo: false };
    const comoACadeiaComeca = (textoDoModelo: string) =>
      aplicarAjustesDeEstilo(textoDoModelo, ajustes);
    const identidade = (corpo: string, finalBody: string, antes: string) =>
      o.antiga ? {} : identidadeDoEnvio(corpo, finalBody, antes);
    const resultados: string[] = [];
    for (const textoDoModelo of o.textos) {
      if (seq >= TETO) {
        resultados.push("recusado:max_sends_per_turn");
        continue;
      }
      // A cadeia: ajustes de estilo, depois os gates; o da apresentação emenda a 1ª.
      const antes = comoACadeiaComeca(textoDoModelo);
      const finalBody =
        primeiroOutbound() && !bodyContainsDisclosure(antes, APRESENTACAO)
          ? prependDisclosure(antes, APRESENTACAO)
          : antes;
      // O `send`: a legenda na capa e as demais fotos sem legenda, ou as bolhas do texto.
      const [capa, ...demais] = o.fotos ?? [];
      let ultimo: SendOutcome | undefined;
      if (capa !== undefined) {
        ultimo = await enviar({
          body: finalBody,
          media: capa,
          ...identidade(finalBody, finalBody, antes),
        });
        for (const foto of demais) {
          if (!OK_KINDS.has(ultimo.kind) || seq >= TETO) break;
          ultimo = await enviar({ body: "", media: foto, ...identidade("", finalBody, antes) });
        }
      } else {
        const bolhas = splitForSend(finalBody, o.fatiar ?? false, 600, Math.max(1, TETO - seq));
        for (const bolha of bolhas) {
          ultimo = await enviar({ body: bolha, ...identidade(bolha, finalBody, antes) });
          if (!OK_KINDS.has(ultimo.kind)) break;
        }
      }
      resultados.push(
        ultimo === undefined ? "nada" : ultimo.kind === "failed" ? "envio_falhou" : "enviada",
      );
    }
    return { saidas, resultados, seq, posicao };
  };
  return {
    db,
    ledger,
    messages,
    handler,
    execucao,
    segurarAsNovas: () => {
      aoGravar = "queued";
    },
    aoReavaliar: (f: (status: string) => string) => {
      aoReavaliar = f;
    },
  };
}

const sha256 = (texto: string) => createHash("sha256").update(texto).digest("hex");
const EMENDADO = prependDisclosure(A, APRESENTACAO);

describe("(C01) `hashDoConteudo` com `identidade`", () => {
  it("texto: a identidade substitui o corpo no hash — o recibo do corpo emendado é o do texto do modelo", () => {
    expect(EMENDADO).toBe(`${APRESENTACAO}\n\n${A}`);
    expect(hashDoConteudo({ body: EMENDADO, identidade: A })).toBe(hashDoConteudo({ body: A }));
    expect(hashDoConteudo({ body: EMENDADO, identidade: A })).not.toBe(
      hashDoConteudo({ body: EMENDADO }),
    );
  });

  it("foto: a mídia continua no hash; a identidade entra no lugar da legenda entregue", () => {
    expect(hashDoConteudo({ body: EMENDADO, media: FOTOS[0], identidade: A })).toBe(
      hashDoConteudo({ body: A, media: FOTOS[0] }),
    );
    expect(hashDoConteudo({ body: EMENDADO, media: FOTOS[0], identidade: A })).not.toBe(
      hashDoConteudo({ body: EMENDADO, media: FOTOS[1], identidade: A }),
    );
  });

  it("sem identidade: o hash de sempre (texto puro = sha256 do corpo; os recibos já gravados continuam válidos)", () => {
    expect(hashDoConteudo({ body: A })).toBe(sha256(A));
    expect(hashDoConteudo({ body: A, identidade: undefined })).toBe(sha256(A));
  });

  it("`conteudoRegistradoNoJob` aceita a identidade: a sonda das bolhas pergunta pelo mesmo hash que o envio grava", async () => {
    const banco = bancoFalso();
    await banco.execucao({ textos: [A] });
    expect(banco.ledger.map((l) => l.body_hash)).toEqual([sha256(A)]);
    // A bolha entregue foi o corpo emendado; perguntar por ele com a identidade acha o recibo.
    await expect(
      conteudoRegistradoNoJob(banco.db, {
        tenantId: ORG,
        jobId: JOB,
        body: EMENDADO,
        identidade: A,
      }),
    ).resolves.toBe(true);
    await expect(
      conteudoRegistradoNoJob(banco.db, { tenantId: ORG, jobId: JOB, body: A }),
    ).resolves.toBe(true);
    // Sem a identidade, o corpo emendado não é conhecido: é o que acontecia antes.
    await expect(
      conteudoRegistradoNoJob(banco.db, { tenantId: ORG, jobId: JOB, body: EMENDADO }),
    ).resolves.toBe(false);
  });
});

describe("(C01) `identidadeDoEnvio`: a emenda que o corpo entregue tem a mais que o corpo com que a cadeia começou", () => {
  it("sem emenda, nada a declarar: a identidade é o corpo entregue, como sempre", () => {
    expect(identidadeDoEnvio(A, A, A)).toEqual({});
  });

  it("mensagem única emendada (sem fatiamento, ou a legenda da capa): a identidade é o texto do modelo", () => {
    expect(identidadeDoEnvio(EMENDADO, EMENDADO, A)).toEqual({ identidade: A });
  });

  it("fatiada em bolhas: a apresentação é bolha própria e fica como está; a do texto também não muda", () => {
    const bolhas = splitForSend(EMENDADO, true, 600);
    expect(bolhas).toEqual([APRESENTACAO, A]);
    expect(identidadeDoEnvio(APRESENTACAO, EMENDADO, A)).toEqual({});
    expect(identidadeDoEnvio(A, EMENDADO, A)).toEqual({});
  });

  it("bolha única do teto (as bolhas juntas na frente da emenda): a identidade é o texto do modelo inteiro", () => {
    const texto = `${A}\n\n${B}\n\n${C}`;
    const emendado = prependDisclosure(texto, APRESENTACAO);
    // Com uma vaga só, `splitForSend` junta tudo numa bolha — a emenda vai junto.
    expect(splitForSend(emendado, true, 600, 1)).toEqual([emendado]);
    expect(identidadeDoEnvio(emendado, emendado, texto)).toEqual({ identidade: texto });
    // Com duas vagas, a apresentação sai sozinha e o resto junto: nenhuma emenda nas duas.
    const [primeira, segunda] = splitForSend(emendado, true, 600, 2);
    expect(primeira).toBe(APRESENTACAO);
    expect(segunda).toBe(texto);
    expect(identidadeDoEnvio(primeira!, emendado, texto)).toEqual({});
    expect(identidadeDoEnvio(segunda!, emendado, texto)).toEqual({});
  });

  it("foto sem legenda depois da capa: a legenda vazia não começa pela emenda — nada a declarar", () => {
    expect(identidadeDoEnvio("", EMENDADO, A)).toEqual({});
  });

  it("o corpo entregue não termina pelo corpo de partida (outra reescrita): nenhuma suposição — a identidade é o entregue", () => {
    expect(identidadeDoEnvio("outro texto", "outro texto", A)).toEqual({});
    expect(identidadeDoEnvio(`${A} e mais`, `${A} e mais`, A)).toEqual({});
  });

  it("a mensagem que é só a emenda não vira identidade vazia", () => {
    expect(identidadeDoEnvio(`${APRESENTACAO}\n\n`, EMENDADO, A)).toEqual({});
  });

  it("com ajustes de estilo da organização, o corpo de partida é o texto ajustado: a identidade é ele (nunca o texto cru)", () => {
    const ajustado = aplicarAjustesDeEstilo(COM_TRAVESSAO, { sem_travessao_longo: true });
    expect(ajustado).not.toBe(COM_TRAVESSAO);
    expect(ajustado).not.toContain("—");
    const emendado = prependDisclosure(ajustado, APRESENTACAO);
    expect(identidadeDoEnvio(emendado, emendado, ajustado)).toEqual({ identidade: ajustado });
    // Partir do texto cru não reconheceria a emenda: o entregue não termina por ele.
    expect(identidadeDoEnvio(emendado, emendado, COM_TRAVESSAO)).toEqual({});
  });
});

describe("(C01) o cenário do Codex, com o ledger real: 1ª resposta com apresentação `inject`, envio aceito, falha antes do checkpoint, re-execução regenera o mesmo texto", () => {
  it("a re-execução reconhece o recibo (`already_sent`): o CRM não é chamado de novo, o ledger não ganha linha, o cliente recebeu a resposta uma vez — com a apresentação", async () => {
    const banco = bancoFalso();
    const primeira = await banco.execucao({ textos: [A] });
    expect(primeira.resultados).toEqual(["enviada"]);
    expect(primeira.saidas.map((s) => [s.kind, s.corpo])).toEqual([["sent", EMENDADO]]);
    expect(banco.handler).toHaveBeenCalledTimes(1);
    expect(banco.messages.map((m) => m.envio.body)).toEqual([EMENDADO]);
    // O recibo é do texto do modelo, não do corpo emendado.
    expect(banco.ledger.map((l) => [l.seq, l.status, l.body_hash])).toEqual([
      [1, "accepted", sha256(A)],
    ]);

    // O job caiu antes do checkpoint; a fila o re-executa, o modelo regenera A.
    const segunda = await banco.execucao({ textos: [A] });
    expect(segunda.resultados).toEqual(["enviada"]);
    expect(segunda.saidas.map((s) => [s.kind, s.corpo])).toEqual([["already_sent", A]]);
    expect(banco.handler).toHaveBeenCalledTimes(1);
    expect(banco.messages).toHaveLength(1);
    expect(banco.ledger).toHaveLength(1);
    // E a posição não avançou: a próxima mensagem nova nasce na 2.
    expect(segunda.posicao).toBe(1);
    expect(segunda.seq).toBe(1);
  });

  it("o defeito, documentado: com a identidade do corpo entregue, a re-execução não acha o recibo e manda a resposta de novo (sem a apresentação)", async () => {
    const banco = bancoFalso();
    await banco.execucao({ textos: [A], antiga: true });
    expect(banco.ledger.map((l) => l.body_hash)).toEqual([sha256(EMENDADO)]);
    const segunda = await banco.execucao({ textos: [A], antiga: true });
    expect(segunda.saidas.map((s) => [s.kind, s.corpo])).toEqual([["sent", A]]);
    expect(banco.handler).toHaveBeenCalledTimes(2);
    expect(banco.messages.map((m) => m.envio.body)).toEqual([EMENDADO, A]);
    expect(banco.ledger.map((l) => l.seq)).toEqual([1, 2]);
  });

  it("com fatiamento: a apresentação saiu como bolha própria e fica; a re-execução reconhece a bolha do texto e não manda nada", async () => {
    const banco = bancoFalso();
    const primeira = await banco.execucao({ textos: [A], fatiar: true });
    expect(primeira.saidas.map((s) => [s.kind, s.corpo])).toEqual([
      ["sent", APRESENTACAO],
      ["sent", A],
    ]);
    expect(banco.ledger.map((l) => [l.seq, l.body_hash])).toEqual([
      [1, sha256(APRESENTACAO)],
      [2, sha256(A)],
    ]);
    const segunda = await banco.execucao({ textos: [A], fatiar: true });
    expect(segunda.saidas.map((s) => [s.kind, s.corpo])).toEqual([["already_sent", A]]);
    expect(banco.handler).toHaveBeenCalledTimes(2);
    expect(banco.ledger).toHaveLength(2);
  });

  it("com fotos: a emenda foi na legenda da capa; a re-execução reconhece a capa e as demais fotos pela mídia e pela identidade", async () => {
    const banco = bancoFalso();
    const primeira = await banco.execucao({ textos: [A], fotos: FOTOS });
    expect(primeira.saidas.map((s) => [s.kind, s.corpo])).toEqual([
      ["sent", EMENDADO],
      ["sent", ""],
    ]);
    expect(banco.ledger.map((l) => l.body_hash)).toEqual([
      hashDoConteudo({ body: A, media: FOTOS[0] }),
      hashDoConteudo({ body: "", media: FOTOS[1] }),
    ]);
    const segunda = await banco.execucao({ textos: [A], fotos: FOTOS });
    expect(segunda.saidas.map((s) => s.kind)).toEqual(["already_sent", "already_sent"]);
    expect(banco.handler).toHaveBeenCalledTimes(2);
    expect(banco.ledger).toHaveLength(2);
  });

  it("a 1ª execução deixou o recibo pendente (o CRM segurou a mensagem): a re-execução ainda é o 1º outbound, emenda de novo, e retoma o MESMO recibo pela mesma chave", async () => {
    const banco = bancoFalso();
    banco.segurarAsNovas();
    const primeira = await banco.execucao({ textos: [A] });
    expect(primeira.saidas.map((s) => s.kind)).toEqual(["queued"]);
    const [recibo] = banco.ledger;
    expect(recibo!.status).toBe("queued");
    expect(recibo!.body_hash).toBe(sha256(A));

    // A sessão voltou; o CRM entrega quando reavaliado.
    banco.aoReavaliar(() => "sent");
    const segunda = await banco.execucao({ textos: [A] });
    expect(segunda.saidas.map((s) => [s.kind, s.corpo, s.idempotencyKey])).toEqual([
      ["sent", EMENDADO, recibo!.id],
    ]);
    expect(banco.ledger).toHaveLength(1);
    expect(banco.ledger[0]!.status).toBe("accepted");
    expect(banco.messages).toHaveLength(1);
  });

  it("com ajustes de estilo ligados (travessão longo → vírgula): a identidade é o texto ajustado nas duas execuções — a re-execução reconhece o recibo", async () => {
    const banco = bancoFalso();
    const ajustes = { sem_travessao_longo: true };
    const ajustado = aplicarAjustesDeEstilo(COM_TRAVESSAO, ajustes);
    const primeira = await banco.execucao({ textos: [COM_TRAVESSAO], ajustes });
    expect(primeira.saidas.map((s) => s.corpo)).toEqual([
      prependDisclosure(ajustado, APRESENTACAO),
    ]);
    expect(banco.ledger.map((l) => l.body_hash)).toEqual([sha256(ajustado)]);
    const segunda = await banco.execucao({ textos: [COM_TRAVESSAO], ajustes });
    expect(segunda.saidas.map((s) => [s.kind, s.corpo])).toEqual([["already_sent", ajustado]]);
    expect(banco.handler).toHaveBeenCalledTimes(1);
  });

  it("segundo turno do mesmo lead (outro job, já há envio aceito): nenhuma emenda, nenhuma identidade declarada — o fluxo de sempre", async () => {
    const banco = bancoFalso();
    await banco.execucao({ textos: [A] });
    // Outro job: o ledger deste job começa vazio, mas o contato já tem envio aceito.
    banco.ledger.forEach((l) => {
      l.job_id = "55555555-5555-4555-8555-555555555555";
    });
    const segundo = await banco.execucao({ textos: [B] });
    expect(segundo.saidas.map((s) => [s.kind, s.corpo])).toEqual([["sent", B]]);
    expect(banco.ledger.find((l) => l.job_id === JOB)!.body_hash).toBe(sha256(B));
  });
});

describe("(C01) a ligação no código", () => {
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const LEDGER = readFileSync("lib/agent-engine/edge/crm/send-ledger.ts", "utf8");
  const ADAPTADOR = readFileSync("lib/agent-engine/channel-adapter.ts", "utf8");
  const ENVIO = readFileSync("lib/agent-engine/edge/crm/send-message.ts", "utf8");
  const CADEIA = readFileSync("lib/agent-engine/guardrails/before-send.ts", "utf8");

  it("o turno tem `identidadeDoEnvio` com este exato corpo (o espelho deste teste)", () => {
    expect(TURNO).toContain(
      [
        "  const identidadeDoEnvio = (corpo: string, finalBody: string, antes: string): { identidade?: string } => {",
        "    if (finalBody === antes || !finalBody.endsWith(antes)) return {};",
        "    const emenda = finalBody.slice(0, finalBody.length - antes.length);",
        "    if (!corpo.startsWith(emenda) || corpo.length === emenda.length) return {};",
        "    return { identidade: corpo.slice(emenda.length) };",
        "  };",
      ].join("\n"),
    );
  });

  it("o corpo com que a cadeia começa é o texto com os ajustes de estilo da organização, pelas mesmas duas funções que a cadeia usa, lidos uma vez por turno", () => {
    expect(TURNO).toMatch(
      /import \{ aplicarAjustesDeEstilo, lerAjustesDeEstiloDaOrg \} from '\.\.\/guardrails\/ajustes-de-estilo-da-org';/,
    );
    expect(TURNO).toContain(
      "const ajustesDeEstilo = (await lerAjustesDeEstiloDaOrg(pool, tenantId)).ajustes;",
    );
    expect(TURNO).toContain(
      "const comoACadeiaComeca = (textoDoModelo: string): string => aplicarAjustesDeEstilo(textoDoModelo, ajustesDeEstilo);",
    );
    // A cadeia: lê os ajustes fora da transação e aplica ao corpo antes dos gates.
    expect(CADEIA).toMatch(
      /import \{ aplicarAjustesDeEstilo, lerAjustesDeEstiloDaOrg \} from '\.\/ajustes-de-estilo-da-org';/,
    );
    expect(CADEIA).toMatch(
      /const bodyDoModelo =\s*estilo !== null \? aplicarAjustesDeEstilo\(args\.body, estilo\.ajustes\) : args\.body;/,
    );
  });

  it("`send_message`: cada mensagem física declara a identidade a partir do corpo entregue à cadeia (o do modelo, ou a frase de espera); a sonda das bolhas usa a mesma", () => {
    expect(TURNO).toContain("let corpoDaCadeia: string = body;");
    expect(TURNO).toMatch(
      /corpoDaCadeia = deps\.knobs\.fraseDeEspera \?\? FRASE_DE_ESPERA_PADRAO;\s*const espera = await runBeforeSend\(\{\s*\.\.\.beforeSendArgs,\s*body: corpoDaCadeia,/,
    );
    expect(TURNO).toMatch(
      /body: corpo,\s*\.\.\.\(media \? \{ media \} : \{\}\),\s*\.\.\.identidadeDoEnvio\(corpo, finalBody, comoACadeiaComeca\(corpoDaCadeia\)\),/,
    );
    expect(TURNO).toContain(
      "conhecido({ body: bolha, ...identidadeDoEnvio(bolha, finalBody, comoACadeiaComeca(corpoDaCadeia)) })",
    );
    // O plano da retomada com o teto cheio parte do mesmo corpo.
    expect(TURNO).toMatch(/const texto = comoACadeiaComeca\(textoDoModelo\);/);
  });

  it("`send_template`: a cadeia começa do renderizado (sem ajustes de estilo); a identidade sai dele", () => {
    expect(TURNO).toMatch(
      /template: \{ name: template_name, language, values \},\s*(?:\/\/[^\n]*\n\s*)*\.\.\.identidadeDoEnvio\(finalBody, finalBody, rendered\),/,
    );
  });

  it("a identidade atravessa o adapter e o `sendTurnMessage` até o ledger, que a prefere ao corpo no hash", () => {
    expect(ADAPTADOR).toMatch(/identidade\?: string;/);
    expect(ENVIO).toMatch(/identidade\?: string;/);
    expect(LEDGER).toMatch(/^  identidade\?: string;$/m);
    expect(LEDGER).toMatch(
      /export function hashDoConteudo\(\s*input: Pick<Intent, "body" \| "template" \| "media" \| "identidade">,\s*\): string \{/,
    );
    expect(LEDGER).toContain('return h.update(input.identidade ?? input.body).digest("hex");');
    expect(LEDGER).toMatch(
      /input: \{ tenantId: string; jobId: string \} & Pick<Intent, "body" \| "media" \| "template" \| "identidade">,/,
    );
  });

  it("os fatos da cadeia que tornam a correção necessária — e a assinatura que ela NÃO mudou", () => {
    // A emenda: o template na frente do corpo, separado por linha em branco.
    expect(CADEIA).toMatch(
      /return \{ pass: true, amendBody: prependDisclosure\(ctx\.body, template\) \};/,
    );
    expect(CADEIA).toMatch(
      /if \(verdict\.amendBody !== undefined\) ctx\.body = verdict\.amendBody;/,
    );
    // Só na 1ª mensagem ao contato — "1ª" é não haver recibo aceito: o próprio envio muda isso.
    expect(CADEIA).toMatch(
      /const isFirstOutbound =\s*disclosure !== null \|\| args\.lgpd !== undefined\s*\? \(await countPriorAcceptedSends\(client, args\.tenantId, args\.leadId\)\) === 0\s*: false;/,
    );
    // O `send` da cadeia recebe só o corpo final: a identidade é calculada por quem o monta.
    expect(CADEIA).toMatch(/^  send: \(body: string\) => Promise<ChannelSendResult>;$/m);
    expect(CADEIA).toMatch(/const outcome = await args\.send\(ctx\.body\);/);
  });
});
