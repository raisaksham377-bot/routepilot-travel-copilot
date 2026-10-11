import type { Constraint } from '../schema/constraint';
import { getAiConfig, aiAvailability, type AiConfig } from './config';
import { redactForModel } from './redact';
import { buildInterpretPayload, findDisallowedKeys, type InterpretPayload } from './payload';
import { constraintPatchSchema, convertPatch, type ConvertedPatch } from './constraintPatch';

/**
 * Interpretation orchestration.
 *
 * The model call itself is injected as a `ModelCaller`. That single decision is
 * what lets every branch below -- success, refusal, malformed output, timeout,
 * unavailable model, missing credentials -- be tested exhaustively with no API
 * key and no network, which is the only way these paths get covered at all.
 *
 * The SDK is not imported here. It lives behind `anthropicCaller.ts`, which is
 * the only file in the project that touches it.
 */

export type ModelFailureKind =
  | 'refusal'
  | 'malformed_output'
  | 'timeout'
  | 'model_unavailable'
  | 'authentication_failed'
  | 'rate_limited'
  | 'transport_error';

export type ModelCallOutcome =
  | { ok: true; raw: unknown }
  | { ok: false; kind: ModelFailureKind; detail: string };

export interface ModelCallRequest {
  payload: InterpretPayload;
  model: string;
  maxOutputTokens: number;
  effort: string;
  timeoutMs: number;
}

export type ModelCaller = (request: ModelCallRequest) => Promise<ModelCallOutcome>;

export type InterpretResult =
  | { status: 'ok'; patch: ConvertedPatch; redactedCategories: string[] }
  | {
      status: 'unavailable';
      reason: 'feature_disabled' | 'no_credentials';
      message: string;
    }
  | { status: 'input_rejected'; reason: 'empty' | 'too_long'; message: string }
  | { status: 'model_failed'; kind: ModelFailureKind; message: string }
  | { status: 'payload_blocked'; disallowedKeys: string[]; message: string };

/** User-facing copy per failure. Every one ends by pointing at the manual path,
 * because the deterministic product always remains available. */
const FAILURE_MESSAGES: Record<ModelFailureKind, string> = {
  refusal:
    'The model declined to process that request. Nothing has been changed. Enter the details using the form instead.',
  malformed_output:
    'The model returned something this app could not validate, so nothing was applied. Try rephrasing, or use the form.',
  timeout:
    'The interpretation request timed out. Nothing has been changed. Your text is preserved below -- try again, or use the form.',
  model_unavailable:
    'The configured model is not available to this account. Check ANTHROPIC_MODEL against the models your key can reach. The form works regardless.',
  authentication_failed:
    'The server could not authenticate with the model provider. Nothing has been changed. The form works regardless.',
  rate_limited:
    'The model provider is rate limiting this deployment. Nothing has been changed. Try again shortly, or use the form.',
  transport_error:
    'Could not reach the model provider. Nothing has been changed. The form works regardless.',
};

export async function interpretUtterance(
  args: {
    utterance: string;
    constraints: readonly Constraint[];
    config?: AiConfig;
  },
  caller: ModelCaller,
): Promise<InterpretResult> {
  const config = args.config ?? getAiConfig();

  // 1. Gating first. No work, no redaction, no call, if AI is off or keyless.
  const availability = aiAvailability(config);
  if (!availability.available) {
    return {
      status: 'unavailable',
      reason: availability.reason,
      message: availability.message,
    };
  }

  // 2. Input validation BEFORE any model call, so an oversized body costs nothing.
  const trimmed = args.utterance.trim();
  if (trimmed === '') {
    return {
      status: 'input_rejected',
      reason: 'empty',
      message: 'Describe the trip first, then interpret.',
    };
  }
  if (trimmed.length > config.maxInputChars) {
    return {
      status: 'input_rejected',
      reason: 'too_long',
      message: `That is ${trimmed.length} characters; the limit is ${config.maxInputChars}. Shorten it, or use the form.`,
    };
  }

  // 3. Redact, then build a payload that structurally cannot hold trip state.
  const redaction = redactForModel(trimmed);
  const payload = buildInterpretPayload({
    redactedUtterance: redaction.text,
    constraints: args.constraints,
  });

  // 4. Last line of defence before transmission. Should be impossible to trip,
  //    which is exactly why it is cheap to assert.
  const disallowed = findDisallowedKeys(payload);
  if (disallowed.length > 0) {
    return {
      status: 'payload_blocked',
      disallowedKeys: disallowed,
      message:
        'Blocked before sending: the outbound payload contained unexpected fields. This is a bug, and nothing was transmitted.',
    };
  }

  // 5. Call.
  const outcome = await caller({
    payload,
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
    effort: config.effort,
    timeoutMs: config.timeoutMs,
  });

  if (!outcome.ok) {
    return {
      status: 'model_failed',
      kind: outcome.kind,
      message: FAILURE_MESSAGES[outcome.kind],
    };
  }

  // 6. Validate the model's output against our own schema before it can touch
  //    anything. A shape we did not ask for is treated as malformed.
  const parsed = constraintPatchSchema.safeParse(outcome.raw);
  if (!parsed.success) {
    return {
      status: 'model_failed',
      kind: 'malformed_output',
      message: FAILURE_MESSAGES.malformed_output,
    };
  }

  return {
    status: 'ok',
    patch: convertPatch(parsed.data),
    redactedCategories: redaction.removed,
  };
}
