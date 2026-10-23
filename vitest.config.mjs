import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { loadEnvFile } from 'node:process';

try { loadEnvFile('.env.local'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

export default defineConfig({
  resolve: { alias: { 'server-only': fileURLToPath(new URL('./tests/support/server-only.js', import.meta.url)) } },
  test: {
    environment: 'node',
    restoreMocks: true,
    unstubEnvs: true,
    pool: 'forks',
    maxWorkers: 2,
    testTimeout: 10000,
    hookTimeout: 15000,
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/**/*.test.mjs'] } },
      { extends: true, test: { name: 'postgres', include: ['tests/*.integration.mjs'], fileParallelism: false } },
      { extends: true, test: { name: 'redis', include: ['tests/redis/*.integration.mjs'], fileParallelism: false } },
    ],
  },
});
