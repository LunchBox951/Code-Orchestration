/**
 * L6b G event definitions for the durable issue record — bottom-up agent friction flowing up as
 * signal (specs-and-issues.md §"Issues"). Lives in the PROJECT store; pure ORCHESTRATION state in
 * program-data only (Principle 12 — pristine-repo).
 *
 * One stream per issue, keyed by the `issue:<issueId>` scope pattern. Four event types model the
 * `detect → diagnose → dedup → file → (opt-in) self-assign` pipeline:
 *
 *   - `issue.captured`      — an agent detected friction (local capture; the dedup step is a read
 *                             over existing records, not an event).
 *   - `issue.diagnosed`     — a `researcher:diagnostic` produced a probable-cause report.
 *   - `issue.filed`         — the issue was posted outward (GitHub) AFTER a recorded per-post
 *                             approval; the payload carries the approval mail seq + the posted ref
 *                             so the audit trail is replayable.
 *   - `issue.self_assigned` — the opt-in, owner-only self-heal step: a filed issue is taken on as
 *                             work. At L6b this is the durable record only; turning it into a live
 *                             task ride's L7's Conductor.
 *
 * This layer defines the durable payloads; the opt-in gates, scrubbing, and the outward approval
 * gate live in `opt-in.ts` / `scrub.ts` / `filing.ts`, and the MCP verbs in `tools/specs/`.
 */
import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';

/** Current payload schema version — v1; no upcasters yet. */
export const ISSUES_EVENT_V = 1;

/** An agent captured a friction point (the `detect` step). */
export const EVENT_ISSUE_CAPTURED = 'issue.captured' as const;

/** A diagnostic researcher recorded a probable-cause report (the `diagnose` step). */
export const EVENT_ISSUE_DIAGNOSED = 'issue.diagnosed' as const;

/** The issue was filed outward under a recorded per-post approval (the `file` step). */
export const EVENT_ISSUE_FILED = 'issue.filed' as const;

/** A filed issue was self-assigned (opt-in, owner-only self-heal loop). */
export const EVENT_ISSUE_SELF_ASSIGNED = 'issue.self_assigned' as const;

/** Scope prefix for the per-issue event stream; suffix is the issue id. */
export const ISSUE_SCOPE_PREFIX = 'issue:';

/** The per-issue stream scope: `issue:<issueId>`. */
export function issueScope(issueId: string): string {
  return ISSUE_SCOPE_PREFIX + issueId;
}

/**
 * Where the issue belongs (specs-and-issues.md §"Two friction types → two destinations"):
 * `target` = a real bug in the repo being worked on → that repo's issues;
 * `co` = friction with `co` itself → the `co` project's repo.
 */
export const ISSUE_DESTINATIONS = ['target', 'co'] as const;
export type IssueDestination = (typeof ISSUE_DESTINATIONS)[number];

/** The `issue.captured` payload. */
export const issueCapturedSchema = z
  .object({
    issueId: z.string().min(1),
    summary: z.string().min(1),
    detail: z.string(),
    destination: z.enum(ISSUE_DESTINATIONS),
    capturedBy: z.string().min(1),
  })
  .strict();
export type IssueCaptured = z.infer<typeof issueCapturedSchema>;

/** The `issue.diagnosed` payload. */
export const issueDiagnosedSchema = z
  .object({
    issueId: z.string().min(1),
    probableCause: z.string().min(1),
    diagnosedBy: z.string().min(1),
  })
  .strict();
export type IssueDiagnosed = z.infer<typeof issueDiagnosedSchema>;

/** The `issue.filed` payload — `approvalSeq` is the per-post approval mail's store seq (audit). */
export const issueFiledSchema = z
  .object({
    issueId: z.string().min(1),
    filedBy: z.string().min(1),
    approvalSeq: z.number().int().nonnegative(),
    postedRef: z.string().min(1),
  })
  .strict();
export type IssueFiled = z.infer<typeof issueFiledSchema>;

/** The `issue.self_assigned` payload. */
export const issueSelfAssignedSchema = z
  .object({
    issueId: z.string().min(1),
    assignee: z.string().min(1),
  })
  .strict();
export type IssueSelfAssigned = z.infer<typeof issueSelfAssignedSchema>;

/** Current-version schema map for issue events — validated on append AND on read (decode). */
export const issuesSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_ISSUE_CAPTURED, issueCapturedSchema],
  [EVENT_ISSUE_DIAGNOSED, issueDiagnosedSchema],
  [EVENT_ISSUE_FILED, issueFiledSchema],
  [EVENT_ISSUE_SELF_ASSIGNED, issueSelfAssignedSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const issuesUpcasters: UpcasterRegistry = new Map();

/** Build + validate an `issue.captured` NewEvent. The capturer is the event `actor`. */
export function makeIssueCapturedEvent(projectId: string, rec: IssueCaptured): NewEvent {
  const payload = issueCapturedSchema.parse(rec);
  return {
    projectId,
    scope: issueScope(payload.issueId),
    type: EVENT_ISSUE_CAPTURED,
    v: ISSUES_EVENT_V,
    payload,
    actor: payload.capturedBy,
  };
}

/** Build + validate an `issue.diagnosed` NewEvent. The diagnosing researcher is the `actor`. */
export function makeIssueDiagnosedEvent(projectId: string, rec: IssueDiagnosed): NewEvent {
  const payload = issueDiagnosedSchema.parse(rec);
  return {
    projectId,
    scope: issueScope(payload.issueId),
    type: EVENT_ISSUE_DIAGNOSED,
    v: ISSUES_EVENT_V,
    payload,
    actor: payload.diagnosedBy,
  };
}

/** Build + validate an `issue.filed` NewEvent. The filing agent is the `actor`. */
export function makeIssueFiledEvent(projectId: string, rec: IssueFiled): NewEvent {
  const payload = issueFiledSchema.parse(rec);
  return {
    projectId,
    scope: issueScope(payload.issueId),
    type: EVENT_ISSUE_FILED,
    v: ISSUES_EVENT_V,
    payload,
    actor: payload.filedBy,
  };
}

/** Build + validate an `issue.self_assigned` NewEvent. The assignee is the `actor`. */
export function makeIssueSelfAssignedEvent(projectId: string, rec: IssueSelfAssigned): NewEvent {
  const payload = issueSelfAssignedSchema.parse(rec);
  return {
    projectId,
    scope: issueScope(payload.issueId),
    type: EVENT_ISSUE_SELF_ASSIGNED,
    v: ISSUES_EVENT_V,
    payload,
    actor: payload.assignee,
  };
}

/** The issue lifecycle states, in pipeline order. */
export type IssueState = 'captured' | 'diagnosed' | 'filed' | 'self_assigned';

/**
 * A persisted, read-back issue record — the read-model shape the issue store facade returns.
 * Timestamps come from `event.ts` on replay (freeze #6 — never wall-clock).
 */
export interface IssueRecord {
  readonly issueId: string;
  readonly summary: string;
  readonly detail: string;
  readonly destination: IssueDestination;
  readonly capturedBy: string;
  readonly state: IssueState;
  readonly probableCause?: string;
  readonly diagnosedBy?: string;
  readonly filedBy?: string;
  readonly approvalSeq?: number;
  readonly postedRef?: string;
  readonly assignee?: string;
  readonly capturedTs: number;
  readonly diagnosedTs?: number;
  readonly filedTs?: number;
  readonly selfAssignedTs?: number;
}
