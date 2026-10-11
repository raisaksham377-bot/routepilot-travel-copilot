import { describe, expect, it } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { anthropicModelCaller } from '@/lib/ai/anthropicCaller';
import { interpretUtterance } from '@/lib/ai/interpret';
import { getAiConfig, type EnvSource } from '@/lib/ai/config';

/**
 * Proves the network guard in tests/setup.no-network.ts is actually installed
 * and effective.
 *
 * A guard nobody verifies is worth very little -- if a future config change
 * dropped the setup file, every other test would keep passing and the
 * protection would be silently gone. These tests fail in that situation.
 */

describe('the network guard is installed', () => {
  it('blocks fetch', async () => {
    await expect(fetch('https://api.anthropic.com/v1/models')).rejects.toThrow(
      /Network access is blocked/,
    );
  });

  it('blocks https.request and https.get', () => {
    expect(() => https.request('https://api.anthropic.com')).toThrow(/Network access is blocked/);
    expect(() => https.get('https://api.anthropic.com')).toThrow(/Network access is blocked/);
  });

  it('blocks http.request and http.get', () => {
    expect(() => http.request('http://example.com')).toThrow(/Network access is blocked/);
    expect(() => http.get('http://example.com')).toThrow(/Network access is blocked/);
  });

  it('blocks a raw socket connect, the last line of defence', () => {
    const socket = new net.Socket();
    expect(() => socket.connect(443, 'api.anthropic.com')).toThrow(/Network access is blocked/);
  });

  it('names the cause in the error, so a failure is self-explaining', async () => {
    await expect(fetch('https://api.anthropic.com/v1/messages')).rejects.toThrow(
      /inject a mocked ModelCaller/,
    );
  });
});

describe('the REAL caller cannot reach a provider from a test', () => {
  /**
   * The decisive one. This invokes the genuine anthropicModelCaller -- the only
   * code path that would make a billed API call -- and asserts it cannot
   * succeed. If someone later wires the real caller into a test by mistake,
   * the guard turns a silent spend into a loud failure.
   */
  it('fails loudly rather than making a billed request', async () => {
    const config = getAiConfig({
      AI_FEATURES_ENABLED: 'true',
      ANTHROPIC_API_KEY: 'placeholder-not-a-real-key',
    } as EnvSource);

    const result = await interpretUtterance(
      { utterance: 'New York by Wednesday', constraints: [], config },
      anthropicModelCaller,
    );

    // It must report a structured failure, never a success.
    expect(result.status).toBe('model_failed');
    if (result.status !== 'model_failed') return;
    // Blocked at the transport layer, exactly as the guard intends.
    expect(['transport_error', 'timeout', 'authentication_failed']).toContain(result.kind);
    expect(result.message.toLowerCase()).toMatch(/form|try again/);
  });

  it('and the deterministic engine is unaffected by that failure', async () => {
    const config = getAiConfig({
      AI_FEATURES_ENABLED: 'true',
      ANTHROPIC_API_KEY: 'placeholder-not-a-real-key',
    } as EnvSource);
    const result = await interpretUtterance(
      { utterance: 'anything', constraints: [], config },
      anthropicModelCaller,
    );
    expect(result).not.toHaveProperty('patch');
  });
});
