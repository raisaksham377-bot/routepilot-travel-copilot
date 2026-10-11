import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// fileURLToPath keeps this correct on Windows. `new URL('.', import.meta.url).pathname`
// would yield "/C:/Users/..." and break path resolution.
const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': projectRoot },
  },
  /*
   * tsconfig sets `jsx: "preserve"` for Next's own compiler, which esbuild
   * cannot transform -- it would leave raw JSX in the output. Overriding to
   * "automatic" here uses the React 17+ runtime, which avoids pulling in
   * @vitejs/plugin-react just to run component tests.
   */
  esbuild: { jsx: 'automatic' },
  test: {
    /*
     * `node` stays the DEFAULT, deliberately. The decision engine is pure and
     * isomorphic, and running 126 engine assertions inside a simulated DOM
     * would be slower and would test a different environment from the one they
     * describe. Component tests opt in per file with a
     * `@vitest-environment jsdom` docblock.
     */
    environment: 'node',
    // .tsx included so component tests can use JSX.
    include: ['tests/**/*.test.{ts,tsx}'],
    // Blocks every live network call for the whole suite. The most expensive
    // possible test bug is one that quietly makes real, billed API calls and
    // passes while doing so -- this makes that impossible rather than merely
    // discouraged. See tests/setup.no-network.ts.
    setupFiles: ['./tests/setup.no-network.ts'],
    // If a test ever reaches for the network, it should fail loudly, not hang.
    testTimeout: 5000,
  },
});
