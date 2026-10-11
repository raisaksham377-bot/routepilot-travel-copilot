import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// fileURLToPath keeps this correct on Windows. `new URL('.', import.meta.url).pathname`
// would yield "/C:/Users/..." and break path resolution.
const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': projectRoot },
  },
  test: {
    // The decision engine is pure and isomorphic: no DOM needed to test it.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Checkpoint A has no network code at all. If a test ever reaches for the
    // network, that is a design regression and should fail loudly, not hang.
    testTimeout: 5000,
  },
});
