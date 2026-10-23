// @vitest-environment node
/** Prova parcial sem custo: escada + derivação + HTTP real local.
 * Não simula qualidade de reconhecimento e NÃO prova webhook/fila/storage/banco.
 * O único dublê de serviço é o endpoint de transcrição, que declara texto fixo.
 */
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({
  TRANSCRIPTION_API_KEY: "fixture-transcription-only",
  TRANSCRIPTION_MODEL: "whisper-1",
  TRANSCRIPTION_BASE_URL: "",
  TRANSCRIPTION_LANGUAGES: "pt",
}));
vi.mock("@/lib/env", () => ({ env: cfg }));
import { decidirTranscricao } from "@/lib/messaging/media/escada-de-transcricao";
import { deriveMediaText } from "@/lib/messaging/media/derive";

let server: Server | undefined;
afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close((e) => e ? reject(e) : resolve()));
    server = undefined;
  }
});

function wavFicticio() {
  // Um segundo de sinal sintético PCM mono, sem fala ou dado pessoal.
  const bytes = Buffer.alloc(44 + 16000 * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < 16000; i++) bytes.writeInt16LE(Math.round(900 * Math.sin(i * Math.PI / 40)), 44 + i * 2);
  return bytes;
}

async function endpoint(status: number) {
  const calls: Array<{ path: string; model: unknown; language: unknown; hash: string; credentialOk: boolean }> = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = new Uint8Array(Buffer.concat(chunks));
    const form = await new Response(body, { headers: { "content-type": req.headers["content-type"] ?? "" } }).formData();
    const file = form.get("file") as File;
    calls.push({ path: req.url ?? "", model: form.get("model"), language: form.get("language"),
      hash: createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex"),
      credentialOk: req.headers.authorization === "Bearer fixture-transcription-only" });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { text: "Tenho duas horas por dia para estudar. [RESPOSTA FICTÍCIA]" } : { error: "fixture rejected" }));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("fixture address");
  cfg.TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${addr.port}/v1`;
  return calls;
}

describe("transcrição dedicada: derivação e transporte HTTP locais reais", () => {
  it("envia arquivo/modelo/idioma certos sem consultar chave genérica nem chamar chat", async () => {
    const calls = await endpoint(200);
    const generic = vi.fn(async () => { throw new Error("não consultar credencial genérica"); });
    const selection = await decidirTranscricao({
      conversa: { provider: "anthropic", apiKey: "fixture-chat-never-used", modelId: "claude-sonnet-4-5" },
      chaveOpenai: generic,
    });
    expect(selection.origem).toBe("servico_da_instalacao");
    expect(selection.anuncio).toEqual({ provider: "openai", modelId: "whisper-1" });
    expect(generic).not.toHaveBeenCalled();
    const input = wavFicticio();
    const unrelated = vi.fn(async () => { throw new Error("não usar outra capacidade"); });
    const text = await deriveMediaText("audio", input, "audio/wav", {
      transcriber: selection.transcriber!, describeImage: unrelated, extractPdf: unrelated,
    });
    expect(text).toBe("Tenho duas horas por dia para estudar. [RESPOSTA FICTÍCIA]");
    expect(unrelated).not.toHaveBeenCalled();
    expect(calls).toEqual([{ path: "/v1/audio/transcriptions", model: "whisper-1", language: "pt",
      hash: createHash("sha256").update(input).digest("hex"), credentialOk: true }]);
  });

  it("401 não gera texto, fallback nem retry dentro do transporte (o worker tem retry próprio)", async () => {
    const calls = await endpoint(401);
    const generic = vi.fn(async () => "fixture-generic-never-used");
    const selection = await decidirTranscricao({ chaveOpenai: generic });
    await expect(deriveMediaText("audio", wavFicticio(), "audio/wav", {
      transcriber: selection.transcriber!, describeImage: vi.fn(), extractPdf: vi.fn(),
    })).rejects.toThrow("transcription_401");
    expect(calls).toHaveLength(1);
    expect(generic).not.toHaveBeenCalled();
  });
});
