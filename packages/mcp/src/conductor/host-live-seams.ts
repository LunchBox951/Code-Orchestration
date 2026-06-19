/**
 * The ONE place that resolves the `[host-live]` seam bundle (real node-pty + socket-bridge transport +
 * real timers). Both the host-proof driver ({@link runHostLiveProof}) and the worker benchmark
 * ({@link runWorkerBenchmark}) build their {@link ConductorEngine} from this, so there is exactly one
 * host-live wiring path — not two that can drift.
 *
 * The real seams are imported AT CALL TIME (not at module load): `node-pty` is a native addon and
 * `./host.js` pulls the host-only graph, so a default `pnpm test` import of a module that merely
 * references this function stays free of both — the cost is paid only when a host-live run actually
 * calls `resolveHostLiveSeams`.
 *
 * The two formerly-hardcoded `TODO(host-live)` magic numbers (inject-retry, ready-settle) are now
 * env-overridable so the first real runs can be calibrated per machine without a code change. They were
 * never tuned against a real binary; the defaults are unchanged.
 */
import { NodePtyHost, type PtyHost } from '@co/core';
import { deriveProofFidelity, type ProofFidelity } from './host-proof.js';
import type { TransportPair } from './engine.js';

/** Env override (ms) for the post-inject retry delay; default {@link DEFAULT_INJECT_RETRY_MS}. */
export const CO_HOST_LIVE_INJECT_RETRY_MS_ENV = 'CO_HOST_LIVE_INJECT_RETRY_MS';
/** Env override (ms) for the post-ready settle; default {@link DEFAULT_READY_SETTLE_MS}. */
export const CO_HOST_LIVE_READY_SETTLE_MS_ENV = 'CO_HOST_LIVE_READY_SETTLE_MS';

const DEFAULT_INJECT_RETRY_MS = 2000;
const DEFAULT_READY_SETTLE_MS = 4000;

/** The resolved host-live seam bundle, shared by the host-proof + worker-benchmark drivers. */
export interface HostLiveSeamBundle {
  /** A real {@link NodePtyHost} (lazily loaded native node-pty). */
  readonly pty: PtyHost;
  /** `'host-live'`, derived from the resolved {@link NodePtyHost} (fail-loud on a non-real host). */
  readonly fidelity: ProofFidelity;
  /** Build the socket-bridge transport pair for a bind to `socketPath` (diagnostics → `bridgeLogPath`). */
  readonly makeTransport: (socketPath: string, bridgeLogPath: string) => TransportPair;
  /** Monotonic ms source (`performance.now`). */
  readonly now: () => number;
  /** The real byte-quiet settle window. */
  readonly quietWindow: (signal: AbortSignal) => Promise<void>;
  /** The post-inject retry delay (env-overridable). */
  readonly injectRetryDelay: (signal?: AbortSignal) => Promise<void>;
  /** The post-ready settle (env-overridable). */
  readonly readySettle: () => Promise<void>;
}

/**
 * Resolve the host-live seam bundle for `mode`. Lazily imports the real transport + host modules,
 * constructs a real {@link NodePtyHost}, and derives `'host-live'` fidelity from it (throws if the
 * resolved host is not a real node-pty — Principle 2 / Principle 9). The fidelity is DERIVED from the
 * resolved pty, never from `mode`.
 */
export async function resolveHostLiveSeams(mode: 'claude' | 'codex'): Promise<HostLiveSeamBundle> {
  const { createSocketBridgeTransportPair } = await import('./real-transport.js');
  const { monotonicNowMs, realQuietWindow } = await import('./host.js');
  const pty = await NodePtyHost.create();
  const fidelity = deriveProofFidelity(mode, pty);
  const injectRetryMs = envMs(CO_HOST_LIVE_INJECT_RETRY_MS_ENV, DEFAULT_INJECT_RETRY_MS);
  const readySettleMs = envMs(CO_HOST_LIVE_READY_SETTLE_MS_ENV, DEFAULT_READY_SETTLE_MS);
  return {
    pty,
    fidelity,
    makeTransport: (socketPath, bridgeLogPath) =>
      createSocketBridgeTransportPair(socketPath, bridgeLogPath),
    now: monotonicNowMs,
    quietWindow: realQuietWindow,
    injectRetryDelay: (signal) => delayMs(injectRetryMs, signal),
    readySettle: () => delayMs(readySettleMs),
  };
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function delayMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
