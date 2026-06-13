/**
 * Stage 9 P6 (L8-B) — `co doctor`: structural health suite. Runs four checks and returns a
 * {@link DoctorReport} with an explicit ok/warn/fail + reason per check (Principle 9 — no silent
 * failures). The live auth/reachability + version probe is a {@link ProviderProbeSeam} [host-live]
 * seam (D5) — sandbox tests inject synthetic results; the real binary probe connects at runtime.
 *
 * Operator-only: these are NOT agent MCP tools. No ToolSpec is registered here; the completeness
 * gate stays green by construction. The P7 CLI exposes them.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Provider } from '../dispatch/usage-source.js';
import { openProjectStore } from '../store/sqlite-store.js';
import { buildCoreRegistry } from '../tools/core-registry.js';
import { checkToolCompleteness } from '../tools/completeness.js';
import { buildProjectProjectors, buildProjectDecode } from '../replay/recovery.js';
import { rebuildAll } from '../replay/projector.js';

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
}

/**
 * Injectable seam for the provider version/capability probe ([host-live] D5).
 * Sandbox tests inject synthetic results; the real binary probe wires in at runtime.
 */
export type ProviderProbeSeam = (provider: Provider) => ProviderProbeResult;

/**
 * Capabilities every provider MUST advertise — derived from the dispatch/tier.ts default
 * capability matrix (which drives every placed agent). A skewed-version provider that still
 * has all required capabilities proceeds with WARN; missing any one hard-stops (fail).
 */
export const REQUIRED_CAPABILITIES: readonly string[] = ['inference', 'tool-use'];

/** The two providers the tier matrix monitors by default (claude + codex). */
const MONITORED_PROVIDERS: readonly Provider[] = ['claude', 'codex'];

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

  for (const provider of MONITORED_PROVIDERS) {
    const result = providerProbe(provider);
    const missingCaps = REQUIRED_CAPABILITIES.filter((c) => !result.capabilities.includes(c));

    if (missingCaps.length > 0) {
      fails.push(
        `${provider}: missing required capabilities [${missingCaps.join(', ')}] — hard-stop.`,
      );
    } else if (result.versionSkewed) {
      warns.push(
        `${provider}: version skew detected (version=${result.version ?? 'unknown'}) — ` +
          `all required capabilities present; proceeding at-risk.`,
      );
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
  return { name, status: 'ok', reason: 'All monitored providers are compatible.' };
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
