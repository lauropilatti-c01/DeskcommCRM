import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import { registrarCompraVerificada, type IntegracaoFinanceira, type ProvaFinanceira } from "@/lib/leads/compra-verificada";

const localUrl = process.env.C01_FINANCIAL_TEST_DATABASE_URL;
if (!process.env.TEST_DB_CONTAINER && (!localUrl || new URL(localUrl).hostname !== "127.0.0.1")) throw new Error("Use pnpm test:db ou um banco descartável local explicitamente identificado.");
const pool = new pg.Pool({connectionString: localUrl ?? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 4});
afterAll(() => pool.end());
const NOW = new Date("2026-10-23T02:00:00.000Z");
const TOKEN = "credencial-ficticia-exclusiva-dos-testes";
const settings = {fields: [{key: "pagamento_confirmado", label: "Pagamento confirmado", type: "boolean", obrigatorio_em: {ao_ganhar: true}}]};

async function fixture() {
  const org = randomUUID(), contact = randomUUID(), lead = randomUUID(), pipeline = randomUUID(), stage = randomUUID(), won = randomUUID(), user = randomUUID(), session = randomUUID(), conversation = randomUUID();
  await pool.query("insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Teste financeiro','Teste financeiro')", [org, `fin-${org}`]);
  await pool.query("insert into auth.users(id,email) values($1,$2)", [user, `${user}@example.test`]);
  await pool.query("insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,'agent',now())", [user, org]);
  await pool.query("insert into contacts(id,organization_id,display_name,phone_number,email,force_human) values($1,$2,'Pessoa fictícia','+5511999990001','pessoa@example.test',true)", [contact, org]);
  await pool.query("insert into crm_pipelines(id,organization_id,name,slug,settings) values($1,$2,'Funil fictício','financeiro',$3)", [pipeline, org, settings]);
  await pool.query("insert into crm_stages(id,organization_id,pipeline_id,name,slug,position,is_won) values($1,$2,$3,'Aberto','aberto',1000,false),($4,$2,$3,'Ganho','ganho',2000,true)", [stage, org, pipeline, won]);
  await pool.query("insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,currency,custom_fields,created_at,owner_user_id) values($1,$2,$3,$4,$5,'Negociação fictícia','BRL',$6,'2026-10-01',$7)", [lead, org, pipeline, stage, contact, {produto_chave: "pb-tp-tecnico", plano_oferecido: "vitalicio"}, user]);
  await pool.query("insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00')", [session, org, `fin-${session}`]);
  await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id,status,assigned_to_user_id,assigned_at,assignee_kind) values($1,$2,$3,$4,'claimed',$5,now(),'user')", [conversation, org, contact, session, user]);
  const version = randomUUID(), flow = randomUUID(), enrollment = randomUUID();
  await pool.query("insert into followup_flow_versions(id,organization_id,graph) values($1,$2,'{}')", [version, org]);
  await pool.query("insert into followup_flow_pointers(id,organization_id,name,status,active_version_id) values($1,$2,'Comercial fictício','active',$3)", [flow, org, version]);
  await pool.query("insert into followup_enrollments(id,organization_id,pointer_id,version_id,contact_id,current_node_id,status,next_eval_at) values($1,$2,$3,$4,$5,'start','active',now()+interval '1 day')", [enrollment, org, flow, version, contact]);
  const callback = randomUUID(), access = randomUUID(), job = randomUUID(), accessJob = randomUUID();
  const commercial = {scope: "commercial", lead_id: lead, product_key: "pb-tp-tecnico"};
  await pool.query("insert into cron_jobs(id,organization_id,contact_id,kind,job_kind,next_run_at,payload) values($1,$2,$3,'at','followup_turn',now()+interval '1 day',$4),($5,$2,$3,'at','followup_turn',now()+interval '1 day',$6)", [callback, org, contact, commercial, access, {scope: "access", lead_id: lead}]);
  await pool.query("insert into job_queue(id,organization_id,contact_id,kind,payload,status) values($1,$2,$3,'followup_turn',$4,'pending'),($5,$2,$3,'followup_turn',$6,'pending')", [job, org, contact, {followup_enrollment_id: enrollment}, accessJob, {cron_job_id: access}]);
  const proof: ProvaFinanceira = {transactionId: "tx-ficticia", sourceAccountId: "conta-teste", productId: "produto-origem", offerId: "oferta-origem", status: "paid", paidAt: "2026-10-22T23:00:00.000Z", orderedAt: "2026-10-22T22:00:00.000Z", observedAt: NOW.toISOString(), paidCents: 10000, totalCents: 10000, currency: "BRL", phone: "+5511999990001", email: "pessoa@example.test", evidenceHash: "a".repeat(64)};
  const integration: IntegracaoFinanceira = {enabled: true, integrationId: "guru-test", organizationId: org, provider: "guru", sourceAccountId: "conta-teste", tokenSha256: createHash("sha256").update(TOKEN).digest("hex"), receiptSigningKey: "chave-ficticia-de-assinatura-com-32-caracteres", products: [{productId: "produto-origem", offerId: "oferta-origem", crmProductKey: "pb-tp-tecnico", crmOfferKey: "vitalicio", commercialFlowIds: [flow]}], readAuthoritativePayment: vi.fn(async () => proof)};
  const request = {token: TOKEN, transactionId: proof.transactionId, leadId: lead};
  const deps = {pool, integration, now: () => NOW};
  return {org, contact, lead, pipeline, stage, won, user, conversation, enrollment, callback, access, job, accessJob, proof, integration, request, deps};
}
type F = Awaited<ReturnType<typeof fixture>>;
async function untouched(f: F) {
  expect((await pool.query("select status,custom_fields from crm_leads where id=$1", [f.lead])).rows[0]).toMatchObject({status: "open", custom_fields: {produto_chave: "pb-tp-tecnico"}});
  expect((await pool.query("select custom_fields->'pagamento_confirmado' as paid from crm_leads where id=$1", [f.lead])).rows[0].paid).toBeNull();
  expect((await pool.query("select count(*)::int as n from orders where organization_id=$1", [f.org])).rows[0].n).toBe(0);
  expect((await pool.query("select count(*)::int as n from crm_lead_links where lead_id=$1", [f.lead])).rows[0].n).toBe(0);
  expect((await pool.query("select status from followup_enrollments where id=$1", [f.enrollment])).rows[0].status).toBe("active");
  expect((await pool.query("select enabled from cron_jobs where id=$1", [f.callback])).rows[0].enabled).toBe(true);
  expect((await pool.query("select status from job_queue where id=$1", [f.job])).rows[0].status).toBe("pending");
}

describe("C01 compra verificada — PostgreSQL real, fonte sintética e integração desligada por padrão", () => {
  it("desligada, credencial errada e falta de adaptador recusam antes da fonte", async () => {
    const f = await fixture();
    await expect(registrarCompraVerificada({...f.deps, integration: {...f.integration, enabled: undefined}}, f.request)).rejects.toMatchObject({code: "financial_integration_disabled"});
    await expect(registrarCompraVerificada(f.deps, {...f.request, token: "mcp-nao-e-financeiro"})).rejects.toMatchObject({code: "financial_unauthorized"});
    await expect(registrarCompraVerificada({...f.deps, integration: {...f.integration, readAuthoritativePayment: undefined}}, f.request)).rejects.toMatchObject({code: "financial_source_unavailable"});
    expect(f.integration.readAuthoritativePayment).not.toHaveBeenCalled();
    await untouched(f);
  });

  it("aplica uma vez, relê a fonte no replay, cancela só comercial e preserva atendimento humano", async () => {
    const f = await fixture();
    const before = (await pool.query("select * from conversations where id=$1", [f.conversation])).rows[0];
    const result = await registrarCompraVerificada(f.deps, f.request);
    expect(result).toMatchObject({status: "applied", leadId: f.lead, cancelledEnrollments: [f.enrollment], cancelledCallbacks: [f.callback], cancelledJobs: [f.job]});
    expect((await pool.query("select status,stage_id,owner_user_id,custom_fields from crm_leads where id=$1", [f.lead])).rows[0]).toMatchObject({status: "won", stage_id: f.won, owner_user_id: f.user, custom_fields: {pagamento_confirmado: true}});
    expect((await pool.query("select force_human from contacts where id=$1", [f.contact])).rows[0].force_human).toBe(true);
    expect((await pool.query("select * from conversations where id=$1", [f.conversation])).rows[0]).toEqual(before);
    expect((await pool.query("select status,cancel_reason from followup_enrollments where id=$1", [f.enrollment])).rows[0]).toMatchObject({status: "cancelled", cancel_reason: "purchase_confirmed"});
    expect((await pool.query("select enabled from cron_jobs where id=$1", [f.access])).rows[0].enabled).toBe(true);
    expect((await pool.query("select status from job_queue where id=$1", [f.accessJob])).rows[0].status).toBe("pending");
    expect((await pool.query("select status,last_error from job_queue where id=$1", [f.job])).rows[0]).toMatchObject({status: "failed", last_error: "purchase_confirmed"});
    f.proof.evidenceHash = "b".repeat(64);
    expect(await registrarCompraVerificada(f.deps, f.request)).toMatchObject({status: "replay", orderId: result.orderId});
    expect(f.integration.readAuthoritativePayment).toHaveBeenCalledTimes(2);
    expect((await pool.query("select count(*)::int as n from orders where organization_id=$1", [f.org])).rows[0].n).toBe(1);
  });

  it.each(["recibo", "vinculo", "ganho", "cancelamento"] as const)("falha após %s desfaz todos os efeitos; uma nova tentativa completa", async stage => {
    const f = await fixture();
    await expect(registrarCompraVerificada({...f.deps, afterWrite: async current => { if (current === stage) throw new Error("falha provocada"); }}, f.request)).rejects.toThrow("falha provocada");
    await untouched(f);
    expect(await registrarCompraVerificada(f.deps, f.request)).toMatchObject({status: "applied"});
  });

  it("concorrência no mesmo contato não duplica; a tentativa ocupada pode repetir", async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const first = registrarCompraVerificada({...f.deps, afterWrite: async stage => { if (stage === "recibo") { entered(); await wait; } }}, f.request);
    await started;
    await expect(registrarCompraVerificada(f.deps, f.request)).rejects.toMatchObject({code: "financial_contact_busy"});
    release();
    await first;
    expect(await registrarCompraVerificada(f.deps, f.request)).toMatchObject({status: "replay"});
  });

  it("empresa diferente não lê a oportunidade nem consulta a fonte", async () => {
    const f = await fixture();
    await expect(registrarCompraVerificada({...f.deps, integration: {...f.integration, organizationId: randomUUID()}}, f.request)).rejects.toMatchObject({code: "financial_lead_not_found"});
    expect(f.integration.readAuthoritativePayment).not.toHaveBeenCalled();
    await untouched(f);
  });

  it.each([
    ["sem fonte", "financial_source_unavailable", async () => { throw new Error("offline"); }],
    ["JSON do espelho", "financial_evidence_invalid", async () => ({paid: true, pago_em: NOW.toISOString()})],
    ["pagamento pendente", "financial_evidence_invalid", (p: ProvaFinanceira) => ({...p, status: "pending"})],
    ["consulta velha", "financial_evidence_invalid", (p: ProvaFinanceira) => ({...p, observedAt: "2026-10-22T20:00:00Z"})],
    ["outra conta", "financial_evidence_invalid", (p: ProvaFinanceira) => ({...p, sourceAccountId: "outra"})],
    ["outra transação", "financial_evidence_invalid", (p: ProvaFinanceira) => ({...p, transactionId: "outra"})],
    ["pagamento parcial", "financial_evidence_invalid", (p: ProvaFinanceira) => ({...p, paidCents: 100})],
    ["telefone divergente", "financial_identity_mismatch", (p: ProvaFinanceira) => ({...p, phone: "+5511999990002"})],
    ["produto desconhecido", "financial_product_unmapped", (p: ProvaFinanceira) => ({...p, productId: "outro"})],
    ["compra antiga", "financial_opportunity_mismatch", (p: ProvaFinanceira) => ({...p, paidAt: "2026-09-01T01:00:00Z", orderedAt: "2026-09-01T00:00:00Z"})],
    ["pedido antigo pago agora", "financial_opportunity_mismatch", (p: ProvaFinanceira) => ({...p, orderedAt: "2026-09-01T00:00:00Z"})],
  ] as const)("%s não vira ganho", async (_label, code, adapter) => {
    const f = await fixture();
    f.integration.readAuthoritativePayment = async () => adapter(f.proof);
    await expect(registrarCompraVerificada(f.deps, f.request)).rejects.toMatchObject({code});
    await untouched(f);
  });

  it("telefone e e-mail apontando para pessoas diferentes seguem para revisão", async () => {
    const f = await fixture();
    await pool.query("update contacts set email=null where id=$1", [f.contact]);
    await pool.query("insert into contacts(organization_id,display_name,email) values($1,'Outra pessoa fictícia','pessoa@example.test')", [f.org]);
    await expect(registrarCompraVerificada(f.deps, f.request)).rejects.toMatchObject({code: "financial_identity_ambiguous"});
    await untouched(f);
  });

  it("duas oportunidades abertas exigem revisão antes de cancelar a sequência do contato", async () => {
    const f = await fixture();
    await pool.query("insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,'Outra negociação')", [f.org, f.pipeline, f.stage, f.contact]);
    await expect(registrarCompraVerificada(f.deps, f.request)).rejects.toMatchObject({code: "financial_opportunity_ambiguous"});
    await untouched(f);
  });

  it("mantém os demais campos obrigatórios do funil", async () => {
    const f = await fixture();
    await pool.query("update crm_pipelines set settings=$2 where id=$1", [f.pipeline, {fields: [...settings.fields, {key: "enfase", label: "Ênfase", type: "text", obrigatorio_em: {ao_ganhar: true}}]}]);
    await expect(registrarCompraVerificada(f.deps, f.request)).rejects.toMatchObject({code: "financial_required_fields_missing"});
    await untouched(f);
  });

  it.each(["lease", "running"] as const)("%s de envio em curso exige nova tentativa, sem compra parcial", async state => {
    const f = await fixture();
    if (state === "lease") await pool.query("update followup_enrollments set claimed_until=$2 where id=$1", [f.enrollment, new Date(NOW.getTime()+60_000)]);
    else await pool.query("update job_queue set status='running' where id=$1", [f.job]);
    await expect(registrarCompraVerificada(f.deps, f.request)).rejects.toMatchObject({code: "financial_followup_busy"});
    if (state === "running") await pool.query("update job_queue set status='pending' where id=$1", [f.job]);
    await untouched(f);
  });

  it("recibo forjado no JSON de orders não autoriza replay nem ganho", async () => {
    const f = await fixture();
    await pool.query("insert into orders(organization_id,external_provider,external_id,contact_id,status,total_cents,currency,payload,ordered_at) values($1,'external','guru-test:tx-ficticia',$2,'paid',10000,'BRL',$3,now())", [f.org, f.contact, {platform: "guru", financial_receipt: {signature: "inventada"}}]);
    await expect(registrarCompraVerificada(f.deps, f.request)).rejects.toMatchObject({code: "financial_receipt_conflict"});
    expect((await pool.query("select status from crm_leads where id=$1", [f.lead])).rows[0].status).toBe("open");
  });

  it("recibo adulterado depois da primeira execução impede replay", async () => {
    const f = await fixture();
    const result = await registrarCompraVerificada(f.deps, f.request);
    await pool.query("update orders set payload=jsonb_set(payload,'{financial_receipt,signature}','\"forjada\"') where id=$1", [result.orderId]);
    await expect(registrarCompraVerificada(f.deps, f.request)).rejects.toMatchObject({code: "financial_receipt_conflict"});
  });

  it("a mesma compra não ganha uma segunda oportunidade", async () => {
    const f = await fixture();
    await registrarCompraVerificada(f.deps, f.request);
    const other = (await pool.query("insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title,custom_fields,created_at) values($1,$2,$3,$4,'Segunda negociação',$5,'2026-10-01') returning id", [f.org, f.pipeline, f.stage, f.contact, {produto_chave: "pb-tp-tecnico", plano_oferecido: "vitalicio"}])).rows[0].id;
    await expect(registrarCompraVerificada(f.deps, {...f.request, leadId: other})).rejects.toMatchObject({code: "financial_receipt_conflict"});
    expect((await pool.query("select status from crm_leads where id=$1", [other])).rows[0].status).toBe("open");
  });

  it("cancela envio já enfileirado por cron disparado e enrollment concluído, preservando seu histórico", async () => {
    const f = await fixture();
    await pool.query("update followup_enrollments set status='completed',next_eval_at=null where id=$1", [f.enrollment]);
    await pool.query("update cron_jobs set enabled=false where id=$1", [f.callback]);
    const cronJob = (await pool.query("insert into job_queue(organization_id,contact_id,kind,payload) values($1,$2,'followup_turn',$3) returning id", [f.org, f.contact, {cron_job_id: f.callback}])).rows[0].id;
    const result = await registrarCompraVerificada(f.deps, f.request);
    expect(result.cancelledEnrollments).toEqual([]);
    expect(result.cancelledCallbacks).toEqual([]);
    expect(new Set(result.cancelledJobs)).toEqual(new Set([f.job, cronJob]));
    expect((await pool.query("select status from followup_enrollments where id=$1", [f.enrollment])).rows[0].status).toBe("completed");
    expect((await pool.query("select cancelled_at from cron_jobs where id=$1", [f.callback])).rows[0].cancelled_at).toBeNull();
  });

  it.each(["dormente", "coletando"])("compra cancela o estado nativo %s sem esperar o próximo toque", async status => {
    const f = await fixture();
    await pool.query("update followup_enrollments set status=$2 where id=$1", [f.enrollment, status]);
    expect(await registrarCompraVerificada(f.deps, f.request)).toMatchObject({cancelledEnrollments: [f.enrollment]});
    expect((await pool.query("select status from followup_enrollments where id=$1", [f.enrollment])).rows[0].status).toBe("cancelled");
  });

  it("uma conexão basta: todas as escritas usam a sessão da trava", async () => {
    const f = await fixture();
    const single = new pg.Pool({connectionString: localUrl ?? `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`, max: 1});
    try {
      expect(await registrarCompraVerificada({...f.deps, pool: single}, f.request)).toMatchObject({status: "applied"});
    } finally { await single.end(); }
  }, 5_000);

  it("fonte que ignora cancelamento não segura a trava indefinidamente", async () => {
    const f = await fixture();
    f.integration.readAuthoritativePayment = async () => new Promise(() => {});
    await expect(registrarCompraVerificada(f.deps, f.request)).rejects.toMatchObject({code: "financial_source_unavailable"});
    await untouched(f);
    f.integration.readAuthoritativePayment = async () => f.proof;
    expect(await registrarCompraVerificada(f.deps, f.request)).toMatchObject({status: "applied"});
  }, 12_000);
});
