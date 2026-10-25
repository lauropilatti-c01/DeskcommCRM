import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import { hashDoCorpo } from "@/lib/api/idempotency";
import {
  conferirProvaRetornoC01,
  conferirRetornoNoEnvioC01,
  prepararRetornoComercialC01,
} from "./c01-retorno";

const financeiro = vi.hoisted(() => vi.fn());
vi.mock("@/lib/leads/fonte-financeira", () => ({ lerSituacaoFinanceira: financeiro }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = id(1),
  contact = id(2),
  conversation = id(3),
  lead = id(4),
  message = id(5),
  connection = id(6),
  template = id(7),
  agent = id(8),
  job = id(9);
const consentAt = "2026-10-23T15:00:00.000Z";
const promisedAt = "2026-10-25T15:00:00.000Z";
const components = [{ type: "BODY", text: "Mensagem fictícia de retorno do laboratório." }];
const contentHash = hashDoCorpo({
  name: "retorno_ficticio",
  language: "pt_BR",
  parameter_format: "POSITIONAL",
  components,
});
const cfg = {
  enabled: true,
  organizationId: org,
  tokenSha256: "a".repeat(64),
  signingKey: "b".repeat(40),
  allowedKinds: ["cronograma"],
  callbackTemplate: { enabled: true, connectionId: connection, templateId: template, contentHash },
};

function banco() {
  const state = {
    last_inbound_at: consentAt,
    channel_session_id: connection,
    assignee_kind: "ai",
    status: "open",
    bot_silenced_until: null,
    is_blocked: false,
    ai_opt_out: false,
    force_human: false,
    is_anonymized: false,
    is_merged_into: null,
    custom_fields: { produto_chave: "produto-ficticio" },
    lead_status: "open",
  };
  const consent = {
    id: message,
    conversation_id: conversation,
    body: "Pode me chamar 25/10 às 12h.",
    sent_at: consentAt,
  };
  const model = {
    id: template,
    name: "retorno_ficticio",
    language: "pt_BR",
    components: structuredClone(components),
    parameter_format: "POSITIONAL",
    status: "APPROVED",
  };
  const currentAgent = {
    followup: { c01_callback: true, callback_enabled: true },
    timezone: "America/Sao_Paulo",
    paused_at: null,
    archived_at: null,
    operation_mode: "automatic",
  };
  let payload: Record<string, unknown> = {};
  let modelExists = true;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("from meta_templates where"))
      return {
        rows:
          modelExists && values?.[0] === org
            ? [{ name: model.name, language: model.language }]
            : [],
      };
    if (sql.includes("from meta_templates t"))
      return {
        rows: modelExists && values?.[0] === org && values?.[3] === connection ? [model] : [],
      };
    if (sql.includes("from ai_agents a"))
      return { rows: values?.[1] === agent ? [currentAgent] : [] };
    if (sql.includes("c01:callback:job")) return { rows: [{ payload }] };
    if (sql.includes("c01:callback:state")) return { rows: [{ ...state, ...consent }] };
    if (sql.includes("select id,conversation_id,body,sent_at::text as sent_at from messages"))
      return { rows: [consent] };
    if (sql.includes("select id,custom_fields from crm_leads"))
      return { rows: [{ id: lead, custom_fields: state.custom_fields }] };
    if (sql.includes("from conversations cv join contacts c")) return { rows: [state] };
    throw new Error(`Consulta fictícia não prevista: ${sql}`);
  });
  return {
    db: { query } as unknown as Queryable,
    query,
    state,
    consent,
    model,
    currentAgent,
    setPayload(p: Record<string, unknown>) {
      payload = p;
    },
    removeModel() {
      modelExists = false;
    },
  };
}
function preparar(b: ReturnType<typeof banco>, extra: Record<string, unknown> = {}) {
  return prepararRetornoComercialC01(b.db, {
    organizationId: org,
    contactId: contact,
    leadId: lead,
    agentId: agent,
    promisedAt,
    consent: { consent_message_id: message, consent_excerpt: "Pode me chamar" },
    ...extra,
  } as Parameters<typeof prepararRetornoComercialC01>[1]);
}
async function agendado(b: ReturnType<typeof banco>) {
  const p = await preparar(b);
  b.setPayload({ ...p, promised_at: promisedAt, callback_agent_id: agent });
  return p;
}
function conferir(b: ReturnType<typeof banco>, now = new Date(promisedAt)) {
  return conferirRetornoNoEnvioC01(
    b.db,
    { organizationId: org, contactId: contact, jobId: job },
    now,
    new AbortController().signal,
    financeiro,
  );
}
beforeEach(() => {
  vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(cfg));
  financeiro
    .mockReset()
    .mockImplementation(async (input) => ({
      status: "nao_comprou_confirmado",
      complete: true,
      checkedAt: input.now.toISOString(),
    }));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("retorno combinado com modelo explicitamente vinculado", () => {
  it("aceita 48 h somente com vínculo aprovado e assina canal, modelo e agente", async () => {
    const b = banco();
    const p = await agendado(b);
    expect(p.c01_callback).toMatchObject({
      callback_agent_id: agent,
      template: { connection_id: connection, template_id: template, content_hash: contentHash },
    });
    expect(conferirProvaRetornoC01(p.c01_callback)).not.toBeNull();
    await expect(conferir(b)).resolves.toBeUndefined();
  });
  it.each([undefined, { ...cfg.callbackTemplate, enabled: false }])(
    "ausente ou OFF preserva a recusa, sem nova promessa",
    async (binding) => {
      vi.stubEnv(
        "C01_ACOMPANHAMENTO_INTEGRATION",
        JSON.stringify({ ...cfg, callbackTemplate: binding }),
      );
      await expect(preparar(banco())).rejects.toThrow("template_required_before_promise");
    },
  );
  it("dia anotado, sem consentimento explícito, não vira retorno", async () => {
    const b = banco();
    b.consent.body = "Amanhã eu volto.";
    await expect(
      preparar(b, { consent: { consent_message_id: message, consent_excerpt: "Amanhã" } }),
    ).rejects.toThrow("time_not_confirmed");
  });
  it.each(["PENDING", "REJECTED", "PAUSED", "DISABLED"])(
    "modelo %s não permite prometer",
    async (status) => {
      const b = banco();
      b.model.status = status;
      await expect(preparar(b)).rejects.toThrow("template");
    },
  );
  it("modelo apagado, ID de outra definição ou corpo alterado bloqueiam", async () => {
    const b = banco();
    b.removeModel();
    await expect(preparar(b)).rejects.toThrow("template");
    const other = banco();
    other.model.id = id(99);
    await expect(preparar(other)).rejects.toThrow("template");
    const changed = banco();
    changed.model.components[0]!.text += " Alterada.";
    await expect(preparar(changed)).rejects.toThrow("template");
  });
  it("modelo com variável sem contrato de valores bloqueia", async () => {
    const b = banco();
    b.model.components[0]!.text = "Olá, {{1}}.";
    const contentHash = hashDoCorpo({
      name: b.model.name,
      language: b.model.language,
      parameter_format: b.model.parameter_format,
      components: b.model.components,
    });
    vi.stubEnv(
      "C01_ACOMPANHAMENTO_INTEGRATION",
      JSON.stringify({ ...cfg, callbackTemplate: { ...cfg.callbackTemplate, contentHash } }),
    );
    await expect(preparar(b)).rejects.toThrow("template");
  });
  it("não usa modelo de outra conexão ou organização", async () => {
    const b = banco();
    b.state.channel_session_id = id(99);
    await expect(preparar(b)).rejects.toThrow("template");
    await expect(preparar(banco(), { organizationId: id(99) })).rejects.toThrow(
      "configuration_missing",
    );
  });
  it("desligar a configuração depois de agendar impede o envio", async () => {
    const b = banco();
    await agendado(b);
    vi.stubEnv(
      "C01_ACOMPANHAMENTO_INTEGRATION",
      JSON.stringify({ ...cfg, callbackTemplate: { ...cfg.callbackTemplate, enabled: false } }),
    );
    await expect(conferir(b)).rejects.toThrow("template");
  });
  it("modelo alterado ou rejeitado depois de agendar impede envio", async () => {
    const b = banco();
    await agendado(b);
    b.model.status = "REJECTED";
    await expect(conferir(b)).rejects.toThrow("template");
  });
  it.each(["2026-10-25T10:59:00.000Z", "2026-10-26T00:00:00.000Z"])(
    "%s não autoriza antecipar nem enviar fora da faixa",
    async (now) => {
      const b = banco();
      await agendado(b);
      await expect(conferir(b, new Date(now))).rejects.toThrow(/not_due|outside_send_window/);
    },
  );
  it.each(["is_blocked", "ai_opt_out", "force_human"])(
    "%s verificado novamente antes do envio",
    async (key) => {
      const b = banco();
      await agendado(b);
      Object.assign(b.state, { [key]: true });
      await expect(conferir(b)).rejects.toThrow(/restricted|human/);
    },
  );
  it("nova resposta, consentimento alterado e prova adulterada impedem envio", async () => {
    const b = banco();
    const p = await agendado(b);
    b.state.last_inbound_at = "2026-10-24T15:00:00.000Z";
    await expect(conferir(b)).rejects.toThrow("new_reply");
    b.state.last_inbound_at = consentAt;
    b.consent.body += " talvez";
    await expect(conferir(b)).rejects.toThrow("consent_changed");
    expect(
      conferirProvaRetornoC01({ ...p.c01_callback, promised_at: "2026-10-25T16:00:00.000Z" }),
    ).toBeNull();
  });
  it.each(["confirmado", "ambiguo", "indisponivel"])(
    "compra %s impede o retorno",
    async (status) => {
      const b = banco();
      await agendado(b);
      financeiro.mockResolvedValue({
        status,
        complete: status === "confirmado",
        checkedAt: promisedAt,
      });
      await expect(conferir(b)).rejects.toThrow(/purchased|purchase_unconfirmed/);
    },
  );
  it("agente pausado depois do agendamento impede envio mesmo com modelo válido", async () => {
    const b = banco();
    await agendado(b);
    Object.assign(b.currentAgent, { paused_at: consentAt });
    await expect(conferir(b)).rejects.toThrow("agent");
  });
  it("remover a autorização comercial do agente impede envio", async () => {
    const b = banco();
    await agendado(b);
    b.currentAgent.followup.c01_callback = false;
    await expect(conferir(b)).rejects.toThrow("agent");
  });
});
