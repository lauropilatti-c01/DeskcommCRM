import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { ConfigOrigemC01 } from "./c01-origem";
import {
  gravarCandidaturaContinuacaoC01,
  conferirCandidaturaContinuacaoC01,
} from "./c01-continuacao-turno";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-24T15:00:10Z");
const scope = {
  organizationId: id(1),
  contactId: id(2),
  conversationId: id(3),
  jobId: id(4),
  workerId: "worker-ficticio",
  acquiredAt: "2026-10-24T14:59:00Z",
};
const cfg: ConfigOrigemC01 = {
  enabled: true,
  organizationId: id(1),
  tokenSha256: "a".repeat(64),
  signingKey: "b".repeat(40),
  allowedKinds: ["cronograma", "oferta"],
  continuation: { enabled: true, policyStatus: "approved", activatedAt: "2026-10-24T11:00:00Z" },
};
const proposal = {
  estado: "pendente",
  caminho: "L1",
  mensagem_entrada_id: id(5),
  trecho_do_pedido: "quero entender o cronograma",
  natureza: "informacao_solicitada",
  texto: "Podemos começar pelas metas da sua área.",
};
function fixture() {
  let saved: unknown;
  const state = {
    job: {
      id: id(4),
      kind: "inbound_turn",
      status: "running",
      attempts: 1,
      locked_by: scope.workerId,
      claim_acquired_at: scope.acquiredAt,
      created_at: "2026-10-24T14:59:00Z",
      payload: { inbound_message_id: id(5), conversation_id: id(3) },
    },
    inbound: {
      id: id(5),
      body: "Eu quero entender o cronograma",
      sent_at: "2026-10-24T14:59:00Z",
      revoked_at: null,
    },
    final: {
      id: id(6),
      type: "text",
      body: "Qual área deseja conhecer primeiro?",
      sent_at: "2026-10-24T15:00:00Z",
      direction: "outbound",
      external_id: "wamid.ficticio",
      status: "sent",
      metadata: {},
      ledger_status: "accepted",
    },
    leads: [{ id: id(7), product_key: "produto-ficticio" }],
    update: 1,
  };
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("c01:continuacao:job")) return { rows: [state.job] };
    if (sql.includes("c01:continuacao:entrada")) return { rows: [state.inbound] };
    if (sql.includes("c01:continuacao:saida")) return { rows: [state.final] };
    if (sql.includes("c01:continuacao:negocio")) return { rows: state.leads };
    if (sql.includes("c01:continuacao:gravar")) {
      saved = params?.at(-1);
      return { rows: state.update ? [{ id: id(4) }] : [] };
    }
    throw new Error("Consulta inesperada no teste: " + sql);
  });
  return { state, query, db: { query } as Queryable, saved: () => saved };
}
describe("candidatura do turno no armazenamento existente", () => {
  it("L1 guarda sem_oferta com produto nulo; L2 não cria identidade de produto", async () => {
    const f = fixture();
    f.state.leads[0]!.product_key = "";
    expect((await gravarCandidaturaContinuacaoC01(f.db, cfg, scope, proposal, now)).status).toBe(
      "recorded",
    );
    expect(conferirCandidaturaContinuacaoC01(cfg, f.saved())).toMatchObject({
      productKey: null,
      financialScope: "sem_oferta",
    });
    const g = fixture();
    g.state.leads[0]!.product_key = "";
    expect(
      (
        await gravarCandidaturaContinuacaoC01(
          g.db,
          cfg,
          scope,
          { ...proposal, caminho: "L2", texto: undefined },
          now,
        )
      ).status,
    ).toBe("blocked");
  });
  it("grava prova assinada no job, sem inscrever, sem emitir job e sem chamar modelo", async () => {
    const f = fixture();
    expect(await gravarCandidaturaContinuacaoC01(f.db, cfg, scope, proposal, now)).toEqual({
      status: "recorded",
    });
    const proof = conferirCandidaturaContinuacaoC01(cfg, f.saved());
    expect(proof).toMatchObject({
      jobId: id(4),
      leadId: id(7),
      finalMessageId: id(6),
      inboundMessageId: id(5),
      proposal,
    });
    expect(
      f.query.mock.calls.every(
        ([sql]) => !sql.includes("followup_enrollments") && !sql.includes("insert into job_queue"),
      ),
    ).toBe(true);
  });
  it("OFF não consulta banco e não expõe autoridade implícita", async () => {
    const f = fixture();
    expect((await gravarCandidaturaContinuacaoC01(f.db, null, scope, proposal, now)).status).toBe(
      "off",
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it("lease antigo, fonte errada e negócio ambíguo não gravam", async () => {
    const f = fixture();
    f.state.job.locked_by = "outro";
    expect((await gravarCandidaturaContinuacaoC01(f.db, cfg, scope, proposal, now)).status).toBe(
      "blocked",
    );
    const g = fixture();
    g.state.leads.push({ id: id(8), product_key: "outro" });
    expect((await gravarCandidaturaContinuacaoC01(g.db, cfg, scope, proposal, now)).status).toBe(
      "blocked",
    );
    const h = fixture();
    h.state.inbound.body = "Obrigado";
    expect((await gravarCandidaturaContinuacaoC01(h.db, cfg, scope, proposal, now)).status).toBe(
      "blocked",
    );
    expect([f.saved(), g.saved(), h.saved()]).toEqual([undefined, undefined, undefined]);
  });
  it("CAS perdido não reporta candidatura gravada", async () => {
    const f = fixture();
    f.state.update = 0;
    expect((await gravarCandidaturaContinuacaoC01(f.db, cfg, scope, proposal, now)).status).toBe(
      "blocked",
    );
  });
  it("assinatura recusa texto alterado ou outra organização", async () => {
    const f = fixture();
    await gravarCandidaturaContinuacaoC01(f.db, cfg, scope, proposal, now);
    const original = f.saved() as Record<string, unknown>;
    expect(
      conferirCandidaturaContinuacaoC01(cfg, {
        ...original,
        proposal: { ...proposal, texto: "Texto adulterado" },
      }),
    ).toBeNull();
    expect(
      conferirCandidaturaContinuacaoC01({ ...cfg, organizationId: id(99) }, original),
    ).toBeNull();
  });
});
