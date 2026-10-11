import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from '@/lib/decision';
import { renderBrief } from '@/lib/brief/render';
import { ALL_SCENARIOS } from '@/lib/data/scenarios';
import { discriminationState } from '@/lib/data/fixtures';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const NOKEY_MODE = process.env.ROUTEPILOT_NOKEY_MODE === '1';

/**
 * Proves the public demo's configuration actually works.
 *
 * Checkpoint A has no model calls at all, so the engine tests below pass
 * unconditionally. The point is that they are wired up now, so when Checkpoint B
 * introduces the AI routes the guarantee is already enforced instead of being
 * retrofitted after someone notices the public demo is broken.
 */

describe('credential hygiene', () => {
  it.runIf(NOKEY_MODE)('clears the WHOLE credential chain, not just the API key', () => {
    // An unset ANTHROPIC_API_KEY does not mean "no credentials": the SDK also
    // resolves ANTHROPIC_AUTH_TOKEN and an on-disk OAuth profile. A no-key test
    // that clears only the first can pass by making real, billed calls.
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(process.env.ANTHROPIC_PROFILE).toBeUndefined();
  });

  it('commits no secret in .env.example', () => {
    const example = readFileSync(join(PROJECT_ROOT, '.env.example'), 'utf8');
    expect(example).not.toMatch(/sk-ant/);
    // Every variable line must be a bare name with no value after the "=".
    const assignments = example
      .split(/\r?\n/)
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .filter((l) => l.trim() !== l.split('=')[0] + '=');
    expect(assignments).toEqual([]);
  });

  it('git-ignores the local env file', () => {
    const ignore = readFileSync(join(PROJECT_ROOT, '.gitignore'), 'utf8');
    expect(ignore).toContain('.env.local');
  });
});

describe('the model id has a single source of truth', () => {
  /**
   * Checkpoint A has no app/api directory yet. The assertion is written now so
   * that the first AI route cannot introduce a hardcoded model string without
   * failing the build -- switching tiers must stay a one-line env change.
   */
  it('no API route hardcodes a claude- model string', () => {
    const apiDir = join(PROJECT_ROOT, 'app', 'api');
    if (!existsSync(apiDir)) {
      expect(existsSync(apiDir)).toBe(false); // documents the current state
      return;
    }
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          if (readFileSync(full, 'utf8').includes('claude-')) offenders.push(full);
        }
      }
    };
    walk(apiDir);
    expect(offenders).toEqual([]);
  });
});

describe('the whole deterministic product works with no credentials', () => {
  it.each(ALL_SCENARIOS)('$id evaluates without any network or key', (scenario) => {
    const result = decide(scenario.state);
    expect(result.trace.schemaVersion).toBe(1);
  });

  it('ranks, recommends and renders a brief end to end', () => {
    const state = discriminationState('arrival_buffer_first');
    const result = decide(state);
    if (result.status !== 'ok') throw new Error('expected ok');

    expect(result.ranked).toHaveLength(3);
    expect(result.recommendation.chosenOptionId).toBe('A');

    const brief = renderBrief(state, result);
    expect(brief).toContain('Executive travel decision brief');
    expect(brief).toContain('Recommendation: A');
    expect(brief.length).toBeGreaterThan(400);
  });

  it('has no API routes in Checkpoint A at all', () => {
    // Checkpoint A is deliberately network-free. Checkpoint B adds exactly two
    // routes, both gated and both optional.
    expect(existsSync(join(PROJECT_ROOT, 'app', 'api'))).toBe(false);
  });
});
