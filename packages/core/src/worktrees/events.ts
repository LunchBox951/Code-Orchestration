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
 * Three streams, each keyed by branch via the L0 `${entity}:${id}` scope pattern:
 *   - `worktree:<branch>`  — the created sandbox record (one per slung branch).
 *   - `baseline:<branch>`  — the test baseline captured when the branch was cut from its base.
 *   - `finish:<branch>`    — the finish recorded by `co_finish` (commit sha + the finish test run).
 *
 * The event types are DOTTED (`worktree.created`, `baseline.captured`, `finish.recorded`) to mark
 * them as L0-style infrastructure events, mirroring `config.set` / `mail.read`.
 */

/** Current payload schema version — v1; no upcasters yet (an empty chain is the identity upcast). */
export const WORKTREE_EVENT_V = 1;

/** A sandbox was created (worktree + branch) from an auto-detected (or overridden) base ref. */
export const EVENT_WORKTREE_CREATED = 'worktree.created' as const;
/** The test baseline captured at branch-off (the honest-verification baseline — review-gates.md). */
export const EVENT_BASELINE_CAPTURED = 'baseline.captured' as const;
/** A finish recorded by `co_finish` (L3-C): the house-style commit + the finish's test run (L5 input). */
export const EVENT_FINISH_RECORDED = 'finish.recorded' as const;
/** A sandbox was torn down (L3-E): its git worktree + program-data dir removed; the record is marked. */
export const EVENT_WORKTREE_REMOVED = 'worktree.removed' as const;

/** Scope prefix for the per-branch worktree-record stream; the suffix is the branch. */
export const WORKTREE_SCOPE_PREFIX = 'worktree:';
/** Scope prefix for the per-branch baseline stream; the suffix is the branch. */
export const BASELINE_SCOPE_PREFIX = 'baseline:';
/** Scope prefix for the per-branch finish stream; the suffix is the branch. */
export const FINISH_SCOPE_PREFIX = 'finish:';

/** A branch's worktree-record stream scope: `worktree:<branch>`. */
export function worktreeScope(branch: string): string {
  return WORKTREE_SCOPE_PREFIX + branch;
}

/** A branch's baseline stream scope: `baseline:<branch>`. */
export function baselineScope(branch: string): string {
  return BASELINE_SCOPE_PREFIX + branch;
}

/** A branch's finish stream scope: `finish:<branch>`. */
export function finishScope(branch: string): string {
  return FINISH_SCOPE_PREFIX + branch;
}

/**
 * The `worktree.created` payload (camelCase, like `DeliveredMail`): the created sandbox's facts.
 * `baseRef` is the resolved base (auto-detected or overridden), `baseSha` its commit at branch-off,
 * `path` the program-data sandbox dir (NEVER in the repo), `parent` the spawner the sandbox is for,
 * `agent` is the assigned child agent allowed to mount the sandbox, `role`/`subRole` are the intended
 * child role binding, and `provisioned` is the gitignored working-essential set actually placed into
 * this sandbox.
 */
export const worktreeProvisionedEntrySchema = z.object({
  path: z.string().min(1),
  mechanism: z.enum(['symlink', 'copy', 'isolated-copy']),
});
export type WorktreeProvisionedEntry = z.infer<typeof worktreeProvisionedEntrySchema>;

export const worktreeCreatedSchema = z.object({
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  baseSha: z.string().min(1),
  path: z.string().min(1),
  parent: z.string().min(1),
  agent: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  subRole: z.string().min(1).optional(),
  provisioned: z.array(worktreeProvisionedEntrySchema).optional(),
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

/**
 * The `finish.recorded` payload: what `co_finish` durably records when a worker finishes — the
 * branch, the `baseSha` it was cut from (so L5 can locate the baseline to diff against), the
 * `commitSha` of the rendered house-style commit, and the finish's structured test run. This is the
 * INPUT L5 compares against {@link Baseline}; this layer only RECORDS it (it does NOT compute the
 * regression diff — that is L5). The `tests` shape is aligned with {@link TestOutcome} so the
 * comparison is apples-to-apples.
 */
export const finishRecordedSchema = z.object({
  branch: z.string().min(1),
  baseSha: z.string().min(1),
  commitSha: z.string().min(1),
  tests: z.array(testOutcomeSchema),
  agent: z.string().min(1).optional(),
});
export type FinishRecorded = z.infer<typeof finishRecordedSchema>;

/**
 * The `worktree.removed` payload (L3-E teardown): just the `branch` whose sandbox was torn down. It
 * folds onto the SAME `worktree:<branch>` stream as `worktree.created` (one stream per sandbox), and
 * marks the read-model record `removed = 1`. Idempotent + replay-safe: a re-removal re-asserts the
 * same flag. Carries NO path/fs detail — the dir deletion is teardown's side effect, not orchestration
 * state; the record already holds the path.
 */
export const worktreeRemovedSchema = z.object({
  branch: z.string().min(1),
});
export type WorktreeRemoved = z.infer<typeof worktreeRemovedSchema>;

/** Current-version schema per L3 worktree event type — validated on append AND on read (decode). */
export const worktreeSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_WORKTREE_CREATED, worktreeCreatedSchema],
  [EVENT_BASELINE_CAPTURED, baselineCapturedSchema],
  [EVENT_FINISH_RECORDED, finishRecordedSchema],
  [EVENT_WORKTREE_REMOVED, worktreeRemovedSchema],
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

/** Build + validate a `finish.recorded` `NewEvent`, keyed on the branch's finish stream scope. */
export function makeFinishRecordedEvent(projectId: string, f: FinishRecorded): NewEvent {
  const payload = finishRecordedSchema.parse(f);
  return {
    projectId,
    scope: finishScope(payload.branch),
    type: EVENT_FINISH_RECORDED,
    v: WORKTREE_EVENT_V,
    payload,
    ...(payload.agent != null ? { actor: payload.agent } : {}),
  };
}

/**
 * Build + validate a `worktree.removed` `NewEvent` (L3-E teardown). It reuses the branch's
 * `worktree:<branch>` scope — the SAME stream as `worktree.created` — so a sandbox's create + remove
 * are one ordered history. Self-validating like the other `make*Event`s.
 */
export function makeWorktreeRemovedEvent(projectId: string, r: WorktreeRemoved): NewEvent {
  const payload = worktreeRemovedSchema.parse(r);
  return {
    projectId,
    scope: worktreeScope(payload.branch),
    type: EVENT_WORKTREE_REMOVED,
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
  /** The assigned child agent allowed to mount this sandbox. Absent only for legacy records. */
  readonly agent?: string;
  readonly role?: string;
  readonly subRole?: string;
  readonly createdTs: number;
  readonly removed: boolean;
  /** The working essentials actually placed at sling time; absent for older records. */
  readonly provisioned?: readonly WorktreeProvisionedEntry[];
}

/** A persisted, read-back baseline — the read-model shape `getBaseline` returns. */
export interface Baseline {
  readonly branch: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly tests: readonly TestOutcome[];
  readonly capturedTs: number;
}

/**
 * A persisted, read-back finish record — the read-model shape `getFinish` returns. `recordedTs` is
 * the PERSISTED event ts (freeze #6 — never wall-clock on read). This is what L5 reads (with the
 * matching {@link Baseline}) to tell a regression from a pre-existing failure.
 */
export interface FinishRecord {
  readonly branch: string;
  readonly baseSha: string;
  readonly commitSha: string;
  readonly tests: readonly TestOutcome[];
  readonly recordedTs: number;
  /** The persisted event seq for ordering against review verdicts. Absent only for legacy rows. */
  readonly recordedSeq?: number;
  /** The agent that recorded the latest finish. Absent only for legacy finish records. */
  readonly agent?: string;
}
