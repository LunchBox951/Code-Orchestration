import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_ISSUE_CAPTURED,
  EVENT_ISSUE_DIAGNOSED,
  EVENT_ISSUE_FILED,
  EVENT_ISSUE_SELF_ASSIGNED,
  type IssueCaptured,
  type IssueDestination,
  type IssueDiagnosed,
  type IssueFiled,
  type IssueRecord,
  type IssueSelfAssigned,
  type IssueState,
} from './events.js';

const CREATE_ISSUES_TABLE = `
  CREATE TABLE IF NOT EXISTS issues (
    issue_id         TEXT PRIMARY KEY,
    summary          TEXT NOT NULL,
    detail           TEXT NOT NULL,
    destination      TEXT NOT NULL,
    captured_by      TEXT NOT NULL,
    state            TEXT NOT NULL,
    probable_cause   TEXT,
    diagnosed_by     TEXT,
    filed_by         TEXT,
    approval_seq     INTEGER,
    posted_ref       TEXT,
    assignee         TEXT,
    captured_ts      INTEGER NOT NULL,
    diagnosed_ts     INTEGER,
    filed_ts         INTEGER,
    self_assigned_ts INTEGER
  );
`;

/** Defensive create of the issues read-model table — called on reset/apply AND every read path. */
export function ensureIssuesTables(db: DatabaseSync): void {
  db.exec(CREATE_ISSUES_TABLE);
}

const ISSUE_COLUMNS =
  'issue_id, summary, detail, destination, captured_by, state, probable_cause, diagnosed_by, ' +
  'filed_by, approval_seq, posted_ref, assignee, captured_ts, diagnosed_ts, filed_ts, self_assigned_ts';

/** Map a raw `issues` row to an {@link IssueRecord}. */
export function rowToIssueRecord(row: Record<string, unknown>): IssueRecord {
  return {
    issueId: String(row.issue_id),
    summary: String(row.summary),
    detail: String(row.detail),
    destination: String(row.destination) as IssueDestination,
    capturedBy: String(row.captured_by),
    state: String(row.state) as IssueState,
    ...(row.probable_cause != null ? { probableCause: String(row.probable_cause) } : {}),
    ...(row.diagnosed_by != null ? { diagnosedBy: String(row.diagnosed_by) } : {}),
    ...(row.filed_by != null ? { filedBy: String(row.filed_by) } : {}),
    ...(row.approval_seq != null ? { approvalSeq: Number(row.approval_seq) } : {}),
    ...(row.posted_ref != null ? { postedRef: String(row.posted_ref) } : {}),
    ...(row.assignee != null ? { assignee: String(row.assignee) } : {}),
    capturedTs: Number(row.captured_ts),
    ...(row.diagnosed_ts != null ? { diagnosedTs: Number(row.diagnosed_ts) } : {}),
    ...(row.filed_ts != null ? { filedTs: Number(row.filed_ts) } : {}),
    ...(row.self_assigned_ts != null ? { selfAssignedTs: Number(row.self_assigned_ts) } : {}),
  };
}

/** The issue record for `issueId`, or undefined. */
export function selectIssue(db: DatabaseSync, issueId: string): IssueRecord | undefined {
  ensureIssuesTables(db);
  const row = db.prepare(`SELECT ${ISSUE_COLUMNS} FROM issues WHERE issue_id = ?`).get(issueId);
  return row ? rowToIssueRecord(row as Record<string, unknown>) : undefined;
}

/** All issue records, in stable order: by `captured_ts` then `issue_id` for tie-breaks. */
export function selectAllIssues(db: DatabaseSync): IssueRecord[] {
  const rows = listIssueRows(db);
  return rows.map((r) => rowToIssueRecord(r as Record<string, unknown>));
}

function listIssueRows(db: DatabaseSync): unknown[] {
  ensureIssuesTables(db);
  return db.prepare(`SELECT ${ISSUE_COLUMNS} FROM issues ORDER BY captured_ts, issue_id`).all();
}

/** Normalize a summary for dedup comparison: trim, lower-case, collapse internal whitespace. */
function normalizeSummary(summary: string): string {
  return summary.trim().toLowerCase().replace(/\s+/gu, ' ');
}

/**
 * The `dedup` step of the pipeline (specs-and-issues.md): before capturing or filing, search the
 * existing records for one that already covers this friction — same destination and a
 * normalized-summary match. Pure over the passed records so the tool layer can also run it over a
 * filtered subset. Returns the first match in record order, or `undefined`.
 */
export function findDuplicateIssue(
  existing: readonly IssueRecord[],
  candidate: { readonly summary: string; readonly destination: IssueDestination },
): IssueRecord | undefined {
  const wanted = normalizeSummary(candidate.summary);
  return existing.find(
    (rec) => rec.destination === candidate.destination && normalizeSummary(rec.summary) === wanted,
  );
}

function sameCapture(existing: IssueRecord, rec: IssueCaptured): boolean {
  return (
    existing.summary === rec.summary &&
    existing.detail === rec.detail &&
    existing.destination === rec.destination &&
    existing.capturedBy === rec.capturedBy
  );
}

/**
 * Validate issue lifecycle transitions against the already-folded read model. The pipeline order
 * is enforced here: `captured → diagnosed → filed → self_assigned`. Returns the existing record
 * when the operation is idempotent (no-op); throws on illegal transitions (Principle 9 —
 * loud-fail). Never returns silently for a true mutation.
 */
export function validateIssueTransition(
  db: DatabaseSync,
  type: string,
  payload: IssueCaptured | IssueDiagnosed | IssueFiled | IssueSelfAssigned,
): IssueRecord | undefined {
  const { issueId } = payload;

  if (type === EVENT_ISSUE_CAPTURED) {
    const rec = payload as IssueCaptured;
    const existing = selectIssue(db, issueId);
    if (existing == null) return undefined;
    if (sameCapture(existing, rec)) return existing;
    throw new Error(
      `issues: issue '${issueId}' already exists with different content — refusing conflicting re-capture`,
    );
  }

  if (type === EVENT_ISSUE_DIAGNOSED) {
    const rec = payload as IssueDiagnosed;
    const existing = selectIssue(db, issueId);
    if (existing == null) {
      throw new Error(`issues: cannot diagnose issue '${issueId}' — no captured issue exists`);
    }
    if (existing.state === 'captured') return undefined;
    if (
      existing.probableCause === rec.probableCause &&
      existing.diagnosedBy === rec.diagnosedBy &&
      existing.state === 'diagnosed'
    ) {
      return existing;
    }
    if (existing.state === 'diagnosed') {
      throw new Error(
        `issues: issue '${issueId}' already has a different diagnosis — refusing conflicting re-diagnosis`,
      );
    }
    throw new Error(
      `issues: cannot diagnose issue '${issueId}' in state '${existing.state}' — it is already filed`,
    );
  }

  if (type === EVENT_ISSUE_FILED) {
    const rec = payload as IssueFiled;
    const existing = selectIssue(db, issueId);
    if (existing == null) {
      throw new Error(`issues: cannot file issue '${issueId}' — no captured issue exists`);
    }
    if (existing.state === 'captured') {
      throw new Error(
        `issues: cannot file issue '${issueId}' — it must be diagnosed before filing ` +
          '(the pipeline is detect → diagnose → dedup → file)',
      );
    }
    if (existing.state === 'diagnosed') return undefined;
    if (
      existing.postedRef === rec.postedRef &&
      existing.filedBy === rec.filedBy &&
      existing.approvalSeq === rec.approvalSeq
    ) {
      return existing;
    }
    throw new Error(
      `issues: issue '${issueId}' is already filed at '${existing.postedRef}' — refusing conflicting re-filing`,
    );
  }

  if (type === EVENT_ISSUE_SELF_ASSIGNED) {
    const rec = payload as IssueSelfAssigned;
    const existing = selectIssue(db, issueId);
    if (existing == null) {
      throw new Error(`issues: cannot self-assign issue '${issueId}' — no captured issue exists`);
    }
    if (existing.state === 'filed') return undefined;
    if (existing.state === 'self_assigned') {
      if (existing.assignee === rec.assignee) return existing;
      throw new Error(
        `issues: issue '${issueId}' is already self-assigned to '${existing.assignee}' — ` +
          `refusing re-assign to '${rec.assignee}'`,
      );
    }
    throw new Error(
      `issues: cannot self-assign issue '${issueId}' in state '${existing.state}' — only a filed ` +
        'issue can be self-assigned',
    );
  }

  throw new Error(`issues: unknown event type '${type}'`);
}

interface IssueCapturedEvent extends StoredEvent {
  readonly type: typeof EVENT_ISSUE_CAPTURED;
  readonly payload: IssueCaptured;
}
interface IssueDiagnosedEvent extends StoredEvent {
  readonly type: typeof EVENT_ISSUE_DIAGNOSED;
  readonly payload: IssueDiagnosed;
}
interface IssueFiledEvent extends StoredEvent {
  readonly type: typeof EVENT_ISSUE_FILED;
  readonly payload: IssueFiled;
}
interface IssueSelfAssignedEvent extends StoredEvent {
  readonly type: typeof EVENT_ISSUE_SELF_ASSIGNED;
  readonly payload: IssueSelfAssigned;
}
type IssueEvent =
  | IssueCapturedEvent
  | IssueDiagnosedEvent
  | IssueFiledEvent
  | IssueSelfAssignedEvent;

/**
 * Folds issue events into the `issues` read-model. Enforces the pipeline lifecycle
 * `captured → diagnosed → filed → self_assigned` with loud-fail on illegal transitions
 * (Principle 9). `event.ts` is used for all timestamps (never wall-clock — freeze #6).
 */
export class IssuesProjector implements Projector {
  readonly name = 'issues';

  handles(type: string): boolean {
    return (
      type === EVENT_ISSUE_CAPTURED ||
      type === EVENT_ISSUE_DIAGNOSED ||
      type === EVENT_ISSUE_FILED ||
      type === EVENT_ISSUE_SELF_ASSIGNED
    );
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureIssuesTables(db);
    db.exec('DELETE FROM issues');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureIssuesTables(db);
    const issueEvent = event as IssueEvent;
    const type = issueEvent.type;
    switch (type) {
      case EVENT_ISSUE_CAPTURED: {
        const { issueId, summary, detail, destination, capturedBy } = issueEvent.payload;
        const existing = validateIssueTransition(db, type, issueEvent.payload);
        if (existing != null) return;
        db.prepare(
          `INSERT INTO issues (issue_id, summary, detail, destination, captured_by, state, captured_ts)
           VALUES (?, ?, ?, ?, ?, 'captured', ?)`,
        ).run(issueId, summary, detail, destination, capturedBy, event.ts);
        return;
      }
      case EVENT_ISSUE_DIAGNOSED: {
        const { issueId, probableCause, diagnosedBy } = issueEvent.payload;
        const existing = validateIssueTransition(db, type, issueEvent.payload);
        if (existing != null) return;
        db.prepare(
          `UPDATE issues SET state = 'diagnosed', probable_cause = ?, diagnosed_by = ?,
           diagnosed_ts = ? WHERE issue_id = ?`,
        ).run(probableCause, diagnosedBy, event.ts, issueId);
        return;
      }
      case EVENT_ISSUE_FILED: {
        const { issueId, filedBy, approvalSeq, postedRef } = issueEvent.payload;
        const existing = validateIssueTransition(db, type, issueEvent.payload);
        if (existing != null) return;
        db.prepare(
          `UPDATE issues SET state = 'filed', filed_by = ?, approval_seq = ?, posted_ref = ?,
           filed_ts = ? WHERE issue_id = ?`,
        ).run(filedBy, approvalSeq, postedRef, event.ts, issueId);
        return;
      }
      case EVENT_ISSUE_SELF_ASSIGNED: {
        const { issueId, assignee } = issueEvent.payload;
        const existing = validateIssueTransition(db, type, issueEvent.payload);
        if (existing != null) return;
        db.prepare(
          `UPDATE issues SET state = 'self_assigned', assignee = ?, self_assigned_ts = ?
           WHERE issue_id = ?`,
        ).run(assignee, event.ts, issueId);
        return;
      }
      default:
        return assertNever(type);
    }
  }
}
