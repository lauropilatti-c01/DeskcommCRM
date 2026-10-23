import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } }, test: { environment: 'node', include: ['tests/invariants/c01-retorno-e-trava.test.ts'], maxWorkers: 1 } });
