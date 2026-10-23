import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { dispatchWahaEvent } from "../../lib/waha/ingest";
import type { getLeadContext } from "../../lib/agent-engine/edge/crm/get-lead-context";
import { fecharRedeNoLocal } from "./rede-local";
import { MARCADOR_NAO_LIDA } from "../../lib/messaging/media/derivable";

const executar = promisify(execFile);
const org = randomUUID();
const canal = randomUUID();
const resposta = "Tenho duas horas por dia para estudar. [RESPOSTA FICTÍCIA]";
const chave = "fixture-transcription-only";
const audio = readFileSync(process.env.C01_AUDIO_FILE ?? "");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let servidor: Server;
let admin: SupabaseClient;
let db: pg.Pool;
let recusadas: string[];
let ingest: typeof dispatchWahaEvent;
let context: typeof getLeadContext;
const chamadas: Array<{ hash: string; model: unknown; language: unknown; authorization?: string }> =
  [];
let downloads = 0;
let recusarTranscricao = false;
let porta: number;
interface Mensagem {
  id: string;
  contact_id: string;
  conversation_id: string;
  media_derived_text: string | null;
  media_derived_status: string | null;
  media_storage_path: string | null;
  media_size_bytes: string | null;
  metadata: Record<string, unknown>;
}
let mensagem: Mensagem;
let antigo: Mensagem;
const sessao = {
  id: canal,
  organization_id: org,
  waha_session_name: "audio-ficticio",
  is_warmup_complete: true,
  warmup_started_at: null,
};

async function worker() {
  const { stdout } = await executar(
    process.execPath,
    ["--import", "tsx", "tests/c01-audio/worker-local.ts"],
    { cwd: process.cwd(), env: process.env, timeout: 45_000, maxBuffer: 2_000_000 },
  );
  const linha = stdout.split("\n").find((v) => v.startsWith("C01_AUDIO_RESULT="));
  if (!linha) throw new Error(stdout);
  const result = JSON.parse(linha.slice("C01_AUDIO_RESULT=".length));
  expect(result.recusadas).toEqual([]);
  return result.resumo;
}
async function lerMensagem(id: string) {
  const { rows } = await db.query<Mensagem>(
    "select * from messages where id=$1 and organization_id=$2",
    [id, org],
  );
  if (!rows[0]) throw new Error("Mensagem fictícia ausente.");
  return rows[0];
}
async function receber(externalId: string) {
  await ingest(
    admin,
    sessao,
    {
      event: "message",
      session: "audio-ficticio",
      payload: {
        id: externalId,
        from: "5511999990000@c.us",
        to: "5511999990001@c.us",
        fromMe: false,
        timestamp: Math.floor(Date.now() / 1000),
        type: "ptt",
        body: "",
        hasMedia: true,
        media: { url: `http://127.0.0.1:${porta}/audio.wav`, mimetype: "audio/wav" },
      },
    },
    randomUUID(),
  );
  for (let i = 0; i < 50; i++) {
    const { rows } = await db.query<Mensagem>(
      `select m.* from messages m where organization_id=$1 and external_id=$2
      and exists(select 1 from event_log e where e.entity_id=m.id and e.event_type='media.persist_requested')`,
      [org, externalId],
    );
    if (rows[0]) return rows[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("A entrada não gerou mensagem e evento de persistência.");
}
async function contextoDa(m: Mensagem) {
  const r = await context(
    db,
    { supabase: admin },
    {
      tenantId: org,
      leadId: m.contact_id,
      conversationId: m.conversation_id,
      fuso: "America/Sao_Paulo",
    },
    { historyLimit: 20, maxTokens: 4000 },
  );
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.context.messages;
}

beforeAll(async () => {
  servidor = createServer(async (req, res) => {
    if (req.url === "/audio.wav") {
      downloads++;
      expect(req.headers["x-api-key"]).toBe("fixture-waha-only");
      res
        .writeHead(200, { "content-type": "audio/wav", "content-length": audio.length })
        .end(audio);
      return;
    }
    if (req.url !== "/v1/audio/transcriptions") {
      res.writeHead(404).end();
      return;
    }
    const partes: Buffer[] = [];
    for await (const p of req) partes.push(Buffer.from(p));
    const form = await new Response(Buffer.concat(partes), {
      headers: { "content-type": req.headers["content-type"]! },
    }).formData();
    const arquivo = form.get("file") as File;
    chamadas.push({
      hash: sha(new Uint8Array(await arquivo.arrayBuffer())),
      model: form.get("model"),
      language: form.get("language"),
      authorization: req.headers.authorization,
    });
    res.writeHead(recusarTranscricao ? 401 : 200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        recusarTranscricao ? { error: { message: "Recusa fictícia." } } : { text: resposta },
      ),
    );
  });
  await new Promise<void>((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  porta = (servidor.address() as { port: number }).port;
  process.env.TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${porta}/v1`;
  process.env.WAHA_API_BASE_URL = `http://127.0.0.1:${porta}`;
  process.env.TRANSCRIPTION_API_KEY = chave;
  process.env.TRANSCRIPTION_MODEL = "whisper-1";
  process.env.TRANSCRIPTION_LANGUAGES = "pt";
  process.env.WAHA_API_KEY = "fixture-waha-only";
  process.env.EVENT_LOG_WORKER_DRAINS = "true";
  process.env.OPENROUTER_API_KEY = "fixture-chat-never-called";
  process.env.IA_DESTINOS_INTERNOS_PERMITIDOS = "127.0.0.1/32";
  process.env.OPENAI_API_KEY = "";
  process.env.ANTHROPIC_API_KEY = "";
  ({ recusadas } = fecharRedeNoLocal());
  db = new pg.Pool({ connectionString: process.env.SUPABASE_DB_URL, max: 2 });
  const foraDaBancada = await db.query(
    "select count(*)::int as n from organizations where slug not like 'audio-%'",
  );
  if (foraDaBancada.rows[0].n !== 0) throw new Error("Banco não é exclusivo desta prova fictícia.");
  ({ dispatchWahaEvent: ingest } = await import("../../lib/waha/ingest"));
  ({ getLeadContext: context } = await import("../../lib/agent-engine/edge/crm/get-lead-context"));
  admin = (await import("../../lib/supabase/admin")).createAdminClient();
  await db.query(
    `insert into organizations (id,slug,legal_name,display_name,settings) values ($1,$2,$3,$3,$4)`,
    [
      org,
      `audio-${org}`,
      "Bancada fictícia de áudio",
      JSON.stringify({
        llm: { provider: "openrouter", default_model: "fixture-chat" },
        ai_dispatch_mode: "off",
      }),
    ],
  );
  await db.query(
    `insert into channel_sessions (id,organization_id,waha_session_name,webhook_secret_encrypted,status) values ($1,$2,$3,$4,'WORKING')`,
    [canal, org, `audio-${org}`, Buffer.from("fixture-secret-no-webhook-publicado")],
  );
});
afterAll(async () => {
  expect(recusadas ?? []).toEqual([]);
  await db?.end();
  if (servidor)
    await new Promise<void>((resolve, reject) =>
      servidor.close((err) => (err ? reject(err) : resolve())),
    );
});

describe("Áudio fictício: ingestão, fila, Storage, worker e contexto reais", () => {
  it("áudio novo atravessa o circuito e preserva os bytes até a transcrição local", async () => {
    mensagem = await receber(`audio-novo-${org}`);
    expect(mensagem.media_storage_path).toBeNull();
    expect(chamadas).toHaveLength(0);
    const persistencia = await worker();
    expect(persistencia.done).toBe(1);
    const armazenada = await lerMensagem(mensagem.id);
    expect(armazenada.metadata.media_status).toBe("stored");
    expect(Number(armazenada.media_size_bytes)).toBe(audio.length);
    expect(chamadas).toHaveLength(0);
    const baixada = await admin.storage
      .from("whatsapp-media")
      .download(armazenada.media_storage_path!);
    expect(baixada.error).toBeNull();
    expect(sha(new Uint8Array(await baixada.data!.arrayBuffer()))).toBe(sha(audio));
    expect((await worker()).done).toBe(1);
    const pronta = await lerMensagem(mensagem.id);
    expect(pronta.media_derived_status).toBe("ready");
    expect(pronta.media_derived_text).toBe(resposta);
    expect(chamadas).toEqual([
      { hash: sha(audio), model: "whisper-1", language: "pt", authorization: `Bearer ${chave}` },
    ]);
    expect(JSON.stringify(await contextoDa(pronta))).toContain(resposta);
    const { rows } = await db.query(
      `select event_type,status,consumed_by from event_log where entity_id=$1 and event_type like 'media.%' order by event_type`,
      [mensagem.id],
    );
    expect(rows).toEqual([
      { event_type: "media.derive_requested", status: "done", consumed_by: ["media_derive_v1"] },
      { event_type: "media.persist_requested", status: "done", consumed_by: ["media_persist_v1"] },
    ]);
  });

  it("reentrega do webhook e replay da fila não retranscrevem áudio pronto", async () => {
    await receber(`audio-novo-${org}`);
    expect(
      (await db.query("select count(*)::int as n from messages where organization_id=$1", [org]))
        .rows[0].n,
    ).toBe(1);
    const { error } = await admin.rpc("emit_event", {
      p_event_type: "media.derive_requested",
      p_entity_kind: "message",
      p_entity_id: mensagem.id,
      p_payload: { message_id: mensagem.id },
      p_metadata: { source: "fixture-replay" },
      p_organization_id: org,
    });
    expect(error).toBeNull();
    const replay = await worker();
    expect(replay.pulados).toContain("media.derive_requested/media_derive_v1: already derived");
    expect(chamadas).toHaveLength(1);
    expect(downloads).toBe(1);
  });

  it("configuração de áudio novo não reabre falhas antigas", async () => {
    const id = randomUUID();
    await db.query(
      `insert into messages (id, organization_id,conversation_id,channel_session_id,contact_id,external_id,type,direction,status,media_derived_status,media_derived_text,sent_at,metadata)
      values ($1,$2,$3,$4,$5,$6,'audio','inbound','delivered','failed','[Falha antiga fictícia]',now()-interval '3 days','{"fixture":"antigo"}')`,
      [id, org, mensagem.conversation_id, canal, mensagem.contact_id, `audio-antigo-${org}`],
    );
    await db.query(
      `insert into event_log (organization_id,event_type,entity_kind,entity_id,payload,status,attempts,last_error) values ($1,'media.derive_requested','message',$2,$3,'dead',5,'falha antiga fictícia')`,
      [org, id, JSON.stringify({ message_id: id })],
    );
    antigo = await lerMensagem(id);
    const novas = await receber(`audio-segundo-${org}`);
    await worker();
    await worker();
    expect((await lerMensagem(novas.id)).media_derived_status).toBe("ready");
    expect(await lerMensagem(id)).toEqual(antigo);
    expect(chamadas).toHaveLength(2);
  });

  it("401 vira erro explícito e fila morta após cinco tentativas, sem texto inventado", async () => {
    recusarTranscricao = true;
    const erro = await receber(`audio-erro-${org}`);
    await worker();
    for (let tentativa = 1; tentativa <= 5; tentativa++) {
      const resumo = await worker();
      expect(tentativa < 5 ? resumo.failed : resumo.dead).toBe(1);
      // Avança somente o vencimento da fixture; attempts e retry são do dreno real.
      await db.query(
        `update event_log set next_attempt_at=now() where entity_id=$1 and event_type='media.derive_requested' and status='pending'`,
        [erro.id],
      );
    }
    const falha = await lerMensagem(erro.id);
    expect(falha.media_derived_status).toBe("failed");
    expect(falha.media_derived_text).toBe(MARCADOR_NAO_LIDA);
    expect(falha.metadata.media_derived_motivo).toContain("transcription_401");
    const r = await contextoDa(falha);
    expect(JSON.stringify(r)).toContain(falha.media_derived_text);
    const { rows } = await db.query(
      `select status,attempts,last_error from event_log where entity_id=$1 and event_type='media.derive_requested'`,
      [erro.id],
    );
    expect(rows[0]).toMatchObject({ status: "dead", attempts: 5 });
    expect(rows[0].last_error).toContain("transcription_401");
    expect(chamadas).toHaveLength(7);
    expect(await lerMensagem(antigo.id)).toEqual(antigo);
    expect(
      (
        await db.query(
          "select count(*)::int as n from messages where organization_id=$1 and direction='outbound'",
          [org],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
