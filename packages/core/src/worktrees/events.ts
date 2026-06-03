import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';

/**
 * L3 worktree events live in the PROJECT store (one per registered project), exactly like the L1
 * mail events — the owning envelope `projectId` is the real project id (the store owner). They are
 * pure ORCHESTRATION state: a worktree record and the test baseline captured at branch-off. None of
 * it ever touches the target repo (Principle 12 — pristine-repo); it lives only in program-data.
 *
 * Two streams, each keyed by branch via the L0 `${entity}:${id}` scope pattern:
 *   - `worktree:<branch>`  — the created sandbox record (one per slung branch).
 *   - `baseline:<branch>`  — the test baseline captured when the branch was cut from its base.
 *
 * The event types are DOTTED (`worktree.created`, `baseline.captured`) to mark them as L0-style
 * infrastructure events, mirroring `config.set` / `mail.read`.
 */

/** Current payload schema version — v1; no upcasters yet (an empty chain is the identity upcast). */
export const WORKTREE_EVENT_V = 1;

/** A sandbox was created (worktree + branch) from an auto-detected (or overridden) base ref. */
export const EVENT_WORKTREE_CREATED = 'worktree.created' as const;
/** The test baseline captured at branch-off (the honest-verification baseline — review-gates.md). */
export const EVENT_BASELINE_CAPTURED = 'baseline.captured' as const;

/** Scope prefix for the per-branch worktree-record stream; the suffix is the branch. */
export const WORKTREE_SCOPE_PREFIX = 'worktree:';
/** Scope prefix for the per-branch baseline stream; the suffix is the branch. */
export const BASELINE_SCOPE_PREFIX = 'baseline:';

/** A branch's worktree-record stream scope: `worktree:<branch>`. */
export function worktreeScope(branch: string): string {
  return WORKTREE_SCOPE_PREFIX + branch;
}

/** A branch's baseline stream scope: `baseline:<branch>`. */
export function baselineScope(branch: string): string {
  return BASELINE_SCOPE_PREFIX + branch;
}

/**
 * The `worktree.created` payload (camelCase, like `DeliveredMail`): the created sandbox's facts.
 * `baseRef` is the resolved base (auto-detected or overridden), `baseSha` its commit at branch-off,
 * `path` the program-data sandbox dir (NEVER in the repo), `parent` the spawner the sandbox is for.
 */
export const worktreeCreatedSchema = z.object({
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  baseSha: z.string().min(1),
  path: z.string().min(1),
  parent: z.string().min(1),
});
export type WorktreeCreated = z.infer<typeof worktreeCreatedSchema>;

/** One test's outcome in a baseline snapshot — structured, never a prose blob. */
export const testOutcomeSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
});
export type TestOutcome = z.infer<typeof testOutcomeSchema>;

/**
 * The `baseline.captured` payload: the structured test snapshot taken at branch-off, keyed by
 * branch (with the base it was cut from). L5 compares a later run against this to tell a regression
 * (a new failure) from a pre-existing one — this layer only CAPTURES + STORES it (do not compare).
 */
export const baselineCapturedSchema = z.object({
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  baseSha: z.string().min(1),
  tests: z.array(testOutcomeSchema),
});
export type BaselineCaptured = z.infer<typeof baselineCapturedSchema>;

/** Current-version schema per L3 worktree event type — validated on append AND on read (decode). */
export const worktreeSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_WORKTREE_CREATED, worktreeCreatedSchema],
  [EVENT_BASELINE_CAPTURED, baselineCapturedSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const worktreeUpcasters: UpcasterRegistry = new Map();

/**
 * Build + validate a `worktree.created` `NewEvent`. The branch keys the stream scope; the spawner
 * is recorded as the event `actor` (the L0 reserved field), mirroring how a mail's sender lands on
 * `actor`. Self-validating like L0's `make*Event` / L1's `makeMailEvent`.
 */
export function makeWorktreeCreatedEvent(projectId: string, rec: WorktreeCreated): NewEvent {
  const payload = worktreeCreatedSchema.parse(rec);
  return {
    projectId,
    scope: worktreeScope(payload.branch),
    type: EVENT_WORKTREE_CREATED,
    v: WORKTREE_EVENT_V,
    payload,
    actor: payload.parent,
  };
}

/** Build + validate a `baseline.captured` `NewEvent`, keyed on the branch's baseline stream scope. */
export function makeBaselineCapturedEvent(projectId: string, b: BaselineCaptured): NewEvent {
  const payload = baselineCapturedSchema.parse(b);
  return {
    projectId,
    scope: baselineScope(payload.branch),
    type: EVENT_BASELINE_CAPTURED,
    v: WORKTREE_EVENT_V,
    payload,
  };
}

/**
 * A persisted, read-back worktree record — the read-model shape the store facade returns.
 * `createdTs` is the PERSISTED event ts (freeze #6 — never wall-clock on read). `removed` is the
 * phase-E teardown flag, default false; carried now so the read-model shape is stable.
 */
export interface WorktreeRecord {
  readonly branch: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly path: string;
  readonly parent: string;
  readonly createdTs: number;
  readonly removed: boolean;
}

/** A persisted, read-back baseline — the read-model shape `getBaseline` returns. */
export interface Baseline {
  readonly branch: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly tests: readonly TestOutcome[];
  readonly capturedTs: number;
}
