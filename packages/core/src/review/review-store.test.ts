import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { applyEvent, rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import { assertRepoPristine } from '../config/pristine.js';
import {
  makeMergeSerializedEvent,
  makeReviewOverrideEvent,
  makeReviewRequestedEvent,
  makeReviewStrikeEvent,
  makeReviewVerdictEvent,
  reviewSchemas,
  reviewUpcasters,
  type ReviewRequested,
  type ReviewVerdictRecorded,
} from './events.js';
import { ensureReviewTables, ReviewProjector } from './review-projector.js';
import { openReviewStore } from './review-store.js';
import { renderReviewSpecRef } from './spec-ref.js';

// ── Program-data dir per test (mirrors worktree-store.test.ts) ───────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-rev-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of [...dataDirs, ...repoDirs]) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
});

/** A throwaway repo-like tree (a tracked file + a `.git/HEAD`), mirroring worktree-store.test.ts. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-rev-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

const verdict = (over: Partial<ReviewVerdictRecorded> = {}): ReviewVerdictRecorded => ({
  reviewId: 'rev-1',
  target: 'co/l5-review-gate',
  branch: 'co/l5-phase-a',
  reviewer: 'rev-7',
  verdict: 'PASS',
  blockers: [],
  suggestions: [],
  ...over,
});

const request = (over: Partial<ReviewRequested> = {}): ReviewRequested => ({
  reviewId: 'rev-1',
  target: 'co/l5-review-gate',
  branch: 'co/l5-phase-a',
  requestedBy: 'lead-2',
  ...over,
});

describe('ReviewStore — record + read verdicts', () => {
  it('migrates a legacy reviews projection that predates spec-ref columns', () => {
    const raw = openProjectStore('p-legacy-reviews');
    try {
      raw.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        db.exec(`
          CREATE TABLE reviews (
            target          TEXT NOT NULL,
            branch          TEXT NOT NULL,
            review_id       TEXT,
            verdict         TEXT,
            blockers        TEXT,
            suggestions     TEXT,
            verification    TEXT,
            reviewer        TEXT,
            verdict_ts      INTEGER,
            requested_by    TEXT,
            requested_ts    INTEGER,
            strikes         INTEGER NOT NULL DEFAULT 0,
            serialized      INTEGER NOT NULL DEFAULT 0,
            overridden      INTEGER NOT NULL DEFAULT 0,
            override_reason TEXT,
            override_by     TEXT,
            PRIMARY KEY (target, branch)
          );
        `);
        ensureReviewTables(db);
        const columns = db.prepare('PRAGMA table_info(reviews)').all() as Array<{ name: string }>;
        expect(columns.map((c) => c.name)).toEqual(
          expect.arrayContaining(['scope', 'spec_ref_kind', 'spec_ref_ref']),
        );
      });
    } finally {
      raw.close();
    }

    const store = openReviewStore('p-legacy-reviews');
    try {
      const ref = 'docs/specs/stage-5.locked.md#AC-L5-8';
      const saved = store.recordReviewRequested(
        request({ specRefKind: 'criteria', specRefRef: ref }),
      );
      expect(saved.specRef).toEqual({ kind: 'criteria', ref });
    } finally {
      store.close();
    }
  });

  it('backfills legacy verdict_seq values from review.verdict events', () => {
    const first = openReviewStore('p-legacy-verdict-seq');
    let expectedSeq: number;
    try {
      const saved = first.recordVerdict(verdict({ reviewId: 'rev-seq' }));
      expectedSeq = saved.recordedSeq!;
    } finally {
      first.close();
    }
    const raw = openProjectStore('p-legacy-verdict-seq');
    try {
      raw.transaction((tx) => {
        (tx.raw as DatabaseSync).exec('UPDATE reviews SET verdict_seq = NULL');
      });
    } finally {
      raw.close();
    }

    const reopened = openReviewStore('p-legacy-verdict-seq');
    try {
      expect(reopened.getVerdict('co/l5-review-gate', 'co/l5-phase-a')?.recordedSeq).toBe(
        expectedSeq,
      );
    } finally {
      reopened.close();
    }
  });

  it('records a PASS verdict and reads it back, structured (per target + branch)', () => {
    const store = openReviewStore('p-verdict');
    try {
      const saved = store.recordVerdict(verdict({ suggestions: [{ summary: 'tidy a comment' }] }));
      expect(saved.verdict).toBe('PASS');
      expect(saved.scope).toBe('worker_merge');
      expect(saved.target).toBe('co/l5-review-gate');
      expect(saved.branch).toBe('co/l5-phase-a');
      expect(saved.reviewer).toBe('rev-7');
      expect(saved.blockers).toEqual([]);
      expect(saved.suggestions).toEqual([{ summary: 'tidy a comment' }]);
      expect(saved.verification).toBeUndefined();
      expect(saved.recordedTs).toBeGreaterThan(0);
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toEqual(saved);
      expect(store.getVerdict('co/l5-review-gate', 'co/absent')).toBeUndefined();
      expect(store.getVerdict('co/absent', 'co/l5-phase-a')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('records an ISSUES verdict with blockers + a verification marker', () => {
    const store = openReviewStore('p-issues');
    try {
      const saved = store.recordVerdict(
        verdict({
          verdict: 'ISSUES',
          blockers: [{ summary: 'a test regressed' }, { summary: 'lint fails' }],
          verification: {
            commands_run: ['pnpm test'],
            suite_result: 'fail',
            baseline_compared: true,
          },
        }),
      );
      expect(saved.verdict).toBe('ISSUES');
      expect(saved.blockers).toEqual([{ summary: 'a test regressed' }, { summary: 'lint fails' }]);
      expect(saved.verification).toEqual({
        commands_run: ['pnpm test'],
        suite_result: 'fail',
        baseline_compared: true,
      });
    } finally {
      store.close();
    }
  });

  it('records verdict scope and lets callers require the matching scope', () => {
    const store = openReviewStore('p-scope');
    try {
      store.recordVerdict(verdict({ scope: 'worker_merge' }));
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')?.scope).toBe('worker_merge');
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a', 'pr_merge')).toBeUndefined();

      const prPass = store.recordVerdict(verdict({ reviewId: 'rev-pr', scope: 'pr_merge' }));
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a', 'pr_merge')).toEqual(prPass);
    } finally {
      store.close();
    }
  });

  it('the builder rejects an ISSUES with no blocker (AC-L5-1 enforced at the event boundary)', () => {
    const store = openReviewStore('p-reject');
    try {
      expect(() => store.recordVerdict(verdict({ verdict: 'ISSUES', blockers: [] }))).toThrow(
        /at least one blocker/,
      );
      // …and nothing was recorded.
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('a re-review UPSERTs — the read-model holds the LATEST verdict for the branch on the target', () => {
    const store = openReviewStore('p-rereview');
    try {
      store.recordVerdict(
        verdict({ reviewId: 'rev-1', verdict: 'ISSUES', blockers: [{ summary: 'fix me' }] }),
      );
      const second = store.recordVerdict(
        verdict({ reviewId: 'rev-2', verdict: 'PASS', blockers: [] }),
      );
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toEqual(second);
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')?.verdict).toBe('PASS');
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')?.reviewId).toBe('rev-2');
    } finally {
      store.close();
    }
  });

  it('lists every recorded verdict on a target; two distinct branches → two records', () => {
    const store = openReviewStore('p-list');
    try {
      store.recordVerdict(verdict({ branch: 'co/a' }));
      store.recordVerdict(verdict({ branch: 'co/b' }));
      // A verdict on a DIFFERENT target must not leak into this target's list.
      store.recordVerdict(verdict({ target: 'co/other', branch: 'co/c' }));
      const branches = store.listVerdicts('co/l5-review-gate').map((r) => r.branch);
      expect(branches).toEqual(['co/a', 'co/b']);
      expect(store.listVerdicts('co/other').map((r) => r.branch)).toEqual(['co/c']);
    } finally {
      store.close();
    }
  });

  it('records a review request and reads it back (minimal — Phase E grows it)', () => {
    const store = openReviewStore('p-request');
    try {
      const saved = store.recordReviewRequested(request());
      expect(saved.reviewId).toBe('rev-1');
      expect(saved.scope).toBe('worker_merge');
      expect(saved.requestedBy).toBe('lead-2');
      expect(saved.requestedTs).toBeGreaterThan(0);
      expect(store.getReviewRequest('co/l5-review-gate', 'co/l5-phase-a')).toEqual(saved);
      // A request alone is NOT a verdict.
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('records review request scope so human re-entry can replay the same strictness', () => {
    const store = openReviewStore('p-request-scope');
    try {
      const saved = store.recordReviewRequested(
        request({ reviewId: 'rev-pr-request', scope: 'pr_merge' }),
      );
      expect(saved.scope).toBe('pr_merge');
      expect(store.getReviewRequest('co/l5-review-gate', 'co/l5-phase-a')?.scope).toBe('pr_merge');
    } finally {
      store.close();
    }
  });

  it('a request then a verdict for the same review both read back on the same row', () => {
    const store = openReviewStore('p-req-then-verdict');
    try {
      store.recordReviewRequested(request({ reviewId: 'rev-9' }));
      store.recordVerdict(verdict({ reviewId: 'rev-9' }));
      expect(store.getReviewRequest('co/l5-review-gate', 'co/l5-phase-a')?.reviewId).toBe('rev-9');
      const v = store.getVerdict('co/l5-review-gate', 'co/l5-phase-a');
      expect(v?.verdict).toBe('PASS');
      expect(v?.reviewId).toBe('rev-9');
    } finally {
      store.close();
    }
  });

  it('refuses a second verdict for the same review request', () => {
    const store = openReviewStore('p-req-duplicate-verdict');
    try {
      store.recordReviewRequested(request({ reviewId: 'rev-dup-verdict' }));
      store.recordVerdict(
        verdict({
          reviewId: 'rev-dup-verdict',
          verdict: 'ISSUES',
          blockers: [{ summary: 'needs work' }],
        }),
      );

      expect(() =>
        store.recordVerdict(verdict({ reviewId: 'rev-dup-verdict', verdict: 'PASS' })),
      ).toThrow(/already recorded/);
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')?.verdict).toBe('ISSUES');
    } finally {
      store.close();
    }
  });

  it('a duplicate request with the same reviewId preserves an already recorded verdict', () => {
    const store = openReviewStore('p-request-duplicate-preserves-verdict');
    try {
      store.recordReviewRequested(request({ reviewId: 'rev-dup' }));
      store.recordVerdict(verdict({ reviewId: 'rev-dup' }));

      const rerequest = store.recordReviewRequested(request({ reviewId: 'rev-dup' }));

      expect(rerequest.reviewId).toBe('rev-dup');
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')?.verdict).toBe('PASS');
    } finally {
      store.close();
    }
  });

  it('a duplicate request with the same reviewId but different fields is refused', () => {
    const store = openReviewStore('p-request-duplicate-mismatch');
    try {
      store.recordReviewRequested(request({ reviewId: 'rev-dup-mismatch' }));

      expect(() =>
        store.recordReviewRequested(request({ reviewId: 'rev-dup-mismatch', scope: 'pr_merge' })),
      ).toThrow(/duplicate reviewId.*scope/i);
    } finally {
      store.close();
    }
  });

  it('a duplicate reviewId on another target or branch is refused project-wide', () => {
    const store = openReviewStore('p-request-duplicate-cross-target');
    try {
      store.recordReviewRequested(request({ reviewId: 'rev-cross-target' }));

      expect(() =>
        store.recordReviewRequested(
          request({
            reviewId: 'rev-cross-target',
            target: 'co/another-target',
            branch: 'co/another-branch',
          }),
        ),
      ).toThrow(/duplicate reviewId.*already belongs/i);
    } finally {
      store.close();
    }
  });

  it('a historical reviewId cannot be reused after a newer request overwrites the row', () => {
    const store = openReviewStore('p-request-duplicate-history');
    try {
      store.recordReviewRequested(request({ reviewId: 'rev-historical' }));
      store.recordReviewRequested(request({ reviewId: 'rev-newer' }));

      expect(() =>
        store.recordReviewRequested(
          request({
            reviewId: 'rev-historical',
            target: 'co/another-target',
            branch: 'co/another-branch',
          }),
        ),
      ).toThrow(/duplicate reviewId.*already belongs/i);
    } finally {
      store.close();
    }
  });

  it('a historical reviewId cannot be reused on the same target and branch after supersession', () => {
    const store = openReviewStore('p-request-duplicate-history-same-branch');
    try {
      store.recordReviewRequested(request({ reviewId: 'rev-old' }));
      store.recordReviewRequested(request({ reviewId: 'rev-current' }));

      expect(() => store.recordReviewRequested(request({ reviewId: 'rev-old' }))).toThrow(
        /duplicate reviewId.*already belongs/i,
      );
      expect(store.getReviewRequest('co/l5-review-gate', 'co/l5-phase-a')?.reviewId).toBe(
        'rev-current',
      );
    } finally {
      store.close();
    }
  });

  it('a verdict inherits the matching request scope when no verdict scope is supplied', () => {
    const store = openReviewStore('p-verdict-inherits-request-scope');
    try {
      store.recordReviewRequested(request({ reviewId: 'rev-pr', scope: 'pr_merge' }));
      const saved = store.recordVerdict(verdict({ reviewId: 'rev-pr' }));
      expect(saved.scope).toBe('pr_merge');
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a', 'pr_merge')).toEqual(saved);
    } finally {
      store.close();
    }
  });

  it('rejects a verdict whose scope does not match the latest request scope', () => {
    const store = openReviewStore('p-verdict-request-scope-mismatch');
    try {
      store.recordReviewRequested(request({ reviewId: 'rev-worker', scope: 'worker_merge' }));
      expect(() =>
        store.recordVerdict(verdict({ reviewId: 'rev-worker', scope: 'pr_merge' })),
      ).toThrow(/scope.*pr_merge.*worker_merge/i);
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('a new review request clears the prior verdict for the same target and branch', () => {
    const store = openReviewStore('p-request-clears-verdict');
    try {
      store.recordVerdict(verdict({ reviewId: 'rev-old', scope: 'pr_merge' }));
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a', 'pr_merge')?.verdict).toBe(
        'PASS',
      );

      store.recordReviewRequested(request({ reviewId: 'rev-new' }));

      expect(store.getReviewRequest('co/l5-review-gate', 'co/l5-phase-a')?.reviewId).toBe(
        'rev-new',
      );
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toBeUndefined();
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a', 'pr_merge')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('a second connection sees the same persisted verdict', () => {
    const a = openReviewStore('p-shared');
    try {
      a.recordVerdict(verdict());
    } finally {
      a.close();
    }
    const b = openReviewStore('p-shared');
    try {
      expect(b.getVerdict('co/l5-review-gate', 'co/l5-phase-a')?.reviewer).toBe('rev-7');
    } finally {
      b.close();
    }
  });
});

// ── AC-L5-11 — the L5 read-model replays byte-equal (the replay invariant) ───────────────────────
describe('AC-L5-11 — review read-model rebuilds byte-identical (all five events)', () => {
  function snapshot(db: DatabaseSync): string {
    return JSON.stringify(
      db
        .prepare(
          'SELECT target, branch, scope, review_id, verdict, blockers, suggestions, verification, reviewer, ' +
            'verdict_ts, verdict_seq, requested_by, requested_ts, strikes, serialized, overridden, ' +
            'override_reason, override_by, override_verification_failures FROM reviews ORDER BY target, branch',
        )
        .all(),
    );
  }

  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous, all five event types)', () => {
    const store = openProjectStore('p-replay');
    const projectors = [new ReviewProjector()];
    const t = 'co/l5-review-gate';
    const sequence = [
      makeReviewRequestedEvent('p-replay', request({ reviewId: 'r-a', branch: 'co/a' })),
      makeReviewVerdictEvent(
        'p-replay',
        verdict({
          reviewId: 'r-a',
          branch: 'co/a',
          verdict: 'ISSUES',
          blockers: [{ summary: 'x' }],
        }),
      ),
      // A re-review of co/a (UPSERT — last wins): the rebuild must reach the same final row.
      makeReviewRequestedEvent('p-replay', request({ reviewId: 'r-a2', branch: 'co/a' })),
      makeReviewVerdictEvent(
        'p-replay',
        verdict({ reviewId: 'r-a2', branch: 'co/a', verdict: 'PASS' }),
      ),
      makeReviewVerdictEvent(
        'p-replay',
        verdict({
          reviewId: 'r-b',
          branch: 'co/b',
          verdict: 'PASS',
          suggestions: [{ summary: 's' }],
          verification: {
            commands_run: ['pnpm test'],
            suite_result: 'pass',
            baseline_compared: false,
          },
        }),
      ),
      // The three later-phase event types are folded NOW (read-model plumbing) — exercise each.
      makeReviewStrikeEvent('p-replay', {
        reviewId: 'r-b',
        target: t,
        branch: 'co/b',
        reason: 'flaky',
      }),
      makeReviewStrikeEvent('p-replay', {
        reviewId: 'r-b2',
        target: t,
        branch: 'co/b',
        reason: 'again',
      }),
      makeMergeSerializedEvent('p-replay', { target: t, branch: 'co/a' }),
      makeReviewOverrideEvent('p-replay', {
        target: t,
        branch: 'co/c',
        reason: 'operator force',
        overriddenBy: 'lead-2',
      }),
    ];
    try {
      for (const e of sequence) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, reviewUpcasters, reviewSchemas), projectors);
        });
      }
      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, reviewUpcasters, reviewSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against a vacuous pass.
      expect(live).toContain('"branch":"co/a"');
      expect(live).toContain('"verdict":"PASS"'); // co/a's re-review won
      expect(live).toContain('"strikes":2'); // both strikes folded
      expect(live).toContain('"serialized":1');
      expect(live).toContain('"overridden":1');
      expect(live).toContain('operator force');
      expect(live).toContain('pnpm test'); // co/b's verification marker
    } finally {
      store.close();
    }
  });
});

// ── ReviewStore.recordStrike / getStrikeCount (Phase D) ──────────────────────────────────────────
describe('ReviewStore.recordStrike + getStrikeCount (AC-L5-4 plumbing)', () => {
  it('getStrikeCount returns 0 for an unknown (target, branch)', () => {
    const store = openReviewStore('p-strike-zero');
    try {
      expect(store.getStrikeCount('co/l5-review-gate', 'co/absent')).toBe(0);
    } finally {
      store.close();
    }
  });

  it('recordStrike bumps the counter per (target, branch)', () => {
    const store = openReviewStore('p-strike-bump');
    try {
      store.recordStrike({
        reviewId: 'rev-1',
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        reason: 'failing tests',
      });
      expect(store.getStrikeCount('co/l5-review-gate', 'co/l5-phase-a')).toBe(1);
      store.recordStrike({
        reviewId: 'rev-2',
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        reason: 'still failing',
      });
      expect(store.getStrikeCount('co/l5-review-gate', 'co/l5-phase-a')).toBe(2);
    } finally {
      store.close();
    }
  });

  it('recordStrike is idempotent per (target, branch, reviewId)', () => {
    const store = openReviewStore('p-strike-idempotent');
    try {
      store.recordStrike({
        reviewId: 'rev-1',
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        reason: 'failing tests',
      });
      store.recordStrike({
        reviewId: 'rev-1',
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        reason: 'retry',
      });

      expect(store.getStrikeCount('co/l5-review-gate', 'co/l5-phase-a')).toBe(1);
      expect(store.hasStrike('co/l5-review-gate', 'co/l5-phase-a', 'rev-1')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('recording a PASS verdict resets the strike counter to 0', () => {
    const store = openReviewStore('p-strike-pass-reset');
    try {
      store.recordStrike({
        reviewId: 'rev-1',
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        reason: 'blocker',
      });
      store.recordStrike({
        reviewId: 'rev-2',
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        reason: 'blocker',
      });
      expect(store.getStrikeCount('co/l5-review-gate', 'co/l5-phase-a')).toBe(2);
      store.recordVerdict(verdict({ verdict: 'PASS', blockers: [] }));
      expect(store.getStrikeCount('co/l5-review-gate', 'co/l5-phase-a')).toBe(0);
    } finally {
      store.close();
    }
  });

  it('PASS reset does not make an already-consumed reviewId strikeable again', () => {
    const store = openReviewStore('p-strike-pass-keeps-consumed-review');
    try {
      store.recordStrike({
        reviewId: 'rev-1',
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        reason: 'blocker',
      });
      expect(store.getStrikeCount('co/l5-review-gate', 'co/l5-phase-a')).toBe(1);

      store.recordVerdict(verdict({ verdict: 'PASS', blockers: [] }));
      expect(store.getStrikeCount('co/l5-review-gate', 'co/l5-phase-a')).toBe(0);
      expect(store.hasStrike('co/l5-review-gate', 'co/l5-phase-a', 'rev-1')).toBe(true);

      store.recordStrike({
        reviewId: 'rev-1',
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        reason: 'retry after pass',
      });
      expect(store.getStrikeCount('co/l5-review-gate', 'co/l5-phase-a')).toBe(0);
    } finally {
      store.close();
    }
  });

  it('recording an ISSUES verdict does NOT reset the counter', () => {
    const store = openReviewStore('p-strike-issues-norepo');
    try {
      store.recordStrike({
        reviewId: 'rev-1',
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        reason: 'b',
      });
      store.recordVerdict(verdict({ verdict: 'ISSUES', blockers: [{ summary: 'b' }] }));
      expect(store.getStrikeCount('co/l5-review-gate', 'co/l5-phase-a')).toBe(1);
    } finally {
      store.close();
    }
  });

  it('backfills legacy strike idempotency rows from review.strike events on open', () => {
    const projectId = 'p-strike-backfill';
    const target = 'co/l5-review-gate';
    const branch = 'co/l5-phase-a';
    const reviewId = 'rev-legacy-strike';
    const raw = openProjectStore(projectId);
    try {
      raw.transaction((tx) => {
        tx.append([
          makeReviewStrikeEvent(projectId, {
            reviewId,
            target,
            branch,
            reason: 'legacy strike',
          }),
        ]);
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db, { backfillStrikes: false });
        db.prepare(
          `INSERT INTO reviews (target, branch, scope, review_id, strikes)
           VALUES (?, ?, 'worker_merge', ?, 1)`,
        ).run(target, branch, reviewId);
        db.exec('DROP TABLE review_strikes');
      });
    } finally {
      raw.close();
    }

    const store = openReviewStore(projectId);
    try {
      expect(store.getStrikeCount(target, branch)).toBe(1);
      expect(store.hasStrike(target, branch, reviewId)).toBe(true);
      store.recordStrike({ reviewId, target, branch, reason: 'retry' });
      expect(store.getStrikeCount(target, branch)).toBe(1);
    } finally {
      store.close();
    }
  });

  it('backfills legacy duplicate strike rows to the replay-equivalent visible count', () => {
    const projectId = 'p-strike-backfill-duplicates';
    const target = 'co/l5-review-gate';
    const branch = 'co/l5-phase-a';
    const raw = openProjectStore(projectId);
    try {
      raw.transaction((tx) => {
        tx.append([
          makeReviewStrikeEvent(projectId, {
            reviewId: 'rev-before-pass',
            target,
            branch,
            reason: 'legacy duplicate before pass',
          }),
          makeReviewStrikeEvent(projectId, {
            reviewId: 'rev-before-pass',
            target,
            branch,
            reason: 'legacy duplicate before pass',
          }),
          makeReviewVerdictEvent(
            projectId,
            verdict({ reviewId: 'rev-pass', target, branch, verdict: 'PASS' }),
          ),
          makeReviewStrikeEvent(projectId, {
            reviewId: 'rev-after-pass',
            target,
            branch,
            reason: 'legacy duplicate after pass',
          }),
          makeReviewStrikeEvent(projectId, {
            reviewId: 'rev-after-pass',
            target,
            branch,
            reason: 'legacy duplicate after pass',
          }),
        ]);
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        db.prepare(
          `INSERT INTO reviews (target, branch, scope, review_id, strikes)
           VALUES (?, ?, 'worker_merge', ?, 4)
           ON CONFLICT(target, branch) DO UPDATE SET strikes = 4`,
        ).run(target, branch, 'rev-after-pass');
        db.exec('DROP TABLE review_strikes');
      });
    } finally {
      raw.close();
    }

    const store = openReviewStore(projectId);
    try {
      expect(store.hasStrike(target, branch, 'rev-before-pass')).toBe(true);
      expect(store.hasStrike(target, branch, 'rev-after-pass')).toBe(true);
      expect(store.getStrikeCount(target, branch)).toBe(1);
      store.recordStrike({ reviewId: 'rev-after-pass', target, branch, reason: 'retry' });
      expect(store.getStrikeCount(target, branch)).toBe(1);
      store.recordStrike({ reviewId: 'rev-new', target, branch, reason: 'fresh' });
      expect(store.getStrikeCount(target, branch)).toBe(2);
    } finally {
      store.close();
    }
  });

  it('backfills a post-PASS duplicate reviewId strike as already consumed', () => {
    const projectId = 'p-strike-backfill-pass-duplicate';
    const target = 'co/l5-review-gate';
    const branch = 'co/l5-phase-a';
    const raw = openProjectStore(projectId);
    try {
      raw.transaction((tx) => {
        tx.append([
          makeReviewStrikeEvent(projectId, {
            reviewId: 'rev-retry',
            target,
            branch,
            reason: 'legacy strike before pass',
          }),
          makeReviewVerdictEvent(
            projectId,
            verdict({ reviewId: 'rev-pass', target, branch, verdict: 'PASS' }),
          ),
          makeReviewStrikeEvent(projectId, {
            reviewId: 'rev-retry',
            target,
            branch,
            reason: 'legacy retry after pass',
          }),
        ]);
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        db.prepare(
          `INSERT INTO reviews (target, branch, scope, review_id, strikes)
           VALUES (?, ?, 'worker_merge', ?, 1)
           ON CONFLICT(target, branch) DO UPDATE SET strikes = 1`,
        ).run(target, branch, 'rev-retry');
        db.exec('DROP TABLE review_strikes');
      });
    } finally {
      raw.close();
    }

    const store = openReviewStore(projectId);
    try {
      expect(store.hasStrike(target, branch, 'rev-retry')).toBe(true);
      expect(store.getStrikeCount(target, branch)).toBe(0);
      store.recordStrike({ reviewId: 'rev-retry', target, branch, reason: 'retry' });
      expect(store.getStrikeCount(target, branch)).toBe(0);
      store.recordStrike({ reviewId: 'rev-new', target, branch, reason: 'fresh' });
      expect(store.getStrikeCount(target, branch)).toBe(1);
    } finally {
      store.close();
    }
  });

  it('backfills legacy strike rows even when the reviews row is missing', () => {
    const projectId = 'p-strike-backfill-missing-review-row';
    const target = 'co/l5-review-gate';
    const branch = 'co/l5-phase-a';
    const raw = openProjectStore(projectId);
    try {
      raw.transaction((tx) => {
        tx.append([
          makeReviewStrikeEvent(projectId, {
            reviewId: 'rev-legacy',
            target,
            branch,
            reason: 'legacy strike',
          }),
        ]);
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        db.prepare('DELETE FROM reviews WHERE target = ? AND branch = ?').run(target, branch);
        db.exec('DROP TABLE review_strikes');
      });
    } finally {
      raw.close();
    }

    const store = openReviewStore(projectId);
    try {
      expect(store.hasStrike(target, branch, 'rev-legacy')).toBe(true);
      expect(store.getStrikeCount(target, branch)).toBe(1);
      store.recordStrike({ reviewId: 'rev-legacy', target, branch, reason: 'retry' });
      expect(store.getStrikeCount(target, branch)).toBe(1);
    } finally {
      store.close();
    }
  });

  it('strike counter is scoped per (target, branch) — different branch is independent', () => {
    const store = openReviewStore('p-strike-scope');
    try {
      store.recordStrike({
        reviewId: 'rev-1',
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        reason: 'b',
      });
      store.recordStrike({
        reviewId: 'rev-2',
        target: 'co/l5-review-gate',
        branch: 'co/l5-phase-a',
        reason: 'b',
      });
      expect(store.getStrikeCount('co/l5-review-gate', 'co/l5-phase-a')).toBe(2);
      expect(store.getStrikeCount('co/l5-review-gate', 'co/l5-phase-b')).toBe(0);
    } finally {
      store.close();
    }
  });
});

// ── AC-L5-4 strike counter replay: PASS reset is replay-equal ────────────────────────────────────
describe('AC-L5-4 — strike counter replay: PASS reset is byte-identical on rebuild', () => {
  function strikeSnapshot(db: DatabaseSync): string {
    return JSON.stringify(
      db.prepare('SELECT target, branch, strikes FROM reviews ORDER BY target, branch').all(),
    );
  }

  it('strikes→PASS→strikes is replay-equal: live == rebuilt (non-vacuous)', () => {
    const store = openProjectStore('p-strike-replay');
    const projectors = [new ReviewProjector()];
    const t = 'co/l5-review-gate';
    // Sequence: strike, strike, PASS (resets), strike — final count must be 1.
    const sequence = [
      makeReviewStrikeEvent('p-strike-replay', {
        reviewId: 'r-1',
        target: t,
        branch: 'co/a',
        reason: 'first',
      }),
      makeReviewStrikeEvent('p-strike-replay', {
        reviewId: 'r-2',
        target: t,
        branch: 'co/a',
        reason: 'second',
      }),
      makeReviewVerdictEvent(
        'p-strike-replay',
        verdict({ reviewId: 'r-pass', branch: 'co/a', verdict: 'PASS' }),
      ),
      makeReviewStrikeEvent('p-strike-replay', {
        reviewId: 'r-3',
        target: t,
        branch: 'co/a',
        reason: 'fresh',
      }),
    ];
    try {
      for (const e of sequence) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, reviewUpcasters, reviewSchemas), projectors);
        });
      }
      const live = store.transaction((tx) => strikeSnapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, reviewUpcasters, reviewSchemas));
      const replayed = store.transaction((tx) => strikeSnapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard: PASS reset 2 strikes to 0, then one fresh strike → final count = 1.
      expect(live).toContain('"strikes":1');
      expect(live).not.toContain('"strikes":2');
      expect(live).not.toContain('"strikes":3');
    } finally {
      store.close();
    }
  });
});

// ── ReviewStore.recordSerialized / activeSerialized / serializedBranches (Phase F, AC-L5-7) ───────
describe('ReviewStore.recordSerialized + activeSerialized (AC-L5-7 plumbing)', () => {
  it('activeSerialized returns undefined for a target with no merge.serialized events', () => {
    const store = openReviewStore('p-ser-zero');
    try {
      expect(store.activeSerialized('co/l5-review-gate')).toBeUndefined();
      expect(store.serializedBranches('co/l5-review-gate')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('an odd write HOLDS the slot; the paired even write RELEASES it (the toggle)', () => {
    const store = openReviewStore('p-ser-toggle');
    try {
      const t = 'co/l5-review-gate';
      store.recordSerialized({ target: t, branch: 'co/a' });
      expect(store.activeSerialized(t)).toBe('co/a');
      store.recordSerialized({ target: t, branch: 'co/a' });
      expect(store.activeSerialized(t)).toBeUndefined();
      store.recordSerialized({ target: t, branch: 'co/b' });
      expect(store.activeSerialized(t)).toBe('co/b');
      // Both branches carry the serialized flag in the read-model (branch order).
      expect(store.serializedBranches(t)).toEqual(['co/a', 'co/b']);
    } finally {
      store.close();
    }
  });

  it('serialization is scoped per target — a different target is independent', () => {
    const store = openReviewStore('p-ser-scope');
    try {
      store.recordSerialized({ target: 'co/t1', branch: 'co/a' });
      store.recordSerialized({ target: 'co/t2', branch: 'co/b' });
      expect(store.activeSerialized('co/t1')).toBe('co/a');
      expect(store.activeSerialized('co/t2')).toBe('co/b');
    } finally {
      store.close();
    }
  });
});

// ── ReviewStore.recordOverride (Phase F, AC-L5-6) ─────────────────────────────────────────────────
describe('ReviewStore.recordOverride (AC-L5-6 plumbing)', () => {
  it('records an audited override; no false PASS is conjured for the branch', () => {
    const rs = openReviewStore('p-override');
    try {
      rs.recordOverride({
        target: 'co/l5-review-gate',
        branch: 'co/c',
        reason: 'operator force-land',
        overriddenBy: 'lead-2',
      });
      // A verdict was never recorded — the override row exists independently (no false PASS).
      expect(rs.getVerdict('co/l5-review-gate', 'co/c')).toBeUndefined();
    } finally {
      rs.close();
    }
  });
});

// ── AC-L5-7 / AC-L5-11 — the merge.serialized toggle replays byte-identical (event-sourced slot) ────
describe('AC-L5-7 — activeSerialized is event-sourced: rebuild preserves the slot', () => {
  it('the toggle fold reaches the same active slot after a full rebuildAll (non-vacuous)', () => {
    const store = openProjectStore('p-ser-replay');
    const projectors = [new ReviewProjector()];
    const t = 'co/l5-review-gate';
    // grant a · release a · grant b ⇒ b holds. (Replaying the same log reaches the same slot.)
    const sequence = [
      makeMergeSerializedEvent('p-ser-replay', { target: t, branch: 'co/a' }),
      makeMergeSerializedEvent('p-ser-replay', { target: t, branch: 'co/a' }),
      makeMergeSerializedEvent('p-ser-replay', { target: t, branch: 'co/b' }),
    ];
    try {
      for (const e of sequence) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, reviewUpcasters, reviewSchemas), projectors);
        });
      }
      // The slot is derived from the event stream (readStream + fold), so it is replay-invariant.
      const live = openReviewStore('p-ser-replay');
      try {
        expect(live.activeSerialized(t)).toBe('co/b');
      } finally {
        live.close();
      }

      // Rebuild the read-model from the log; the read-model `serialized` flag is byte-identical.
      const snap = (db: DatabaseSync): string =>
        JSON.stringify(
          db
            .prepare('SELECT target, branch, serialized FROM reviews ORDER BY target, branch')
            .all(),
        );
      const before = store.transaction((tx) => snap(tx.raw as DatabaseSync));
      rebuildAll(store, projectors, (e) => decode(e, reviewUpcasters, reviewSchemas));
      const after = store.transaction((tx) => snap(tx.raw as DatabaseSync));
      expect(after).toBe(before);
      expect(before).toContain('"serialized":1');
    } finally {
      store.close();
    }
  });
});

// ── Principle 12: the review store writes only program-data, never the repo ──────────────────────
describe('AC-L5-1 — assertRepoPristine holds around the review recorders', () => {
  it('recordVerdict + recordReviewRequested write nothing into the target repo', () => {
    const repo = makeRepo();
    const store = openReviewStore('p-pristine');
    try {
      assertRepoPristine(repo, () => {
        store.recordReviewRequested(request());
        store.recordVerdict(verdict());
      });
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toBeDefined();
      expect(existsSync(join(repo, '.co'))).toBe(false);
    } finally {
      store.close();
    }
  });
});

// ── AC-L5-8 — spec-ref seam: criteria ref + no-locked-spec marker ─────────────────────────────────
describe('AC-L5-8 — specRef is recorded on review.requested + read back on getReviewRequest', () => {
  it('no specRef supplied ⇒ getReviewRequest returns { kind: no-locked-spec }', () => {
    const store = openReviewStore('p-specref-absent');
    try {
      const saved = store.recordReviewRequested(request());
      expect(saved.specRef).toEqual({ kind: 'no-locked-spec' });
      const read = store.getReviewRequest('co/l5-review-gate', 'co/l5-phase-a');
      expect(read?.specRef).toEqual({ kind: 'no-locked-spec' });
      // The literal "<TODO>" must never appear in the rendered marker.
      expect(renderReviewSpecRef(saved.specRef)).not.toContain('<TODO>');
    } finally {
      store.close();
    }
  });

  it('criteria specRef ⇒ getReviewRequest returns { kind: criteria, ref }', () => {
    const store = openReviewStore('p-specref-criteria');
    try {
      const ref = 'docs/specs/2026-06-07-stage-5-7fa7.locked.md#AC-L5-8';
      const saved = store.recordReviewRequested(
        request({ specRefKind: 'criteria', specRefRef: ref }),
      );
      expect(saved.specRef).toEqual({ kind: 'criteria', ref });
      const read = store.getReviewRequest('co/l5-review-gate', 'co/l5-phase-a');
      expect(read?.specRef).toEqual({ kind: 'criteria', ref });
      expect(renderReviewSpecRef(saved.specRef)).toBe(ref);
    } finally {
      store.close();
    }
  });

  it('specRef is independent of verdict — a criteria request alone is not a PASS', () => {
    const store = openReviewStore('p-specref-no-verdict');
    try {
      store.recordReviewRequested(
        request({ specRefKind: 'criteria', specRefRef: 'some/spec.md#AC-1' }),
      );
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

// ── AC-L5-8 / AC-L5-11 — specRef replay: review.requested with specRef replays byte-identical ─────
describe('AC-L5-8 + AC-L5-11 — specRef on review.requested replays byte-identical', () => {
  function specRefSnapshot(db: DatabaseSync): string {
    return JSON.stringify(
      db
        .prepare(
          'SELECT target, branch, scope, spec_ref_kind, spec_ref_ref FROM reviews ORDER BY target, branch',
        )
        .all(),
    );
  }

  it('criteria + no-spec mix: live == rebuilt (non-vacuous, both kinds exercised)', () => {
    const store = openProjectStore('p-specref-replay');
    const projectors = [new ReviewProjector()];
    const sequence = [
      // Branch co/a: request with a criteria ref.
      makeReviewRequestedEvent('p-specref-replay', {
        ...request({ reviewId: 'r-a', branch: 'co/a' }),
        specRefKind: 'criteria',
        specRefRef: 'docs/specs/task.locked.md#AC-L5-8',
      }),
      // Branch co/b: request with no specRef ⇒ no-locked-spec.
      makeReviewRequestedEvent('p-specref-replay', request({ reviewId: 'r-b', branch: 'co/b' })),
      // Add a verdict for co/a so the replay has a multi-event row.
      makeReviewVerdictEvent('p-specref-replay', verdict({ reviewId: 'r-a', branch: 'co/a' })),
    ];
    try {
      for (const e of sequence) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, reviewUpcasters, reviewSchemas), projectors);
        });
      }
      const live = store.transaction((tx) => specRefSnapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, reviewUpcasters, reviewSchemas));
      const replayed = store.transaction((tx) => specRefSnapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against a vacuous pass.
      expect(live).toContain('"spec_ref_kind":"criteria"');
      expect(live).toContain('"spec_ref_ref":"docs/specs/task.locked.md#AC-L5-8"');
      expect(live).toContain('"branch":"co/b"');
      // Branch co/b has null spec_ref_kind (no specRef provided).
      expect(live).not.toContain('<TODO>');
    } finally {
      store.close();
    }
  });
});

describe('ReviewProjector — committed invalid review histories fail on rebuild', () => {
  it('allows exact duplicate same-branch review request events during replay', () => {
    const store = openProjectStore('p-review-replay-idempotent-review-id');
    try {
      store.append([
        makeReviewRequestedEvent(
          'p-review-replay-idempotent-review-id',
          request({ reviewId: 'rev-idempotent-replay', branch: 'co/a' }),
        ),
        makeReviewRequestedEvent(
          'p-review-replay-idempotent-review-id',
          request({ reviewId: 'rev-idempotent-replay', branch: 'co/a' }),
        ),
      ]);

      expect(() =>
        rebuildAll(store, [new ReviewProjector()], (e) =>
          decode(e, reviewUpcasters, reviewSchemas),
        ),
      ).not.toThrow();
    } finally {
      store.close();
    }
  });

  it('treats an exact duplicate request after a verdict as a replay no-op', () => {
    const store = openProjectStore('p-review-replay-idempotent-after-verdict');
    try {
      store.append([
        makeReviewRequestedEvent(
          'p-review-replay-idempotent-after-verdict',
          request({ reviewId: 'rev-idempotent-after-verdict', branch: 'co/a' }),
        ),
        makeReviewVerdictEvent(
          'p-review-replay-idempotent-after-verdict',
          verdict({ reviewId: 'rev-idempotent-after-verdict', branch: 'co/a', verdict: 'PASS' }),
        ),
        makeReviewRequestedEvent(
          'p-review-replay-idempotent-after-verdict',
          request({ reviewId: 'rev-idempotent-after-verdict', branch: 'co/a' }),
        ),
      ]);

      rebuildAll(store, [new ReviewProjector()], (e) => decode(e, reviewUpcasters, reviewSchemas));
      const row = store.transaction(
        (tx) =>
          (tx.raw as DatabaseSync)
            .prepare("SELECT verdict, reviewer FROM reviews WHERE branch = 'co/a'")
            .get() as Record<string, unknown> | undefined,
      );
      expect(row).toEqual({ verdict: 'PASS', reviewer: 'rev-7' });
    } finally {
      store.close();
    }
  });

  it('rejects duplicate reviewIds across committed request events during replay', () => {
    const store = openProjectStore('p-review-replay-duplicate-review-id');
    try {
      store.append([
        makeReviewRequestedEvent(
          'p-review-replay-duplicate-review-id',
          request({ reviewId: 'rev-dup-replay', branch: 'co/a' }),
        ),
        makeReviewRequestedEvent(
          'p-review-replay-duplicate-review-id',
          request({ reviewId: 'rev-dup-replay', branch: 'co/b' }),
        ),
      ]);

      expect(() =>
        rebuildAll(store, [new ReviewProjector()], (e) =>
          decode(e, reviewUpcasters, reviewSchemas),
        ),
      ).toThrow(/duplicate reviewId.*already belongs/i);
    } finally {
      store.close();
    }
  });

  it('rejects a duplicate historical request after a newer request superseded the row', () => {
    const store = openProjectStore('p-review-replay-historical-duplicate');
    try {
      store.append([
        makeReviewRequestedEvent(
          'p-review-replay-historical-duplicate',
          request({ reviewId: 'rev-old-replay', branch: 'co/a' }),
        ),
        makeReviewRequestedEvent(
          'p-review-replay-historical-duplicate',
          request({ reviewId: 'rev-new-replay', branch: 'co/a' }),
        ),
        makeReviewRequestedEvent(
          'p-review-replay-historical-duplicate',
          request({ reviewId: 'rev-old-replay', branch: 'co/a' }),
        ),
      ]);

      expect(() =>
        rebuildAll(store, [new ReviewProjector()], (e) =>
          decode(e, reviewUpcasters, reviewSchemas),
        ),
      ).toThrow(/duplicate reviewId.*conflicts|earlier request event/i);
    } finally {
      store.close();
    }
  });

  it('rejects a stale verdict for an older review request id', () => {
    const store = openProjectStore('p-review-replay-stale-verdict');
    try {
      store.append([
        makeReviewRequestedEvent(
          'p-review-replay-stale-verdict',
          request({ reviewId: 'rev-old', scope: 'pr_merge' }),
        ),
        makeReviewRequestedEvent(
          'p-review-replay-stale-verdict',
          request({ reviewId: 'rev-new', scope: 'pr_merge' }),
        ),
        makeReviewVerdictEvent(
          'p-review-replay-stale-verdict',
          verdict({ reviewId: 'rev-old', scope: 'pr_merge' }),
        ),
      ]);

      expect(() =>
        rebuildAll(store, [new ReviewProjector()], (e) =>
          decode(e, reviewUpcasters, reviewSchemas),
        ),
      ).toThrow(/stale review verdict/i);
    } finally {
      store.close();
    }
  });

  it('rejects a verdict whose scope differs from the latest request scope', () => {
    const store = openProjectStore('p-review-replay-scope-mismatch');
    try {
      store.append([
        makeReviewRequestedEvent(
          'p-review-replay-scope-mismatch',
          request({ reviewId: 'rev-worker', scope: 'worker_merge' }),
        ),
        makeReviewVerdictEvent(
          'p-review-replay-scope-mismatch',
          verdict({ reviewId: 'rev-worker', scope: 'pr_merge' }),
        ),
      ]);

      expect(() =>
        rebuildAll(store, [new ReviewProjector()], (e) =>
          decode(e, reviewUpcasters, reviewSchemas),
        ),
      ).toThrow(/scope.*pr_merge.*worker_merge/i);
    } finally {
      store.close();
    }
  });
});
