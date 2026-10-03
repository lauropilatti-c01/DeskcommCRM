/**
 * (C01) O RECIBO FALHADO CEDE A POSIÇÃO — achado 2 (alto) da sexta revisão adversarial
 * do Codex (03/10/2026), rodada 7, correção 2.
 *
 * O achado: com a posição 1 'failed' e as 2 e 3 aceitas, a recuperação por conteúdo
 * (C54) entregava a mensagem regenerada na posição 4 e deixava o 'failed' na 1 para
 * sempre — a posição continua da maior aceita, e o ramo de colisão que sempre
 * rotacionou o 'failed' (`ocuparPosicao`) nunca mais era alcançado. No follow-up por
 * IA, `resultadoDoEnvioDoFollowup` exige todos os recibos aceitos e lança
 * `followup_message_not_sent`: `completeFollowupTurn` nunca rodava, os retries
 * esgotavam, e o fluxo não avançava — com o cliente tendo recebido tudo.
 *
 * A correção, sem mudança de banco ('failed' já é status permitido) e sem mexer no
 * ledger além de LER: `estadoInicialDoJob` devolve as posições falhadas pela execução
 * anterior (`falhadas`), e o turno — no seu único caminho ao canal, `enviarPeloCanal` —
 * dá a primeira delas como dica de posição a cada envio físico, em vez de `posicao + 1`.
 * O ledger faz o que sempre fez com um 'failed' na posição pedida: rotaciona (chave
 * nova, mesma posição), com o mesmo conteúdo ou com outro. É o que o replay por
 * posição da versão do autor fazia por acidente de ordem; agora é deliberado. O
 * conteúdo já conhecido (`already_sent`, retomada de pendente) não ocupa a posição.
 * A prova de fluxo completo (Postgres real, `completeFollowupTurn` chamado) está em
 * `tests/invariants/c01-followup-conclui-com-recibo-falhado.test.ts`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  estadoInicialDoJob,
  hashDoConteudo,
  posicaoFalhadaFoiOcupada,
  resultadoDoEnvioDoFollowup,
  sendWithLedger,
} from "@/lib/agent-engine/edge/crm/send-ledger";

type Store = Parameters<typeof sendWithLedger>[0];
type Linha = {
  id: string;
  seq: number;
  status: "requested" | "accepted" | "queued" | "vetoed" | "failed";
  body_hash: string;
  crm_message_id: string | null;
  last_error: string | null;
};
type Mensagem = { id: string; status: string };

const ORG = "org";
const JOB = "job";
const A = "Oi! Vi que você perguntou sobre o plano.";
const B = "Ele inclui o material e o acesso à plataforma.";
const C = "Quer que eu te mande o link para começar?";
const A2 = "Olá! Vi sua pergunta sobre o plano — vamos lá.";

/**
 * Um ledger em memória com a forma da loja real (as consultas por hash e a posição
 * livre), o CRM falso que grava a mensagem como `sent` — ou como `failed`, quando o caso
 * pede — e um `db.query` que responde às consultas que `estadoInicialDoJob`,
 * `posicaoFalhadaFoiOcupada` e `resultadoDoEnvioDoFollowup` fazem pela loja Postgres.
 */
function ledgerEmMemoria() {
  const linhas: Linha[] = [];
  const mensagens = new Map<string, Mensagem>(); // chave do recibo → mensagem
  let proximoId = 1;
  const novaChave = () => `k${proximoId++}`;
  const doJob = () => [...linhas].sort((x, y) => x.seq - y.seq);
  const rotate = vi.fn(async (i: { seq: number }, hash: string) => {
    const linha = linhas.find((l) => l.seq === i.seq);
    if (!linha) throw new Error("send_ledger_rotation_missing");
    linha.id = novaChave();
    linha.status = "requested";
    linha.body_hash = hash;
    linha.crm_message_id = null;
    linha.last_error = null;
    return linha.id;
  });
  const atualiza = (
    key: string,
    status: Linha["status"],
    id: string | null,
    error: string | null,
  ) => {
    const linha = linhas.find((l) => l.id === key);
    if (!linha) throw new Error("recibo sumiu");
    linha.status = status;
    if (id) linha.crm_message_id = id;
    linha.last_error = error;
  };
  const store: Store = {
    async create(i, hash) {
      if (linhas.some((l) => l.seq === i.seq)) throw { code: "23505" };
      const id = novaChave();
      linhas.push({
        id,
        seq: i.seq,
        status: "requested",
        body_hash: hash,
        crm_message_id: null,
        last_error: null,
      });
      return id;
    },
    async find(i) {
      return linhas.find((l) => l.seq === i.seq) ?? null;
    },
    rotate,
    async message(_org, key) {
      return mensagens.get(key) ?? null;
    },
    async update(_org, key, status, id, error) {
      atualiza(key, status, id, error);
    },
    async findAccepted(_i, hash) {
      return doJob().find((l) => l.status === "accepted" && l.body_hash === hash) ?? null;
    },
    async findPendente(_i, hash) {
      return (
        doJob().find(
          (l) => (l.status === "requested" || l.status === "queued") && l.body_hash === hash,
        ) ?? null
      );
    },
    async nextSeq() {
      return (linhas.length ? Math.max(...linhas.map((l) => l.seq)) : 0) + 1;
    },
  };
  /** Um recibo como a execução anterior o deixou (com a mensagem gravada, quando houve). */
  const recibo = (seq: number, status: Linha["status"], body: string, mensagem: string | null) => {
    const id = novaChave();
    linhas.push({
      id,
      seq,
      status,
      body_hash: hashDoConteudo({ body }),
      crm_message_id: mensagem ? `m-${id}` : null,
      last_error: null,
    });
    if (mensagem) mensagens.set(id, { id: `m-${id}`, status: mensagem });
    return id;
  };
  const entregues: Array<{ key: string; body: string }> = [];
  let falhaProxima = false;
  /** Envia pelo ledger de verdade, com a dica de posição que o turno daria. */
  const envia = (body: string, seq: number) =>
    sendWithLedger(
      store,
      { tenantId: ORG, leadId: "lead", jobId: JOB, seq, body },
      async (key, messageId) => {
        entregues.push({ key, body });
        const status = falhaProxima ? "failed" : "sent";
        falhaProxima = false;
        mensagens.set(key, { id: messageId, status });
        return { id: messageId, status };
      },
    );
  /** O Postgres falso: só as consultas da loja real que os dois leitores fazem. */
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.startsWith("select seq,status from send_ledger")) {
        const rows = doJob().map((l) => ({ seq: l.seq, status: l.status }));
        return { rows, rowCount: rows.length };
      }
      if (
        s.startsWith("select * from send_ledger where organization_id=$1 and job_id=$2 and seq=$3")
      ) {
        const rows = linhas.filter((l) => l.seq === Number(params[2]));
        return { rows, rowCount: rows.length };
      }
      if (s.startsWith("select id,status from messages")) {
        const m = mensagens.get(String(params[1]));
        return { rows: m ? [m] : [], rowCount: m ? 1 : 0 };
      }
      if (s.startsWith("update send_ledger set status=$3")) {
        const [, key, status, id, error] = params as [
          string,
          string,
          Linha["status"],
          string | null,
          string | null,
        ];
        atualiza(key, status, id, error);
        return { rows: [], rowCount: 1 };
      }
      if (s.startsWith("select status from send_ledger")) {
        const rows = doJob().map((l) => ({ status: l.status }));
        return { rows, rowCount: rows.length };
      }
      throw new Error(`SQL fora do roteiro do teste: ${s}`);
    },
  };
  return {
    store,
    db,
    linhas: () => doJob().map((l) => [l.seq, l.status] as const),
    detalhe: () => doJob(),
    hashes: () => doJob().map((l) => l.body_hash),
    recibo,
    envia,
    entregues,
    rotate,
    falharAProxima: () => {
      falhaProxima = true;
    },
    estado: () => estadoInicialDoJob(db as never, { tenantId: ORG, jobId: JOB }),
    ocupada: (seq: number, chave: string) =>
      posicaoFalhadaFoiOcupada(db as never, { tenantId: ORG, jobId: JOB, seq, chave }),
    followup: () => resultadoDoEnvioDoFollowup(db as never, ORG, JOB),
  };
}

describe("(C01) `estadoInicialDoJob` devolve as posições falhadas pela execução anterior", () => {
  it("o cenário do Codex — posição 1 'failed' (A), 2 e 3 aceitas: `falhadas` = [{1, chave}], `posicao` 3, `enviadas` 2 (o cliente não recebeu A)", async () => {
    const l = ledgerEmMemoria();
    const chave = l.recibo(1, "failed", A, "failed");
    l.recibo(2, "accepted", B, "sent");
    l.recibo(3, "accepted", C, "sent");
    expect(await l.estado()).toEqual({
      posicao: 3,
      enviadas: 2,
      pendentes: [],
      falhadas: [{ seq: 1, chave }],
    });
  });

  it("várias falhadas vêm por ordem de posição, inclusive acima da maior aceita", async () => {
    const l = ledgerEmMemoria();
    const k3 = l.recibo(3, "failed", C, "failed");
    const k1 = l.recibo(1, "failed", A, "failed");
    l.recibo(2, "accepted", B, "sent");
    expect(await l.estado()).toMatchObject({
      posicao: 2,
      enviadas: 1,
      falhadas: [
        { seq: 1, chave: k1 },
        { seq: 3, chave: k3 },
      ],
    });
  });

  it("recibo PENDENTE cuja mensagem o CRM marcou `failed` (a sessão caiu com ela na fila) é reconciliado como 'failed' e entra na lista — antes ficava pendente para sempre", async () => {
    const l = ledgerEmMemoria();
    const chave = l.recibo(1, "queued", A, "failed");
    l.recibo(2, "accepted", B, "sent");
    expect(await l.estado()).toEqual({
      posicao: 2,
      enviadas: 1,
      pendentes: [],
      falhadas: [{ seq: 1, chave }],
    });
    expect(l.detalhe()[0]).toMatchObject({
      id: chave,
      status: "failed",
      crm_message_id: `m-${chave}`,
      last_error: "handler marcou a mensagem como failed",
    });
  });

  it("o resto não muda: pendente com mensagem na fila conta e fica em `pendentes`; 'requested' sem mensagem nem conta nem entra nas falhadas (limite de sempre); sem falha, `falhadas` é vazia", async () => {
    const l = ledgerEmMemoria();
    l.recibo(1, "accepted", A, "sent");
    const naFila = l.recibo(2, "queued", B, "queued");
    l.recibo(3, "requested", C, null);
    expect(await l.estado()).toEqual({
      posicao: 1,
      enviadas: 2,
      pendentes: [naFila],
      falhadas: [],
    });
    expect(l.linhas()).toEqual([
      [1, "accepted"],
      [2, "queued"],
      [3, "requested"],
    ]);
  });
});

describe("(C01) `sendWithLedger` com a dica de posição que o turno dá (a posição falhada)", () => {
  it("o cenário do Codex, na re-execução que regenera A: a dica é a 1 — A toma a posição 1 (rotate, chave nova), nenhum 'failed' sobra, e o agregador do follow-up vê o passo enviado", async () => {
    const l = ledgerEmMemoria();
    const antiga = l.recibo(1, "failed", A, "failed");
    l.recibo(2, "accepted", B, "sent");
    l.recibo(3, "accepted", C, "sent");

    const a = await l.envia(A, 1);
    expect(a.kind).toBe("sent");
    expect(a.idempotencyKey).not.toBe(antiga);
    expect(l.rotate).toHaveBeenCalledTimes(1);
    expect(l.rotate.mock.calls[0]![0]).toMatchObject({ seq: 1 });
    expect(l.linhas()).toEqual([
      [1, "accepted"],
      [2, "accepted"],
      [3, "accepted"],
    ]);
    expect(l.hashes()[0]).toBe(hashDoConteudo({ body: A }));
    expect(l.entregues.map((e) => e.body)).toEqual([A]);
    // A posição foi ocupada: o turno a tira da lista.
    expect(await l.ocupada(1, antiga)).toBe(true);
    // B e C, aceitas, não saem de novo — nem com a dica de posição que for.
    expect((await l.envia(B, 4)).kind).toBe("already_sent");
    expect((await l.envia(C, 4)).kind).toBe("already_sent");
    expect(l.entregues).toHaveLength(1);
    // E o agregador do follow-up, intacto, vê o passo enviado.
    await expect(l.followup()).resolves.toEqual({ kind: "sent" });
  });

  it("o defeito, documentado: com a dica de antes (a maior aceita + 1), A nasce na posição 4, o 'failed' fica, e o agregador lança `followup_message_not_sent`", async () => {
    const l = ledgerEmMemoria();
    l.recibo(1, "failed", A, "failed");
    l.recibo(2, "accepted", B, "sent");
    l.recibo(3, "accepted", C, "sent");
    expect((await l.envia(A, 4)).kind).toBe("sent");
    expect(l.rotate).not.toHaveBeenCalled();
    expect(l.linhas()).toEqual([
      [1, "failed"],
      [2, "accepted"],
      [3, "accepted"],
      [4, "accepted"],
    ]);
    await expect(l.followup()).rejects.toThrow("followup_message_not_sent");
  });

  it("conteúdo NOVO na posição falhada (o modelo reescreveu a mensagem) também a toma — o ramo de colisão rotaciona o 'failed' com outro hash", async () => {
    const l = ledgerEmMemoria();
    l.recibo(1, "failed", A, "failed");
    l.recibo(2, "accepted", B, "sent");
    expect((await l.envia(A2, 1)).kind).toBe("sent");
    expect(l.rotate).toHaveBeenCalledTimes(1);
    expect(l.rotate.mock.calls[0]![0]).toMatchObject({ seq: 1 });
    expect(l.linhas()).toEqual([
      [1, "accepted"],
      [2, "accepted"],
    ]);
    expect(l.hashes()[0]).toBe(hashDoConteudo({ body: A2 }));
  });

  it("conteúdo CONHECIDO com a dica da posição falhada não a ocupa: aceito volta `already_sent`, pendente é retomado pela própria chave — e a posição continua aberta", async () => {
    const aceito = ledgerEmMemoria();
    const falhada = aceito.recibo(1, "failed", A, "failed");
    aceito.recibo(2, "accepted", B, "sent");
    expect((await aceito.envia(B, 1)).kind).toBe("already_sent");
    expect(aceito.rotate).not.toHaveBeenCalled();
    expect(await aceito.ocupada(1, falhada)).toBe(false);

    const pendente = ledgerEmMemoria();
    const falhada2 = pendente.recibo(1, "failed", A, "failed");
    const chave = pendente.recibo(2, "queued", B, "queued");
    const r = await pendente.envia(B, 1);
    expect(r).toMatchObject({ kind: "sent", idempotencyKey: chave });
    expect(pendente.rotate).not.toHaveBeenCalled();
    expect(pendente.linhas()).toEqual([
      [1, "failed"],
      [2, "accepted"],
    ]);
    expect(await pendente.ocupada(1, falhada2)).toBe(false);
  });

  it("falhando de novo na posição, o recibo volta a 'failed' nela com chave nova: a posição conta como ocupada nesta execução (uma tentativa por execução), e o retry seguinte a revisita — o limite de sempre", async () => {
    const l = ledgerEmMemoria();
    const antiga = l.recibo(1, "failed", A, "failed");
    l.falharAProxima();
    expect((await l.envia(A, 1)).kind).toBe("failed");
    expect(l.linhas()).toEqual([[1, "failed"]]);
    expect(l.detalhe()[0]!.id).not.toBe(antiga);
    expect(await l.ocupada(1, antiga)).toBe(true);
    await expect(l.followup()).rejects.toThrow("followup_message_not_sent");
    // A execução seguinte parte do estado novo: a posição 1 volta à lista.
    expect(await l.estado()).toMatchObject({ falhadas: [{ seq: 1, chave: l.detalhe()[0]!.id }] });
  });

  it("sem recibo falhado nada muda: a dica é a próxima posição, e a colisão segue pelos ramos de sempre", async () => {
    const l = ledgerEmMemoria();
    l.recibo(1, "accepted", A, "sent");
    expect((await l.envia(B, 2)).kind).toBe("sent");
    expect(l.rotate).not.toHaveBeenCalled();
    expect(l.linhas()).toEqual([
      [1, "accepted"],
      [2, "accepted"],
    ]);
  });

  it("`posicaoFalhadaFoiOcupada`: a posição que sumiu também conta como ocupada (nada a revisitar)", async () => {
    const l = ledgerEmMemoria();
    expect(await l.ocupada(7, "k-que-nao-existe")).toBe(true);
  });
});

describe("(C01) a ligação pelo código", () => {
  const LEDGER = readFileSync("lib/agent-engine/edge/crm/send-ledger.ts", "utf8");
  const TURNO = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");

  it("`estadoInicialDoJob` lista as falhadas com a chave, reconcilia o pendente de mensagem falhada, e continua sem contar o 'failed' nas entregas", () => {
    const estado = LEDGER.slice(
      LEDGER.indexOf("export async function estadoInicialDoJob("),
      LEDGER.indexOf("export async function posicaoFalhadaFoiOcupada("),
    );
    expect(estado).toMatch(/falhadas: Array<\{ seq: number; chave: string \}>;/);
    expect(estado).toMatch(
      /if \(row\.status === "failed"\) \{\s*const recibo = await store\.find\(\{ \.\.\.input, leadId: null, seq, body: "" \}\);\s*if \(recibo\) falhadas\.push\(\{ seq, chave: recibo\.id \}\);\s*continue;\s*\}/,
    );
    expect(estado).toMatch(
      /if \(row\.status !== "requested" && row\.status !== "queued"\) continue;/,
    );
    expect(estado).toMatch(
      /\} else \{\s*(?:\/\/[^\n]*\n\s*)*await store\.update\(input\.tenantId, recibo\.id, "failed", mensagem\.id, "handler marcou a mensagem como failed"\);\s*falhadas\.push\(\{ seq, chave: recibo\.id \}\);\s*\}/,
    );
    expect(estado).toMatch(/return \{ posicao, enviadas, pendentes, falhadas \};/);
    // O 'failed' não entra em `enviadas` nem em `posicao`: só `continue` depois da lista.
    expect(estado).not.toMatch(
      /if \(row\.status === "failed"\) \{[\s\S]*?enviadas \+= 1[\s\S]*?continue;\s*\}/,
    );
  });

  it("`posicaoFalhadaFoiOcupada` lê o recibo da posição e compara a chave", () => {
    expect(LEDGER).toMatch(
      /export async function posicaoFalhadaFoiOcupada\(\s*db: Queryable,\s*input: \{ tenantId: string; jobId: string; seq: number; chave: string \},\s*\): Promise<boolean> \{\s*const recibo = await pgSendLedger\(db\)\.find\(\{ \.\.\.input, leadId: null, body: "" \}\);\s*return recibo === null \|\| recibo\.id !== input\.chave;\s*\}/,
    );
  });

  it("o turno dá a posição falhada como dica no ÚNICO caminho ao canal, e só a tira da lista quando ocupada; o preview não tem falhadas", () => {
    expect(TURNO).toMatch(/\? \{ posicao: 0, enviadas: 0, pendentes: \[\], falhadas: \[\] \}/);
    expect(TURNO).toMatch(/const falhadas = \[\.\.\.estadoInicial\.falhadas\];/);
    expect(TURNO.match(/liveChannel\(\)\.send\(/g)).toHaveLength(1);
    expect(TURNO).toMatch(
      /const falhada = falhadas\[0\];\s*const resultado = await liveChannel\(\)\.send\(\{ \.\.\.envio, seq: falhada\?\.seq \?\? posicao \+ 1 \}\);\s*if \(resultado\.kind !== 'already_sent'\) \{\s*if \(falhada === undefined\) posicao \+= 1;\s*else if \(await posicaoFalhadaFoiOcupada\(pool, \{ tenantId, jobId: liveJob\(\)\.id, \.\.\.falhada \}\)\) \{\s*falhadas\.shift\(\);\s*if \(falhada\.seq > posicao\) posicao = falhada\.seq;\s*\}\s*if \(contaNoTeto\(resultado\)\) seq \+= 1;\s*\}/,
    );
    expect(TURNO).toMatch(
      /import \{ conteudoRegistradoNoJob, estadoInicialDoJob, posicaoFalhadaFoiOcupada \} from '\.\.\/edge\/crm\/send-ledger';/,
    );
  });

  it("o ledger não mudou de contrato: o ramo de colisão rotaciona o 'failed' (mesmo hash ou outro), `sendWithLedger` ocupa a posição pedida, e o agregador do follow-up continua exigindo todos aceitos", () => {
    expect(LEDGER).toMatch(
      /if \(prior\.status === "failed"\) key = await store\.rotate\(input, hash\);/,
    );
    expect(LEDGER).toMatch(/prior\.status === "failed" \|\|/);
    const ramo = LEDGER.slice(
      LEDGER.indexOf("const pendente ="),
      LEDGER.indexOf("let message = existing;"),
    );
    expect(ramo).toMatch(/\} else \{\s*const posicao = await ocuparPosicao\(store, input, hash\);/);
    expect(LEDGER).not.toMatch(/recibosFalhados|posicaoFalhada\(/);
    expect(LEDGER).toMatch(
      /if \(rows\.some\(\(row\) => row\.status !== "accepted"\)\) throw new Error\("followup_message_not_sent"\);/,
    );
  });

  it("'failed' é status permitido pelo CHECK da tabela: nenhum valor novo no banco", () => {
    const MIGRACAO = readFileSync(
      "supabase/migrations/20260719000000_0050_agent_harness.sql",
      "utf8",
    );
    expect(MIGRACAO).toMatch(
      /check \(status in \('requested','accepted','queued','vetoed','failed'\)\)/,
    );
    expect(LEDGER).toMatch(
      /export type SendLedgerStatus = "requested" \| "accepted" \| "queued" \| "vetoed" \| "failed";/,
    );
  });
});
