import type * as Acompanhamento from "@/lib/followup/c01-acompanhamento-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { EsperaFinanceiraC01Error, BloqueioFinanceiroC01Error } from "@/lib/followup/c01-financeiro-espera";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import { sendWithLedger, type SendLedgerStatus } from "@/lib/agent-engine/edge/crm/send-ledger";
import type { HandlerCtx } from "@/lib/api/handlers/types";
const h = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@/lib/followup/c01-acompanhamento-runtime", async (original) => ({
  ...(await original<typeof Acompanhamento>()),
  comEnvioAcompanhamentoC01: async (
    _db: unknown,
    _scope: unknown,
    _org: unknown,
    action: () => Promise<unknown>,
  ) => action(),
  assertAcompanhamentoC01Supabase: h.check,
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
const org = "11111111-1111-4111-8111-111111111111",
  conv = "22222222-2222-4222-8222-222222222222",
  contact = "33333333-3333-4333-8333-333333333333",
  session = "44444444-4444-4444-8444-444444444444",
  jobId = "55555555-5555-4555-8555-555555555555";
const ctx: HandlerCtx = {
  organization_id: org,
  actor: { type: "ai_agent", id: "agent-engine", role: "manager" },
  requestId: "fixture",
  proactiveContext: {
    organizationId: org,
    contactId: contact,
    jobId,
    jobClaim: { worker_id: "ficticio", acquired_at: "2026-10-24T15:00:00Z" },
  },
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  h.check.mockReset();
});
describe("espera financeira C01: veto atravessa o handler sem ser convertido em mensagem de sucesso", () => {
  it.each(["espera-inicial", "espera-final", "bloqueio-inicial", "bloqueio-final"])(
    "propaga a exceção tipada no corte %s sem transporte",
    async (cut) => {
      vi.stubEnv("WAHA_API_BASE_URL", "http://127.0.0.1:1");
      vi.stubEnv("WAHA_API_KEY", "ficticio");
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const veto = cut.startsWith("espera") ? new EsperaFinanceiraC01Error("2026-10-24T18:01:00Z") : new BloqueioFinanceiroC01Error("compras_sem_conferencia_univoca");
      if (cut.endsWith("final")) h.check.mockResolvedValueOnce(undefined);
      h.check.mockRejectedValue(veto);
      const { supabase, mensagens } = criarDubleDoHandler({
        conversation: {
          id: conv,
          organization_id: org,
          contact_id: contact,
          channel_session_id: session,
          is_group: false,
          group_chat_id: null,
          contacts: { phone_number: "+5511999990000", wa_identity: null, is_blocked: false },
          channel_sessions: {
            provider: "waha",
            waha_session_name: "ficticio",
            status: "WORKING",
            archived_at: null,
          },
        },
        rpcData: true,
      });
      await expect(
        sendMessageHandler(supabase, ctx, {
          conversation_id: conv,
          type: "text",
          body: "Retorno fictício",
        }),
      ).rejects.toBe(veto);
      expect(fetch).not.toHaveBeenCalled();
      expect(mensagens).toHaveLength(cut.endsWith("inicial") ? 0 : 1);
      expect(mensagens.some((m) => m.status === "sent" || m.status === "delivered")).toBe(false);
    },
  );
});

it("handler e ledger reais retomam o mesmo ID uma vez após a fonte recuperar", async () => {
  vi.stubEnv("WAHA_API_BASE_URL", "http://127.0.0.1:1");
  vi.stubEnv("WAHA_API_KEY", "ficticio");
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ id: "recibo-ficticio" }),{status:200}));
  vi.stubGlobal("fetch",fetch);
  const f = criarDubleDoHandler({
    indiceUnicoMensagemId:true,
    conversation:{id:conv,organization_id:org,contact_id:contact,channel_session_id:session,is_group:false,group_chat_id:null,
      contacts:{phone_number:"+5511999990000",wa_identity:null,is_blocked:false},
      channel_sessions:{provider:"waha",waha_session_name:"ficticio",status:"WORKING",archived_at:null}},rpcData:true,
  });
  const key="66666666-6666-4666-8666-666666666666";
  let exists=false,status:SendLedgerStatus="requested";
  const store:Parameters<typeof sendWithLedger>[0]={
    create:async()=>{if(exists)throw {code:"23505"};exists=true;return key;},
    find:async()=>exists?{id:key,status,crm_message_id:null}:null,
    rotate:async()=>{throw new Error("Não deve trocar a intenção durante espera");},
    message:async()=>{const m=f.mensagens.find(x=>x.id===key);return m?{id:key,status:String(m.status)}:null;},
    update:async(_org,_key,value)=>{status=value;},
  };
  const intent={tenantId:org,leadId:contact,jobId,seq:1,body:"Retorno fictício"};
  const send=()=>sendWithLedger(store,intent,async(id)=>sendMessageHandler(f.supabase,{...ctx,internalMessageId:id},
    {conversation_id:conv,type:"text",body:intent.body,metadata:{idempotency_key:id}}));
  const wait=new EsperaFinanceiraC01Error("2026-10-24T18:01:00Z");
  h.check.mockResolvedValueOnce(undefined).mockRejectedValue(wait);
  await expect(send()).rejects.toBe(wait);
  expect(status).toBe("requested");expect(f.mensagens).toHaveLength(1);
  expect(f.mensagens[0]).toMatchObject({id:key,status:"queued",external_id:null});expect(fetch).not.toHaveBeenCalled();
  h.check.mockResolvedValue(undefined);
  expect((await send()).kind).toBe("sent");
  expect(status).toBe("accepted");expect(f.mensagens).toHaveLength(1);
  expect(fetch.mock.calls.filter(([url])=>String(url).endsWith("/api/sendText"))).toHaveLength(1);
  const calls=fetch.mock.calls.length;
  expect((await send()).kind).toBe("already_sent");expect(fetch).toHaveBeenCalledTimes(calls);
});
