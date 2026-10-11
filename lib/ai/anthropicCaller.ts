import { constraintPatchSchema } from './constraintPatch';
import type { ModelCallRequest, ModelCallOutcome, ModelCaller } from './interpret';

/**
 * The ONLY file in this project that touches the Anthropic SDK.
 *
 * Imported dynamically inside the function so the SDK is never loaded on a
 * deployment with AI switched off -- which is the public demo's configuration.
 *
 * Verified against @anthropic-ai/sdk 0.133.0:
 *   - `client.messages.parse(...)` exists
 *   - `zodOutputFormat` is exported from '@anthropic-ai/sdk/helpers/zod'
 *   - the typed error classes referenced below all exist
 *
 * Structured outputs are used rather than forced tool calling, because
 * `tool_choice: {type:"any"}` returns a 400 on the current Opus and Sonnet
 * models. `output_config.format` is the supported way to constrain shape.
 */

const SYSTEM_PROMPT = `You extract travel constraints from a short description of a business trip.

You are given the traveller's words and a list of which constraint keys are already recorded (keys and whether each is firm or a preference -- never their values).

Rules:
- Only propose constraints the text actually supports. Do not invent a budget, a cabin or a deadline that was not mentioned.
- Leave a value out rather than guessing it. Absent means absent.
- A deadline needs BOTH a local date-and-time and an IANA timezone. If the text does not make the timezone determinable, do not propose the deadline -- ask about it in clarifyingQuestions instead.
- rawValue is always a string. For arrival_deadline use "YYYY-MM-DDTHH:MM" with no offset, and put the IANA zone in timezone.
- Ask at most two clarifying questions, and only about information that is genuinely missing.
- Put anything the traveller mentioned that does not map to a supported constraint into unmapped, rather than discarding it.

You are proposing, not deciding. A human reviews everything you return.`;

function buildUserMessage(request: ModelCallRequest): string {
  const context =
    request.payload.constraintContext.length === 0
      ? 'No constraints are recorded yet.'
      : `Already recorded (keys and kinds only): ${request.payload.constraintContext
          .map((c) => `${c.key} (${c.kind})`)
          .join(', ')}`;

  return `${context}\n\nTraveller's description:\n${request.payload.utterance}`;
}

/** Maps SDK errors onto our transport-agnostic failure kinds. */
function classifyError(error: unknown, Anthropic: typeof import('@anthropic-ai/sdk').default): ModelCallOutcome {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { ok: false, kind: 'timeout', detail: 'request timed out' };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return { ok: false, kind: 'authentication_failed', detail: 'authentication rejected' };
  }
  if (error instanceof Anthropic.NotFoundError) {
    // A 404 on a messages request almost always means the model id is not
    // available to this account.
    return { ok: false, kind: 'model_unavailable', detail: 'model not found for this account' };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { ok: false, kind: 'rate_limited', detail: 'rate limited' };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { ok: false, kind: 'malformed_output', detail: 'request rejected as invalid' };
  }
  if (error instanceof Anthropic.APIError) {
    return { ok: false, kind: 'transport_error', detail: `api error ${error.status ?? 'unknown'}` };
  }
  return { ok: false, kind: 'transport_error', detail: 'unexpected transport failure' };
}

export const anthropicModelCaller: ModelCaller = async (request) => {
  // Dynamic import: nothing loads unless a call is actually made.
  const [{ default: Anthropic }, { zodOutputFormat }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('@anthropic-ai/sdk/helpers/zod'),
  ]);

  // Zero-arg construction resolves credentials from the environment. The key
  // is never read into a variable here, never logged, never returned.
  const client = new Anthropic({ timeout: request.timeoutMs });

  try {
    const response = await client.messages.parse({
      model: request.model,
      max_tokens: request.maxOutputTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(request) }],
      output_config: {
        effort: request.effort as 'low' | 'medium' | 'high',
        format: zodOutputFormat(constraintPatchSchema),
      },
    });

    // Safety classifiers can decline with HTTP 200. Check before reading content.
    if (response.stop_reason === 'refusal') {
      return { ok: false, kind: 'refusal', detail: 'declined by safety classifier' };
    }
    if (response.stop_reason === 'max_tokens') {
      return { ok: false, kind: 'malformed_output', detail: 'output truncated at max_tokens' };
    }

    // parsed_output is null when parsing failed. Guard rather than assert.
    if (response.parsed_output === null || response.parsed_output === undefined) {
      return { ok: false, kind: 'malformed_output', detail: 'no parsable structured output' };
    }

    return { ok: true, raw: response.parsed_output };
  } catch (error) {
    const { default: AnthropicNs } = await import('@anthropic-ai/sdk');
    return classifyError(error, AnthropicNs);
  }
};
