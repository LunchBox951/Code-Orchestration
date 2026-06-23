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
import { appendFileSync, closeSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { InjectMailOptions, Provider } from '@co/core';

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
  readonly provider: Provider;
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
  readonly provider: Provider;
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
  /** Absolute output directory when armed. */
  readonly dir?: string;
  /**
   * The composer-echo tap for {@link InjectMailOptions.onPasteEcho}. `undefined` when inert, so
   * `{ ...injectOptions, ...(capture.onPasteEcho ? { onPasteEcho: capture.onPasteEcho } : {}) }`
   * (or a conditional spread) adds nothing in production with the env unset. The second arg preserves
   * the legacy `multiline` semantic; the third arg is the real paste decision (`pasted`): true for
   * multi-line OR long single-line payloads (#92), false for short single-line ones.
   */
  readonly onPasteEcho?: (chunk: string, multiline: boolean, pasted: boolean) => void;
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

export interface HostLiveCaptureOptions {
  /** Directory that capture output must not live inside (normally the project/repo cwd). */
  readonly forbiddenRoot?: string;
  /** Diagnostic sink for rejected paths or write failures. */
  readonly onError?: (error: Error) => void;
}

/** The default sink: appends one JSON line per record to `<dir>/<file>`, creating `<dir>` if needed. */
export function fileCaptureSink(
  dir: string,
  opts: Pick<HostLiveCaptureOptions, 'onError'> = {},
): HostLiveCaptureSink {
  let ensuredDir = false;
  let reportedWriteFailure = false;
  const reportWriteFailure = (cause: unknown): void => {
    if (reportedWriteFailure) return;
    reportedWriteFailure = true;
    reportCaptureError(
      opts.onError,
      new Error(
        `host-live capture: failed to append capture evidence under '${dir}': ${errorMessage(cause)}`,
        cause instanceof Error ? { cause } : undefined,
      ),
    );
  };
  return {
    append: (file, record) => {
      try {
        if (!ensuredDir) {
          // 0o700 — captured pane bytes can include secrets, so the capture tree must not be
          // group/other-readable on a multi-user host (see docs/host-proof.md).
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          ensuredDir = true;
        }
        // Open with an explicit 0o600 create-mode and append through the fd: appendFileSync's mode
        // only applies on create and is masked by umask, so the fd form is the robust restriction.
        const fd = openSync(join(dir, file), 'a', 0o600);
        try {
          appendFileSync(
            fd,
            JSON.stringify({ at: new Date().toISOString(), ...asObject(record) }) + '\n',
          );
        } finally {
          closeSync(fd);
        }
      } catch (cause) {
        reportWriteFailure(cause);
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
  opts: HostLiveCaptureOptions = {},
): HostLiveCapture {
  const dir = env[CO_HOST_LIVE_CAPTURE_ENV];
  if (dir == null || dir.trim() === '') return INERT_CAPTURE;
  const rawDir = dir.trim();
  const resolvedDir = resolve(rawDir);
  if (!isAbsolute(rawDir)) {
    reportCaptureError(
      opts.onError,
      new Error(
        `host-live capture: ${CO_HOST_LIVE_CAPTURE_ENV} must be an absolute path outside the repo; ` +
          `got '${dir}'. Capture is disabled.`,
      ),
    );
    return INERT_CAPTURE;
  }
  if (opts.forbiddenRoot != null && isPathInsideOrEqual(opts.forbiddenRoot, resolvedDir)) {
    reportCaptureError(
      opts.onError,
      new Error(
        `host-live capture: refusing to write capture evidence inside '${resolve(opts.forbiddenRoot)}' ` +
          `(got '${resolvedDir}'). Capture is disabled to preserve the pristine repo invariant.`,
      ),
    );
    return INERT_CAPTURE;
  }
  if (sink == null) {
    try {
      probeCaptureDir(resolvedDir);
    } catch (cause) {
      reportCaptureError(
        opts.onError,
        new Error(
          `host-live capture: '${resolvedDir}' is not writable: ${errorMessage(cause)}. ` +
            'Capture is disabled.',
          cause instanceof Error ? { cause } : undefined,
        ),
      );
      return INERT_CAPTURE;
    }
  }
  const resolvedSink = sink ?? fileCaptureSink(resolvedDir, opts);
  return {
    armed: true,
    dir: resolvedDir,
    onPasteEcho: (chunk, multiline, pasted) =>
      resolvedSink.append(CAPTURE_FILES.pasteEcho, {
        multiline,
        pasted,
        chunk,
        // A JSON-safe, escape-visible rendering so a captured ESC/control byte is human-readable.
        chunkEscaped: JSON.stringify(chunk),
      }),
    captureMcpApproval: (obs) => resolvedSink.append(CAPTURE_FILES.mcpApproval, obs),
    captureClaudeStatusLine: (obs) => resolvedSink.append(CAPTURE_FILES.claudeStatusLine, obs),
    captureUsageSample: (obs) => resolvedSink.append(CAPTURE_FILES.usageSample, obs),
  };
}

function probeCaptureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 }); // captured bytes may include secrets — keep it owner-only
  const probe = join(dir, '.co-host-live-capture-probe');
  appendFileSync(probe, '');
  try {
    unlinkSync(probe);
  } catch {
    /* best-effort cleanup; a leftover empty probe is harmless in the capture dir */
  }
}

function isPathInsideOrEqual(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function reportCaptureError(onError: ((error: Error) => void) | undefined, error: Error): void {
  try {
    onError?.(error);
  } catch {
    /* diagnostic sinks must never break host startup */
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
