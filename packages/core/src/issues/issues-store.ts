/**
 * The L6b G durable issue record store. Opens the PROJECT store, wires the
 * {@link IssuesProjector}, and exposes a typed {@link IssueStore} facade.
 *
 * L6b note: this layer builds the record + projection + store only; the opt-in gates, scrubbing,
 * and the per-post outward approval gate live in `opt-in.ts` / `scrub.ts` / `filing.ts`, and the
 * production MCP verbs in `tools/specs/` call this facade after those checks pass. Tests may still
 * populate directly via the `record*` methods.
 */
import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import {
  EVENT_ISSUE_CAPTURED,
  EVENT_ISSUE_DIAGNOSED,
  EVENT_ISSUE_FILED,
  EVENT_ISSUE_SELF_ASSIGNED,
  issuesSchemas,
  issuesUpcasters,
  makeIssueCapturedEvent,
  makeIssueDiagnosedEvent,
  makeIssueFiledEvent,
  makeIssueSelfAssignedEvent,
  type IssueCaptured,
  type IssueDestination,
  type IssueDiagnosed,
  type IssueFiled,
  type IssueRecord,
  type IssueSelfAssigned,
} from './events.js';
import {
  IssuesProjector,
  ensureIssuesTables,
  findDuplicateIssue,
  selectAllIssues,
  selectIssue,
  validateIssueTransition,
} from './issues-projector.js';

export interface IssueStore {
  /** Record a friction capture (append `issue.captured` + fold); returns the read-back record. */
  recordCapture(rec: IssueCaptured): IssueRecord;
  /** Record a probable-cause diagnosis (append `issue.diagnosed` + fold). */
  recordDiagnosis(rec: IssueDiagnosed): IssueRecord;
  /** Record an outward filing (append `issue.filed` + fold) — call ONLY behind the approval gate. */
  recordFiling(rec: IssueFiled): IssueRecord;
  /** Record an owner-mode self-assign (append `issue.self_assigned` + fold). */
  recordSelfAssign(rec: IssueSelfAssigned): IssueRecord;
  /** The issue record for `issueId`, or undefined. */
  getIssue(issueId: string): IssueRecord | undefined;
  /** Every recorded issue, in stable order (by captured_ts then issue_id). */
  listIssues(): readonly IssueRecord[];
  /** The dedup step: an existing record covering this friction, or undefined. */
  findDuplicate(candidate: {
    readonly summary: string;
    readonly destination: IssueDestination;
  }): IssueRecord | undefined;
  /** Close the underlying project store. */
  close(): void;
}

/**
 * Open the project issue store: open the PROJECT store, wire the {@link IssuesProjector}, and
 * return the {@link IssueStore} facade. Safe alongside other stores on the same per-project
 * `store.db` — the issue store owns distinct scopes (`issue:`) and a distinct read-model table
 * (`issues`).
 */
export function openIssueStore(projectId: string): IssueStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new IssuesProjector()];

  /** Shared append-validate-fold-read-back recipe for all four write verbs. */
  function record(
    type: string,
    payload: IssueCaptured | IssueDiagnosed | IssueFiled | IssueSelfAssigned,
    build: () => ReturnType<typeof makeIssueCapturedEvent>,
    verb: string,
  ): IssueRecord {
    return store.transaction((tx) => {
      const db = tx.raw as DatabaseSync;
      ensureIssuesTables(db);
      const existing = validateIssueTransition(db, type, payload);
      if (existing != null) return existing;
      const [stored] = tx.append([build()]);
      applyEvent(tx, decode(stored!, issuesUpcasters, issuesSchemas), projectors);
      const row = selectIssue(db, payload.issueId);
      if (!row) {
        throw new Error(
          `openIssueStore.${verb}: row missing after projection (issueId='${payload.issueId}')`,
        );
      }
      return row;
    });
  }

  return {
    recordCapture(rec: IssueCaptured): IssueRecord {
      return record(
        EVENT_ISSUE_CAPTURED,
        rec,
        () => makeIssueCapturedEvent(projectId, rec),
        'recordCapture',
      );
    },

    recordDiagnosis(rec: IssueDiagnosed): IssueRecord {
      return record(
        EVENT_ISSUE_DIAGNOSED,
        rec,
        () => makeIssueDiagnosedEvent(projectId, rec),
        'recordDiagnosis',
      );
    },

    recordFiling(rec: IssueFiled): IssueRecord {
      return record(
        EVENT_ISSUE_FILED,
        rec,
        () => makeIssueFiledEvent(projectId, rec),
        'recordFiling',
      );
    },

    recordSelfAssign(rec: IssueSelfAssigned): IssueRecord {
      return record(
        EVENT_ISSUE_SELF_ASSIGNED,
        rec,
        () => makeIssueSelfAssignedEvent(projectId, rec),
        'recordSelfAssign',
      );
    },

    getIssue(issueId: string): IssueRecord | undefined {
      return store.transaction((tx) => selectIssue(tx.raw as DatabaseSync, issueId));
    },

    listIssues(): readonly IssueRecord[] {
      return store.transaction((tx) => selectAllIssues(tx.raw as DatabaseSync));
    },

    findDuplicate(candidate): IssueRecord | undefined {
      return store.transaction((tx) =>
        findDuplicateIssue(selectAllIssues(tx.raw as DatabaseSync), candidate),
      );
    },

    close(): void {
      store.close();
    },
  };
}
