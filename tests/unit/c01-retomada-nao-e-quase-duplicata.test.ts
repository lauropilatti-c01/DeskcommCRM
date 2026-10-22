/**
 * (C01, junção da 1.86.0) A RETOMADA DO C54 NÃO É SUPRIMIDA PELA QUASE-DUPLICATA DO AUTOR.
 *
 * A 1.86 semeia a régua `near-dup.ts` com o que saiu para a conversa desde a última
 * mensagem do cliente (`corposEnviadosDesdeUltimaInbound`), tirando só o `failed`. A
 * mensagem que o CRM segura (`queued`/`sending`) entrava na memória. Na re-execução
 * do job, a nossa recuperação (C54) retoma essa mensagem pela mesma chave do
 * `send_ledger` (`estadoInicialDoJob().pendentes`, `findPendente`). O `send_message`
 * com o mesmo texto era suprimido antes de chegar ao ledger, e a retomada não
 * acontecia. Agora o turno tira da memória o corpo dos pendentes a retomar
 * (`lib/c01/memoria-sem-retomadas.ts`); o que já foi entregue continua suprimindo.
 *
 * Banco falso, mas `estadoInicialDoJob`, `corposEnviadosDesdeUltimaInbound` e a trava
 * são os de verdade.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { corposEnviadosDesdeUltimaInbound } from "@/lib/agent-engine/agent/memoria-envio";
import { criarTravaDeDuplicata } from "@/lib/agent-engine/agent/near-dup";
import { estadoInicialDoJob } from "@/lib/agent-engine/edge/crm/send-ledger";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { corposDasPendentes, semAsRetomadas } from "@/lib/c01/memoria-sem-retomadas";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "33333333-3333-4333-8333-333333333333";
const JOB = "44444444-4444-4444-8444-444444444444";

const A = "Oi! Vi que você perguntou sobre o plano.";
const B = "Ele inclui o material e o acesso à plataforma.";
const C = "Essa é a apostila do módulo 1.";
const K = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000003"];

type Recibo = { id: string; seq: number; status: string };
type Mensagem = { id: string; status: string; body: string | null; chaveLegada?: string };

function banco(recibos: Recibo[], mensagens: Mensagem[]): Queryable {
  const q = async (sql: string, p: unknown[] = []) => {
    const s = sql.replace(/\s+/g, " ").trim();
    const linhas = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (s.startsWith("select seq,status from send_ledger")) return linhas(recibos.map((r) => ({ seq: r.seq, status: r.status })));
    if (s.startsWith("select * from send_ledger where organization_id=$1 and job_id=$2 and seq=$3")) {
      return linhas(recibos.filter((r) => r.seq === Number(p[2])).map((r) => ({ ...r, organization_id: ORG, job_id: JOB })));
    }
    if (s.startsWith("update send_ledger set status=$3")) {
      const r = recibos.find((x) => x.id === p[1]);
      if (r) r.status = String(p[2]);
      return linhas([]);
    }
    if (s.startsWith("select id,status from messages where organization_id=$1 and id=$2")) {
      return linhas(mensagens.filter((m) => m.id === p[1]).map((m) => ({ id: m.id, status: m.status })));
    }
    if (s.startsWith("select id,status from messages where organization_id=$1 and metadata->>'idempotency_key'=$2")) {
      return linhas(mensagens.filter((m) => m.chaveLegada === p[1]).map((m) => ({ id: m.id, status: m.status })));
    }
    // A memória do autor: as outbound desde a última inbound, menos as `failed`.
    if (s.startsWith("with ultima_inbound as")) {
      return linhas(mensagens.filter((m) => m.status !== "failed").reverse().map((m) => ({ body: m.body })));
    }
    if (s.startsWith("select id::text as chave, body from messages")) {
      const ids = p[1] as string[];
      return linhas(mensagens.filter((m) => ids.includes(m.id)).map((m) => ({ chave: m.id, body: m.body })));
    }
    if (s.startsWith("select metadata->>'idempotency_key' as chave, body from messages")) {
      const chaves = p[1] as string[];
      return linhas(
        mensagens.filter((m) => m.chaveLegada && chaves.includes(m.chaveLegada)).map((m) => ({ chave: m.chaveLegada, body: m.body })),
      );
    }
    throw new Error(`consulta inesperada: ${s.slice(0, 80)}`);
  };
  return { query: q } as unknown as Queryable;
}

/** A primeira execução: A entregue (posição 1); B na fila do CRM (2); C com o canal (3). */
function primeiraExecucao(): { recibos: Recibo[]; mensagens: Mensagem[] } {
  return {
    recibos: [
      { id: K[0]!, seq: 1, status: "accepted" },
      { id: K[1]!, seq: 2, status: "queued" },
      { id: K[2]!, seq: 3, status: "requested" },
    ],
    mensagens: [
      { id: K[0]!, status: "sent", body: A },
      { id: K[1]!, status: "queued", body: B },
      { id: K[2]!, status: "sending", body: C },
    ],
  };
}

async function memoriaDoAutor(db: Queryable) {
  return corposEnviadosDesdeUltimaInbound(db as never, { organizationId: ORG, conversationId: CONV });
}

describe("(C01) a retomada do C54 contra a quase-duplicata da 1.86", () => {
  it("o defeito, documentado: só com a memória do autor, a re-execução de B e de C é suprimida", async () => {
    const { recibos, mensagens } = primeiraExecucao();
    const db = banco(recibos, mensagens);
    const estado = await estadoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    expect(estado.pendentes).toEqual([K[1], K[2]]);
    const trava = criarTravaDeDuplicata();
    trava.semear(await memoriaDoAutor(db));
    expect(trava.checar(B)).toBe(B);
    expect(trava.checar(C)).toBe(C);
  });

  it("com a memória sem as retomadas: B e C passam para o ledger retomá-las; A, já entregue, continua suprimida", async () => {
    const { recibos, mensagens } = primeiraExecucao();
    const db = banco(recibos, mensagens);
    const estado = await estadoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    const trava = criarTravaDeDuplicata();
    trava.semear(semAsRetomadas(await memoriaDoAutor(db), await corposDasPendentes(db, ORG, estado.pendentes)));
    expect(trava.checar(B)).toBeNull();
    expect(trava.checar(C)).toBeNull();
    expect(trava.checar(A)).toBe(A);
    // Retomada a B, a repetição dela NO MESMO turno volta a ser suprimida.
    trava.reservar(B);
    trava.promover(B);
    expect(trava.checar(B)).toBe(B);
  });

  it("recibo legado (a mensagem gravada pela chave na metadata, não pela PK): a retomada também passa", async () => {
    const { recibos, mensagens } = primeiraExecucao();
    mensagens[1] = { id: "bbbbbbbb-0000-4000-8000-00000000000b", status: "queued", body: B, chaveLegada: K[1]! };
    const db = banco(recibos, mensagens);
    const estado = await estadoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    expect(estado.pendentes).toContain(K[1]);
    const trava = criarTravaDeDuplicata();
    trava.semear(semAsRetomadas(await memoriaDoAutor(db), await corposDasPendentes(db, ORG, estado.pendentes)));
    expect(trava.checar(B)).toBeNull();
  });

  it("sem pendente nenhum, a memória é a do autor, inteira (nada muda para o turno comum)", async () => {
    const recibos: Recibo[] = [{ id: K[0]!, seq: 1, status: "accepted" }];
    const mensagens: Mensagem[] = [{ id: K[0]!, status: "sent", body: A }];
    const db = banco(recibos, mensagens);
    const estado = await estadoInicialDoJob(db, { tenantId: ORG, jobId: JOB });
    expect(estado.pendentes).toEqual([]);
    expect(await corposDasPendentes(db, ORG, estado.pendentes)).toEqual([]);
    expect(semAsRetomadas(await memoriaDoAutor(db), [])).toEqual([A]);
  });

  it("tira uma ocorrência por pendente, e só ela", () => {
    expect(semAsRetomadas([B, A, B], [B])).toEqual([A, B]);
    expect(semAsRetomadas([A], [B])).toEqual([A]);
  });

  it("o turno semeia a trava com a memória sem as retomadas, a partir de porRetomar", () => {
    const fonte = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    expect(fonte).toMatch(/const porRetomar = new Set<string>\(estadoInicial\.pendentes\);/);
    expect(fonte).toMatch(
      /const memoria = semAsRetomadas\(\s*jaDito,\s*porRetomar\.size > 0 \? await corposDasPendentes\(pool, tenantId, \[\.\.\.porRetomar\]\) : \[\],\s*\);\s*if \(memoria\.length > 0\) \{\s*dupTrava\.semear\(memoria\);/,
    );
    expect(fonte).not.toMatch(/dupTrava\.semear\(jaDito\)/);
  });
});
