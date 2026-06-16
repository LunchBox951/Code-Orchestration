import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDispatchStore, type DispatchStore } from '../../dispatch/dispatch-store.js';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openReviewStore, type ReviewStore } from '../../review/review-store.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// AC-L5-1, AC-L5-3 — co_review_finalize through invokeTool: it records a structured verdict
// (PASS or ISSUES), rejects the rubber-stamp inverse (ISSUES with no blocker), rejects a PASS
// without a verification marker (AC-L5-3 defense-in-depth), and loud-fails without a review store.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let mails: MailStore[] = [];
let reviews: ReviewStore[] = [];
let rosters: RosterStore[] = [];
let regs: ProjectRegistry[] = [];
let dispatches: DispatchStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  mails = [];
  reviews = [];
  rosters = [];
  regs = [];
  dispatches = [];
  const data = mkdtempSync(join(tmpdir(), 'co-rf-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const m of mails) m.close();
  for (const r of reviews) r.close();
  for (const r of rosters) r.close();
  for (const r of regs) r.close();
  for (const d of dispatches) d.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  mails = [];
  reviews = [];
  rosters = [];
  regs = [];
  dispatches = [];
});

type FinalizeOut = { review_id: string; verdict: 'PASS' | 'ISSUES'; recorded: boolean };
const TARGET = 'co/l5-review-gate';
const BRANCH = 'co/l5-phase-a';

function setup(
  agent: string,
  withReviews = true,
  opts: { registerCaller?: boolean; role?: 'lead' | 'reviewer'; dispatch?: DispatchStore } = {},
): { ctx: ToolContext; review?: ReviewStore } {
  const mail = openMailStore('p-rf');
  mails.push(mail);
  const registry = openRegistry();
  regs.push(registry);
  let review: ReviewStore | undefined;
  if (withReviews) {
    review = openReviewStore('p-rf');
    reviews.push(review);
  }
  const roster = openRosterStore('p-rf');
  rosters.push(roster);
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
  if (opts.registerCaller !== false && agent !== 'lead-1') {
    const role = opts.role ?? 'reviewer';
    roster.recordAgent({
      agentId: agent,
      role,
      parent: role === 'lead' ? 'coord-1' : 'lead-1',
    });
  }
  const ctx: ToolContext = {
    agent,
    projectId: 'p-rf',
    cwd: '/repo',
    mail,
    registry,
    roster,
    ...(review ? { reviews: review } : {}),
    ...(opts.dispatch != null ? { dispatch: opts.dispatch } : {}),
  };
  return { ctx, ...(review ? { review } : {}) };
}

function requestReview(
  review: ReviewStore,
  reviewId = 'rev-1',
  scope: 'worker_merge' | 'phase_merge' | 'pr_merge' = 'worker_merge',
): void {
  review.recordReviewRequested({
    reviewId,
    target: TARGET,
    branch: BRANCH,
    scope,
    requestedBy: 'lead-1',
    specRefKind: 'no-locked-spec',
  });
}

describe('co_review_finalize (AC-L5-1, AC-L5-3)', () => {
  it('schema says omitted scope defaults to the requested review scope', () => {
    const spec = buildCoreRegistry().get('co_review_finalize')!;
    const inputSchema = spec.inputSchema as typeof spec.inputSchema & {
      readonly shape: { readonly scope: { readonly description?: string } };
    };

    expect(inputSchema.shape.scope.description).toMatch(/requested scope/i);
    expect(inputSchema.shape.scope.description).not.toMatch(/defaults to worker_merge/i);
  });

  it('records a PASS verdict with a verification marker; the reviewer is ctx.agent (never a caller input)', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer:pr@rev-1');
    requestReview(review!, 'rev-1', 'pr_merge');
    const out = (await invokeTool(reg, ctx, 'co_review_finalize', {
      target: TARGET,
      branch: BRANCH,
      scope: 'pr_merge',
      review_id: 'rev-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [{ summary: 'tidy a comment' }],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    })) as FinalizeOut;
    expect(out).toEqual({ review_id: 'rev-1', verdict: 'PASS', recorded: true });
    const recorded = review!.getVerdict(TARGET, BRANCH, 'pr_merge');
    expect(recorded?.verdict).toBe('PASS');
    expect(recorded?.scope).toBe('pr_merge');
    expect(recorded?.reviewer).toBe('reviewer:pr@rev-1');
    expect(recorded?.suggestions).toEqual([{ summary: 'tidy a comment' }]);
    expect(recorded?.verification).toEqual({
      commands_run: ['pnpm test'],
      suite_result: 'pass',
      baseline_compared: true,
    });
  });

  it('refuses to finalize a human-routed review request through the agent reviewer tool', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer:pr@rev-human');
    review!.recordReviewRequested({
      reviewId: 'rev-human',
      target: TARGET,
      branch: BRANCH,
      scope: 'pr_merge',
      requestedBy: 'lead-1',
      reviewerKind: 'human',
      specRefKind: 'no-locked-spec',
    });

    await expect(
      invokeTool(reg, ctx, 'co_review_finalize', {
        target: TARGET,
        branch: BRANCH,
        scope: 'pr_merge',
        review_id: 'rev-human',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
        verification: {
          commands_run: ['pnpm test'],
          suite_result: 'pass',
          baseline_compared: true,
        },
      }),
    ).rejects.toThrow(/human review.*operator Review view/i);
    expect(review!.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
  });

  it('records an ISSUES verdict with a blocker + verification marker', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer@rev-1');
    requestReview(review!);
    const out = (await invokeTool(reg, ctx, 'co_review_finalize', {
      target: TARGET,
      branch: BRANCH,
      review_id: 'rev-1',
      verdict: 'ISSUES',
      blockers: [{ summary: 'a test regressed' }],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'fail', baseline_compared: true },
    })) as FinalizeOut;
    expect(out.verdict).toBe('ISSUES');
    const recorded = review!.getVerdict(TARGET, BRANCH);
    expect(recorded?.blockers).toEqual([{ summary: 'a test regressed' }]);
    expect(recorded?.verification).toEqual({
      commands_run: ['pnpm test'],
      suite_result: 'fail',
      baseline_compared: true,
    });
  });

  it('records an ISSUES verdict without a verification marker (marker is optional for ISSUES)', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer@rev-1');
    requestReview(review!);
    const out = (await invokeTool(reg, ctx, 'co_review_finalize', {
      target: TARGET,
      branch: BRANCH,
      review_id: 'rev-1',
      verdict: 'ISSUES',
      blockers: [{ summary: 'a test regressed' }],
      suggestions: [],
    })) as FinalizeOut;
    expect(out.verdict).toBe('ISSUES');
    const recorded = review!.getVerdict(TARGET, BRANCH);
    expect(recorded?.verification).toBeUndefined();
  });

  it('does not record an ISSUES verdict when active slot release fails', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer@rev-1');
    requestReview(review!);
    let recordCalled = false;
    const failingReview: ReviewStore = {
      ...review!,
      recordVerdictAndRelease: () => {
        throw new Error('verdict/release store unavailable');
      },
      recordVerdict: (verdict) => {
        recordCalled = true;
        return review!.recordVerdict(verdict);
      },
    };

    await expect(
      invokeTool(reg, { ...ctx, reviews: failingReview }, 'co_review_finalize', {
        target: TARGET,
        branch: BRANCH,
        review_id: 'rev-1',
        verdict: 'ISSUES',
        blockers: [{ summary: 'a test regressed' }],
        suggestions: [],
      }),
    ).rejects.toThrow(/verdict\/release store unavailable/);
    expect(recordCalled).toBe(false);
    expect(review!.getVerdict(TARGET, BRANCH)).toBeUndefined();
  });

  it('rejects the rubber-stamp inverse: an ISSUES verdict with no blocker', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer@rev-1');
    requestReview(review!);
    await expect(
      invokeTool(reg, ctx, 'co_review_finalize', {
        target: TARGET,
        branch: BRANCH,
        review_id: 'rev-1',
        verdict: 'ISSUES',
        blockers: [],
        suggestions: [],
      }),
    ).rejects.toThrow(/at least one blocker/);
    // Nothing was recorded.
    expect(review!.getVerdict(TARGET, BRANCH)).toBeUndefined();
  });

  it('rejects a PASS verdict with no verification marker (AC-L5-3 — PASS-without-marker)', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer@rev-1');
    requestReview(review!);
    await expect(
      invokeTool(reg, ctx, 'co_review_finalize', {
        target: TARGET,
        branch: BRANCH,
        review_id: 'rev-1',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
        // no verification field
      }),
    ).rejects.toThrow(/PASS.*verification marker/);
    // Nothing was recorded.
    expect(review!.getVerdict(TARGET, BRANCH)).toBeUndefined();
  });

  it('refuses a verdict when no matching review request exists', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer@rev-missing');

    await expect(
      invokeTool(reg, ctx, 'co_review_finalize', {
        target: TARGET,
        branch: BRANCH,
        review_id: 'rev-missing',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
        verification: {
          commands_run: ['pnpm test'],
          suite_result: 'pass',
          baseline_compared: true,
        },
      }),
    ).rejects.toThrow(/no matching review request/i);
    expect(review!.getVerdict(TARGET, BRANCH)).toBeUndefined();
  });

  it('refuses a verdict from a reviewer who was not assigned this review seat', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer@other');
    requestReview(review!, 'rev-assigned');

    await expect(
      invokeTool(reg, ctx, 'co_review_finalize', {
        target: TARGET,
        branch: BRANCH,
        review_id: 'rev-assigned',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
        verification: {
          commands_run: ['pnpm test'],
          suite_result: 'pass',
          baseline_compared: true,
        },
      }),
    ).rejects.toThrow(/assigned reviewer/i);
    expect(review!.getVerdict(TARGET, BRANCH)).toBeUndefined();
  });

  it('binds finalization to the durable placement instead of recomputing reviewer_profiles', async () => {
    const dispatch = openDispatchStore('p-rf');
    dispatches.push(dispatch);
    dispatch.recordPlacement('reviewer:bugfix@rev-durable', {
      kind: 'placed',
      role: 'reviewer:bugfix',
      work_size: 'technical',
      reasoning_budget: 'standard',
      provider: 'claude',
      account: 'claude:max',
      model: 'claude-opus-4-8',
      effort: 'high',
      context: 'extended',
    });
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer:bugfix@rev-durable', true, { dispatch });
    requestReview(review!, 'rev-durable', 'pr_merge');

    const out = (await invokeTool(reg, ctx, 'co_review_finalize', {
      target: TARGET,
      branch: BRANCH,
      scope: 'pr_merge',
      review_id: 'rev-durable',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    })) as FinalizeOut;

    expect(out).toEqual({ review_id: 'rev-durable', verdict: 'PASS', recorded: true });
    expect(review!.getVerdict(TARGET, BRANCH, 'pr_merge')?.reviewer).toBe(
      'reviewer:bugfix@rev-durable',
    );
  });

  it('uses the placed retry assignment when a review has an older waiting placement', async () => {
    const dispatch = openDispatchStore('p-rf');
    dispatches.push(dispatch);
    dispatch.recordPlacement('reviewer:pr@rev-retry', {
      kind: 'waiting',
      role: 'reviewer:pr',
      work_size: 'technical',
      reasoning_budget: 'standard',
      reason: 'queued before capacity recovered',
      maxed_providers: [],
      maxed_accounts: [],
      unavailable_providers: [],
      unavailable_accounts: [],
    });
    dispatch.recordPlacement('reviewer:pr@rev-retry', {
      kind: 'placed',
      role: 'reviewer:pr',
      work_size: 'technical',
      reasoning_budget: 'standard',
      provider: 'claude',
      account: 'claude:max',
      model: 'claude-opus-4-8',
      effort: 'high',
      context: 'extended',
    });
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer:pr@rev-retry', true, { dispatch });
    requestReview(review!, 'rev-retry', 'pr_merge');

    const out = (await invokeTool(reg, ctx, 'co_review_finalize', {
      target: TARGET,
      branch: BRANCH,
      scope: 'pr_merge',
      review_id: 'rev-retry',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    })) as FinalizeOut;

    expect(out).toEqual({ review_id: 'rev-retry', verdict: 'PASS', recorded: true });
    expect(review!.getVerdict(TARGET, BRANCH, 'pr_merge')?.reviewer).toBe('reviewer:pr@rev-retry');
  });

  it('refuses finalization while the durable reviewer placement is still waiting', async () => {
    const dispatch = openDispatchStore('p-rf');
    dispatches.push(dispatch);
    dispatch.recordPlacement('reviewer:pr@rev-waiting', {
      kind: 'waiting',
      role: 'reviewer:pr',
      work_size: 'technical',
      reasoning_budget: 'standard',
      reason: 'queued before capacity recovered',
      maxed_providers: [],
      maxed_accounts: [],
      unavailable_providers: [],
      unavailable_accounts: [],
    });
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer:pr@rev-waiting', true, { dispatch });
    requestReview(review!, 'rev-waiting', 'pr_merge');

    await expect(
      invokeTool(reg, ctx, 'co_review_finalize', {
        target: TARGET,
        branch: BRANCH,
        scope: 'pr_merge',
        review_id: 'rev-waiting',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
        verification: {
          commands_run: ['pnpm test'],
          suite_result: 'pass',
          baseline_compared: true,
        },
      }),
    ).rejects.toThrow(/waiting|not.*placed/i);
    expect(review!.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
  });

  it('refuses a reviewer placement bound to a different review request', async () => {
    const dispatch = openDispatchStore('p-rf');
    dispatches.push(dispatch);
    dispatch.recordPlacement('reviewer:pr@rev-bound', {
      kind: 'placed',
      role: 'reviewer:pr',
      work_size: 'technical',
      reasoning_budget: 'standard',
      review_id: 'rev-bound',
      review_target: 'co/old-target',
      review_branch: 'co/old-branch',
      review_scope: 'pr_merge',
      provider: 'claude',
      account: 'claude:max',
      model: 'claude-opus-4-8',
      effort: 'high',
      context: 'extended',
    });
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('reviewer:pr@rev-bound', true, { dispatch });
    requestReview(review!, 'rev-bound', 'pr_merge');

    await expect(
      invokeTool(reg, ctx, 'co_review_finalize', {
        target: TARGET,
        branch: BRANCH,
        scope: 'pr_merge',
        review_id: 'rev-bound',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
        verification: {
          commands_run: ['pnpm test'],
          suite_result: 'pass',
          baseline_compared: true,
        },
      }),
    ).rejects.toThrow(/does not match the current review request/i);
    expect(review!.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
  });

  it('loud-fails when the mount injected no review store (Principle 9)', async () => {
    const reg = buildCoreRegistry();
    const { ctx } = setup('rev-7', false);
    await expect(
      invokeTool(reg, ctx, 'co_review_finalize', {
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        review_id: 'rev-1',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
        verification: {
          commands_run: ['pnpm test'],
          suite_result: 'pass',
          baseline_compared: true,
        },
      }),
    ).rejects.toThrow(/ctx\.reviews absent/);
  });

  it('refuses an unregistered or non-reviewer caller before recording a verdict', async () => {
    const reg = buildCoreRegistry();
    const unregistered = setup('lead-2', true, { registerCaller: false });
    await expect(
      invokeTool(reg, unregistered.ctx, 'co_review_finalize', {
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        review_id: 'rev-unregistered',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
        verification: {
          commands_run: ['pnpm test'],
          suite_result: 'pass',
          baseline_compared: true,
        },
      }),
    ).rejects.toThrow(/not registered in the roster/i);
    expect(unregistered.review!.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toBeUndefined();

    const lead = setup('lead-2', true, { role: 'lead' });
    await expect(
      invokeTool(reg, lead.ctx, 'co_review_finalize', {
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        review_id: 'rev-lead',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
        verification: {
          commands_run: ['pnpm test'],
          suite_result: 'pass',
          baseline_compared: true,
        },
      }),
    ).rejects.toThrow(/requires reviewer/i);
    expect(lead.review!.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toBeUndefined();
  });
});
