/**
 * L4 Phase 6 — shared machinery for the LIVE {@link ProviderUsageSource} adapters (Claude status-line /
 * Codex sqlite). The frozen seam (spec §4.4) and the headless policy stack (Phases 1–5) are already in
 * place; this layer turns the injected port into real measurement. Everything live-I/O sits behind
 * INJECTED seams in the per-provider modules; this module holds only the provider-neutral glue:
 *
 *   - {@link layeredRead} — the passive-first source ordering + fail-loud terminus (spec §4.3): try each
 *     source in order, the first that yields a snapshot wins, and if NONE do, throw the typed
 *     {@link UsageUnavailableError} (AC6, Principle 9 — no-silent-failures) so headroom reads `unknown`,
 *     never a fabricated healthy 0%.
 *   - {@link buildSnapshot} — assemble the EXACT frozen {@link UsageSnapshot} shape (spec §4.4).
 *   - small defensive coercions ({@link asRecord}/{@link numberish}/{@link stringish}/{@link boolish})
 *     so the parsers tolerate extra / missing / loosely-typed fields and only fail loud on the truly
 *     unparseable — the host-side live run validates against reality and any shape delta is a small
 *     follow-up (spec §Fixtures), so the parsers must not over-fit.
 *
 * **AC11 (HARD RULE — Principle 2 authentic-terminal + billing):** nothing here runs inference or spends
 * API-billed tokens. There is no `claude -p` / `codex exec` / streaming-completion path anywhere in the
 * retrieval stack — only passive reads (a status-line value, a local sqlite row) and metadata probes.
 */

import {
  UsageUnavailableError,
  type Provider,
  type UsageSnapshot,
  type UsageWindow,
} from './usage-source.js';

/**
 * One attempt in a provider's layered source ordering. `run` resolves a {@link UsageSnapshot} when this
 * source produced one (available `true` OR `false` — an unavailable snapshot is first-class data that
 * still WINS, e.g. not-logged-in / over-limit), resolves `null` when this source had nothing to offer
 * (so the next source is tried), or THROWS when it errored (also falls through to the next, with the
 * error recorded for the fail-loud terminus). `label` names the source for diagnostics.
 */
export interface UsageSourceAttempt {
  readonly label: string;
  readonly run: () => Promise<UsageSnapshot | null>;
}

/**
 * Run an ordered list of {@link UsageSourceAttempt}s passive-first (spec §4.3): the FIRST attempt that
 * yields a snapshot wins; a `null` result or a thrown error falls through to the next. If EVERY attempt
 * falls through, throw the typed {@link UsageUnavailableError} (AC6, Principle 9) carrying the provider,
 * the best-known account, and a message listing what each source reported — fail-loud, never a silent
 * "looks healthy" default. The caller's ingest then marks the account headroom `unknown`.
 */
export async function layeredRead(
  provider: Provider,
  account: string,
  attempts: readonly UsageSourceAttempt[],
): Promise<UsageSnapshot> {
  const failures: string[] = [];
  let lastCause: unknown;
  for (const attempt of attempts) {
    try {
      const snapshot = await attempt.run();
      if (snapshot) return snapshot;
      failures.push(`${attempt.label}: no data`);
    } catch (cause) {
      lastCause = cause;
      failures.push(`${attempt.label}: ${errorMessage(cause)}`);
    }
  }
  throw new UsageUnavailableError(
    provider,
    `no usage source succeeded for '${provider}' (${failures.join('; ')})`,
    { account, ...(lastCause !== undefined ? { cause: lastCause } : {}) },
  );
}

/** Assemble the EXACT frozen {@link UsageSnapshot} (spec §4.4) — the single shape every adapter returns. */
export function buildSnapshot(args: {
  readonly provider: Provider;
  readonly account: string;
  readonly windows: readonly UsageWindow[];
  readonly available: boolean;
  readonly source: string;
  readonly sampledAt: string;
}): UsageSnapshot {
  return {
    provider: args.provider,
    account: args.account,
    windows: args.windows,
    available: args.available,
    source: args.source,
    sampled_at: args.sampledAt,
  };
}

/** Read an ISO-8601 sample timestamp from the injected clock (epoch ms); defaults to the wall clock. */
export function sampledNowIso(now?: () => number): string {
  return new Date((now ?? Date.now)()).toISOString();
}

// ── Defensive coercions ───────────────────────────────────────────────────────────────────────────
// The live payloads are loosely typed at the process / sqlite / JSON boundary, and the host-side run is
// the only place they meet reality. These coercions let the parsers tolerate extra/missing/odd-typed
// fields and fail loud ONLY on the truly unparseable (spec §Fixtures — do not over-fit).

/** A plain object (not null, not an array), or undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A finite number from a number or a numeric string, else undefined. */
export function numberish(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** A non-empty string, else undefined. */
export function stringish(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A boolean from a boolean / common string / number, else undefined (unknown ⇒ caller decides). */
export function boolish(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (/^(true|yes|on|1)$/i.test(value)) return true;
    if (/^(false|no|off|0)$/i.test(value)) return false;
  }
  return undefined;
}

/**
 * Pick the first defined value among several candidate keys of a record (tolerant field aliasing). The
 * verified field name from the spec goes first; defensive aliases follow so a minor host-side rename is
 * a parse hit, not a parse miss.
 */
export function pick(record: Record<string, unknown>, ...keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Best-effort message extraction from an unknown thrown value (no `[object Object]`). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
