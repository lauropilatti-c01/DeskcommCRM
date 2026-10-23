import { describe, expect, it, vi } from "vitest";
import { avancarEnrollmentAtivo, type AdminClient, type TickDeps } from "./engine";
import { decidirAcompanhamentoC01 } from "./c01-acompanhamento-runtime";
import type { EnrollmentRow } from "./node-handlers";
import type { FlowGraph } from "./graph-schema";
import type { ConfigAcompanhamento, FatosAcompanhamento } from "./c01-acompanhamento";

const policy = {
  version: 1 as const,
  kind: "oferta" as const,
  activated_at: "2026-10-23T11:00:00.000Z",
};
const row = {
  id: "enrollment",
  organization_id: "org",
  contact_id: "contact",
  version_id: "version",
  current_node_id: "touch",
  steps_taken: 0,
  status: "active",
  pointer_id: "pointer",
  started_at: "2026-10-23T12:00:00.000Z",
} as EnrollmentRow;
function rig(
  type: "action" | "move_lead" | "end" = "action",
  config: ConfigAcompanhamento = policy,
) {
  const node =
    type === "action"
      ? { id: "touch", type, config: { mode: "text", body: "Mensagem de teste" } }
      : type === "move_lead"
        ? { id: "touch", type, config: { stage_id: "lost", lost_reason: "Sem resposta" } }
        : { id: "touch", type, config: { outcome: "exhausted" } };
  const graph = {
    settings: { c01_acompanhamento: config },
    nodes: [node],
    edges: [],
  } as unknown as FlowGraph;
  const db = {
    loadFlowGraph: vi.fn(async () => graph),
    decidirAcompanhamentoC01: vi.fn(async () =>
      decidirAcompanhamentoC01(
        config,
        { organizationId: "org", contactId: "contact", enrollmentId: "enrollment" },
        new Date("2026-10-23T15:00:00.000Z"),
      ),
    ),
    updateEnrollment: vi.fn(async () => undefined),
    insertEnrollmentEvent: vi.fn(async () => ({ inserted: true })),
    moverLeadNoFunil: vi.fn(async () => undefined),
    loadLeadFacts: vi.fn(),
  } as unknown as AdminClient;
  const enqueueJob = vi.fn();
  const deps = { db, enqueueJob, clock: () => new Date("2026-10-23T15:00:00.000Z") } as TickDeps;
  return { db, deps, enqueueJob };
}
describe("C01 no motor real", () => {
  it.each(["action", "move_lead", "end"] as const)(
    "%s fica parado antes do efeito quando a fonte aplicada não existe",
    async (type) => {
      const r = rig(type);
      await avancarEnrollmentAtivo(r.deps, row);
      expect(r.enqueueJob).not.toHaveBeenCalled();
      expect(r.db.moverLeadNoFunil).not.toHaveBeenCalled();
      expect(r.db.updateEnrollment).toHaveBeenCalledWith(
        "enrollment",
        "org",
        expect.objectContaining({
          status: "paused_manual",
          last_error: "c01:integracao_aplicada_indisponivel",
          next_eval_at: null,
        }),
      );
      expect(r.db.insertEnrollmentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { decision: "blocked", reason: "integracao_aplicada_indisponivel" },
        }),
      );
    },
  );
  it("não libera quando o adaptador sequer implementa a política", async () => {
    const r = rig();
    delete r.db.decidirAcompanhamentoC01;
    await avancarEnrollmentAtivo(r.deps, row);
    expect(r.enqueueJob).not.toHaveBeenCalled();
    expect(r.db.updateEnrollment).toHaveBeenCalledWith(
      "enrollment",
      "org",
      expect.objectContaining({ status: "paused_manual" }),
    );
  });
  it("adiamento e cancelamento viram estado persistido, sem criar job", async () => {
    for (const decision of [
      { kind: "defer", reason: "fora_do_horario", until: "2026-10-24T11:00:00.000Z" },
      { kind: "cancel", reason: "respondeu" },
      { kind: "cancel", reason: "retorno_combinado_tem_prioridade" },
    ] as const) {
      const r = rig();
      r.db.decidirAcompanhamentoC01 = vi.fn(async () => decision);
      await avancarEnrollmentAtivo(r.deps, row);
      expect(r.enqueueJob).not.toHaveBeenCalled();
      expect(r.db.updateEnrollment).toHaveBeenCalledWith(
        "enrollment",
        "org",
        expect.objectContaining(
          decision.kind === "defer"
            ? { next_eval_at: decision.until }
            : { status: "cancelled", cancel_reason: decision.reason },
        ),
      );
    }
  });
  it("o despertar após 2h persiste o prazo calculado; execução tardia fica bloqueada", async () => {
    const config: ConfigAcompanhamento = {
      version: 1,
      kind: "cronograma",
      activated_at: "2026-10-22T11:00:00.000Z",
      cronograma_timing: { minimum_wait_minutes: 120, window_margin_minutes: 15 },
    };
    const last = "2026-10-23T01:54:00.000Z"; // 22h54 de Brasília.
    for (const [now, expected] of [
      [
        "2026-10-23T03:54:00.000Z",
        { next_eval_at: "2026-10-23T23:59:00.000Z", last_error: "c01:ainda_nao_venceu" },
      ],
      [
        "2026-10-24T00:05:00.000Z",
        {
          next_eval_at: null,
          status: "paused_manual",
          last_error: "c01:janela_do_cronograma_perdida",
        },
      ],
    ] as const) {
      const r = rig("action", config);
      const f: FatosAcompanhamento = {
        organizationId: "org",
        contactId: "contact",
        opportunityId: "deal",
        anchor: { kind: "cronograma", at: last, delivered: true },
        lastInboundAt: last,
        hasNewReply: false,
        offerAfterAnchor: false,
        human: false,
        optedOut: false,
        restricted: false,
        callbackPending: false,
        anotherSequence: false,
        purchase: {
          source: "aplicada",
          organizationId: "org",
          contactId: "contact",
          opportunityId: "deal",
          checkedAt: now,
          complete: true,
          identity: "univoca",
          result: "nao_comprou",
        },
        template: { approved: false, accountReady: false },
        touches: [],
      };
      r.deps.clock = () => new Date(now);
      r.db.decidirAcompanhamentoC01 = vi.fn(async (p, enrollment, at) =>
        decidirAcompanhamentoC01(
          p,
          {
            organizationId: enrollment.organization_id,
            contactId: enrollment.contact_id,
            enrollmentId: enrollment.id,
          },
          at,
          async () => f,
        ),
      );
      await avancarEnrollmentAtivo(r.deps, { ...row, started_at: last });
      expect(r.enqueueJob).not.toHaveBeenCalled();
      expect(r.db.updateEnrollment).toHaveBeenCalledWith(
        "enrollment",
        "org",
        expect.objectContaining(expected),
      );
    }
  });
});
