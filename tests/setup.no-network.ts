import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Makes a live network call IMPOSSIBLE for the whole suite.
 *
 * Why this is a guard rather than a convention: the AI path is the first code
 * in this project that *could* reach the internet, and the most expensive
 * possible test bug is one that silently makes real, billed API calls -- which
 * would also pass, hiding itself. A mocked `ModelCaller` prevents that by
 * design, but only for as long as every future test remembers to inject one.
 *
 * This removes the need to remember. Any socket, any fetch, any http(s)
 * request from anywhere in the suite throws immediately with an explanatory
 * message, so the failure is loud and names the cause.
 *
 * It runs in setupFiles, before any test module is imported, so there is no
 * window in which an import-time request could slip through.
 */

const BLOCKED = (api: string, target: string) =>
  new Error(
    `Network access is blocked in tests (${api} -> ${target}).\n` +
      'No test may make a live network call. If this fired from the AI path, ' +
      'inject a mocked ModelCaller instead of the real anthropicModelCaller.',
  );

function describeTarget(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    const o = first as Record<string, unknown>;
    if (typeof o.href === 'string') return o.href;
    if (typeof o.hostname === 'string' || typeof o.host === 'string') {
      return `${String(o.hostname ?? o.host)}:${String(o.port ?? '')}`;
    }
  }
  return 'unknown target';
}

/*
 * fetch -- what the browser-side component and the Anthropic SDK both use.
 *
 * It REJECTS rather than throwing synchronously, because that is what real
 * fetch does on a network failure. A synchronous throw would behave
 * differently from the thing it stands in for: code with `try { await fetch }`
 * would still catch it, but code that calls `fetch(...).catch(...)` without
 * awaiting would not, so a test could pass here and fail in production. The
 * guard has to be faithful to the contract it is intercepting.
 */
globalThis.fetch = ((...args: Parameters<typeof fetch>) =>
  Promise.reject(BLOCKED('fetch', describeTarget(args)))) as typeof fetch;

// The Anthropic SDK and most Node HTTP clients bottom out in these.
const blockModule = (mod: typeof http | typeof https, name: string) => {
  for (const method of ['request', 'get'] as const) {
    Object.defineProperty(mod, method, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => {
        throw BLOCKED(`${name}.${method}`, describeTarget(args));
      },
    });
  }
};
blockModule(http, 'http');
blockModule(https, 'https');

// Last line of defence: a raw socket, which every higher-level client needs.
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function blockedConnect(...args: unknown[]) {
  throw BLOCKED('net.Socket.connect', describeTarget(args));
} as typeof originalConnect;

/** Exposed so a test can assert the guard itself is actually installed. */
export const NETWORK_GUARD_INSTALLED = true;
