import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * The "no credentials" configuration.
 *
 * Why this exists as a config file rather than a shell one-liner: the POSIX form
 * `ANTHROPIC_API_KEY= npm test` is not valid in PowerShell, and this project is
 * developed on Windows. Clearing the variables from inside a setup file is
 * shell-agnostic and behaves identically locally and in CI.
 */
export default defineConfig({
  resolve: {
    alias: { '@': projectRoot },
  },
  // Matches vitest.config.ts: tsconfig's `jsx: "preserve"` is for Next, not esbuild.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Network guard first, then credential clearing. Together these make the
    // no-key suite prove two things at once: nothing resolves a credential,
    // and nothing could reach a provider even if it did.
    setupFiles: ['./tests/setup.no-network.ts', './tests/setup.nokey.ts'],
    testTimeout: 5000,
  },
});
