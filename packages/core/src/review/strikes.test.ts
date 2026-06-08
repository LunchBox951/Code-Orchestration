import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIL_ESCALATION } from '../mail/events.js';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { openReviewStore, type ReviewStore } from './review-store.js';
import {
  consecutiveStrikes,
  nextReviewAction,
  applyStrikePolicy,
  REVIEW_ROUND_BUDGET_KEY,
  REVIEW_ROUND_BUDGET_DEFAULT,
  type StrikeEnforcementDeps,
} from './strikes.js';
import type { ReviewVerdictRecord } from './events.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────

const TARGET = 'co/l5-review-gate';
const BRANCH = 'co/l5-phase-a';

function makeVerdict(verdict: 'PASS' | 'ISSUES', ts = 1): ReviewVerdictRecord {
  return {
    reviewId: 'rev-1',
    target: TARGET,
    branch: BRANCH,
    scope: 'worker_merge',
    reviewer: 'rev-7',
    verdict,
    blockers: verdict === 'ISSUES' ? [{ summary: 'a blocker' }] : [],
    suggestions: [],
    recordedTs: ts,
  };
}

// ── Program-data dir per test ─────────────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let mailStores: MailStore[] = [];
let reviewStores: ReviewStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  mailStores = [];
  reviewStores = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-strikes-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const m of mailStores) m.close();
  for (const r of reviewStores) r.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  mailStores = [];
  reviewStores = [];
});

// ── consecutiveStrikes — pure fn ─────────────────────────────────────────────────────────────────
describe('consecutiveStrikes — pure trailing-ISSUES counter', () => {
  it('empty history → 0', () => {
    expect(consecutiveStrikes([])).toBe(0);
  });

  it('[PASS] → 0', () => {
    expect(consecutiveStrikes([makeVerdict('PASS')])).toBe(0);
  });

  it('[ISSUES] → 1', () => {
    expect(consecutiveStrikes([makeVerdict('ISSUES')])).toBe(1);
  });

  it('[ISSUES, ISSUES] → 2', () => {
    expect(consecutiveStrikes([makeVerdict('ISSUES'), makeVerdict('ISSUES')])).toBe(2);
  });

  it('[ISSUES, PASS] → 0 (trailing PASS resets)', () => {
    expect(consecutiveStrikes([makeVerdict('ISSUES'), makeVerdict('PASS')])).toBe(0);
  });

  it('[PASS, ISSUES] → 1 (trailing run since last PASS)', () => {
    expect(consecutiveStrikes([makeVerdict('PASS'), makeVerdict('ISSUES')])).toBe(1);
  });

  it('[ISSUES, ISSUES, PASS, ISSUES] → 1 (PASS resets; only trailing ISSUES counts)', () => {
    expect(
      consecutiveStrikes([
        makeVerdict('ISSUES'),
        makeVerdict('ISSUES'),
        makeVerdict('PASS'),
        makeVerdict('ISSUES'),
      ]),
    ).toBe(1);
  });

  it('[ISSUES×3] → 3 (budget=3 would escalate)', () => {
    expect(
      consecutiveStrikes([makeVerdict('ISSUES'), makeVerdict('ISSUES'), makeVerdict('ISSUES')]),
    ).toBe(3);
  });
});

// ── nextReviewAction — pure decision fn ──────────────────────────────────────────────────────────
describe('nextReviewAction — pure budget decision', () => {
  it('count=0, budget=3 → kickback', () => {
    expect(nextReviewAction(0, 3)).toBe('kickback');
  });

  it('count=2, budget=3 → kickback (below budget)', () => {
    expect(nextReviewAction(2, 3)).toBe('kickback');
  });

  it('count=3, budget=3 → escalate (at budget)', () => {
    expect(nextReviewAction(3, 3)).toBe('escalate');
  });

  it('count=4, budget=3 → escalate (beyond budget)', () => {
    expect(nextReviewAction(4, 3)).toBe('escalate');
  });

  it('count=5, budget=5 (default) → escalate (at default budget)', () => {
    expect(nextReviewAction(5, REVIEW_ROUND_BUDGET_DEFAULT)).toBe('escalate');
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────────────────────────
describe('constants', () => {
  it('REVIEW_ROUND_BUDGET_KEY is review_round_budget', () => {
    expect(REVIEW_ROUND_BUDGET_KEY).toBe('review_round_budget');
  });

  it('REVIEW_ROUND_BUDGET_DEFAULT is 5', () => {
    expect(REVIEW_ROUND_BUDGET_DEFAULT).toBe(5);
  });
});

// ── applyStrikePolicy — AC-L5-4 enforcement ──────────────────────────────────────────────────────
describe('applyStrikePolicy — 3-strike escalation enforcement (AC-L5-4)', () => {
  const BUDGET = 3;

  function openStores(id: string): { reviews: ReviewStore; mail: MailStore } {
    const reviews = openReviewStore(id);
    reviewStores.push(reviews);
    const mail = openMailStore(id);
    mailStores.push(mail);
    return { reviews, mail };
  }

  function makeDeps(reviews: ReviewStore, mail: MailStore, budget = BUDGET): StrikeEnforcementDeps {
    return {
      reviews,
      mail,
      resolver: { parentOf: () => 'coordinator-1' },
      agentId: 'lead-1',
      budget,
    };
  }

  function makeCtx(idx: number) {
    return {
      reviewId: `rev-${idx}`,
      target: TARGET,
      branch: BRANCH,
      blockers: [{ summary: `blocker ${idx}` }],
    };
  }

  it('first ISSUES → kickback (below budget)', () => {
    const { reviews, mail } = openStores('p-strike-kick1');
    const action = applyStrikePolicy(makeDeps(reviews, mail), makeCtx(1));
    expect(action).toBe('kickback');
    expect(reviews.getStrikeCount(TARGET, BRANCH)).toBe(1);
    expect(mail.inbox('coordinator-1').filter((m) => m.type === MAIL_ESCALATION)).toHaveLength(0);
  });

  it('two consecutive ISSUES → kickback (still below budget=3)', () => {
    const { reviews, mail } = openStores('p-strike-kick2');
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(1));
    const action = applyStrikePolicy(makeDeps(reviews, mail), makeCtx(2));
    expect(action).toBe('kickback');
    expect(reviews.getStrikeCount(TARGET, BRANCH)).toBe(2);
    expect(mail.inbox('coordinator-1').filter((m) => m.type === MAIL_ESCALATION)).toHaveLength(0);
  });

  it('third consecutive ISSUES → escalate, exactly one escalation mail to coordinator (AC-L5-4)', () => {
    const { reviews, mail } = openStores('p-strike-esc3');
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(1));
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(2));
    const action = applyStrikePolicy(makeDeps(reviews, mail), makeCtx(3));

    expect(action).toBe('escalate');
    expect(reviews.getStrikeCount(TARGET, BRANCH)).toBe(3);

    const escalations = mail.inbox('coordinator-1').filter((m) => m.type === MAIL_ESCALATION);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.subject).toContain(BRANCH);
    expect(escalations[0]!.subject).toContain('3/3');
  });

  it('fourth ISSUES after escalation → still escalate, NO second escalation mail (idempotent)', () => {
    const { reviews, mail } = openStores('p-strike-esc4');
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(1));
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(2));
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(3)); // fires escalation
    const action = applyStrikePolicy(makeDeps(reviews, mail), makeCtx(4)); // must NOT re-fire

    expect(action).toBe('escalate');
    expect(reviews.getStrikeCount(TARGET, BRANCH)).toBe(4);

    // Still exactly one escalation (from the 3rd call).
    const escalations = mail.inbox('coordinator-1').filter((m) => m.type === MAIL_ESCALATION);
    expect(escalations).toHaveLength(1);
  });

  it('ISSUES, ISSUES, PASS, ISSUES → never escalates (PASS resets the run — AC-L5-4)', () => {
    const { reviews, mail } = openStores('p-strike-reset');

    // Two ISSUES then a PASS verdict (resets the counter).
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(1));
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(2));

    // Record a PASS verdict to reset the counter.
    reviews.recordVerdict({
      reviewId: 'rev-pass',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });
    expect(reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);

    // Now a fresh ISSUES after the PASS reset — count = 1, below budget.
    const action = applyStrikePolicy(makeDeps(reviews, mail), makeCtx(3));
    expect(action).toBe('kickback');
    expect(reviews.getStrikeCount(TARGET, BRANCH)).toBe(1);
    expect(mail.inbox('coordinator-1').filter((m) => m.type === MAIL_ESCALATION)).toHaveLength(0);
  });

  it('ISSUES×2, PASS, ISSUES×3 → escalates on 3rd post-reset ISSUES (fresh run)', () => {
    const { reviews, mail } = openStores('p-strike-fresh-run');

    // Two ISSUES then PASS (resets).
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(1));
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(2));
    reviews.recordVerdict({
      reviewId: 'rev-pass',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    // Three fresh ISSUES after the reset → reaches budget.
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(3));
    applyStrikePolicy(makeDeps(reviews, mail), makeCtx(4));
    const action = applyStrikePolicy(makeDeps(reviews, mail), makeCtx(5));

    expect(action).toBe('escalate');
    const escalations = mail.inbox('coordinator-1').filter((m) => m.type === MAIL_ESCALATION);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.subject).toContain('3/3');
  });
});
