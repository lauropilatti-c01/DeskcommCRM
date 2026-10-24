import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it, vi } from "vitest";

// Rota, assinatura, parser, ingestor e RPCs canônicas reais. Este adaptador
// só transporta as consultas usadas pelo ingestor ao PG descartável oficial.
// Não representa o transporte PostgREST/Meta nem executa efeitos comerciais.
const estado = vi.hoisted(() => ({
  admin: null as SupabaseClient | null,
  org: "",
  session: "",
  efeitos: [] as string[],
}));
vi.mock("@/lib/channels/meta/session", () => ({
  metaSessionByWebhookToken: async () => ({
    id: estado.session,
    organizationId: estado.org,
    wabaId: "waba-ficticia",
  }),
}));
vi.mock("@/lib/channels/meta/app", () => ({
  appDaMeta: async () => ({ appSecret: "segredo-ficticio", verifyToken: "teste" }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => estado.admin }));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));
vi.mock("@/lib/escalacao/resposta-whatsapp-ao-caso", () => ({
  consumirRespostaDoSuporteNoWhatsApp: async () => false,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
  registrarMensagemIgnorada: async () => undefined,
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  aplicarEfeitosPosEntrada: async (_: unknown, entrada: { messageId: string }) => {
    estado.efeitos.push(entrada.messageId);
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
import { POST } from "@/app/api/v1/webhooks/meta/[token]/route";

if (!process.env.TEST_DB_CONTAINER || !process.env.TEST_DB_PORT)
  throw new Error("Use pnpm test:db: somente banco descartável local.");
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
  max: 12,
});
afterAll(() => pool.end());
const ctx = { params: Promise.resolve({ token: "fixture" }) };
function request(ids: string[]) {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-ficticia",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: estado.session },
              messages: ids.map((id) => ({
                id,
                from: "5511999990001",
                timestamp: "1792836000",
                type: "text",
                text: { body: "Somente fixture" },
              })),
            },
          },
        ],
      },
    ],
  });
  return {
    text: async () => raw,
    headers: new Headers({
      "x-hub-signature-256":
        "sha256=" + createHmac("sha256", "segredo-ficticio").update(raw).digest("hex"),
    }),
  } as never;
}
function identifier(value: string) {
  if (!/^[a-z_]+$/.test(value)) throw new Error("Identificador fora do contrato do teste");
  return `"${value}"`;
}
async function fixture(options: { timeoutId?: string; respostaPerdidaId?: string } = {}) {
  estado.org = randomUUID();
  estado.session = randomUUID();
  estado.efeitos = [];
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name) values($1,$2,'ACK fictício','ACK fictício')",
    [estado.org, "ack-" + estado.org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,provider,meta_phone_number_id) values($1,$2,$3,'\\x00','meta_cloud',$4)",
    [estado.session, estado.org, "ack-" + estado.session, estado.session],
  );
  const falhas: string[] = [];
  let bloquear = Boolean(options.timeoutId),
    perderResposta = Boolean(options.respostaPerdidaId);
  const admin = {
    async rpc(name: string, args: Record<string, unknown>) {
      if (
        ![
          "fn_upsert_wa_contact",
          "fn_upsert_wa_conversation",
          "fn_mark_conversation_message",
          "emit_event",
        ].includes(name)
      )
        throw new Error("RPC fora do contrato: " + name);
      try {
        const fields = Object.keys(args);
        const result = await pool.query(
          `select public.${identifier(name)}(${fields.map((key, i) => `${identifier(key)} => $${i + 1}`).join(",")}) as value`,
          Object.values(args),
        );
        return { data: result.rows[0]?.value, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
    from(table: string) {
      if (!["messages", "channel_sessions"].includes(table))
        throw new Error("Tabela fora do contrato: " + table);
      let row: Record<string, unknown> | undefined;
      let columns = "id";
      const filters: [string, unknown][] = [];
      const query = {
        select(value: string) {
          columns = value;
          return query;
        },
        eq(key: string, value: unknown) {
          filters.push([key, value]);
          return query;
        },
        is(key: string, value: null) {
          filters.push([key, value]);
          return query;
        },
        insert(value: Record<string, unknown>) {
          row = value;
          return query;
        },
        async maybeSingle() {
          let client: pg.PoolClient | undefined, blocker: pg.PoolClient | undefined;
          try {
            let result: pg.QueryResult;
            if (row) {
              client = await pool.connect();
              await client.query("set lock_timeout='100ms'");
              if (bloquear && row.external_id === options.timeoutId) {
                bloquear = false;
                blocker = await pool.connect();
                await blocker.query("begin");
                await blocker.query("lock table public.messages in access exclusive mode");
              }
              const fields = Object.keys(row);
              result = await client.query(
                `insert into public.${identifier(table)}(${fields.map(identifier).join(",")}) values(${fields.map((_, i) => "$" + (i + 1)).join(",")}) returning ${columns
                  .split(",")
                  .map((c) => identifier(c.trim()))
                  .join(",")}`,
                Object.values(row),
              );
              if (perderResposta && row.external_id === options.respostaPerdidaId) {
                perderResposta = false;
                return {
                  data: null,
                  error: { code: "08006", message: "Resposta perdida depois do commit (seam)" },
                };
              }
            } else {
              const args: unknown[] = [];
              const where = filters
                .map(([key, value]) =>
                  value === null
                    ? `${identifier(key)} is null`
                    : `${identifier(key)}=$${args.push(value)}`,
                )
                .join(" and ");
              result = await pool.query(
                `select ${columns
                  .split(",")
                  .map((c) => identifier(c.trim()))
                  .join(",")} from public.${identifier(table)} where ${where}`,
                args,
              );
            }
            return {
              data: result.rows.length === 1 ? result.rows[0] : null,
              error:
                result.rows.length > 1 ? { code: "PGRST116", message: "Múltiplas linhas" } : null,
            };
          } catch (error) {
            falhas.push((error as { code: string }).code);
            return { data: null, error };
          } finally {
            if (blocker) {
              await blocker.query("rollback");
              blocker.release();
            }
            if (client) {
              await client.query("reset lock_timeout");
              client.release();
            }
          }
        },
      };
      return query;
    },
  };
  estado.admin = admin as unknown as SupabaseClient;
  const org = estado.org;
  return {
    org,
    falhas,
    rows: async () =>
      (
        await pool.query(
          "select id,external_id,direction from messages where organization_id=$1 order by external_id",
          [org],
        )
      ).rows,
  };
}

describe("ACK Meta e banco canônico", () => {
  it("lock real no segundo insert gera 503; replay conserva A e grava B uma vez", async () => {
    const f = await fixture({ timeoutId: "B" });
    expect((await POST(request(["A", "B"]), ctx)).status).toBe(503);
    expect(f.falhas).toContain("55P03");
    expect((await f.rows()).map((row) => row.external_id)).toEqual(["A"]);
    expect((await POST(request(["A", "B"]), ctx)).status).toBe(200);
    const rows = await f.rows();
    expect(rows.map((row) => row.external_id)).toEqual(["A", "B"]);
    expect(estado.efeitos.sort()).toEqual(rows.map((row) => row.id).sort());
  });
  it("oito requisições concorrentes têm uma mensagem e um conjunto de efeitos", async () => {
    const f = await fixture();
    const responses = await Promise.all(Array.from({ length: 8 }, () => POST(request(["C"]), ctx)));
    expect(responses.map((response) => response.status)).toEqual(Array(8).fill(200));
    const rows = await f.rows();
    expect(rows).toHaveLength(1);
    expect(estado.efeitos).toEqual([rows[0].id]);
    expect(f.falhas.filter((code) => code === "23505")).toHaveLength(7);
  });
  it("conflito real com sentido diferente não vira confirmação de duplicata", async () => {
    const f = await fixture();
    expect((await POST(request(["D"]), ctx)).status).toBe(200);
    await pool.query("update messages set direction='outbound' where organization_id=$1", [f.org]);
    expect((await POST(request(["D"]), ctx)).status).toBe(503);
    expect(await f.rows()).toHaveLength(1);
    expect(estado.efeitos).toHaveLength(1);
  });
  it("ID externo igual em outro tenant é outra mensagem, não duplicata", async () => {
    const first = await fixture();
    expect((await POST(request(["E"]), ctx)).status).toBe(200);
    const second = await fixture();
    expect((await POST(request(["E"]), ctx)).status).toBe(200);
    const a = await first.rows(),
      b = await second.rows();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].id).not.toBe(b[0].id);
  });
  it("resposta perdida depois do commit pede retry, que relê a mensagem exata", async () => {
    const f = await fixture({ respostaPerdidaId: "F" });
    expect((await POST(request(["F"]), ctx)).status).toBe(503);
    expect(await f.rows()).toHaveLength(1);
    expect((await POST(request(["F"]), ctx)).status).toBe(200);
    expect(await f.rows()).toHaveLength(1);
    // Limite intencional: esta fatia confirma ingestão, não repara efeitos
    // pós-entrada que não começaram quando a resposta do INSERT se perdeu.
    expect(estado.efeitos).toHaveLength(0);
  });
});
