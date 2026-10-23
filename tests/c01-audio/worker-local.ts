import { fecharRedeNoLocal } from "./rede-local";

// Processo separado: registro real apenas dos consumidores de mídia. A mesma
// função do worker reclama eventos reais no PostgREST; não chama derive direto.
async function main() {
  const rede = fecharRedeNoLocal();
  const { registerHandler } = await import("../../lib/event-log/dispatcher");
  const { mediaPersistHandler } = await import("../../workers/media-persist-worker.handler");
  const { mediaDeriveHandler } = await import("../../workers/media-derive-worker.handler");
  const { createAdminClient } = await import("../../lib/supabase/admin");
  const { drainEventLog } = await import("../../lib/event-log/drain");
  registerHandler(mediaPersistHandler);
  registerHandler(mediaDeriveHandler);
  const resumo = await drainEventLog(createAdminClient());
  console.info("C01_AUDIO_RESULT=" + JSON.stringify({ resumo, recusadas: rede.recusadas }));
  process.exit(rede.recusadas.length ? 1 : 0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
