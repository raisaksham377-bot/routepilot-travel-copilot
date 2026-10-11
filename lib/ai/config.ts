/**
 * AI runtime configuration. Server-side only.
 *
 * THE SINGLE SOURCE OF TRUTH FOR THE MODEL ID. No other file may contain a
 * `claude-` literal, so switching tier stays a one-line env change. A test
 * enforces that.
 *
 * This module never returns, logs, or echoes a credential value. The only thing
 * it exposes about the key is whether one exists.
 */

/** Default when ANTHROPIC_MODEL is unset. Verify availability against your own
 * account before relying on it:
 *
 *   curl https://api.anthropic.com/v1/models \
 *     -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
 */
const DEFAULT_MODEL = 'claude-opus-5-5';

/** Extraction is a parsing task, not a reasoning task. */
const DEFAULT_EFFORT = 'low';

/** These outputs are small JSON objects. A low ceiling is also a cost ceiling. */
const DEFAULT_MAX_OUTPUT_TOKENS = 1500;

/** Request-body cap, enforced BEFORE any model call is made. */
const DEFAULT_MAX_INPUT_CHARS = 8000;

const DEFAULT_TIMEOUT_MS = 10_000;

export type AiEffort = 'low' | 'medium' | 'high';

export interface AiConfig {
  /** AI_FEATURES_ENABLED must be explicitly "true". Anything else is off. */
  enabled: boolean;
  /** True when a credential exists. NEVER the credential itself. */
  hasCredentials: boolean;
  model: string;
  effort: AiEffort;
  maxOutputTokens: number;
  maxInputChars: number;
  timeoutMs: number;
  /** Set when a passphrase gate is configured for a non-local deployment. */
  requiresPassphrase: boolean;
}

/**
 * Deliberately looser than NodeJS.ProcessEnv: this reader only needs string
 * lookups, and requiring the full ProcessEnv type would force every test to
 * fabricate unrelated fields like NODE_ENV just to construct a fixture.
 * `process.env` satisfies this signature.
 */
export type EnvSource = Record<string, string | undefined>;

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function effortFromEnv(raw: string | undefined): AiEffort {
  return raw === 'medium' || raw === 'high' ? raw : DEFAULT_EFFORT;
}

export function getAiConfig(env: EnvSource = process.env): AiConfig {
  // Credentials resolve through a chain, not a single variable. Checking only
  // ANTHROPIC_API_KEY would misreport a machine authenticated by auth token.
  const hasCredentials =
    (env.ANTHROPIC_API_KEY ?? '').trim() !== '' || (env.ANTHROPIC_AUTH_TOKEN ?? '').trim() !== '';

  return {
    // Default-deny. The public demo must stay off unless explicitly turned on,
    // so that an open endpoint cannot be used to spend the owner's credits.
    enabled: env.AI_FEATURES_ENABLED === 'true',
    hasCredentials,
    model: (env.ANTHROPIC_MODEL ?? '').trim() || DEFAULT_MODEL,
    effort: effortFromEnv(env.ANTHROPIC_EFFORT),
    maxOutputTokens: intFromEnv(env.AI_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS),
    maxInputChars: intFromEnv(env.AI_MAX_INPUT_CHARS, DEFAULT_MAX_INPUT_CHARS),
    timeoutMs: intFromEnv(env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    requiresPassphrase: (env.DEMO_PASSPHRASE ?? '').trim() !== '',
  };
}

/** Why AI is unavailable, if it is. Shaped for display, never for silent failure. */
export type AiUnavailableReason = 'feature_disabled' | 'no_credentials';

export function aiAvailability(
  config: AiConfig,
): { available: true } | { available: false; reason: AiUnavailableReason; message: string } {
  if (!config.enabled) {
    return {
      available: false,
      reason: 'feature_disabled',
      message:
        'AI interpretation is switched off for this deployment. Enter trip details using the form, or set AI_FEATURES_ENABLED=true locally.',
    };
  }
  if (!config.hasCredentials) {
    return {
      available: false,
      reason: 'no_credentials',
      message:
        'AI interpretation is enabled but no Anthropic credential is configured on the server. Enter trip details using the form instead.',
    };
  }
  return { available: true };
}
