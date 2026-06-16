/**
 * Stage 13 R-A — the daemon-side resolver behind the `reviewContext` operator-IPC method.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * Resolves everything the in-app Review view needs for a pending HUMAN review: the unified diff, the
 * acceptance criteria (or the explicit no-locked-spec marker), and the branch/target/scope refs. This
 * is the only real logic behind the operator-IPC `reviewContext` round-trip — host.ts wires the
 * production store openers + the real `git diff` reader through it; server.ts/client.ts ship the
 * {@link import('@co/core').ReviewContext} result across the app→daemon socket. It lives in its own
 * small, headless-testable module so host.ts stays thin.
 *
 * ALL READS — appends NO events and defines NO event types. It only calls existing read methods
 * (`getReviewRequestById`, `getSpec`, `getWorktree`) + a read-only `git diff`. Every failure mode
 * DEGRADES to a NAMED state (Principle 9 — never blank/throw to the view): `not-found`,
 * `diff:unavailable{reason}`, `criteria:no-locked-spec`. Each store is opened PER CALL and closed
 * before the next read (mirrors the server's `openMail` per-write pattern — no leaked handles).
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { createHash } from 'node:crypto';
import {
  type GitReader,
  taskIdFromLockedSpecRef,
  type ReviewContext,
  type ReviewCriteria,
  type ReviewDiff,
  type ReviewRequestRecord,
  type ReviewSpecRef,
  type FinishRecord,
  type ReviewStore,
  type SpecStore,
  type WorktreeRecord,
  type WorktreeStore,
} from '@co/core';

/** The injected store openers + the read git seam, so the resolver is headless-testable. */
export interface ReviewContextDeps {
  /** Open the review store for one read, then `close()` it. Needs only `getReviewRequestById`. */
  readonly openReviews: () => Pick<ReviewStore, 'getReviewRequestById' | 'close'>;
  /** Open the spec store for one read, then `close()` it. Needs only `getSpec`. */
  readonly openSpecs: () => Pick<SpecStore, 'getSpec' | 'close'>;
  /** Open the worktree store for one read, then `close()` it. Needs worktree + finish evidence. */
  readonly openWorktrees: () => Pick<WorktreeStore, 'getWorktree' | 'getFinish' | 'close'>;
  /** The READ git seam: `(cwd, args) => stdout | null` (null on a non-zero exit). NEVER `GitExec`. */
  readonly gitReader: GitReader; // (cwd, args) => string | null
}

/**
 * Resolve `reviewId`'s review context. See the module header for the degrade discipline.
 *
 * Recipe: the durable request (→ branch/target/scope ⊕ specRef) ⊕ a criteria half (the locked spec's
 * criteria, else the explicit no-locked-spec marker) ⊕ a diff half (`git diff target...branch` in the
 * recorded worktree, else a named unavailable reason). Async because the operator-IPC wire is async;
 * the reads themselves are synchronous.
 */
export async function resolveReviewContext(
  deps: ReviewContextDeps,
  reviewId: string,
): Promise<ReviewContext> {
  const req = readReviewRequest(deps, reviewId);
  if (req == null) return { kind: 'not-found', reviewId };
  const criteria = resolveCriteria(deps, req.specRef);
  const evidence = resolveWorktreeEvidence(deps, req.branch, req.target);
  return {
    kind: 'resolved',
    reviewId,
    evidenceFingerprint: reviewEvidenceFingerprint({
      reviewId,
      branch: req.branch,
      target: req.target,
      scope: req.scope,
      diff: evidence.diff,
      criteria,
      finish: evidence.finish,
    }),
    branch: req.branch,
    target: req.target,
    scope: req.scope,
    diff: evidence.diff,
    criteria,
  };
}

/** Read the durable review request (open→read→close); undefined when `reviewId` is unknown. */
function readReviewRequest(
  deps: ReviewContextDeps,
  reviewId: string,
): ReviewRequestRecord | undefined {
  const reviews = deps.openReviews();
  try {
    return reviews.getReviewRequestById(reviewId);
  } finally {
    reviews.close();
  }
}

/**
 * The criteria half. A `no-locked-spec` request ref surfaces the explicit marker directly. A `criteria`
 * ref is `spec:<taskId>#locked`: parse the taskId out robustly, read the locked spec record, and pass
 * its criteria through. A ref whose record is gone degrades to the explicit no-locked-spec marker
 * (never throws — Principle 9). An empty criteria array on a present record is still "criteria".
 */
function resolveCriteria(deps: ReviewContextDeps, specRef: ReviewSpecRef): ReviewCriteria {
  if (specRef.kind === 'no-locked-spec') return { kind: 'no-locked-spec' };
  const taskId = taskIdFromLockedSpecRef(specRef.ref);
  if (taskId == null) return { kind: 'no-locked-spec' };
  const specs = deps.openSpecs();
  try {
    const spec = specs.getSpec(taskId);
    if (spec == null || spec.state !== 'locked') return { kind: 'no-locked-spec' };
    return { kind: 'criteria', specRef: specRef.ref, criteria: spec.criteria };
  } finally {
    specs.close();
  }
}

/**
 * The diff half. No recorded (or `removed`) worktree ⇒ `worktree-missing`. Else `git diff
 * target...branch` in the recorded sandbox with external diff/color disabled: a non-zero git exit
 * (`gitReader` → null) ⇒ `git-failed`; otherwise the patch text — an empty string is VALID ("no
 * changes"), NOT unavailable.
 */
function resolveWorktreeEvidence(
  deps: ReviewContextDeps,
  branch: string,
  target: string,
): { readonly diff: ReviewDiff; readonly finish: FinishRecord | undefined } {
  const worktrees = deps.openWorktrees();
  let wt: WorktreeRecord | undefined;
  let finish: FinishRecord | undefined;
  try {
    wt = worktrees.getWorktree(branch);
    finish = worktrees.getFinish(branch);
  } finally {
    worktrees.close();
  }
  if (wt == null || wt.removed === true) {
    return { diff: { kind: 'unavailable', reason: 'worktree-missing' }, finish };
  }
  const patch = deps.gitReader(wt.path, [
    'diff',
    '--no-ext-diff',
    '--no-color',
    `${target}...${branch}`,
  ]);
  return {
    diff: patch == null ? { kind: 'unavailable', reason: 'git-failed' } : { kind: 'patch', patch },
    finish,
  };
}

function reviewEvidenceFingerprint(input: {
  readonly reviewId: string;
  readonly branch: string;
  readonly target: string;
  readonly scope: string;
  readonly diff: ReviewDiff;
  readonly criteria: ReviewCriteria;
  readonly finish: FinishRecord | undefined;
}): string {
  const payload = {
    reviewId: input.reviewId,
    branch: input.branch,
    target: input.target,
    scope: input.scope,
    diff: input.diff,
    criteria: input.criteria,
    finish:
      input.finish == null
        ? null
        : {
            commitSha: input.finish.commitSha,
            recordedSeq: input.finish.recordedSeq ?? null,
            recordedTs: input.finish.recordedTs,
            tests: input.finish.tests,
          },
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}
