/**
 * Stage 9 P6 (L8-B) — `co doctor`: structural health suite. Runs four checks and returns a
 * {@link DoctorReport} with an explicit ok/warn/fail + reason per check (Principle 9 — no silent
 * failures). The live auth/reachability + version probe is a {@link ProviderProbeSeam} [host-live]
 * seam (D5) — sandbox tests inject synthetic results; the real binary probe connects at runtime.
 *
 * Operator-only: these are NOT agent MCP tools. No ToolSpec is registered here; the completeness
 * gate stays green by construction. The P7 CLI exposes them.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CLAUDE_AUTH_STATUS_ARGS, parseClaudeAuthStatus } from '../dispatch/claude-source.js';
import { CODEX_DOCTOR_ARGS, parseCodexDoctor } from '../dispatch/codex-source.js';
import type { Provider } from '../dispatch/usage-source.js';
import { openProjectStore } from '../store/sqlite-store.js';
import { buildCoreRegistry } from '../tools/core-registry.js';
import { checkToolCompleteness } from '../tools/completeness.js';
import { buildProjectProjectors, buildProjectDecode } from '../replay/recovery.js';
import { rebuildAll } from '../replay/projector.js';
import { assertNever } from '../assert-never.js';

// ─── Report types ─────────────────────────────────────────────────────────────

export type DoctorStatus = 'ok' | 'warn' | 'fail';

/** One structural health check result: explicit status + human reason (never silent). */
export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly reason: string;
}

/** The full doctor report. `healthy` is `true` iff every check is `'ok'`. */
export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly healthy: boolean;
}

// ─── Provider probe seam ([host-live] D5) ────────────────────────────────────

/**
 * Result from one [host-live] provider probe.
 *
 * - `version`: the observed version string, or `undefined` when not detectable.
 * - `versionSkewed`: `true` when the version differs from the expected pinned version —
 *   a skewed-but-workable provider proceeds with a loud WARN (degrade-safely-and-loudly).
 * - `capabilities`: the capabilities this instance advertises. Every entry in
 *   {@link REQUIRED_CAPABILITIES} must be present or the doctor hard-stops (fail).
 */
export interface ProviderProbeResult {
  readonly version: string | undefined;
  readonly versionSkewed: boolean;
  readonly capabilities: readonly string[];
  readonly diagnostic?: string;
}

/**
 * Injectable seam for the provider version/capability probe ([host-live] D5).
 * Sandbox tests inject synthetic results; the real binary probe wires in at runtime.
 */
export type ProviderProbeSeam = (provider: Provider) => ProviderProbeResult;

/** Result from running one metadata-only provider command for {@link defaultProviderProbe}. */
export interface ProviderProbeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
  readonly error?: Error;
}

/** A sync, shell-free command seam for provider metadata probes. */
export type ProviderProbeCommand = (
  command: string,
  args: readonly string[],
) => ProviderProbeCommandResult;

export interface DefaultProviderProbeOptions {
  readonly command?: ProviderProbeCommand;
  readonly expectedVersions?: Partial<Record<Provider, string | RegExp>>;
}

/**
 * Capabilities every provider MUST advertise — derived from the dispatch/tier.ts default
 * capability matrix (which drives every placed agent). A skewed-version provider that still
 * has all required capabilities proceeds with WARN; missing any one hard-stops (fail).
 */
export const REQUIRED_CAPABILITIES: readonly string[] = ['inference', 'tool-use'];

/** The two providers the tier matrix monitors by default (claude + codex). */
const MONITORED_PROVIDERS: readonly Provider[] = ['claude', 'codex'];

const PROVIDER_PROBE_TIMEOUT_MS = 15_000;

function realProviderProbeCommand(
  command: string,
  args: readonly string[],
): ProviderProbeCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: PROVIDER_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out: ProviderProbeCommandResult = {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    status: result.status,
    ...(result.error instanceof Error ? { error: result.error } : {}),
  };
  return out;
}

function trimmed(value: string): string | undefined {
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function commandDiagnostic(label: string, result: ProviderProbeCommandResult): string {
  const detail = trimmed(result.stderr) ?? result.error?.message ?? `exit status ${result.status}`;
  return `${label} failed: ${detail}`;
}

function parseJsonObject(raw: string): { readonly value: unknown } | { readonly error: string } {
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `invalid JSON: ${msg}` };
  }
}

function versionSkewed(
  provider: Provider,
  version: string | undefined,
  expectedVersions: Partial<Record<Provider, string | RegExp>>,
): boolean {
  if (version === undefined) return true;
  const expected = expectedVersions[provider];
  if (expected === undefined) return false;
  return typeof expected === 'string' ? version !== expected : !expected.test(version);
}

function probeClaude(
  command: ProviderProbeCommand,
  expectedVersions: Partial<Record<Provider, string | RegExp>>,
): ProviderProbeResult {
  const versionResult = command('claude', ['--version']);
  const version = versionResult.status === 0 ? trimmed(versionResult.stdout) : undefined;
  const auth = command('claude', CLAUDE_AUTH_STATUS_ARGS);
  if (auth.error !== undefined || auth.status !== 0 || trimmed(auth.stdout) === undefined) {
    return {
      version,
      versionSkewed: versionSkewed('claude', version, expectedVersions),
      capabilities: [],
      diagnostic: commandDiagnostic('claude auth status --json', auth),
    };
  }
  const parsed = parseJsonObject(auth.stdout);
  if ('error' in parsed) {
    return {
      version,
      versionSkewed: versionSkewed('claude', version, expectedVersions),
      capabilities: [],
      diagnostic: `claude auth status --json returned ${parsed.error}.`,
    };
  }
  const account = parseClaudeAuthStatus(parsed.value);
  if (!account.loggedIn) {
    return {
      version,
      versionSkewed: versionSkewed('claude', version, expectedVersions),
      capabilities: [],
      diagnostic: 'claude auth status --json reported not logged in.',
    };
  }
  return {
    version,
    versionSkewed: versionSkewed('claude', version, expectedVersions),
    capabilities: [...REQUIRED_CAPABILITIES],
  };
}

function probeCodex(
  command: ProviderProbeCommand,
  expectedVersions: Partial<Record<Provider, string | RegExp>>,
): ProviderProbeResult {
  const versionResult = command('codex', ['--version']);
  const version = versionResult.status === 0 ? trimmed(versionResult.stdout) : undefined;
  const doctor = command('codex', CODEX_DOCTOR_ARGS);
  if (doctor.error !== undefined || doctor.status !== 0 || trimmed(doctor.stdout) === undefined) {
    return {
      version,
      versionSkewed: versionSkewed('codex', version, expectedVersions),
      capabilities: [],
      diagnostic: commandDiagnostic('codex doctor --json', doctor),
    };
  }
  const parsed = parseJsonObject(doctor.stdout);
  if ('error' in parsed) {
    return {
      version,
      versionSkewed: versionSkewed('codex', version, expectedVersions),
      capabilities: [],
      diagnostic: `codex doctor --json returned ${parsed.error}.`,
    };
  }
  const account = parseCodexDoctor(parsed.value);
  if (!account.healthy) {
    return {
      version,
      versionSkewed: versionSkewed('codex', version, expectedVersions),
      capabilities: [],
      diagnostic: 'codex doctor --json reported the provider is unhealthy or unauthenticated.',
    };
  }
  return {
    version,
    versionSkewed: versionSkewed('codex', version, expectedVersions),
    capabilities: [...REQUIRED_CAPABILITIES],
  };
}

/**
 * Build the real provider compatibility probe used by the CLI host process.
 *
 * The commands are metadata-only:
 * - Claude: `claude --version`, `claude auth status --json`
 * - Codex: `codex --version`, `codex doctor --json`
 *
 * No inference subcommands are spawned.
 */
export function defaultProviderProbe(options: DefaultProviderProbeOptions = {}): ProviderProbeSeam {
  const command = options.command ?? realProviderProbeCommand;
  const expectedVersions = options.expectedVersions ?? {};
  return (provider) => {
    switch (provider) {
      case 'claude':
        return probeClaude(command, expectedVersions);
      case 'codex':
        return probeCodex(command, expectedVersions);
      default:
        return assertNever(provider);
    }
  };
}

// ─── Doctor deps ──────────────────────────────────────────────────────────────

export interface DoctorDeps {
  /** Project id whose event store to integrity-check. */
  readonly projectId: string;
  /** Absolute path to the repo root — used for project-memory file presence checks. */
  readonly repoRoot: string;
  /**
   * Injectable provider probe seam ([host-live] D5). When absent, the provider-compatibility
   * check is skipped (status: 'ok'). The real binary probe wires in at runtime.
   */
  readonly providerProbe?: ProviderProbeSeam;
}

// ─── Snapshot helpers ────────────────────────────────────────────────────────

/** Snapshot all read-model projection tables (excluding `events`) as a structured map. */
function snapshotProjections(db: DatabaseSync): Record<string, unknown[]> {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name != 'events'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);

  const snap: Record<string, unknown[]> = {};
  for (const name of tables) {
    snap[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all() as unknown[];
  }
  return snap;
}

/**
 * Compare two snapshots table-by-table, treating a missing table as an empty table so that
 * lazy-created tables that had no rows before rebuild compare equal after rebuild.
 *
 * Returns a human-readable divergence reason, or `null` when identical.
 */
function compareSnapshots(
  before: Record<string, unknown[]>,
  after: Record<string, unknown[]>,
): string | null {
  const allTables = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const table of allTables) {
    const beforeRows = JSON.stringify(before[table] ?? []);
    const afterRows = JSON.stringify(after[table] ?? []);
    if (beforeRows !== afterRows) {
      return `Projection divergence in table '${table}': live read-model differs from a fresh replay of the event log.`;
    }
  }
  return null;
}

// ─── Individual checks ────────────────────────────────────────────────────────

/**
 * Program-data integrity: snapshot the live projections, rebuild from the event log, compare.
 * Any divergence (or a decode/validate error during rebuild) is surfaced as fail.
 * After this check the store is in a consistent (rebuilt) state regardless of outcome.
 */
function checkProgramDataIntegrity(projectId: string): DoctorCheck {
  const name = 'program-data-integrity';
  const store = openProjectStore(projectId);
  try {
    const pre = store.transaction((tx) => snapshotProjections(tx.raw as DatabaseSync));
    rebuildAll(store, buildProjectProjectors(), buildProjectDecode());
    const post = store.transaction((tx) => snapshotProjections(tx.raw as DatabaseSync));
    const divergence = compareSnapshots(pre, post);
    if (divergence != null) {
      return { name, status: 'fail', reason: divergence };
    }
    return { name, status: 'ok', reason: 'Live projections are consistent with the event log.' };
  } catch (err) {
    return {
      name,
      status: 'fail',
      reason: `Rebuild/decode failure: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    store.close();
  }
}

/**
 * Project-memory validity: verify CLAUDE.md and AGENTS.md are present in the repo root.
 * A CLAUDE.md-only repo loads NO project memory for Codex agents (documented gap, providers.md);
 * surfaced as a loud WARN rather than a fail (the system can still run, just with Codex memory-blind).
 * Neither file present → fail (no provider can read project memory).
 */
function checkProjectMemoryValidity(repoRoot: string): DoctorCheck {
  const name = 'project-memory-validity';
  const hasClaudeMd = existsSync(join(repoRoot, 'CLAUDE.md'));
  const hasAgentsMd = existsSync(join(repoRoot, 'AGENTS.md'));

  if (hasClaudeMd && hasAgentsMd) {
    return { name, status: 'ok', reason: 'CLAUDE.md and AGENTS.md are both present.' };
  }
  if (hasClaudeMd && !hasAgentsMd) {
    return {
      name,
      status: 'warn',
      reason:
        'CLAUDE.md present but AGENTS.md absent: Codex agents will run memory-blind on this repo ' +
        '(documented gap — providers.md). Remedy: create AGENTS.md or symlink it to CLAUDE.md.',
    };
  }
  if (!hasClaudeMd && hasAgentsMd) {
    return {
      name,
      status: 'warn',
      reason:
        'AGENTS.md present but CLAUDE.md absent: Claude agents will run memory-blind on this repo. ' +
        'Remedy: create CLAUDE.md or symlink it to AGENTS.md.',
    };
  }
  return {
    name,
    status: 'fail',
    reason:
      'Neither CLAUDE.md nor AGENTS.md found in repo root: no provider can load project memory.',
  };
}

/**
 * Live MCP-surface completeness: run checkToolCompleteness over buildCoreRegistry().
 * Any ToolViolation (declared-but-stubbed agent tool) is a fail (Principle 4 — declared-not-stubbed;
 * AC-L2-3). Pure function — no I/O, no store, identical to the CI gate.
 */
function checkMcpSurfaceCompleteness(): DoctorCheck {
  const name = 'mcp-surface-completeness';
  const violations = checkToolCompleteness(buildCoreRegistry());
  if (violations.length === 0) {
    return { name, status: 'ok', reason: 'All declared MCP tools are complete (no stubs).' };
  }
  const summary = violations.map((v) => `  ${v.tool}: ${v.reason}`).join('\n');
  return {
    name,
    status: 'fail',
    reason: `${violations.length} tool violation(s) detected:\n${summary}`,
  };
}

/**
 * Provider version / capability compatibility: for each monitored provider, call the injected
 * probe seam and check required capabilities.
 *
 * - Version skewed but all required capabilities present → loud WARN (proceed-at-risk).
 * - Any required capability absent → hard-stop (fail).
 * - Probe absent → skip (ok) — the real [host-live] D5 probe wires in at runtime.
 */
function checkProviderCompatibility(providerProbe: ProviderProbeSeam | undefined): DoctorCheck {
  const name = 'provider-compatibility';

  if (providerProbe == null) {
    return {
      name,
      status: 'ok',
      reason: 'Provider compatibility probe not wired ([host-live] D5 — skipped in sandbox).',
    };
  }

  const warns: string[] = [];
  const fails: string[] = [];
  const ok: string[] = [];

  for (const provider of MONITORED_PROVIDERS) {
    const result = providerProbe(provider);
    const missingCaps = REQUIRED_CAPABILITIES.filter((c) => !result.capabilities.includes(c));

    if (missingCaps.length > 0) {
      const diagnostic = result.diagnostic === undefined ? '' : ` ${result.diagnostic}`;
      fails.push(
        `${provider}: missing required capabilities [${missingCaps.join(
          ', ',
        )}] — hard-stop.${diagnostic}`,
      );
    } else if (result.versionSkewed) {
      const diagnostic = result.diagnostic === undefined ? '' : ` ${result.diagnostic}`;
      warns.push(
        `${provider}: version skew detected (version=${result.version ?? 'unknown'}) — ` +
          `all required capabilities present; proceeding at-risk.${diagnostic}`,
      );
    } else {
      ok.push(`${provider}: version=${result.version ?? 'unknown'}`);
    }
  }

  if (fails.length > 0) {
    return { name, status: 'fail', reason: fails.join(' ') };
  }
  if (warns.length > 0) {
    return {
      name,
      status: 'warn',
      reason: warns.join(' '),
    };
  }
  return {
    name,
    status: 'ok',
    reason: `All monitored providers are compatible (${ok.join('; ')}).`,
  };
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Run the full `co doctor` structural health suite and return a {@link DoctorReport}.
 *
 * Every check yields an explicit ok/warn/fail + reason — no silent passes. A recoverable
 * problem is a loud WARN that proceeds; a hard-stop fires only on a genuinely absent
 * REQUIRED capability or a structural integrity failure (Principle 9 — no-silent-failures).
 */
export function runDoctor(deps: DoctorDeps): DoctorReport {
  const checks: DoctorCheck[] = [
    checkProgramDataIntegrity(deps.projectId),
    checkProjectMemoryValidity(deps.repoRoot),
    checkMcpSurfaceCompleteness(),
    checkProviderCompatibility(deps.providerProbe),
  ];
  return {
    checks,
    healthy: checks.every((c) => c.status === 'ok'),
  };
}
