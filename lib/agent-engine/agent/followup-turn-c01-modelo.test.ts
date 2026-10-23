import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRow } from "../queue/queue";
import type * as InboundTurn from "./inbound-turn";
const h = vi.hoisted(() => ({
  conferir: vi.fn(),
  resolver: vi.fn(),
  prova: vi.fn(),
  send: vi.fn(),
  agent: vi.fn(),
  financeiro: vi.fn(),
  guard: vi.fn(),
  callback: vi.fn(),
}));
vi.mock("@/lib/followup/c01-retorno", () => ({
  conferirRetornoNoEnvioC01: h.conferir,
  resolverModeloDoRetornoC01: h.resolver,
  conferirProvaRetornoC01: h.prova,
}));
vi.mock("@/lib/leads/fonte-financeira", () => ({ lerSituacaoFinanceira: h.financeiro }));
vi.mock("./callback-disparo", () => ({ conferirCallbackAntesDoTurno: h.callback }));
vi.mock("./inbound-turn", async (original) => ({
  ...(await original<typeof InboundTurn>()),
  runAgentTurn: h.agent,
}));
vi.mock("../guardrails/before-send", () => ({ runBeforeSend: h.guard }));
vi.mock("./human-handoff", () => ({ isLeadInHandoff: vi.fn(async () => false) }));
vi.mock("../edge/crm/get-lead-context", () => ({
  getLeadContext: vi.fn(async () => ({
    ok: true,
    context: { contact: { is_blocked: false } },
    lgpd: { isAnonymized: false, isProspecting: false, legalBasis: {} },
  })),
}));
vi.mock("@/lib/atendimento/fronteira-server", () => ({ requireCurrentServiceBoundary: vi.fn() }));
import { createFollowupTurnHandler } from "./followup-turn";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = id(1),
  contact = id(2),
  conversation = id(3),
  channel = id(4),
  agent = id(5);
const now = new Date("2026-10-25T15:00:00Z");
const proof = {
  organization_id: org,
  contact_id: contact,
  conversation_id: conversation,
  callback_agent_id: agent,
  template: { connection_id: channel, template_id: id(6), content_hash: "a".repeat(64) },
};
function setup() {
  const job = {
    id: id(7),
    organization_id: org,
    contact_id: contact,
    kind: "followup_turn",
    source_event_id: null,
    payload: {
      scope: "commercial",
      c01_callback: proof,
      callback_agent_id: agent,
      service_boundary: {
        organization_id: org,
        contact_id: contact,
        conversation_id: conversation,
        service_revision: 1,
        demanda_id: null,
        demanda_revision: null,
      },
    },
    status: "running",
    priority: 100,
    run_after: now,
    last_error: null,
    created_at: now,
    attempts: 1,
    max_attempts: 3,
    locked_by: "test",
    locked_at: now,
  } as JobRow;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("from conversations c"))
      return { rows: [{ channel_session_id: channel, archived_at: null, canal_desativado: null }] };
    if (sql.includes("from organizations")) return { rows: [{ timezone: "America/Sao_Paulo" }] };
    return { rows: [] };
  });
  const deps = {
    clock: () => now,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    knobs: {},
    crmCfg: {},
    llmCfg: {},
    channel: () => ({ send: h.send }),
  };
  return {
    job,
    pool: { query },
    run: () =>
      createFollowupTurnHandler(deps as never)(job, { query } as never, { workerId: "test" }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.prova.mockReturnValue(proof);
  h.conferir.mockResolvedValue(undefined);
  h.callback.mockResolvedValue({ tipo: "seguir" });
  h.resolver.mockResolvedValue({
    tipo: "modelo_aprovado",
    body: "Mensagem fictícia.",
    modelo: { name: "retorno_ficticio", language: "pt_BR", values: {} },
  });
  h.send.mockResolvedValue({ kind: "sent" });
  h.guard.mockImplementation(async (args) => ({
    status: "sent",
    outcome: await args.send(args.body),
    trace: [],
  }));
});
describe("turno de retorno C01 usa exclusivamente o modelo assinado", () => {
  it("envia o modelo exato pela cadeia comum, sem gerar conversa por IA", async () => {
    const s = setup();
    await s.run();
    expect(h.conferir).toHaveBeenCalledWith(
      s.pool,
      { organizationId: org, contactId: contact, jobId: s.job.id },
      now,
      expect.any(AbortSignal),
      h.financeiro,
    );
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: s.job.id,
        conversationId: conversation,
        seq: 1,
        template: { name: "retorno_ficticio", language: "pt_BR", values: {} },
      }),
    );
    expect(h.agent).not.toHaveBeenCalled();
    expect(h.guard).toHaveBeenCalledWith(expect.objectContaining({ isTemplate: true }));
    expect(h.guard.mock.calls[0]![0]).not.toHaveProperty("classifyPromiseSemantic");
  });
  it("configuração ou prova inválida impede transporte e IA", async () => {
    const s = setup();
    h.conferir.mockRejectedValueOnce(new Error("c01_callback_template_configuration_changed"));
    await expect(s.run()).rejects.toThrow("configuration_changed");
    expect(h.agent).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });
  it("não deixa um modelo assinado falar em outra conversa", async () => {
    const s = setup();
    h.prova.mockReturnValueOnce({ ...proof, conversation_id: id(99) });
    await expect(s.run()).rejects.toThrow("scope_mismatch");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.agent).not.toHaveBeenCalled();
  });
  it("erro de pagamento/limite não chama IA nem troca o texto", async () => {
    const s = setup();
    h.send.mockRejectedValueOnce(new Error("marketing_limit"));
    await expect(s.run()).rejects.toThrow("marketing_limit");
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.agent).not.toHaveBeenCalled();
  });
  it("retorno sem prova de modelo continua no caminho anterior", async () => {
    const s = setup();
    h.prova.mockReturnValue({ ...proof, template: undefined });
    await s.run();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.agent).toHaveBeenCalledTimes(1);
  });
});
