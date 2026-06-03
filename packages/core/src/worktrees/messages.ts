/**
 * The message contract (AC-L3-3): `co` — not the provider — renders git artifacts from an agent's
 * structured INTENT, in a fixed house style, so Claude-verbose / Codex-terse provider voice can
 * never leak into commit / merge / PR text. These are PURE core functions: each is a deterministic
 * function of its intent and takes **no provider / voice parameter** (freeze #1 / Principle 3 —
 * provider voice cannot reach the artifact *by construction*). Identical intent ⇒ byte-identical
 * output: no `Date`, no `Math.random`, no Map-iteration order — nothing non-deterministic.
 *
 * The register is chosen per AUDIENCE (docs/architecture/worktrees.md §"Messages: `co` owns the
 * contract"):
 *   - {@link renderCommitMessage} — read to *navigate the diff*: Conventional Commits + adaptive body.
 *   - {@link renderMergeMessage}  — read at integration: house style + a review reference + a stat line.
 *   - {@link renderPrMessage}     — read by a maintainer deciding whether to let you in: a sales pitch.
 *
 * In L3 only {@link renderCommitMessage} has a consumer (`co_finish`). The merge / PR renderers ship
 * as exported core functions with NO MCP verb wired to them — the gated verbs that will call them
 * (`co_merge` / `co_push` / `co_pr_merge`) are L5 (an un-gated merge/PR verb would be a bypass, P7).
 */

/** A Conventional-Commit intent: `type(scope): summary` + an optional adaptive body (prose). */
export interface CommitIntent {
  /** The Conventional-Commit type (`feat`, `fix`, `chore`, `docs`, …). */
  readonly type: string;
  /** Optional scope; rendered as `type(scope):` when present, `type:` when omitted/blank. */
  readonly scope?: string;
  /** The imperative one-line summary (no `type`/`scope` prefix — the renderer adds it). */
  readonly summary: string;
  /** Optional body — already wrapped sensibly; omitted (summary-only) for a trivial change. */
  readonly body?: string;
}

/** A merge intent: house style + `[reviewed: <verdict>]` + a `N commits · M regressions` stat line. */
export interface MergeIntent {
  /** The phase branch being merged (e.g. `co/phase-auth`). */
  readonly branch: string;
  /** The imperative summary of what the phase delivered. */
  readonly summary: string;
  /** Optional body prose describing the phase; the stat line is appended to it. */
  readonly body?: string;
  /** The review verdict the merge references (e.g. `PASS`). Rendered verbatim in `[reviewed: …]`. */
  readonly reviewVerdict: string;
  /** Commit count, for the `N commits · …` stat line; the stat line is emitted only with both counts. */
  readonly commits?: number;
  /** Regression count vs the captured baseline, for the `… · M regressions vs baseline.` stat line. */
  readonly regressions?: number;
}

/** A PR intent: the four sales-pitch sections a maintainer reads to decide whether to let you in. */
export interface PrIntent {
  /** Why — the rationale and stakes; the pitch leads with this. */
  readonly why: string;
  /** What changed — the substance of the diff, at a reviewable altitude. */
  readonly whatChanged: string;
  /** Verification — what was run and what it proved (the honest-verification story). */
  readonly verification: string;
  /** Conventions — how the change conforms to the host repo's conventions. */
  readonly conventions: string;
}

/**
 * Normalize a body block deterministically: strip trailing whitespace on every line and trim leading
 * / trailing blank lines, while PRESERVING the author's internal line breaks (the doc bodies break
 * semantically — after a clause — not at a width, so the renderer never re-wraps). Returns '' for an
 * absent / blank body, which the callers treat as "summary only".
 */
function normalizeBody(body: string | undefined): string {
  if (body == null) return '';
  return body.replace(/[ \t]+$/gmu, '').trim();
}

/** The Conventional-Commit header: `type(scope): summary`, or `type: summary` with no scope. */
function commitHeader(type: string, scope: string | undefined, summary: string): string {
  const trimmedScope = scope?.trim();
  const prefix =
    trimmedScope != null && trimmedScope.length > 0 ? `${type}(${trimmedScope})` : type;
  return `${prefix}: ${summary.trim()}`;
}

/**
 * Render a commit message (AC-L3-3): a Conventional-Commit header plus an ADAPTIVE body — summary
 * only for a trivial change, summary + a blank-line-separated body when one helps a reader follow
 * the diff. Matches the worktrees.md commit examples byte-for-byte.
 */
export function renderCommitMessage(intent: CommitIntent): string {
  const header = commitHeader(intent.type, intent.scope, intent.summary);
  const body = normalizeBody(intent.body);
  return body.length > 0 ? `${header}\n\n${body}` : header;
}

/** The `N commits · M regressions vs baseline.` stat line, or '' when either count is absent. */
function mergeStatLine(intent: MergeIntent): string {
  if (intent.commits == null || intent.regressions == null) return '';
  const commits = `${intent.commits} commit${intent.commits === 1 ? '' : 's'}`;
  const regressions = `${intent.regressions} regression${intent.regressions === 1 ? '' : 's'}`;
  return `${commits} · ${regressions} vs baseline.`;
}

/**
 * Render a merge commit message (AC-L3-3): the house style + a `[reviewed: <verdict>]` reference in
 * the header, and a body that appends the `N commits · M regressions vs baseline.` stat line to the
 * phase prose. Matches the worktrees.md merge example byte-for-byte. (Exported core function only —
 * the gated `co_merge` that will call it is L5; no MCP verb is wired to it here.)
 */
export function renderMergeMessage(intent: MergeIntent): string {
  const header = `merge(${intent.branch}): ${intent.summary.trim()}  [reviewed: ${intent.reviewVerdict.trim()}]`;
  const body = [normalizeBody(intent.body), mergeStatLine(intent)]
    .filter((s) => s.length > 0)
    .join(' ');
  return body.length > 0 ? `${header}\n\n${body}` : header;
}

/**
 * Render a PR description (AC-L3-3): the four sales-pitch sections — Why / What changed /
 * Verification / Conventions — leading with rationale and stakes. (Exported core function only — the
 * gated `co_push` / `co_pr_merge` that will call it are L5; no MCP verb is wired to it here.)
 */
export function renderPrMessage(intent: PrIntent): string {
  return [
    '## Why',
    normalizeBody(intent.why),
    '## What changed',
    normalizeBody(intent.whatChanged),
    '## Verification',
    normalizeBody(intent.verification),
    '## Conventions',
    normalizeBody(intent.conventions),
  ].join('\n\n');
}
