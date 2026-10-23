import { defineConfig } from "vitest/config";
import path from "node:path";
const source = process.env.C01_REVIEW_SOURCE ?? import.meta.dirname;
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(source),
      "server-only": path.resolve(source, "node_modules/next/dist/compiled/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    include: ["experiments/extensoes/c01-atendimento/acompanhamento-baseline.test.ts"],
    maxWorkers: 1,
    testTimeout: 30000,
  },
});
