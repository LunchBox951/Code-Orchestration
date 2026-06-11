import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { applyEvent, rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import { assertRepoPristine } from '../config/pristine.js';
import {
  makeIssueCapturedEvent,
  makeIssueDiagnosedEvent,
  makeIssueFiledEvent,
  issuesSchemas,
  issuesUpcasters,
} from './events.js';
import { IssuesProjector, findDuplicateIssue } from './issues-projector.js';
import { openIssueStore } from './issues-store.js';

// L6b G — durable issue records: detect → diagnose → dedup → file lifecycle, replay-equal,
// loud-fail on illegal transitions (AC-L6b-G1).

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-issues-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of [...dataDirs, ...repoDirs]) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-issues-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

const CAPTURE = {
  issueId: 'iss-1',
  summary: 'finish tool no-ops on stalled review',
  detail: 'co_finish returned success but no worker_done mail was emitted.',
  destination: 'co' as const,
  capturedBy: 'lead-7',
};

function snapshot(db: DatabaseSync): string {
  const rows = db
    .prepare(
      'SELECT issue_id, state, destination, posted_ref, captured_ts, diagnosed_ts, filed_ts ' +
        'FROM issues ORDER BY captured_ts, issue_id',
    )
    .all();
  return JSON.stringify(rows);
}

describe('IssueStore — capture → diagnose → file roundtrip', () => {
  it('records the full pipeline in sequence', () => {
    const store = openIssueStore('p-issues-roundtrip');
    try {
      const captured = store.recordCapture(CAPTURE);
      expect(captured.issueId).toBe('iss-1');
      expect(captured.summary).toBe(CAPTURE.summary);
      expect(captured.detail).toBe(CAPTURE.detail);
      expect(captured.destination).toBe('co');
      expect(captured.capturedBy).toBe('lead-7');
      expect(captured.state).toBe('captured');
      expect(captured.capturedTs).toBeGreaterThan(0);
      expect(captured.diagnosedTs).toBeUndefined();
      expect(captured.filedTs).toBeUndefined();

      const diagnosed = store.recordDiagnosis({
        issueId: 'iss-1',
        probableCause: 'review-finalize deletes its own cwd, so the success path exits non-zero',
        diagnosedBy: 'res-diag-1',
      });
      expect(diagnosed.state).toBe('diagnosed');
      expect(diagnosed.probableCause).toMatch(/deletes its own cwd/);
      expect(diagnosed.diagnosedBy).toBe('res-diag-1');
      expect(diagnosed.diagnosedTs).toBeGreaterThan(0);

      const filed = store.recordFiling({
        issueId: 'iss-1',
        filedBy: 'coord-1',
        approvalSeq: 42,
        postedRef: 'https://github.com/acme/co/issues/7',
      });
      expect(filed.state).toBe('filed');
      expect(filed.filedBy).toBe('coord-1');
      expect(filed.approvalSeq).toBe(42);
      expect(filed.postedRef).toBe('https://github.com/acme/co/issues/7');
      expect(filed.filedTs).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('getIssue returns the record and undefined for absent', () => {
    const store = openIssueStore('p-issues-get');
    try {
      store.recordCapture(CAPTURE);
      expect(store.getIssue('iss-1')?.issueId).toBe('iss-1');
      expect(store.getIssue('ghost')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('listIssues returns all issues in captured_ts order', () => {
    const store = openIssueStore('p-issues-list');
    try {
      store.recordCapture(CAPTURE);
      store.recordCapture({ ...CAPTURE, issueId: 'iss-2', summary: 'another friction point' });
      const list = store.listIssues();
      expect(list).toHaveLength(2);
      expect(list[0]?.issueId).toBe('iss-1');
      expect(list[1]?.issueId).toBe('iss-2');
    } finally {
      store.close();
    }
  });

  it('records an owner-mode self-assign after filing', () => {
    const store = openIssueStore('p-issues-self-assign');
    try {
      store.recordCapture(CAPTURE);
      store.recordDiagnosis({ issueId: 'iss-1', probableCause: 'x', diagnosedBy: 'r' });
      store.recordFiling({ issueId: 'iss-1', filedBy: 'c', approvalSeq: 1, postedRef: 'url' });
      const assigned = store.recordSelfAssign({ issueId: 'iss-1', assignee: 'coord-1' });
      expect(assigned.state).toBe('self_assigned');
      expect(assigned.assignee).toBe('coord-1');
      expect(assigned.selfAssignedTs).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});

describe('IssueStore — idempotent re-assert', () => {
  it('idempotent re-capture (byte-identical) returns existing without error', () => {
    const store = openIssueStore('p-issues-idem-capture');
    try {
      const first = store.recordCapture(CAPTURE);
      const second = store.recordCapture(CAPTURE);
      expect(second.capturedTs).toBe(first.capturedTs);
      expect(store.listIssues()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('idempotent re-diagnosis and re-filing return existing without error', () => {
    const store = openIssueStore('p-issues-idem-rest');
    try {
      store.recordCapture(CAPTURE);
      const diag = { issueId: 'iss-1', probableCause: 'x', diagnosedBy: 'r' };
      const d1 = store.recordDiagnosis(diag);
      const d2 = store.recordDiagnosis(diag);
      expect(d2.diagnosedTs).toBe(d1.diagnosedTs);
      const file = { issueId: 'iss-1', filedBy: 'c', approvalSeq: 9, postedRef: 'url' };
      const f1 = store.recordFiling(file);
      const f2 = store.recordFiling(file);
      expect(f2.filedTs).toBe(f1.filedTs);
    } finally {
      store.close();
    }
  });
});

describe('IssueStore — loud-fail on illegal transitions', () => {
  it('conflicting re-capture throws', () => {
    const store = openIssueStore('p-issues-conflict-capture');
    try {
      store.recordCapture(CAPTURE);
      expect(() => store.recordCapture({ ...CAPTURE, detail: 'different detail' })).toThrow(
        /conflicting re-capture/i,
      );
    } finally {
      store.close();
    }
  });

  it('diagnosing an absent issue throws', () => {
    const store = openIssueStore('p-issues-diag-absent');
    try {
      expect(() =>
        store.recordDiagnosis({ issueId: 'ghost', probableCause: 'x', diagnosedBy: 'r' }),
      ).toThrow(/no captured issue/i);
    } finally {
      store.close();
    }
  });

  it('filing an undiagnosed issue throws (diagnose precedes file)', () => {
    const store = openIssueStore('p-issues-file-undiagnosed');
    try {
      store.recordCapture(CAPTURE);
      expect(() =>
        store.recordFiling({ issueId: 'iss-1', filedBy: 'c', approvalSeq: 1, postedRef: 'url' }),
      ).toThrow(/diagnos/i);
    } finally {
      store.close();
    }
  });

  it('conflicting re-diagnosis throws', () => {
    const store = openIssueStore('p-issues-conflict-diag');
    try {
      store.recordCapture(CAPTURE);
      store.recordDiagnosis({ issueId: 'iss-1', probableCause: 'x', diagnosedBy: 'r' });
      expect(() =>
        store.recordDiagnosis({ issueId: 'iss-1', probableCause: 'y', diagnosedBy: 'r' }),
      ).toThrow(/conflicting re-diagnosis/i);
    } finally {
      store.close();
    }
  });

  it('conflicting re-filing throws', () => {
    const store = openIssueStore('p-issues-conflict-file');
    try {
      store.recordCapture(CAPTURE);
      store.recordDiagnosis({ issueId: 'iss-1', probableCause: 'x', diagnosedBy: 'r' });
      store.recordFiling({ issueId: 'iss-1', filedBy: 'c', approvalSeq: 1, postedRef: 'url-a' });
      expect(() =>
        store.recordFiling({ issueId: 'iss-1', filedBy: 'c', approvalSeq: 1, postedRef: 'url-b' }),
      ).toThrow(/conflicting re-filing/i);
    } finally {
      store.close();
    }
  });

  it('self-assigning an unfiled issue throws (file precedes self-assign)', () => {
    const store = openIssueStore('p-issues-assign-unfiled');
    try {
      store.recordCapture(CAPTURE);
      expect(() => store.recordSelfAssign({ issueId: 'iss-1', assignee: 'coord-1' })).toThrow(
        /filed/i,
      );
    } finally {
      store.close();
    }
  });
});

describe('findDuplicateIssue — the dedup step', () => {
  it('matches an existing issue by normalized summary + destination', () => {
    const store = openIssueStore('p-issues-dedup');
    try {
      store.recordCapture(CAPTURE);
      const existing = store.listIssues();
      const dup = findDuplicateIssue(existing, {
        summary: '  Finish tool   NO-OPS on stalled review ',
        destination: 'co',
      });
      expect(dup?.issueId).toBe('iss-1');
    } finally {
      store.close();
    }
  });

  it('does not match a different destination or different summary', () => {
    const store = openIssueStore('p-issues-dedup-miss');
    try {
      store.recordCapture(CAPTURE);
      const existing = store.listIssues();
      expect(
        findDuplicateIssue(existing, { summary: CAPTURE.summary, destination: 'target' }),
      ).toBeUndefined();
      expect(
        findDuplicateIssue(existing, { summary: 'something else', destination: 'co' }),
      ).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe('IssueStore — replay-equal: live fold → rebuildAll → byte-equal', () => {
  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous)', () => {
    const store = openProjectStore('p-issues-replay');
    const projectors = [new IssuesProjector()];
    const events = [
      makeIssueCapturedEvent('p-issues-replay', CAPTURE),
      makeIssueDiagnosedEvent('p-issues-replay', {
        issueId: 'iss-1',
        probableCause: 'x',
        diagnosedBy: 'r',
      }),
      makeIssueFiledEvent('p-issues-replay', {
        issueId: 'iss-1',
        filedBy: 'c',
        approvalSeq: 3,
        postedRef: 'https://github.com/acme/co/issues/9',
      }),
      makeIssueCapturedEvent('p-issues-replay', {
        ...CAPTURE,
        issueId: 'iss-2',
        summary: 'second friction',
        destination: 'target',
      }),
    ];
    try {
      for (const e of events) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, issuesUpcasters, issuesSchemas), projectors);
        });
      }

      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, issuesUpcasters, issuesSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      expect(live).toContain('"iss-1"');
      expect(live).toContain('"filed"');
      expect(live).toContain('issues/9');
    } finally {
      store.close();
    }
  });

  it('replay fails loud on an out-of-order pipeline (file before diagnose)', () => {
    const store = openProjectStore('p-issues-replay-order');
    const events = [
      makeIssueCapturedEvent('p-issues-replay-order', CAPTURE),
      makeIssueFiledEvent('p-issues-replay-order', {
        issueId: 'iss-1',
        filedBy: 'c',
        approvalSeq: 1,
        postedRef: 'url',
      }),
    ];
    try {
      store.append(events);
      expect(() =>
        rebuildAll(store, [new IssuesProjector()], (e) =>
          decode(e, issuesUpcasters, issuesSchemas),
        ),
      ).toThrow(/diagnos/i);
    } finally {
      store.close();
    }
  });
});

describe('IssueStore — pristine-repo round-trip', () => {
  it('a full record + read round-trip leaves the repo byte-identical', () => {
    const repoDir = makeRepo();
    assertRepoPristine(repoDir, () => {
      const store = openIssueStore('p-issues-pristine');
      try {
        store.recordCapture(CAPTURE);
        store.recordDiagnosis({ issueId: 'iss-1', probableCause: 'x', diagnosedBy: 'r' });
        expect(store.getIssue('iss-1')).not.toBeUndefined();
        expect(store.listIssues()).toHaveLength(1);
      } finally {
        store.close();
      }
    });
  });
});
