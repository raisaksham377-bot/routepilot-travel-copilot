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

function walkSources(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

describe('the model id has a single source of truth', () => {
  /**
   * Checkpoint B introduces the first API route, so this check is now live
   * rather than vacuous. Switching model tier must stay a one-line env change.
   */
  it('no API route hardcodes a claude- model string', () => {
    const offenders = walkSources(join(PROJECT_ROOT, 'app', 'api')).filter((f) =>
      readFileSync(f, 'utf8').includes('claude-'),
    );
    expect(offenders).toEqual([]);
  });

  /**
   * Stronger than the route-only check: the literal may appear in exactly one
   * file in the entire project, the config module that owns it.
   */
  it('the model literal appears in exactly one source file project-wide', () => {
    const sources = [
      ...walkSources(join(PROJECT_ROOT, 'app')),
      ...walkSources(join(PROJECT_ROOT, 'lib')),
    ];
    const holders = sources
      .filter((f) => /claude-[a-z0-9-]+/.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(PROJECT_ROOT, '').replace(/\\/g, '/'));

    expect(holders).toEqual(['/lib/ai/config.ts']);
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

  /**
   * Replaces the Checkpoint A assertion that `app/api` must not exist.
   *
   * That check encoded a structural fact the approved plan deliberately changes
   * in Checkpoint B, so it could not survive unchanged. It is replaced by a
   * strictly STRONGER one: an allowlist of exactly which routes may exist, so
   * an unplanned or accidentally-added endpoint fails the build. The old
   * version only ever asserted absence; this one constrains the contents.
   */
  it('exposes exactly the planned API routes and no others', () => {
    const apiDir = join(PROJECT_ROOT, 'app', 'api');
    const routes = existsSync(apiDir)
      ? readdirSync(apiDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
      : [];

    // Checkpoint B adds `interpret` only. `parse-options` arrives in C.
    expect(routes).toEqual(['interpret']);
  });

  it('every API route is explicitly on the Node runtime, not edge', () => {
    for (const file of walkSources(join(PROJECT_ROOT, 'app', 'api'))) {
      const src = readFileSync(file, 'utf8');
      if (/export\s+async\s+function\s+(POST|GET|PUT|PATCH|DELETE)/.test(src)) {
        expect(src, `${file} must declare the nodejs runtime`).toContain(
          "export const runtime = 'nodejs'",
        );
      }
    }
  });

  it('no API route logs a request body, utterance or constraint value', () => {
    for (const file of walkSources(join(PROJECT_ROOT, 'app', 'api'))) {
      const src = readFileSync(file, 'utf8');
      // Strip comments so prose about logging does not trip the check.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, `${file} must not log`).not.toMatch(/console\.(log|info|debug|warn|error)/);
    }
  });
});
