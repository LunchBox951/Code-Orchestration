import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openReviewStore, type ReviewStore } from '../../review/review-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// AC-L5-1 — co_review_finalize through invokeTool: it records a structured verdict (PASS or ISSUES),
// rejects the rubber-stamp inverse (ISSUES with no blocker), and loud-fails without a review store.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let mails: MailStore[] = [];
let reviews: ReviewStore[] = [];
let regs: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  mails = [];
  reviews = [];
  regs = [];
  const data = mkdtempSync(join(tmpdir(), 'co-rf-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const m of mails) m.close();
  for (const r of reviews) r.close();
  for (const r of regs) r.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  mails = [];
  reviews = [];
  regs = [];
});

type FinalizeOut = { review_id: string; verdict: 'PASS' | 'ISSUES'; recorded: boolean };

function setup(agent: string, withReviews = true): { ctx: ToolContext; review?: ReviewStore } {
  const mail = openMailStore('p-rf');
  mails.push(mail);
  const registry = openRegistry();
  regs.push(registry);
  let review: ReviewStore | undefined;
  if (withReviews) {
    review = openReviewStore('p-rf');
    reviews.push(review);
  }
  const ctx: ToolContext = {
    agent,
    projectId: 'p-rf',
    cwd: '/repo',
    mail,
    registry,
    ...(review ? { reviews: review } : {}),
  };
  return { ctx, ...(review ? { review } : {}) };
}

describe('co_review_finalize (AC-L5-1)', () => {
  it('records a PASS verdict; the reviewer is ctx.agent (never a caller input)', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('rev-7');
    const out = (await invokeTool(reg, ctx, 'co_review_finalize', {
      target: 'co/l5-review-gate',
      branch: 'co/l5-phase-a',
      review_id: 'rev-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [{ summary: 'tidy a comment' }],
    })) as FinalizeOut;
    expect(out).toEqual({ review_id: 'rev-1', verdict: 'PASS', recorded: true });
    const recorded = review!.getVerdict('co/l5-review-gate', 'co/l5-phase-a');
    expect(recorded?.verdict).toBe('PASS');
    expect(recorded?.reviewer).toBe('rev-7');
    expect(recorded?.suggestions).toEqual([{ summary: 'tidy a comment' }]);
  });

  it('records an ISSUES verdict with a blocker + verification marker', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('rev-7');
    const out = (await invokeTool(reg, ctx, 'co_review_finalize', {
      target: 'co/l5-review-gate',
      branch: 'co/l5-phase-a',
      review_id: 'rev-1',
      verdict: 'ISSUES',
      blockers: [{ summary: 'a test regressed' }],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'fail', baseline_compared: true },
    })) as FinalizeOut;
    expect(out.verdict).toBe('ISSUES');
    const recorded = review!.getVerdict('co/l5-review-gate', 'co/l5-phase-a');
    expect(recorded?.blockers).toEqual([{ summary: 'a test regressed' }]);
    expect(recorded?.verification).toEqual({
      commands_run: ['pnpm test'],
      suite_result: 'fail',
      baseline_compared: true,
    });
  });

  it('rejects the rubber-stamp inverse: an ISSUES verdict with no blocker', async () => {
    const reg = buildCoreRegistry();
    const { ctx, review } = setup('rev-7');
    await expect(
      invokeTool(reg, ctx, 'co_review_finalize', {
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        review_id: 'rev-1',
        verdict: 'ISSUES',
        blockers: [],
        suggestions: [],
      }),
    ).rejects.toThrow(/at least one blocker/);
    // Nothing was recorded.
    expect(review!.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toBeUndefined();
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
      }),
    ).rejects.toThrow(/ctx\.reviews absent/);
  });
});
