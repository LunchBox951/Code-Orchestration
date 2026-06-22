/**
 * [host-live capture] — record real-provider observations to finalize the PLACEHOLDER guesses.
 *
 * Several seams in the live-bring-up carry PLACEHOLDER constants whose real bytes/keys can only be
 * learned from a run against a genuine `claude`/`codex` binary:
 *   - the codex collapsed-paste composer preview (#77 — `CODEX_COLLAPSED_PASTE_NEEDLES`);
 *   - which codex prompt (if any) is raised for an MCP-tool approval, and whether the launch flag /
 *     config pre-grant suppresses it (#78);
 *   - the Claude status-line format the usage sampler parses (#67-adjacent);
 *   - a raw usage sample.
 *
 * This harness is the WIRED observation tap. It is GATED on `CO_HOST_LIVE_CAPTURE=<dir>`:
 *   - UNSET ⇒ {@link openHostLiveCapture} returns an INERT capture whose `onPasteEcho` is `undefined`
 *     (so spreading it into `injectOptions` adds nothing) and whose `capture*` methods are no-ops.
 *     The live launch path threads it UNCONDITIONALLY, so production carries zero overhead when the
 *     env is unset — it is NOT test-only scaffolding.
 *   - SET ⇒ each observation is appended (best-effort, never throwing into the hot path) as one JSON
 *     line to a per-kind file under `<dir>`, so an operator doing a single live run captures the real
 *     bytes/keys and can swap the placeholders for verified values.
 *
 * Pure-ish by construction: all logic (env gating, record shaping) is exercised in-process; only the
 * append is real I/O and is isolated in {@link HostLiveCaptureSink} so the gating/shaping is unit-tested
 * without a live binary. NEVER throws into the caller (Principle 9 stays the daemon's; capture is
 * diagnostic and must never break a turn).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { InjectMailOptions } from '@co/core';

/** The env var that arms the harness; its value is the capture output directory. */
export const CO_HOST_LIVE_CAPTURE_ENV = 'CO_HOST_LIVE_CAPTURE';

/** The per-kind capture file names written under the capture dir. */
export const CAPTURE_FILES = {
  pasteEcho: 'paste-echo.jsonl',
  mcpApproval: 'mcp-approval.jsonl',
  claudeStatusLine: 'claude-status-line.jsonl',
  usageSample: 'usage-sample.jsonl',
} as const;

/** One MCP-tool approval observation (#78): did a prompt appear, was it auto-approved? */
export interface McpApprovalObservation {
  readonly agent: string;
  readonly provider: string;
  readonly tool: string;
  /** Raw pane text around the tool call (where a prompt would render). */
  readonly paneExcerpt: string;
  /** Whether an interactive approval prompt was detected in the excerpt. */
  readonly promptDetected: boolean;
}

/** One Claude status-line observation (#67-adjacent): the raw line the usage sampler parses. */
export interface ClaudeStatusLineObservation {
  readonly agent: string;
  readonly rawLine: string;
}

/** One usage sample observation: the snapshot the dispatcher placed against. */
export interface UsageSampleObservation {
  readonly provider: string;
  readonly account: string;
  readonly source: string;
  readonly raw: unknown;
}

/**
 * The capture surface threaded through the live launch path. When armed, `onPasteEcho` is a real
 * recorder spread into {@link InjectMailOptions}; when inert it is `undefined` (a no-op spread).
 */
export interface HostLiveCapture {
  /** Armed iff `CO_HOST_LIVE_CAPTURE` was set to a non-empty dir. */
  readonly armed: boolean;
  /**
   * The composer-echo tap for {@link InjectMailOptions.onPasteEcho}. `undefined` when inert, so
   * `{ ...injectOptions, ...(capture.onPasteEcho ? { onPasteEcho: capture.onPasteEcho } : {}) }`
   * (or a conditional spread) adds nothing in production with the env unset.
   */
  readonly onPasteEcho?: (chunk: string, multiline: boolean) => void;
  /** Record an MCP-tool approval observation (#78). No-op when inert. */
  readonly captureMcpApproval: (obs: McpApprovalObservation) => void;
  /** Record a Claude status-line observation. No-op when inert. */
  readonly captureClaudeStatusLine: (obs: ClaudeStatusLineObservation) => void;
  /** Record a usage sample observation. No-op when inert. */
  readonly captureUsageSample: (obs: UsageSampleObservation) => void;
}

/** The append sink — isolated so the gating/shaping is testable without real I/O. */
export interface HostLiveCaptureSink {
  /** Append one record (already JSON-serializable) to the named capture file. */
  readonly append: (file: string, record: unknown) => void;
}

/** The default sink: appends one JSON line per record to `<dir>/<file>`, creating `<dir>` if needed. */
export function fileCaptureSink(dir: string): HostLiveCaptureSink {
  let ensuredDir = false;
  return {
    append: (file, record) => {
      try {
        if (!ensuredDir) {
          mkdirSync(dir, { recursive: true });
          ensuredDir = true;
        }
        appendFileSync(
          join(dir, file),
          JSON.stringify({ at: new Date().toISOString(), ...asObject(record) }) + '\n',
        );
      } catch {
        /* capture is diagnostic; a write failure must never break the live run */
      }
    },
  };
}

function asObject(record: unknown): Record<string, unknown> {
  return record != null && typeof record === 'object' && !Array.isArray(record)
    ? (record as Record<string, unknown>)
    : { value: record };
}

/** The inert capture: armed=false, no `onPasteEcho`, every `capture*` a no-op. */
const INERT_CAPTURE: HostLiveCapture = {
  armed: false,
  captureMcpApproval: () => {},
  captureClaudeStatusLine: () => {},
  captureUsageSample: () => {},
};

/**
 * Open the host-live capture from `env`. Returns the {@link INERT_CAPTURE} when
 * `CO_HOST_LIVE_CAPTURE` is unset/blank (production default, zero overhead); otherwise an armed
 * capture that records observations through `sink` (default: {@link fileCaptureSink} under the dir).
 *
 * This is wired into the REAL launch path (`runServeConductor` → `serveConductor`) UNCONDITIONALLY,
 * so it arms on a real run the instant the operator sets the env — it is not test-only.
 */
export function openHostLiveCapture(
  env: NodeJS.ProcessEnv = process.env,
  sink?: HostLiveCaptureSink,
): HostLiveCapture {
  const dir = env[CO_HOST_LIVE_CAPTURE_ENV];
  if (dir == null || dir.trim() === '') return INERT_CAPTURE;
  const resolvedSink = sink ?? fileCaptureSink(dir);
  return {
    armed: true,
    onPasteEcho: (chunk, multiline) =>
      resolvedSink.append(CAPTURE_FILES.pasteEcho, {
        multiline,
        chunk,
        // A JSON-safe, escape-visible rendering so a captured ESC/control byte is human-readable.
        chunkEscaped: JSON.stringify(chunk),
      }),
    captureMcpApproval: (obs) => resolvedSink.append(CAPTURE_FILES.mcpApproval, obs),
    captureClaudeStatusLine: (obs) => resolvedSink.append(CAPTURE_FILES.claudeStatusLine, obs),
    captureUsageSample: (obs) => resolvedSink.append(CAPTURE_FILES.usageSample, obs),
  };
}

/**
 * Spread helper: yields `{ onPasteEcho }` only when the capture is armed, so a caller can write
 * `injectOptions = { ...base, ...injectCaptureOptions(capture) }` and add nothing in production
 * (exactOptionalPropertyTypes-safe — never an explicit `onPasteEcho: undefined`).
 */
export function injectCaptureOptions(
  capture: HostLiveCapture,
): Pick<InjectMailOptions, 'onPasteEcho'> | Record<string, never> {
  return capture.onPasteEcho != null ? { onPasteEcho: capture.onPasteEcho } : {};
}
