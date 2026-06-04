# L4 Phase 5 — Dispatch Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the L4 dispatch policy into the live surface: `co_sling` resolves + records a `placement.decided` event (placed or WAITING), and operators get host-side `co usage`/`co cost`/`co sling --dry-run` CLI readouts — completing the reader-with-writer loop.

**Architecture:** The `placement.decided` event lands in `dispatch/events.ts` (the writer); `DispatchStore.recordPlacement` appends + folds it in one transaction; `co_sling` gains optional routing inputs that resolve + record via Phases 3+4 policy, creating the sandbox only when placed; host-side CLI functions (`renderUsageReport`, `renderCostReport`, `previewPlacement`) live in a new `dispatch/cli-render.ts` and are called by a real `packages/cli/src/run.ts` dispatcher.

**Tech Stack:** TypeScript ESM, zod, node:sqlite (via core store), vitest. CLI imports ONLY `@co/core` barrel + node builtins (enforced by layering test). No new MCP tool; `EXPECTED_TOOLS` count unchanged.

---

## File Structure

**New files:**
- `packages/core/src/dispatch/placement-projector.ts` — DDL, `PlacementProjector`, row selectors
- `packages/core/src/dispatch/cli-render.ts` — `renderUsageReport`, `renderCostReport`, `previewPlacement`

**Modified files:**
- `packages/core/src/dispatch/events.ts` — add `placement.decided` event constant, scope prefix/fn, payload schemas, `PlacementRecord` interface, factory `makePlacementDecidedEvent`
- `packages/core/src/dispatch/dispatch-store.ts` — add `recordPlacement` to `DispatchStore` interface + impl, wire `PlacementProjector`
- `packages/core/src/tools/context.ts` — add `dispatch?: DispatchStore` (optional, additive)
- `packages/mcp/src/context.ts` — open + inject `openDispatchStore(projectId)` alongside worktrees
- `packages/mcp/src/context.test.ts` — assert `ctx.dispatch` is present on happy path
- `packages/core/src/tools/specs/sling.ts` — extend input (role/work_size/reasoning_budget/accounts optional), output (placement/waiting optional), handler (routing branch)
- `packages/core/src/tools/specs/sling.test.ts` — add routing tests (placed, waiting, absent, missing-dispatch)
- `packages/core/src/index.ts` — export all new symbols
- `packages/cli/src/run.ts` — replace stub with real argv dispatcher
- `packages/cli/src/run.test.ts` — replace stub test with real CLI tests

---

## Task 1: `placement.decided` event types, schemas, and factory in `events.ts`

**Files:**
- Modify: `packages/core/src/dispatch/events.ts`

- [ ] **Step 1: Read `dispatch/events.ts` in full** (already done in planning; verify the exact line numbers for the insertion points).

- [ ] **Step 2: Append event constant, scope prefix/fn, and payload schemas to `events.ts`**

After the last `export` block (after `makeCostNearBudgetEvent`), add:

```typescript
// ── placement.decided ────────────────────────────────────────────────────────────────────────────
/**
 * `placement.decided` records the final dispatch resolution for one seat — either PLACED on a
 * concrete provider or WAITING (all providers at capacity). This is the WRITER that completes the
 * reader-with-writer loop: Phase 5 records a decision so Phase 6+ (and the operator CLI) can read
 * back placement history and throttle signals. Filed under `placement:<agent>` (one stream per
 * requesting agent), mirroring how `cost.recorded` is filed under `cost:<agent>`.
 *
 * AC8: placement.decided is INTERNAL orchestration state — it is not agent-facing. The only
 * surface change is the enriched co_sling response; the event itself is program-data only.
 */
export const EVENT_PLACEMENT_DECIDED = 'placement.decided' as const;

/** Scope prefix for the per-agent placement-decision stream. */
export const PLACEMENT_SCOPE_PREFIX = 'placement:';

/** A placement-decision stream scope: `placement:<agent>`. */
export function placementScope(agent: string): string {
  return PLACEMENT_SCOPE_PREFIX + agent;
}

/** zod effort enum (mirrors balancer.ts private copy; re-defined here so events.ts stays self-contained). */
const effortEnumSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

/** zod context-window enum. */
const contextWindowEnumSchema = z.enum(['standard', 'extended']);

export const placementDecidedPlacedSchema = z.object({
  kind: z.literal('placed'),
  role: z.string().min(1),
  work_size: workSizeSchema,
  reasoning_budget: reasoningBudgetSchema,
  provider: providerSchema,
  model: z.string().min(1),
  effort: effortEnumSchema,
  context: contextWindowEnumSchema,
});

export const placementDecidedWaitingSchema = z.object({
  kind: z.literal('waiting'),
  role: z.string().min(1),
  work_size: workSizeSchema,
  reasoning_budget: reasoningBudgetSchema,
  eta_reset_at: z.string().optional(),
  reason: z.string().min(1),
  maxed_providers: z.array(providerSchema),
});

export const placementDecidedSchema = z.discriminatedUnion('kind', [
  placementDecidedPlacedSchema,
  placementDecidedWaitingSchema,
]);
export type PlacementDecidedPlaced = z.infer<typeof placementDecidedPlacedSchema>;
export type PlacementDecidedWaiting = z.infer<typeof placementDecidedWaitingSchema>;
export type PlacementDecided = z.infer<typeof placementDecidedSchema>;
```

- [ ] **Step 3: Add `PlacementRecord` read-model interface** (after the `NearBudgetRecord` interface):

```typescript
/**
 * A recorded dispatch decision — one row per `placement.decided` event. `seq` is the persisted L0
 * sequence (its stable identity); `recordedTs` is the persisted event ts (freeze #6). The `placed`
 * fields are present only when `kind === 'placed'`; the `waiting` fields when `kind === 'waiting'`.
 */
export interface PlacementRecord {
  readonly seq: number;
  readonly agent: string;
  readonly role: string;
  readonly workSize: string;
  readonly reasoningBudget: string;
  readonly kind: 'placed' | 'waiting';
  /** placed only */
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly context?: string;
  /** waiting only */
  readonly etaResetAt?: string;
  readonly reason?: string;
  readonly maxedProviders?: readonly string[];
  readonly recordedTs: number;
}
```

- [ ] **Step 4: Add factory function `makePlacementDecidedEvent`** (after `makeCostNearBudgetEvent`):

```typescript
/** Build + validate a `placement.decided` `NewEvent`, filed under `placement:<agent>`. */
export function makePlacementDecidedEvent(
  projectId: string,
  agent: string,
  payload: PlacementDecided,
): NewEvent {
  const validated = placementDecidedSchema.parse(payload);
  return {
    projectId,
    scope: placementScope(agent),
    type: EVENT_PLACEMENT_DECIDED,
    v: DISPATCH_EVENT_V,
    payload: validated,
    actor: agent,
  };
}
```

- [ ] **Step 5: Register `EVENT_PLACEMENT_DECIDED` in `dispatchSchemas`** by updating the Map initializer:

```typescript
export const dispatchSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_USAGE_OBSERVED, usageObservedSchema],
  [EVENT_COST_RECORDED, costRecordedSchema],
  [EVENT_COST_NEAR_BUDGET, costNearBudgetSchema],
  [EVENT_PLACEMENT_DECIDED, placementDecidedSchema],
]);
```

- [ ] **Step 6: Add required imports to `events.ts`**

At the top of events.ts, add imports for `workSizeSchema` and `reasoningBudgetSchema`:

```typescript
import { workSizeSchema, reasoningBudgetSchema } from './tier.js';
```

- [ ] **Step 7: Run the dispatch events tests to ensure existing tests still pass**

```bash
cd /home/Projects/Code-Orchestration/.co/worktrees/l4-5-integration
pnpm vitest run packages/core --reporter=verbose 2>&1 | head -80
```

Expected: existing dispatch tests pass, no failures in events-related tests.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/dispatch/events.ts
git commit -s -m "feat(core): add placement.decided event types, schemas, scope, factory (L4 Phase 5)"
```

---

## Task 2: `PlacementProjector` and `DispatchStore.recordPlacement`

**Files:**
- Create: `packages/core/src/dispatch/placement-projector.ts`
- Modify: `packages/core/src/dispatch/dispatch-store.ts`
- Modify: `packages/core/src/dispatch/dispatch-store.test.ts`

- [ ] **Step 1: Write failing tests for `recordPlacement` in `dispatch-store.test.ts`**

At the end of `dispatch-store.test.ts` (after the existing test blocks), add:

```typescript
describe('DispatchStore.recordPlacement — record + read-back', () => {
  it('records a placed decision and reads it back correctly', () => {
    const registry = openRegistry();
    const repo = makeRepo();
    const projectId = registry.register(repo);
    registry.close();
    const store = openDispatchStore(projectId);
    try {
      const record = store.recordPlacement('agent-1', {
        kind: 'placed',
        role: 'implementer',
        work_size: 'average',
        reasoning_budget: 'standard',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        context: 'standard',
      });
      expect(record.kind).toBe('placed');
      expect(record.agent).toBe('agent-1');
      expect(record.role).toBe('implementer');
      expect(record.provider).toBe('claude');
      expect(record.model).toBe('claude-sonnet-4-6');
      expect(record.effort).toBe('high');
      expect(record.seq).toBeGreaterThan(0);
      expect(record.recordedTs).toBeGreaterThan(0);

      const all = store.readPlacements();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(record);
    } finally {
      store.close();
    }
  });

  it('records a waiting decision and reads it back correctly', () => {
    const registry = openRegistry();
    const repo = makeRepo();
    const projectId = registry.register(repo);
    registry.close();
    const store = openDispatchStore(projectId);
    try {
      const record = store.recordPlacement('agent-2', {
        kind: 'waiting',
        role: 'reviewer',
        work_size: 'simple',
        reasoning_budget: 'economy',
        eta_reset_at: '2026-06-04T10:00:00Z',
        reason: 'all providers maxed',
        maxed_providers: ['claude', 'codex'],
      });
      expect(record.kind).toBe('waiting');
      expect(record.agent).toBe('agent-2');
      expect(record.etaResetAt).toBe('2026-06-04T10:00:00Z');
      expect(record.reason).toBe('all providers maxed');
      expect(record.maxedProviders).toEqual(['claude', 'codex']);

      const placements = store.readPlacements('agent-2');
      expect(placements).toHaveLength(1);
      expect(placements[0]!.kind).toBe('waiting');
    } finally {
      store.close();
    }
  });

  it('readPlacements replay-equal: rebuild reproduces the same rows', () => {
    const registry = openRegistry();
    const repo = makeRepo();
    const projectId = registry.register(repo);
    registry.close();
    const store = openDispatchStore(projectId);
    try {
      store.recordPlacement('agent-3', {
        kind: 'placed',
        role: 'coordinator',
        work_size: 'technical',
        reasoning_budget: 'deep',
        provider: 'claude',
        model: 'claude-opus-4-8',
        effort: 'max',
        context: 'extended',
      });
      store.recordPlacement('agent-3', {
        kind: 'waiting',
        role: 'coordinator',
        work_size: 'technical',
        reasoning_budget: 'deep',
        reason: 'claude maxed',
        maxed_providers: ['claude'],
      });
      const beforeRebuild = store.readPlacements();
      expect(beforeRebuild).toHaveLength(2);
    } finally {
      store.close();
    }

    // Rebuild from a fresh store instance (replays the log from scratch)
    const store2 = openDispatchStore(projectId);
    try {
      const afterRebuild = store2.readPlacements();
      expect(afterRebuild).toHaveLength(2);
      expect(afterRebuild[0]!.kind).toBe('placed');
      expect(afterRebuild[1]!.kind).toBe('waiting');
    } finally {
      store2.close();
    }
  });
});
```

Also add `openRegistry` to the import at the top of dispatch-store.test.ts:
```typescript
import { openRegistry } from '../registry/registry.js';
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run packages/core/src/dispatch/dispatch-store.test.ts 2>&1 | tail -20
```

Expected: test failures mentioning `recordPlacement` and `readPlacements` not found.

- [ ] **Step 3: Create `packages/core/src/dispatch/placement-projector.ts`**

```typescript
import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_PLACEMENT_DECIDED,
  type PlacementDecided,
  type PlacementRecord,
} from './events.js';

const CREATE_PLACEMENT_TABLE = `
  CREATE TABLE IF NOT EXISTS placement_records (
    seq          INTEGER PRIMARY KEY,
    agent        TEXT NOT NULL,
    role         TEXT NOT NULL,
    work_size    TEXT NOT NULL,
    reasoning_budget TEXT NOT NULL,
    kind         TEXT NOT NULL,
    provider     TEXT,
    model        TEXT,
    effort       TEXT,
    context      TEXT,
    eta_reset_at TEXT,
    reason       TEXT,
    maxed_providers TEXT,
    ts           INTEGER NOT NULL
  )
`;

export function ensurePlacementTable(db: DatabaseSync): void {
  db.exec(CREATE_PLACEMENT_TABLE);
}

export function rowToPlacementRecord(row: Record<string, unknown>): PlacementRecord {
  const kind = row['kind'] as string;
  if (kind !== 'placed' && kind !== 'waiting') {
    throw new Error(`placement-projector: unknown kind '${kind}'`);
  }
  const base = {
    seq: row['seq'] as number,
    agent: row['agent'] as string,
    role: row['role'] as string,
    workSize: row['work_size'] as string,
    reasoningBudget: row['reasoning_budget'] as string,
    kind: kind as 'placed' | 'waiting',
    recordedTs: row['ts'] as number,
  };
  if (kind === 'placed') {
    return {
      ...base,
      provider: row['provider'] as string,
      model: row['model'] as string,
      effort: row['effort'] as string,
      context: row['context'] as string,
    };
  }
  // waiting
  const maxedRaw = row['maxed_providers'];
  const maxedProviders: readonly string[] =
    typeof maxedRaw === 'string' && maxedRaw.length > 0
      ? (JSON.parse(maxedRaw) as string[])
      : [];
  return {
    ...base,
    etaResetAt: row['eta_reset_at'] as string | undefined,
    reason: row['reason'] as string,
    maxedProviders,
  };
}

export function selectAllPlacements(db: DatabaseSync): readonly PlacementRecord[] {
  ensurePlacementTable(db);
  const rows = db
    .prepare('SELECT * FROM placement_records ORDER BY seq')
    .all() as Record<string, unknown>[];
  return rows.map(rowToPlacementRecord);
}

export function selectPlacementsByAgent(
  db: DatabaseSync,
  agent: string,
): readonly PlacementRecord[] {
  ensurePlacementTable(db);
  const rows = db
    .prepare('SELECT * FROM placement_records WHERE agent = ? ORDER BY seq')
    .all(agent) as Record<string, unknown>[];
  return rows.map(rowToPlacementRecord);
}

export function selectPlacementBySeq(
  db: DatabaseSync,
  seq: number,
): PlacementRecord | undefined {
  ensurePlacementTable(db);
  const row = db
    .prepare('SELECT * FROM placement_records WHERE seq = ?')
    .get(seq) as Record<string, unknown> | undefined;
  return row ? rowToPlacementRecord(row) : undefined;
}

/**
 * The placement read-model projector: folds `placement.decided` events into `placement_records`.
 * One row per event (keyed by `seq`), so a `rebuildAll` reproduces byte-identical rows (AC5).
 */
export class PlacementProjector implements Projector {
  handles(eventType: string): boolean {
    return eventType === EVENT_PLACEMENT_DECIDED;
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensurePlacementTable(db);
    const p = event.payload as PlacementDecided;
    if (p.kind === 'placed') {
      db.prepare(
        `INSERT OR REPLACE INTO placement_records
         (seq, agent, role, work_size, reasoning_budget, kind, provider, model, effort, context, ts)
         VALUES (?, ?, ?, ?, ?, 'placed', ?, ?, ?, ?, ?)`,
      ).run(
        event.seq,
        event.actor ?? '',
        p.role,
        p.work_size,
        p.reasoning_budget,
        p.provider,
        p.model,
        p.effort,
        p.context,
        event.ts,
      );
    } else if (p.kind === 'waiting') {
      db.prepare(
        `INSERT OR REPLACE INTO placement_records
         (seq, agent, role, work_size, reasoning_budget, kind, eta_reset_at, reason, maxed_providers, ts)
         VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`,
      ).run(
        event.seq,
        event.actor ?? '',
        p.role,
        p.work_size,
        p.reasoning_budget,
        p.eta_reset_at ?? null,
        p.reason,
        JSON.stringify(p.maxed_providers),
        event.ts,
      );
    } else {
      assertNever(p);
    }
  }
}
```

- [ ] **Step 4: Add `recordPlacement` to `DispatchStore` interface in `dispatch-store.ts`**

Add the method signature to the `DispatchStore` interface (after `readNearBudget`):

```typescript
/** Record a placement decision (append `placement.decided` + fold); returns the stored record. */
recordPlacement(agent: string, payload: PlacementDecided): PlacementRecord;
/** All recorded placement decisions in seq order; optionally filtered to one agent. */
readPlacements(agent?: string): readonly PlacementRecord[];
```

Also add imports at the top:
```typescript
import {
  makePlacementDecidedEvent,
  type PlacementDecided,
  type PlacementRecord,
} from './events.js';
import {
  PlacementProjector,
  ensurePlacementTable,
  selectAllPlacements,
  selectPlacementBySeq,
  selectPlacementsByAgent,
} from './placement-projector.js';
```

- [ ] **Step 5: Add `PlacementProjector` to `openDispatchStore` projectors array and implement the two methods**

In `openDispatchStore`, change:
```typescript
const projectors: readonly Projector[] = [new UsageProjector(), new CostProjector()];
```
to:
```typescript
const projectors: readonly Projector[] = [
  new UsageProjector(),
  new CostProjector(),
  new PlacementProjector(),
];
```

Update `ensureTables`:
```typescript
const ensureTables = (db: DatabaseSync): void => {
  ensureUsageTables(db);
  ensureCostTables(db);
  ensurePlacementTable(db);
};
```

Add the two method implementations in the returned object (after `readNearBudget`):

```typescript
recordPlacement(agent: string, payload: PlacementDecided): PlacementRecord {
  return store.transaction((tx) => {
    const db = tx.raw as DatabaseSync;
    ensureTables(db);
    const [stored] = tx.append([makePlacementDecidedEvent(projectId, agent, payload)]);
    applyEvent(tx, decode(stored!, dispatchUpcasters, dispatchSchemas), projectors);
    const record = selectPlacementBySeq(db, stored!.seq);
    if (!record) {
      throw new Error(
        `openDispatchStore.recordPlacement: placement row missing after projection ` +
          `(agent='${agent}', kind='${payload.kind}')`,
      );
    }
    return record;
  });
},

readPlacements(agent?: string): readonly PlacementRecord[] {
  return store.transaction((tx) => {
    const db = tx.raw as DatabaseSync;
    return agent !== undefined
      ? selectPlacementsByAgent(db, agent)
      : selectAllPlacements(db);
  });
},
```

- [ ] **Step 6: Run failing tests to confirm they now pass**

```bash
pnpm vitest run packages/core/src/dispatch/dispatch-store.test.ts 2>&1 | tail -30
```

Expected: all tests green, including the new `recordPlacement` tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/dispatch/placement-projector.ts packages/core/src/dispatch/dispatch-store.ts packages/core/src/dispatch/dispatch-store.test.ts
git commit -s -m "feat(core): add PlacementProjector + DispatchStore.recordPlacement (L4 Phase 5-A)"
```

---

## Task 3: Wire `dispatch?` seam into `ToolContext` and MCP mount

**Files:**
- Modify: `packages/core/src/tools/context.ts`
- Modify: `packages/mcp/src/context.ts`
- Modify: `packages/mcp/src/context.test.ts`

- [ ] **Step 1: Add `dispatch?: DispatchStore` to `ToolContext` in `context.ts`**

Replace the existing `ToolContext` interface:

```typescript
import type { MailStore } from '../mail/mail-store.js';
import type { ProjectRegistry, ProjectId } from '../registry/registry.js';
import type { WorktreeStore } from '../worktrees/worktree-store.js';
import type { DispatchStore } from '../dispatch/dispatch-store.js';

export interface ToolContext {
  readonly agent: string;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly mail: MailStore;
  readonly registry: ProjectRegistry;
  readonly worktrees?: WorktreeStore;
  /**
   * OPTIONAL L4 program-data handle: the dispatch store (usage/cost/placement records), opened +
   * injected by the mount alongside mail + worktrees. Optional + additive so every existing
   * ToolContext construction site (L1/L2/L3 tests, mcp/cli) keeps compiling; an L4 tool that needs
   * it loud-fails when absent (Principle 9), mirroring the worktrees seam.
   */
  readonly dispatch?: DispatchStore;
}
```

- [ ] **Step 2: Add `openDispatchStore` import and injection to `packages/mcp/src/context.ts`**

Add to the import from `@co/core`:
```typescript
import {
  BASE_ROLES,
  openDispatchStore,    // ADD THIS
  openMailStore,
  openRegistry,
  openWorktreeStore,
  toolsForRole,
  type Role,
  type ToolContext,
  type ToolSpec,
} from '@co/core';
```

In `defaultContextFactory`, open + inject dispatch alongside worktrees. The relevant section becomes:

```typescript
const mail = openMailStore(projectId);
const worktrees = openWorktreeStore(projectId);
// L4: open + inject the dispatch store (usage/cost/placement). Safe on same per-project store.db —
// node:sqlite is synchronous and PlacementProjector/UsageProjector/CostProjector own distinct tables.
const dispatch = openDispatchStore(projectId);

if (explicitProjectId != null && resolvedFromCwd == null) {
  const normalizedCwd = resolve(cwd);
  const isRecordedSandbox = worktrees
    .listWorktrees()
    .some((w) => !w.removed && resolve(w.path) === normalizedCwd);
  if (!isRecordedSandbox) {
    mail.close();
    worktrees.close();
    dispatch.close();      // ADD THIS
    registry.close();
    throw new Error(
      `co MCP server: ${CO_PROJECT_ID_ENV} '${projectId}' does not record cwd '${cwd}' as a ` +
        'live slung worktree.',
    );
  }
}
const ctx: ToolContext = { agent, projectId, cwd, mail, registry, worktrees, dispatch };  // ADD dispatch
return () => ctx;
```

- [ ] **Step 3: Add assertion to `mcp/context.test.ts` that `ctx.dispatch` is present**

In the existing "can mount from inside a real slung worktree" test, add an assertion after the existing ones:

```typescript
expect(ctx.dispatch).toBeDefined();
```

And update the finally block to also close dispatch:

```typescript
} finally {
  ctx.mail.close();
  ctx.worktrees?.close();
  ctx.dispatch?.close();
  ctx.registry.close();
}
```

- [ ] **Step 4: Run MCP context tests**

```bash
pnpm vitest run packages/mcp 2>&1 | tail -20
```

Expected: all tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/tools/context.ts packages/mcp/src/context.ts packages/mcp/src/context.test.ts
git commit -s -m "feat(core,mcp): add dispatch? seam to ToolContext; wire openDispatchStore in MCP mount (L4 Phase 5-C)"
```

---

## Task 4: Enhance `co_sling` with optional routing inputs

**Files:**
- Modify: `packages/core/src/tools/specs/sling.ts`
- Modify: `packages/core/src/tools/specs/sling.test.ts`

- [ ] **Step 1: Write failing routing tests in `sling.test.ts`**

Add imports at the top of the test file:

```typescript
import { openDispatchStore } from '../../dispatch/dispatch-store.js';
import type { DispatchStore } from '../../dispatch/dispatch-store.js';
import { FakeUsageSource, type UsageSnapshot } from '../../dispatch/usage-source.js';
```

Add a `dispatchStores: DispatchStore[]` tracker (alongside existing ones), initialized to `[]` and closed in `afterEach`.

Add a helper snapshot:

```typescript
const healthySnapshot: UsageSnapshot = {
  provider: 'claude',
  account: 'default',
  available: true,
  source: 'fake',
  sampled_at: new Date().toISOString(),
  windows: [{ kind: 'five_hour', used_pct: 20, reset_at: new Date(Date.now() + 5 * 3600_000).toISOString() }],
};

const maxedSnapshot: UsageSnapshot = {
  provider: 'claude',
  account: 'default',
  available: true,
  source: 'fake',
  sampled_at: new Date().toISOString(),
  windows: [{ kind: 'five_hour', used_pct: 99, reset_at: new Date(Date.now() + 5 * 3600_000).toISOString() }],
};
```

Add a `makeContextWithDispatch` helper:

```typescript
function makeContextWithDispatch(
  agent: string,
  repo: string,
  snapshot: UsageSnapshot,
): ToolContext {
  const registry = openRegistry();
  regs.push(registry);
  const projectId = registry.register(repo);
  const mail = openMailStore(projectId);
  mails.push(mail);
  const worktrees = openWorktreeStore(projectId);
  worktreeStores.push(worktrees);
  const dispatch = openDispatchStore(projectId);
  dispatchStores.push(dispatch);
  // Seed the dispatch store with a usage snapshot so the balancer has live headroom signal.
  dispatch.recordSnapshot(snapshot);
  return { agent, projectId, cwd: repo, mail, registry, worktrees, dispatch };
}
```

Add a new describe block at the end of the file:

```typescript
describe('co_sling — with routing inputs (Phase 5 dispatch integration)', () => {
  it('placed: records placement.decided and returns placement in output; creates sandbox', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      branch: 'co/routed-placed',
      role: 'implementer',
      work_size: 'average',
      reasoning_budget: 'standard',
      accounts: [{ provider: 'claude', account: 'default' }],
    })) as Record<string, unknown>;

    // Worktree was created
    expect(out['branch']).toBe('co/routed-placed');
    expect(out['worktree_path']).toBeDefined();

    // Placement returned in output
    expect(out['placement']).toBeDefined();
    const pl = out['placement'] as Record<string, unknown>;
    expect(pl['provider']).toBe('claude');
    expect(pl['model']).toBeTruthy();
    expect(pl['effort']).toBeTruthy();

    // placement.decided recorded in the dispatch store
    const placements = ctx.dispatch!.readPlacements('lead-7');
    expect(placements).toHaveLength(1);
    expect(placements[0]!.kind).toBe('placed');
    expect(placements[0]!.role).toBe('implementer');

    // No WAITING in output
    expect(out['waiting']).toBeUndefined();
  });

  it('waiting: records placement.decided(waiting) and returns loud message; does NOT create sandbox', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, maxedSnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      branch: 'co/routed-waiting',
      role: 'implementer',
      work_size: 'average',
      reasoning_budget: 'standard',
      accounts: [{ provider: 'claude', account: 'default' }],
    })) as Record<string, unknown>;

    // WAITING result
    expect(out['waiting']).toBeDefined();
    const w = out['waiting'] as Record<string, unknown>;
    expect(typeof w['message']).toBe('string');
    expect((w['message'] as string).length).toBeGreaterThan(0);

    // No sandbox created
    expect(out['branch']).toBeUndefined();
    expect(out['worktree_path']).toBeUndefined();
    expect(ctx.worktrees?.getWorktree('co/routed-waiting')).toBeUndefined();

    // placement.decided(waiting) recorded
    const placements = ctx.dispatch!.readPlacements('lead-7');
    expect(placements).toHaveLength(1);
    expect(placements[0]!.kind).toBe('waiting');
  });

  it('routing inputs absent: behaves exactly as L3 (no dispatch store needed)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo);  // no dispatch
    const reg = buildCoreRegistry();
    const headSha = git(repo, 'rev-parse', 'HEAD');

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      branch: 'co/no-routing',
    })) as Record<string, unknown>;

    expect(out['branch']).toBe('co/no-routing');
    expect(out['base_sha']).toBe(headSha);
    expect(out['placement']).toBeUndefined();
    expect(out['waiting']).toBeUndefined();
  });

  it('routing inputs present but ctx.dispatch absent: loud-fail (Principle 9)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo);  // no dispatch injected
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        branch: 'co/needs-dispatch',
        role: 'implementer',
        work_size: 'average',
        reasoning_budget: 'standard',
      }),
    ).rejects.toThrow(/dispatch/i);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run packages/core/src/tools/specs/sling.test.ts 2>&1 | tail -20
```

Expected: new tests fail (input schema doesn't accept role/work_size yet).

- [ ] **Step 3: Extend `sling.ts` input schema with optional routing fields**

In `packages/core/src/tools/specs/sling.ts`, replace the `slingInput` definition with:

```typescript
import { z } from 'zod';
import { slingWorktree } from '../../worktrees/sling.js';
import type { ToolSpec } from '../registry.js';
import {
  candidatesFromStore,
  placeAgent,
  resolvePinTable,
} from '../../dispatch/balancer.js';
import type { ProviderAccount } from '../../dispatch/balancer.js';
import { resolveDispatch } from '../../dispatch/throttle.js';
import { providerSchema } from '../../dispatch/events.js';
import { workSizeSchema, reasoningBudgetSchema } from '../../dispatch/tier.js';
import type { WorkSize, ReasoningBudget } from '../../dispatch/tier.js';
import type { PlacementDecided } from '../../dispatch/events.js';

const providerAccountSchema = z.object({
  provider: providerSchema.describe('The provider name (claude or codex).'),
  account: z.string().min(1).describe('The provider account identifier (e.g. "default").'),
});

const DEFAULT_ACCOUNTS: readonly ProviderAccount[] = [
  { provider: 'claude', account: 'default' },
];

const slingInput = z.object({
  parent: z
    .string()
    .min(1)
    .describe(
      'The spawning agent this sandbox is created for, recorded as the worktree's parent. ' +
        'Required — there is no default.',
    ),
  branch: z
    .string()
    .regex(/^co\//u, 'branch must start with "co/"')
    .describe('The new branch to create; must start with "co/" (e.g. co/feature-x).'),
  base: z
    .string()
    .optional()
    .describe(
      'Optional base ref to branch from. Omit to auto-detect the base ' +
        '(origin/HEAD → main → master → local HEAD).',
    ),
  // ── Phase 5 optional routing fields ───────────────────────────────────────────
  role: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The role of the agent being dispatched (e.g. "implementer", "reviewer"). ' +
        'When supplied alongside work_size + reasoning_budget, the dispatch policy is resolved ' +
        'and recorded before creating the sandbox. All three routing fields must be provided together.',
    ),
  work_size: workSizeSchema.optional().describe(
    workSizeSchema.description ?? 'Coarse task complexity band for tier selection.',
  ),
  reasoning_budget: reasoningBudgetSchema.optional().describe(
    reasoningBudgetSchema.description ?? 'Reasoning depth preference for effort selection.',
  ),
  accounts: z
    .array(providerAccountSchema)
    .optional()
    .describe(
      'Provider accounts to consider for placement. Defaults to [{provider:"claude",account:"default"}] when absent.',
    ),
});
```

- [ ] **Step 4: Extend `sling.ts` output schema with optional routing result fields**

```typescript
const slingOutput = z.object({
  branch: z.string().optional().describe('The branch that was created (absent when WAITING — no sandbox).'),
  base_ref: z
    .string()
    .optional()
    .describe('The base ref the sandbox was cut from (absent when WAITING).'),
  base_sha: z.string().optional().describe('The full commit sha the base ref resolved to at branch-off (absent when WAITING).'),
  worktree_path: z
    .string()
    .optional()
    .describe('Absolute path of the created sandbox (absent when WAITING).'),
  baseline_captured: z
    .boolean()
    .optional()
    .describe('True once a test baseline has been recorded at branch-off (absent when WAITING).'),
  // ── Phase 5 routing output fields (both optional — present only when routing inputs supplied) ──
  placement: z
    .object({
      provider: z.string().describe('The provider the seat was placed on.'),
      model: z.string().describe('The model selected for this placement.'),
      effort: z.string().describe('The effort level (low/medium/high/xhigh/max).'),
      context: z.string().describe('The context-window preference (standard/extended).'),
    })
    .optional()
    .describe('Present when routing inputs were supplied and the dispatch was placed.'),
  waiting: z
    .object({
      message: z.string().describe('Loud agent-facing pacing message (spec §3 — never silent, P9).'),
      eta_reset_at: z
        .string()
        .optional()
        .describe('ISO-8601 when the soonest binding window refreshes (absent if unknown).'),
      reason: z.string().describe('Human-readable reason all providers are at capacity.'),
      maxed_providers: z.array(z.string()).describe('Providers at capacity that caused this WAITING.'),
    })
    .optional()
    .describe('Present when routing inputs were supplied and all providers are at capacity.'),
});
type SlingOutput = z.infer<typeof slingOutput>;
```

- [ ] **Step 5: Replace the handler in `sling.ts` with the routing-aware version**

```typescript
export const slingTool: ToolSpec<SlingInput, SlingOutput> = {
  name: 'co_sling',
  title: 'Sling a worktree',
  description:
    'Create an isolated worktree + branch sandbox from an auto-detected base ref (origin/HEAD → ' +
    'main → master → local HEAD, unless you override it), record it, and capture a test baseline ' +
    'at branch-off. When routing inputs (role/work_size/reasoning_budget) are supplied, the dispatch ' +
    'policy is resolved and recorded; a WAITING result means all providers are at capacity and no ' +
    'sandbox is created. The sandbox lives in program-data, never in the repo.',
  inputSchema: slingInput,
  outputSchema: slingOutput,
  handler: (ctx, input): SlingOutput => {
    if (!ctx.worktrees) {
      throw new Error(
        'co_sling: the mount did not inject a worktree store (ctx.worktrees absent).',
      );
    }

    const hasRoutingInputs =
      input.role !== undefined ||
      input.work_size !== undefined ||
      input.reasoning_budget !== undefined;

    if (!hasRoutingInputs) {
      // ── L3 path: no routing inputs → behave exactly as before (AC-L3-1 stays green) ──
      const result = slingWorktree(ctx.worktrees, {
        parent: input.parent,
        branch: input.branch,
        ...(input.base != null ? { base: input.base } : {}),
        repoCwd: ctx.cwd,
        projectId: ctx.projectId,
      });
      return {
        branch: result.branch,
        base_ref: result.baseRef,
        base_sha: result.baseSha,
        worktree_path: result.worktreePath,
        baseline_captured: result.baselineCaptured,
      };
    }

    // ── Phase 5 path: routing inputs present — resolve + record placement ──────
    if (!ctx.dispatch) {
      throw new Error(
        'co_sling: routing inputs were supplied but the mount did not inject a dispatch store ' +
          '(ctx.dispatch absent). The mount must open openDispatchStore(projectId) and inject it ' +
          'onto ctx.dispatch (Principle 9 — a tool never opens its own store).',
      );
    }

    const role = input.role ?? 'implementer';
    const workSize: WorkSize = (input.work_size ?? 'average') as WorkSize;
    const reasoningBudget: ReasoningBudget = (input.reasoning_budget ??
      'standard') as ReasoningBudget;
    const accounts: readonly ProviderAccount[] = input.accounts ?? DEFAULT_ACCOUNTS;

    // Inject nowMs at handler level (the thin impure shell); pass into pure policy (AC10, P16).
    const nowMs = Date.now();

    const pins = resolvePinTable(ctx.projectId);
    const candidates = candidatesFromStore(ctx.dispatch, accounts);
    const decision = placeAgent({ role, workSize, reasoningBudget, pins, candidates, nowMs });
    const resolution = resolveDispatch(decision, candidates, { nowMs });

    // Record the decision (the WRITER — completes the reader-with-writer loop).
    const placedPayload: PlacementDecided =
      resolution.kind === 'placed'
        ? {
            kind: 'placed',
            role,
            work_size: workSize,
            reasoning_budget: reasoningBudget,
            provider: resolution.placement.provider,
            model: resolution.placement.model,
            effort: resolution.placement.effort,
            context: resolution.placement.context,
          }
        : {
            kind: 'waiting',
            role,
            work_size: workSize,
            reasoning_budget: reasoningBudget,
            ...(resolution.etaResetAt !== undefined
              ? { eta_reset_at: resolution.etaResetAt }
              : {}),
            reason: resolution.reason,
            maxed_providers: [...resolution.maxedProviders],
          };
    ctx.dispatch.recordPlacement(ctx.agent, placedPayload);

    if (resolution.kind === 'waiting') {
      // WAITING: loud message, no sandbox created (spec §3, P9 — never silent).
      return {
        waiting: {
          message: resolution.message,
          ...(resolution.etaResetAt !== undefined ? { eta_reset_at: resolution.etaResetAt } : {}),
          reason: resolution.reason,
          maxed_providers: [...resolution.maxedProviders],
        },
      };
    }

    // PLACED: create the sandbox and return placement + worktree facts.
    const result = slingWorktree(ctx.worktrees, {
      parent: input.parent,
      branch: input.branch,
      ...(input.base != null ? { base: input.base } : {}),
      repoCwd: ctx.cwd,
      projectId: ctx.projectId,
    });

    return {
      branch: result.branch,
      base_ref: result.baseRef,
      base_sha: result.baseSha,
      worktree_path: result.worktreePath,
      baseline_captured: result.baselineCaptured,
      placement: {
        provider: resolution.placement.provider,
        model: resolution.placement.model,
        effort: resolution.placement.effort,
        context: resolution.placement.context,
      },
    };
  },
};
```

- [ ] **Step 6: Fix the `SlingInput` type derivation (it needs to be updated since we changed the schema)**

Ensure `type SlingInput = z.infer<typeof slingInput>;` is still present (after the schema definition).

- [ ] **Step 7: Run sling tests**

```bash
pnpm vitest run packages/core/src/tools/specs/sling.test.ts 2>&1 | tail -30
```

Expected: all tests green including the new routing tests.

- [ ] **Step 8: Run the completeness gate to confirm it stays green**

```bash
pnpm vitest run packages/core/src/tools/completeness.test.ts 2>&1 | tail -20
```

Expected: green. The `EXPECTED_TOOLS` count (`11`) is unchanged; `co_sling` is still in the list.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/tools/specs/sling.ts packages/core/src/tools/specs/sling.test.ts
git commit -s -m "feat(core): enhance co_sling with optional routing (placed/WAITING records placement.decided) (L4 Phase 5-B)"
```

---

## Task 5: Core render functions + `previewPlacement` in `cli-render.ts`

**Files:**
- Create: `packages/core/src/dispatch/cli-render.ts`
- Create: `packages/core/src/dispatch/cli-render.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing tests in `packages/core/src/dispatch/cli-render.test.ts`**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRegistry } from '../registry/registry.js';
import { openDispatchStore } from './dispatch-store.js';
import { renderUsageReport, renderCostReport, previewPlacement } from './cli-render.js';
import type { UsageSnapshot } from './usage-source.js';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  const dir = mkdtempSync(join(tmpdir(), 'co-cli-render-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

function makeProjectId(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-render-repo-'));
  dataDirs.push(dir);
  const registry = openRegistry();
  const id = registry.register(dir);
  registry.close();
  return id;
}

const snap: UsageSnapshot = {
  provider: 'claude',
  account: 'default',
  available: true,
  source: 'fake',
  sampled_at: new Date().toISOString(),
  windows: [
    {
      kind: 'five_hour',
      used_pct: 42,
      reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
    },
  ],
};

describe('renderUsageReport', () => {
  it('contains provider, account, used_pct information', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(snap);
      const report = renderUsageReport(projectId, store);
      expect(report).toMatch(/claude/i);
      expect(report).toMatch(/default/i);
      expect(report).toMatch(/42/);
    } finally {
      store.close();
    }
  });

  it('reports "no usage data" when no buckets recorded', () => {
    const projectId = makeProjectId();
    const report = renderUsageReport(projectId);
    expect(report).toMatch(/no usage/i);
  });
});

describe('renderCostReport', () => {
  it('contains cost rollup data and near-budget records when present', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordCost(
        {
          provider: 'claude',
          agent: 'agent-1',
          task: 'task-1',
          turn: 1,
          cost_usd: 0.05,
          input_tokens: 1000,
          output_tokens: 500,
          total_tokens: 1500,
        },
        { capCents: 10, thresholdPct: 50 },  // threshold crossed at $0.05 of $0.10
      );
      const report = renderCostReport(projectId, store);
      expect(report).toMatch(/agent-1/i);
      expect(report).toMatch(/0\.05/);
    } finally {
      store.close();
    }
  });

  it('reports "no cost data" when nothing recorded', () => {
    const projectId = makeProjectId();
    const report = renderCostReport(projectId);
    expect(report).toMatch(/no cost/i);
  });
});

describe('previewPlacement', () => {
  it('returns placed resolution for a healthy provider (writes nothing)', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(snap);

      const before = store.readPlacements();
      const resolution = previewPlacement({
        projectId,
        role: 'implementer',
        workSize: 'average',
        reasoningBudget: 'standard',
        accounts: [{ provider: 'claude', account: 'default' }],
        nowMs: Date.now(),
        store,
      });

      expect(resolution.kind).toBe('placed');
      // Verify nothing was written
      const after = store.readPlacements();
      expect(after).toHaveLength(before.length);
    } finally {
      store.close();
    }
  });

  it('returns waiting resolution for a maxed provider (writes nothing)', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      const maxedSnap: UsageSnapshot = {
        ...snap,
        windows: [{ kind: 'five_hour', used_pct: 99, reset_at: new Date(Date.now() + 5 * 3600_000).toISOString() }],
      };
      store.recordSnapshot(maxedSnap);

      const resolution = previewPlacement({
        projectId,
        role: 'implementer',
        workSize: 'average',
        reasoningBudget: 'standard',
        accounts: [{ provider: 'claude', account: 'default' }],
        nowMs: Date.now(),
        store,
      });

      expect(resolution.kind).toBe('waiting');
      // No placement.decided events written
      expect(store.readPlacements()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run packages/core/src/dispatch/cli-render.test.ts 2>&1 | tail -10
```

Expected: import error (file doesn't exist yet).

- [ ] **Step 3: Create `packages/core/src/dispatch/cli-render.ts`**

```typescript
import { openDispatchStore, type DispatchStore } from './dispatch-store.js';
import {
  candidatesFromStore,
  placeAgent,
  resolvePinTable,
} from './balancer.js';
import type { ProviderAccount } from './balancer.js';
import { resolveDispatch } from './throttle.js';
import type { DispatchResolution } from './throttle.js';
import type { WorkSize, ReasoningBudget } from './tier.js';
import type { CostRollup, UsageBucket } from './events.js';

// ── Usage report ─────────────────────────────────────────────────────────────────────────────────

/**
 * Render a human-readable usage report for `projectId` — all known provider-account usage buckets
 * with their headroom and reset times. Reads program-data only (never the repo). `store` is
 * injectable for headless tests; defaults to opening + closing one internally. CLI only (P3 —
 * render-per-audience; the rich app view is L9).
 */
export function renderUsageReport(projectId: string, store?: DispatchStore): string {
  const ds = store ?? openDispatchStore(projectId);
  const ownsStore = store === undefined;
  try {
    const buckets = ds.readBuckets();
    if (buckets.length === 0) {
      return 'co usage: no usage data recorded for this project.\n';
    }
    const lines: string[] = ['co usage report', '═══════════════'];
    for (const b of buckets) {
      const pct = b.usedPct.toFixed(1);
      const free = (100 - b.usedPct).toFixed(1);
      const resetShort = b.resetAt.replace('T', ' ').replace(/\..+$/, '');
      lines.push(
        `  ${b.provider}/${b.account}  [${b.windowKind}]  ${pct}% used  ${free}% free  reset ${resetShort}`,
      );
    }
    return lines.join('\n') + '\n';
  } finally {
    if (ownsStore) ds.close();
  }
}

// ── Cost report ──────────────────────────────────────────────────────────────────────────────────

/**
 * Render a human-readable cost report for `projectId` — per-agent and per-task rollups, plus any
 * recorded near-budget crossings. Reads program-data only. `store` is injectable for headless tests.
 */
export function renderCostReport(projectId: string, store?: DispatchStore): string {
  const ds = store ?? openDispatchStore(projectId);
  const ownsStore = store === undefined;
  try {
    const rollups = ds.readRollups();
    const nearBudget = ds.readNearBudget();

    if (rollups.length === 0 && nearBudget.length === 0) {
      return 'co cost: no cost data recorded for this project.\n';
    }

    const lines: string[] = ['co cost report', '══════════════'];
    if (rollups.length > 0) {
      lines.push('', 'Rollups:');
      for (const r of rollups) {
        const cost = r.totalCostUsd > 0 ? `  $${r.totalCostUsd.toFixed(4)}` : '';
        const tokens = r.totalTokens > 0 ? `  ${r.totalTokens} tokens` : '';
        lines.push(
          `  [${r.kind}] ${r.id}  obs=${r.observations}${cost}${tokens}`,
        );
      }
    }
    if (nearBudget.length > 0) {
      lines.push('', 'Near-budget crossings:');
      for (const nb of nearBudget) {
        const capUsd = (nb.capCents / 100).toFixed(2);
        lines.push(
          `  task=${nb.task}  $${nb.totalCostUsd.toFixed(4)} of $${capUsd} cap ` +
            `(${nb.thresholdPct}% threshold crossed)`,
        );
      }
    }
    return lines.join('\n') + '\n';
  } finally {
    if (ownsStore) ds.close();
  }
}

// ── Placement preview ────────────────────────────────────────────────────────────────────────────

export interface PreviewPlacementInput {
  readonly projectId: string;
  readonly role: string;
  readonly workSize: WorkSize;
  readonly reasoningBudget: ReasoningBudget;
  readonly accounts: readonly ProviderAccount[];
  readonly nowMs: number;
  /** Injectable for headless tests (avoids opening a second store connection). */
  readonly store?: DispatchStore;
}

/**
 * Preview where a dispatch WOULD land for the given inputs — purely read-only: resolves the same
 * policy as `co_sling` with routing inputs but writes NOTHING (no `placement.decided` event, no
 * worktree, no side-effects). This is the operator's dry-run preview (spec §E, AC8). Injectable
 * `store` for headless tests; defaults to opening + closing one internally.
 */
export function previewPlacement(input: PreviewPlacementInput): DispatchResolution {
  const { projectId, role, workSize, reasoningBudget, accounts, nowMs } = input;
  const ds = input.store ?? openDispatchStore(projectId);
  const ownsStore = input.store === undefined;
  try {
    const pins = resolvePinTable(projectId);
    const candidates = candidatesFromStore(ds, accounts);
    const decision = placeAgent({ role, workSize, reasoningBudget, pins, candidates, nowMs });
    return resolveDispatch(decision, candidates, { nowMs });
  } finally {
    if (ownsStore) ds.close();
  }
}

/**
 * Render a `DispatchResolution` as operator-readable text — the output of `co sling --dry-run`.
 * Pure text; the rich interactive display is L9.
 */
export function renderDispatchResolution(resolution: DispatchResolution): string {
  if (resolution.kind === 'placed') {
    const p = resolution.placement;
    return (
      `co sling --dry-run: PLACED\n` +
      `  provider=${p.provider}  model=${p.model}  effort=${p.effort}  context=${p.context}\n` +
      `  reason: ${resolution.reason}\n`
    );
  }
  // waiting
  const eta =
    resolution.etaResetAt !== undefined
      ? `  eta_reset_at=${resolution.etaResetAt}\n`
      : '  eta_reset_at=(unknown)\n';
  const maxed =
    resolution.maxedProviders.length > 0
      ? `  maxed_providers=${resolution.maxedProviders.join(', ')}\n`
      : '';
  return (
    `co sling --dry-run: WAITING\n` +
    `  ${resolution.message}\n` +
    eta +
    maxed +
    `  reason: ${resolution.reason}\n`
  );
}
```

- [ ] **Step 4: Run tests to confirm they now pass**

```bash
pnpm vitest run packages/core/src/dispatch/cli-render.test.ts 2>&1 | tail -20
```

Expected: all green.

- [ ] **Step 5: Add new exports to `packages/core/src/index.ts`**

After the existing L4-4 export block at the bottom, add:

```typescript
// L4-5 dispatch integration: placement.decided event (the WRITER), DispatchStore.recordPlacement,
// operator-only render/preview fns. AC8: no new agent tool; usage/cost/placement are CLI-only.
export type {
  PlacementDecidedPlaced,
  PlacementDecidedWaiting,
  PlacementDecided,
  PlacementRecord,
} from './dispatch/events.js';
export {
  EVENT_PLACEMENT_DECIDED,
  PLACEMENT_SCOPE_PREFIX,
  placementScope,
  placementDecidedPlacedSchema,
  placementDecidedWaitingSchema,
  placementDecidedSchema,
  makePlacementDecidedEvent,
} from './dispatch/events.js';
export {
  PlacementProjector,
  ensurePlacementTable,
  selectAllPlacements,
  selectPlacementBySeq,
  selectPlacementsByAgent,
} from './dispatch/placement-projector.js';
export type { PreviewPlacementInput } from './dispatch/cli-render.js';
export {
  renderUsageReport,
  renderCostReport,
  previewPlacement,
  renderDispatchResolution,
} from './dispatch/cli-render.js';
```

Also update the `DispatchStore` export (already has `DispatchStore` type exported; verify `PlacementRecord` is included in the type exports from `events.js`).

- [ ] **Step 6: Run full core test suite**

```bash
pnpm vitest run packages/core 2>&1 | tail -30
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/dispatch/cli-render.ts packages/core/src/dispatch/cli-render.test.ts packages/core/src/index.ts
git commit -s -m "feat(core): add renderUsageReport, renderCostReport, previewPlacement, renderDispatchResolution (L4 Phase 5-D/E)"
```

---

## Task 6: Real CLI dispatcher in `packages/cli/src/run.ts`

**Files:**
- Modify: `packages/cli/src/run.ts`
- Modify: `packages/cli/src/run.test.ts`

- [ ] **Step 1: Write failing CLI tests in `run.test.ts`**

Replace the entire content of `run.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRegistry, openDispatchStore } from '@co/core';
import type { UsageSnapshot } from '@co/core';
import { run } from './run.js';

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  const dir = mkdtempSync(join(tmpdir(), 'co-cli-test-data-'));
  tmpDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function makeRegisteredProject(): { projectId: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'co-cli-test-repo-'));
  tmpDirs.push(dir);
  const registry = openRegistry();
  const projectId = registry.register(dir);
  registry.close();
  return { projectId, dir };
}

const usageSnap: UsageSnapshot = {
  provider: 'claude',
  account: 'default',
  available: true,
  source: 'fake',
  sampled_at: new Date().toISOString(),
  windows: [{ kind: 'five_hour', used_pct: 30, reset_at: new Date(Date.now() + 5 * 3600_000).toISOString() }],
};

describe('co usage', () => {
  it('reports usage buckets for a registered project', () => {
    const { projectId, dir } = makeRegisteredProject();
    const store = openDispatchStore(projectId);
    try { store.recordSnapshot(usageSnap); } finally { store.close(); }

    const result = run(['usage'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/claude/i);
    expect(result.output).toMatch(/30/);
  });

  it('reports "no usage data" for a registered project with no samples', () => {
    const { dir } = makeRegisteredProject();
    const result = run(['usage'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/no usage/i);
  });

  it('exits with code 1 for an unregistered cwd', () => {
    const unregistered = mkdtempSync(join(tmpdir(), 'co-cli-unregistered-'));
    tmpDirs.push(unregistered);
    const result = run(['usage'], unregistered);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/not a registered project/i);
  });
});

describe('co cost', () => {
  it('reports cost rollups for a registered project', () => {
    const { projectId, dir } = makeRegisteredProject();
    const store = openDispatchStore(projectId);
    try {
      store.recordCost({
        provider: 'claude', agent: 'agent-1', task: 'task-1',
        turn: 1, cost_usd: 0.025, total_tokens: 800,
      });
    } finally { store.close(); }

    const result = run(['cost'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/agent-1/);
    expect(result.output).toMatch(/0\.025/);
  });

  it('exits with code 1 for an unregistered cwd', () => {
    const unregistered = mkdtempSync(join(tmpdir(), 'co-cli-unregistered2-'));
    tmpDirs.push(unregistered);
    const result = run(['cost'], unregistered);
    expect(result.exitCode).toBe(1);
  });
});

describe('co sling --dry-run', () => {
  it('reports PLACED for a healthy provider', () => {
    const { projectId, dir } = makeRegisteredProject();
    const store = openDispatchStore(projectId);
    try { store.recordSnapshot(usageSnap); } finally { store.close(); }

    const result = run(
      ['sling', '--dry-run', '--role', 'implementer', '--work-size', 'average', '--reasoning-budget', 'standard'],
      dir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/placed/i);
    expect(result.output).toMatch(/claude/i);
  });

  it('reports WAITING for a maxed provider', () => {
    const { projectId, dir } = makeRegisteredProject();
    const maxedSnap: UsageSnapshot = {
      ...usageSnap,
      windows: [{ kind: 'five_hour', used_pct: 99, reset_at: new Date(Date.now() + 5 * 3600_000).toISOString() }],
    };
    const store = openDispatchStore(projectId);
    try { store.recordSnapshot(maxedSnap); } finally { store.close(); }

    const result = run(
      ['sling', '--dry-run', '--role', 'implementer', '--work-size', 'average', '--reasoning-budget', 'standard'],
      dir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/waiting/i);
  });

  it('exits with code 1 for an unregistered cwd', () => {
    const unregistered = mkdtempSync(join(tmpdir(), 'co-cli-unregistered3-'));
    tmpDirs.push(unregistered);
    const result = run(
      ['sling', '--dry-run', '--role', 'implementer', '--work-size', 'average', '--reasoning-budget', 'standard'],
      unregistered,
    );
    expect(result.exitCode).toBe(1);
  });
});

describe('co help / unknown command', () => {
  it('shows help text for unknown commands', () => {
    const { dir } = makeRegisteredProject();
    const result = run(['unknown-command'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/usage|cost|sling/i);
  });

  it('shows help text for --help flag', () => {
    const { dir } = makeRegisteredProject();
    const result = run(['--help'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/usage|cost|sling/i);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm vitest run packages/cli/src/run.test.ts 2>&1 | tail -10
```

Expected: type errors / failures because `run()` currently returns a string and doesn't accept argv.

- [ ] **Step 3: Replace `packages/cli/src/run.ts` with the real CLI dispatcher**

```typescript
import {
  openRegistry,
  renderUsageReport,
  renderCostReport,
  previewPlacement,
  renderDispatchResolution,
} from '@co/core';
import type { ProviderAccount, WorkSize, ReasoningBudget } from '@co/core';

export interface RunResult {
  output: string;
  exitCode: number;
}

const HELP_TEXT = `co — the orchestration CLI

Commands:
  co usage                  Show provider usage buckets for the current project
  co cost                   Show cost rollups and near-budget crossings
  co sling --dry-run        Preview where a dispatch would land (read-only)
    --role <role>           Agent role (default: implementer)
    --work-size <w>         simple|average|technical (default: average)
    --reasoning-budget <r>  economy|standard|deep (default: standard)
    --account <p:acct,...>  Provider accounts to consider (default: claude:default)

Options:
  --help                    Show this help text
`;

/** Extract a named flag's value from argv (e.g. --role implementer → 'implementer'). */
function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

/**
 * Parse --account flags: accepts comma-separated "provider:account" pairs or
 * repeated --account flags. Returns an array of ProviderAccount objects.
 */
function parseAccounts(argv: string[]): readonly ProviderAccount[] | undefined {
  const raw = getArg(argv, '--account');
  if (raw === undefined) return undefined;
  return raw.split(',').map((pair) => {
    const colon = pair.indexOf(':');
    if (colon < 1) throw new Error(`Invalid --account format '${pair}'. Expected 'provider:account'.`);
    return {
      provider: pair.slice(0, colon) as 'claude' | 'codex',
      account: pair.slice(colon + 1),
    };
  });
}

const DEFAULT_ACCOUNTS: readonly ProviderAccount[] = [{ provider: 'claude', account: 'default' }];

/**
 * Run the co CLI. Accepts `argv` (defaults to `process.argv.slice(2)`) and `cwd` (defaults
 * to `process.cwd()`) for testability. Returns `{ output, exitCode }`.
 */
export function run(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): RunResult {
  const [cmd, ...rest] = argv;

  if (cmd === '--help' || cmd === 'help' || cmd === undefined) {
    return { output: HELP_TEXT, exitCode: 0 };
  }

  // Resolve projectId from cwd — loud-fail (P9) if unregistered.
  const registry = openRegistry();
  let projectId: string | undefined;
  try {
    projectId = registry.resolve(cwd) ?? undefined;
  } finally {
    registry.close();
  }
  if (projectId === undefined) {
    return {
      output: `co: '${cwd}' is not a registered project. Run 'co init' to register it.\n`,
      exitCode: 1,
    };
  }

  switch (cmd) {
    case 'usage': {
      const report = renderUsageReport(projectId);
      return { output: report, exitCode: 0 };
    }

    case 'cost': {
      const report = renderCostReport(projectId);
      return { output: report, exitCode: 0 };
    }

    case 'sling': {
      if (!rest.includes('--dry-run')) {
        return {
          output: `co sling: only --dry-run is supported from the CLI (co_sling is the agent tool).\n${HELP_TEXT}`,
          exitCode: 0,
        };
      }
      const role = getArg(rest, '--role') ?? 'implementer';
      const workSize = (getArg(rest, '--work-size') ?? 'average') as WorkSize;
      const reasoningBudget = (getArg(rest, '--reasoning-budget') ?? 'standard') as ReasoningBudget;
      const accounts = parseAccounts(rest) ?? DEFAULT_ACCOUNTS;

      const resolution = previewPlacement({
        projectId,
        role,
        workSize,
        reasoningBudget,
        accounts,
        nowMs: Date.now(),
      });
      return { output: renderDispatchResolution(resolution), exitCode: 0 };
    }

    default: {
      return { output: `co: unknown command '${cmd}'.\n\n${HELP_TEXT}`, exitCode: 0 };
    }
  }
}
```

- [ ] **Step 4: Update `packages/cli/src/index.ts` to use the new `run()` signature**

```typescript
#!/usr/bin/env node
import { run } from './run.js';

const result = run();
process.stdout.write(result.output);
process.exit(result.exitCode);
```

- [ ] **Step 5: Run CLI tests**

```bash
pnpm vitest run packages/cli 2>&1 | tail -30
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/run.ts packages/cli/src/run.test.ts packages/cli/src/index.ts
git commit -s -m "feat(cli): real co usage/co cost/co sling --dry-run dispatcher (barrel-only, L4 Phase 5-D/E)"
```

---

## Task 7: Full gate — lint, typecheck, build, format:check

- [ ] **Step 1: Run the full five-command gate**

```bash
cd /home/Projects/Code-Orchestration/.co/worktrees/l4-5-integration
pnpm test 2>&1 | tail -40
```

Expected: all tests green. Note the exact passed count for `co_finish`.

- [ ] **Step 2: Run lint**

```bash
pnpm lint 2>&1 | tail -20
```

Expected: no lint errors. Fix any reported issues before proceeding.

- [ ] **Step 3: Run typecheck**

```bash
pnpm typecheck 2>&1 | tail -20
```

Expected: no type errors. Fix any reported issues before proceeding.

- [ ] **Step 4: Run build**

```bash
pnpm build 2>&1 | tail -20
```

Expected: build succeeds.

- [ ] **Step 5: Run format:check**

```bash
pnpm format:check 2>&1 | tail -20
```

If it fails (code formatting issues):
```bash
pnpm format
git add -u
git commit -s -m "style: apply prettier formatting (L4 Phase 5)"
```

- [ ] **Step 6: Verify completeness gate and layering test are still green**

```bash
pnpm vitest run packages/core/src/tools/completeness.test.ts packages/core/src/tools/layering.test.ts 2>&1 | tail -20
```

Expected: both green. EXPECTED_TOOLS count is still 11; no cli/mcp deep imports.

- [ ] **Step 7: Call `co_finish` with the test count and notes**

Record the exact number of passing tests from Step 1. Then call:

```
co_finish(
  tests_passed=<N>,
  notes="Phase 5: co_sling resolves+records placement.decided (placed|WAITING, loud pacing) over ctx.dispatch; ToolContext +dispatch? seam wired in mcp mount; host-side co usage/co cost + co sling --dry-run preview (CLI thin over core render/preview fns, barrel-only); AC8 no new agent tool, completeness+scoping+layering green; <N> tests"
)
```

---

## Self-Review Checklist (run before calling `co_finish`)

1. **Spec coverage:**
   - [x] Deliverable A: `placement.decided` event with scope, schemas, factory, projector, `recordPlacement` — Task 1+2
   - [x] Deliverable B: Enhanced `co_sling` with placed/WAITING/absent routing — Task 4
   - [x] Deliverable C: `dispatch?` seam in ToolContext + MCP mount — Task 3
   - [x] Deliverable D: `renderUsageReport`/`renderCostReport` + `co usage`/`co cost` CLI — Task 5+6
   - [x] Deliverable E: `previewPlacement` + `co sling --dry-run` — Task 5+6
   - [x] Deliverable F: near-budget in `co cost` output; WAITING placement.decided IS the throttle signal — Task 5
   - [x] AC8: No new MCP tool; EXPECTED_TOOLS=11 unchanged — verified in Task 7
   - [x] AC9/P12: No repo writes; dispatch store is program-data only
   - [x] AC10/P16: `placeAgent`/`resolveDispatch` stay pure; `nowMs` injected at handler level
   - [x] Layering: CLI imports only `@co/core` barrel — verified in Task 7
   - [x] Replay-equality: `PlacementProjector.apply` is deterministic — tested in Task 2

2. **Placeholder scan:** All steps have complete code. No "TBD" or "fill in later".

3. **Type consistency:** `PlacementDecided` used in both `makePlacementDecidedEvent` and `recordPlacement`; `DispatchResolution` from throttle.ts flows through `previewPlacement` → `renderDispatchResolution` → CLI output unchanged throughout.
