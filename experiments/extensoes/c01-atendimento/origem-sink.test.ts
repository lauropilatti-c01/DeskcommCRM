import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { conferirOrigemC01, hashDoConteudoDaOrigem } from "@/lib/followup/c01-origem";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";

vi.hoisted(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fixture-anon");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fixture-service");
});
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function fixture() {
  const organizationId = randomUUID(),
    contactId = randomUUID(),
    conversationId = randomUUID(),
    leadId = randomUUID();
  const config = {
    enabled: true,
    organizationId,
    tokenSha256: "a".repeat(64),
    signingKey: "b".repeat(32),
    allowedKinds: ["cronograma", "oferta"] as ("cronograma" | "oferta")[],
  };
  vi.stubEnv("C01_ACOMPANHAMENTO_INTEGRATION", JSON.stringify(config));
  vi.stubEnv("WAHA_API_BASE_URL", "http://127.0.0.1:1");
  vi.stubEnv("WAHA_API_KEY", "fixture");
  const transport = vi.fn(() => {
    throw new Error("Transporte externo proibido nesta prova");
  });
  vi.stubGlobal("fetch", transport);
  const rig = criarDubleDoHandler({
    conversation: {
      id: conversationId,
      organization_id: organizationId,
      contact_id: contactId,
      channel_session_id: randomUUID(),
      is_group: false,
      contacts: { phone_number: "+5500000000000", is_blocked: false },
      channel_sessions: {
        provider: "waha",
        waha_session_name: "ficticio",
        status: "STOPPED",
        archived_at: null,
      },
    },
    rpcData: true,
  });
  const ctx: HandlerCtx = {
    organization_id: organizationId,
    actor: { type: "user", id: randomUUID() },
    requestId: randomUUID(),
  };
  return { ...rig, config, ctx, conversationId, leadId, transport };
}

describe("origem passa somente pelo contexto interno do handler real", () => {
  it("metadata pública forjada é descartada antes de persistir", async () => {
    const f = fixture();
    await sendMessageHandler(f.supabase, f.ctx, {
      conversation_id: f.conversationId,
      type: "text",
      body: "Cronograma fictício",
      metadata: {
        c01_origin: { kind: "cronograma", leadId: f.leadId, signature: "f".repeat(64) },
        etiqueta: "preservada",
      },
    });
    expect(f.mensagens).toHaveLength(1);
    expect(f.mensagens[0]!.metadata).toMatchObject({ c01_origin: null, etiqueta: "preservada" });
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("contexto interno grava prova vinculada ao conteúdo e à mensagem efetivamente persistida", async () => {
    const f = fixture();
    await sendMessageHandler(
      f.supabase,
      {
        ...f.ctx,
        c01Origin: { kind: "cronograma", leadId: f.leadId, productKey: "produto-ficticio" },
      },
      {
        conversation_id: f.conversationId,
        type: "text",
        body: "Cronograma fictício",
        metadata: { c01_origin: "tentativa de sobrescrever" },
      },
    );
    expect(f.mensagens).toHaveLength(1);
    const persisted = f.mensagens[0]!;
    const metadata = persisted.metadata as Record<string, unknown>;
    const proof = conferirOrigemC01(f.config, metadata.c01_origin);
    expect(proof).toMatchObject({
      kind: "cronograma",
      leadId: f.leadId,
      messageId: persisted.id,
      conversationId: f.conversationId,
      organizationId: f.config.organizationId,
      contentHash: hashDoConteudoDaOrigem(persisted),
    });
    expect(f.transport).not.toHaveBeenCalled();
  });
});
