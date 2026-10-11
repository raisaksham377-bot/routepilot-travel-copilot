/**
 * Removes every credential the Anthropic SDK would resolve, before any test runs.
 *
 * Clearing ANTHROPIC_API_KEY alone is NOT enough. The SDK resolves credentials
 * through a chain: ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an on-disk
 * OAuth profile selected by ANTHROPIC_PROFILE. A "no key" test that clears only
 * the first variable can pass on a developer machine by making real, billed API
 * calls -- proving nothing about the deployed no-key path while quietly costing
 * money. So we clear the whole chain.
 *
 * Checkpoint A contains no model calls at all, so this currently proves a
 * property that is trivially true. It is wired up now so that when Checkpoint B
 * introduces the AI routes, the guarantee is already enforced rather than
 * retrofitted.
 */
for (const key of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_BASE_URL',
]) {
  delete process.env[key];
}

// Signals to tests that they are running in the no-credentials configuration.
process.env.ROUTEPILOT_NOKEY_MODE = '1';
