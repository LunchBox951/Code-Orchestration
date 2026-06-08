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
import { ReviewProjector } from './review-projector.js';
import { openReviewStore } from './review-store.js';

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
  it('records a PASS verdict and reads it back, structured (per target + branch)', () => {
    const store = openReviewStore('p-verdict');
    try {
      const saved = store.recordVerdict(verdict({ suggestions: [{ summary: 'tidy a comment' }] }));
      expect(saved.verdict).toBe('PASS');
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
      expect(saved.requestedBy).toBe('lead-2');
      expect(saved.requestedTs).toBeGreaterThan(0);
      expect(store.getReviewRequest('co/l5-review-gate', 'co/l5-phase-a')).toEqual(saved);
      // A request alone is NOT a verdict.
      expect(store.getVerdict('co/l5-review-gate', 'co/l5-phase-a')).toBeUndefined();
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
          'SELECT target, branch, review_id, verdict, blockers, suggestions, verification, reviewer, ' +
            'verdict_ts, requested_by, requested_ts, strikes, serialized, overridden, override_reason, ' +
            'override_by FROM reviews ORDER BY target, branch',
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
        reviewId: 'r-b',
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
