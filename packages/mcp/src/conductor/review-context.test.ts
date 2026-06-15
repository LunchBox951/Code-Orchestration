/**
 * Stage 13 R-A — [headless] unit acceptance for {@link resolveReviewContext}, the resolver behind the
 * `reviewContext` operator-IPC method. Pure dependency injection: fake store openers + a fake
 * `gitReader`, no real sqlite / git. It proves EVERY degrade state surfaces a NAMED result (Principle
 * 9) and that each opened store is closed (no leaked handles), independent of the socket round-trip.
 */
import { describe, it, expect } from 'vitest';
import type {
  Criterion,
  GitReader,
  ReviewRequestRecord,
  SpecRecord,
  WorktreeRecord,
} from '@co/core';
import { resolveReviewContext, type ReviewContextDeps } from './review-context.js';

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────
const CRITERIA: readonly Criterion[] = [
  { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
  { text: 'no silent failures' },
];

function reviewRecord(over: Partial<ReviewRequestRecord> = {}): ReviewRequestRecord {
  return {
    reviewId: 'rev-1',
    target: 'main',
    branch: 'co/feature',
    scope: 'pr_merge',
    reviewerKind: 'human',
    requestedBy: 'lead-1',
    requestedTs: 1,
    specRef: { kind: 'criteria', ref: 'spec:task-1#locked' },
    ...over,
  };
}

function specRecord(over: Partial<SpecRecord> = {}): SpecRecord {
  return {
    taskId: 'task-1',
    title: 'Stage 13 spec',
    goal: 'ship reviewContext',
    criteria: CRITERIA,
    body: '',
    state: 'locked',
    draftedTs: 1,
    ...over,
  };
}

function worktreeRecord(over: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    branch: 'co/feature',
    baseRef: 'main',
    baseSha: 'a'.repeat(40),
    path: '/sandbox/co/feature',
    parent: 'lead-1',
    createdTs: 1,
    removed: false,
    ...over,
  };
}

/** A spies bundle: the injected deps + the close counters and the captured read args. */
interface Spies {
  readonly deps: ReviewContextDeps;
  readonly closes: { reviews: number; specs: number; worktrees: number };
  readonly gitCalls: Array<{ cwd: string; args: readonly string[] }>;
  readonly taskIdsAsked: string[];
  readonly branchesAsked: string[];
}

/** Build injected deps from optional records + a `gitReader` behavior (default: an empty patch). */
function makeDeps(opts: {
  request?: ReviewRequestRecord;
  spec?: SpecRecord;
  worktree?: WorktreeRecord;
  git?: GitReader;
}): Spies {
  const closes = { reviews: 0, specs: 0, worktrees: 0 };
  const gitCalls: Array<{ cwd: string; args: readonly string[] }> = [];
  const taskIdsAsked: string[] = [];
  const branchesAsked: string[] = [];
  const gitBehavior: GitReader = opts.git ?? (() => '');
  const deps: ReviewContextDeps = {
    openReviews: () => ({
      getReviewRequestById: (id) =>
        opts.request != null && opts.request.reviewId === id ? opts.request : undefined,
      close: () => void closes.reviews++,
    }),
    openSpecs: () => ({
      getSpec: (taskId) => {
        taskIdsAsked.push(taskId);
        return opts.spec != null && opts.spec.taskId === taskId ? opts.spec : undefined;
      },
      close: () => void closes.specs++,
    }),
    openWorktrees: () => ({
      getWorktree: (branch) => {
        branchesAsked.push(branch);
        return opts.worktree != null && opts.worktree.branch === branch ? opts.worktree : undefined;
      },
      close: () => void closes.worktrees++,
    }),
    gitReader: (cwd, args) => {
      gitCalls.push({ cwd, args });
      return gitBehavior(cwd, args);
    },
  };
  return { deps, closes, gitCalls, taskIdsAsked, branchesAsked };
}

const PATCH = 'diff --git a/x b/x\n+REVIEW_CONTEXT_MARKER\n';

// ── The states ──────────────────────────────────────────────────────────────────────────────────
describe('resolveReviewContext — every state surfaces a NAMED result (Principle 9)', () => {
  it('resolved + criteria: the real criteria array + specRef pass through; refs are verbatim', async () => {
    const spies = makeDeps({
      request: reviewRecord(),
      spec: specRecord(),
      worktree: worktreeRecord(),
      git: () => PATCH,
    });

    const result = await resolveReviewContext(spies.deps, 'rev-1');

    expect(result).toEqual({
      kind: 'resolved',
      reviewId: 'rev-1',
      branch: 'co/feature',
      target: 'main',
      scope: 'pr_merge',
      diff: { kind: 'patch', patch: PATCH },
      criteria: { kind: 'criteria', specRef: 'spec:task-1#locked', criteria: CRITERIA },
    });
    // The criteria array is the SAME one the spec record carried (passed through, not rebuilt).
    if (result.kind === 'resolved' && result.criteria.kind === 'criteria') {
      expect(result.criteria.criteria).toBe(CRITERIA);
    }
    // The taskId was parsed out of `spec:<taskId>#locked`, and the diff ran target...branch in the sandbox.
    expect(spies.taskIdsAsked).toEqual(['task-1']);
    expect(spies.gitCalls).toEqual([
      { cwd: '/sandbox/co/feature', args: ['diff', 'main...co/feature'] },
    ]);
    // Every opened store was closed (no leaked handles).
    expect(spies.closes).toEqual({ reviews: 1, specs: 1, worktrees: 1 });
  });

  it('resolved + no-locked-spec: the spec store is never opened', async () => {
    const spies = makeDeps({
      request: reviewRecord({ specRef: { kind: 'no-locked-spec' } }),
      worktree: worktreeRecord(),
      git: () => PATCH,
    });

    const result = await resolveReviewContext(spies.deps, 'rev-1');

    expect(result).toMatchObject({
      kind: 'resolved',
      diff: { kind: 'patch', patch: PATCH },
      criteria: { kind: 'no-locked-spec' },
    });
    // A no-locked-spec request short-circuits the criteria half — the spec store is never touched.
    expect(spies.taskIdsAsked).toEqual([]);
    expect(spies.closes).toEqual({ reviews: 1, specs: 0, worktrees: 1 });
  });

  it('resolved + criteria ref but the spec record is gone: degrades to no-locked-spec (never throws)', async () => {
    const spies = makeDeps({
      request: reviewRecord(), // specRef criteria → spec:task-1#locked
      spec: undefined, // …but the record is absent
      worktree: worktreeRecord(),
      git: () => PATCH,
    });

    const result = await resolveReviewContext(spies.deps, 'rev-1');

    expect(result).toMatchObject({ kind: 'resolved', criteria: { kind: 'no-locked-spec' } });
    // The spec store WAS opened (and closed) — the degrade is explicit, after a real lookup miss.
    expect(spies.taskIdsAsked).toEqual(['task-1']);
    expect(spies.closes).toEqual({ reviews: 1, specs: 1, worktrees: 1 });
  });

  it.each(['draft', 'archived'] as const)(
    'resolved + criteria ref but the spec record is %s: degrades to no-locked-spec',
    async (state) => {
      const spies = makeDeps({
        request: reviewRecord(),
        spec: specRecord({ state }),
        worktree: worktreeRecord(),
        git: () => PATCH,
      });

      const result = await resolveReviewContext(spies.deps, 'rev-1');

      expect(result).toMatchObject({ kind: 'resolved', criteria: { kind: 'no-locked-spec' } });
      expect(spies.taskIdsAsked).toEqual(['task-1']);
      expect(spies.closes).toEqual({ reviews: 1, specs: 1, worktrees: 1 });
    },
  );

  it('resolved + worktree-missing (record removed): no git diff is attempted', async () => {
    const spies = makeDeps({
      request: reviewRecord(),
      spec: specRecord(),
      worktree: worktreeRecord({ removed: true }),
    });

    const result = await resolveReviewContext(spies.deps, 'rev-1');

    expect(result).toMatchObject({
      kind: 'resolved',
      diff: { kind: 'unavailable', reason: 'worktree-missing' },
      criteria: { kind: 'criteria', specRef: 'spec:task-1#locked' },
    });
    expect(spies.gitCalls).toEqual([]); // a removed sandbox is never shelled
    expect(spies.closes).toEqual({ reviews: 1, specs: 1, worktrees: 1 });
  });

  it('resolved + worktree-missing (no record): no git diff is attempted', async () => {
    const spies = makeDeps({
      request: reviewRecord(),
      spec: specRecord(),
      worktree: undefined, // getWorktree → undefined
    });

    const result = await resolveReviewContext(spies.deps, 'rev-1');

    expect(result).toMatchObject({ diff: { kind: 'unavailable', reason: 'worktree-missing' } });
    expect(spies.gitCalls).toEqual([]);
    expect(spies.closes).toEqual({ reviews: 1, specs: 1, worktrees: 1 });
  });

  it('resolved + git-failed: a non-zero git exit (gitReader → null) is a NAMED reason', async () => {
    const spies = makeDeps({
      request: reviewRecord(),
      spec: specRecord(),
      worktree: worktreeRecord(),
      git: () => null,
    });

    const result = await resolveReviewContext(spies.deps, 'rev-1');

    expect(result).toMatchObject({ diff: { kind: 'unavailable', reason: 'git-failed' } });
    expect(spies.gitCalls).toHaveLength(1); // git WAS attempted, then surfaced its failure
    expect(spies.closes).toEqual({ reviews: 1, specs: 1, worktrees: 1 });
  });

  it('resolved + empty patch: an empty diff is a VALID patch (no changes), NOT unavailable', async () => {
    const spies = makeDeps({
      request: reviewRecord(),
      spec: specRecord(),
      worktree: worktreeRecord(),
      git: () => '', // empty stdout = no changes, distinct from a null (failed) exit
    });

    const result = await resolveReviewContext(spies.deps, 'rev-1');

    expect(result).toMatchObject({ diff: { kind: 'patch', patch: '' } });
    expect(spies.closes).toEqual({ reviews: 1, specs: 1, worktrees: 1 });
  });

  it('not-found: an unknown reviewId resolves to the named not-found state; only reviews is opened', async () => {
    const spies = makeDeps({
      request: reviewRecord({ reviewId: 'rev-1' }),
      spec: specRecord(),
      worktree: worktreeRecord(),
    });

    const result = await resolveReviewContext(spies.deps, 'rev-UNKNOWN');

    expect(result).toEqual({ kind: 'not-found', reviewId: 'rev-UNKNOWN' });
    // A miss on the request short-circuits the spec + worktree halves entirely.
    expect(spies.taskIdsAsked).toEqual([]);
    expect(spies.branchesAsked).toEqual([]);
    expect(spies.gitCalls).toEqual([]);
    expect(spies.closes).toEqual({ reviews: 1, specs: 0, worktrees: 0 });
  });
});
