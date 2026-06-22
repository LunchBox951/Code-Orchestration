/**
 * Holistic recovery from the event store alone — AC-S9-3.
 *
 * Assembles the CANONICAL projector set (one instance of each project-level projector,
 * deduplicated — MailProjector appears once even though mail-store + worktree-store both
 * open it; ReviewProjector appears once even though mail-store + dispatch-store both open
 * it) and the FULL UNION DECODE (all per-domain upcasters + schemas merged into one pass),
 * then runs rebuildAll over the project event store so every read-model is reconstructed
 * from program-data alone.
 *
 * NO repo dependency: recovery reads ONLY the SQLite event store (CO_DATA_DIR/…);
 * it never reads git, the working tree, or any .co/ file. Reconstructed projections
 * are byte-identical to the pre-crash projections (AC-L0-2 holistic).
 *
 * For P4 (watchdog-reconcile): `selectAllSessions` returns every agent whose session
 * has not yet ended (session.created with no session.ended) — exactly the RUNNING set
 * a watchdog needs to reconcile after a crash. Use it alongside `selectAllAgents` and
 * `selectAllPlacements` to determine what each in-flight agent was doing.
 */
import type { StoredEvent } from '../store/types.js';
import { decode, type SchemaMap } from './decode.js';
import { rebuildAll, type Projector } from './projector.js';
import type { UpcasterRegistry } from './upcaster.js';
import { openProjectStore, openGlobalStore } from '../store/sqlite-store.js';

// ── Per-domain projectors and event-codec pairs ──────────────────────────────
import { ConfigProjector } from '../config/config-projector.js';
import { configSchemas, configUpcasters } from '../config/events.js';
import { ProjectsProjector } from '../registry/projects-projector.js';
import { registrySchemas, registryUpcasters } from '../registry/events.js';
import { RosterProjector } from '../roles/roster-projector.js';
import { rolesSchemas, rolesUpcasters } from '../roles/events.js';
import { PlansProjector } from '../plans/plans-projector.js';
import { plansSchemas, plansUpcasters } from '../plans/events.js';
import { MailProjector } from '../mail/mail-projector.js';
import { mailSchemas, mailUpcasters } from '../mail/events.js';
import { ReviewProjector } from '../review/review-projector.js';
import { reviewSchemas, reviewUpcasters } from '../review/events.js';
import { SpecsProjector } from '../specs/specs-projector.js';
import { specsSchemas, specsUpcasters } from '../specs/events.js';
import { SessionProjector } from '../session/session-projector.js';
import { sessionSchemas, sessionUpcasters } from '../session/events.js';
import { CostProjector } from '../dispatch/cost-projector.js';
import { PlacementProjector } from '../dispatch/placement-projector.js';
import { ToolUsageProjector } from '../dispatch/tool-usage-projector.js';
import { UsageProjector } from '../dispatch/usage-projector.js';
import { dispatchSchemas, dispatchUpcasters } from '../dispatch/events.js';
import { WorktreeProjector } from '../worktrees/worktree-projector.js';
import { worktreeSchemas, worktreeUpcasters } from '../worktrees/events.js';
import { IssuesProjector } from '../issues/issues-projector.js';
import { issuesSchemas, issuesUpcasters } from '../issues/events.js';
import { ResearchProjector } from '../research/research-projector.js';
import { researchSchemas, researchUpcasters } from '../research/events.js';
import { ArchiveProjector } from '../archive/archive-projector.js';
import { archiveSchemas, archiveUpcasters } from '../archive/events.js';
import { AgentControlProjector } from '../operator-control/control-projector.js';
import { operatorControlSchemas, operatorControlUpcasters } from '../operator-control/events.js';

// ── P4 running-state selectors ────────────────────────────────────────────────
// Re-exported so the watchdog-reconcile loop can query the recovered state without
// importing the projector modules directly.
export { selectAllSessions, selectSession } from '../session/session-projector.js';
export { selectAllAgents, selectAgent } from '../roles/roster-projector.js';
export { selectAllPlacements, selectPlacementsByAgent } from '../dispatch/placement-projector.js';

// ── Internal helpers ─────────────────────────────────────────────────────────

/** Merge schema maps into one. Throws on duplicate event type (programming error). */
function mergeSchemas(...maps: readonly SchemaMap[]): SchemaMap {
  const merged: SchemaMap = new Map();
  for (const m of maps) {
    for (const [type, schema] of m) {
      if (merged.has(type)) {
        throw new Error(`recovery: duplicate event type in schema union '${type}'`);
      }
      merged.set(type, schema);
    }
  }
  return merged;
}

/** Merge upcaster registries into one. Throws on duplicate event type (programming error). */
function mergeUpcasters(...maps: readonly UpcasterRegistry[]): UpcasterRegistry {
  const merged: UpcasterRegistry = new Map();
  for (const m of maps) {
    for (const [type, chain] of m) {
      if (merged.has(type)) {
        throw new Error(`recovery: duplicate event type in upcaster union '${type}'`);
      }
      merged.set(type, chain);
    }
  }
  return merged;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * The canonical projector set for the per-project event store: every project-level
 * read-model's projector, exactly once.
 *
 * Dedup rule: MailProjector appears once even though mail-store + worktree-store both
 * open it; ReviewProjector appears once even though mail-store + dispatch-store both open
 * it. Adding a new domain means adding one projector here and its schemas/upcasters to
 * {@link buildProjectDecode}.
 */
export function buildProjectProjectors(): readonly Projector[] {
  return [
    new RosterProjector(),
    new PlansProjector(),
    new MailProjector(),
    new ReviewProjector(),
    new SpecsProjector(),
    new SessionProjector(),
    new PlacementProjector(),
    new WorktreeProjector(),
    new IssuesProjector(),
    new CostProjector(),
    new ToolUsageProjector(),
    new UsageProjector(),
    new ResearchProjector(),
    new ArchiveProjector(),
    new AgentControlProjector(),
  ];
}

/**
 * The canonical projector set for the global event store (config + registry).
 * These live in {@link openGlobalStore}, not the per-project store.
 */
export function buildGlobalProjectors(): readonly Projector[] {
  return [new ConfigProjector(), new ProjectsProjector()];
}

/**
 * The full union decode for the project store: merges every per-domain upcaster chain and
 * current-version schema into a single pass. Running the IDENTICAL decode on both the live
 * append path AND rebuildAll is what makes recovered projections byte-equal (AC-L0-2).
 */
export function buildProjectDecode(): (event: StoredEvent) => StoredEvent {
  const schemas = mergeSchemas(
    rolesSchemas,
    plansSchemas,
    mailSchemas,
    reviewSchemas,
    specsSchemas,
    sessionSchemas,
    dispatchSchemas,
    worktreeSchemas,
    issuesSchemas,
    researchSchemas,
    archiveSchemas,
    operatorControlSchemas,
  );
  const upcasters = mergeUpcasters(
    rolesUpcasters,
    plansUpcasters,
    mailUpcasters,
    reviewUpcasters,
    specsUpcasters,
    sessionUpcasters,
    dispatchUpcasters,
    worktreeUpcasters,
    issuesUpcasters,
    researchUpcasters,
    archiveUpcasters,
    operatorControlUpcasters,
  );
  return (event) => decode(event, upcasters, schemas);
}

/**
 * The full union decode for the global store: merges config + registry schemas/upcasters.
 */
export function buildGlobalDecode(): (event: StoredEvent) => StoredEvent {
  const schemas = mergeSchemas(configSchemas, registrySchemas);
  const upcasters = mergeUpcasters(configUpcasters, registryUpcasters);
  return (event) => decode(event, upcasters, schemas);
}

/**
 * Holistic project-store recovery (AC-S9-3): open the project event store, drop ALL
 * per-project projections, and re-fold the full event log from seq=1. Reads program-data
 * ONLY — no git, no working tree, no .co/ files. Recovered projections are byte-equal to
 * the pre-crash projections (AC-L0-2).
 *
 * After this returns, the project store's read-model tables are fully reconstructed.
 * P4 can open a new store handle and query `selectAllSessions` to find in-flight agents.
 */
export function recoverProjectStore(projectId: string): void {
  const store = openProjectStore(projectId);
  try {
    rebuildAll(store, buildProjectProjectors(), buildProjectDecode());
  } finally {
    store.close();
  }
}

/**
 * Holistic global-store recovery: open the global event store, drop config + registry
 * projections, and re-fold the full log. Reads program-data ONLY.
 */
export function recoverGlobalStore(): void {
  const store = openGlobalStore();
  try {
    rebuildAll(store, buildGlobalProjectors(), buildGlobalDecode());
  } finally {
    store.close();
  }
}
