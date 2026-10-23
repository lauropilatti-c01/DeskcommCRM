import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    environment: "node",
    include: ["experiments/extensoes/c01-atendimento/percurso.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55442",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-local-only",
      SUPABASE_SERVICE_ROLE_KEY: "synthetic-local-service-key-not-production-1234567890",
    },
  },
});
