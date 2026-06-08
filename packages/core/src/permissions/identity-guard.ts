import { execFileSync } from 'node:child_process';
import { openConfigStore } from '../config/config-store.js';

/**
 * L6a Phase D2 — Pre-publish identity guard + worktree persona-pinning (AC-L6a-7).
 *
 * Two-part permanent fix for the DCO leak (worktree git identity falling through to global config
 * → personal email in `Signed-off-by`):
 *
 *   1. **Guard** (`checkPublishIdentities`): a pure pre-publish check that refuses a push or PR-merge
 *      if any commit in the range carries an author, committer, or `Signed-off-by` identity outside the
 *      configured persona allowlist (Principle 9 — fail loud with a named reason).
 *
 *   2. **Pinning** (`resolvePersona`): consumed by `slingWorktree` to set the worktree-local git
 *      identity immediately after `git worktree add`, so `git commit -s` always uses the persona and
 *      never falls through to the global config.
 *
 * Both sides are CONFIG-DRIVEN (defaults: empty allowlist → guard skipped; undefined persona →
 * pinning no-op). No specific person is hardcoded in this module.
 *
 * Config shape (program-data only, never in a repo — Principle 12):
 *   `identity.persona_allowlist` — array of `Name <email>` or bare `<email>` strings.
 *   `identity.persona`           — `{ name: string; email: string }` object for the operator persona.
 *
 * Git I/O behind the injectable `CommitIdentityReader` seam so `pnpm test` runs with no real git.
 */

// ---------------------------------------------------------------------------
// Config keys + resolvers
// ---------------------------------------------------------------------------

/** Config cascade key for the persona allowlist (array of `Name <email>` or `<email>` strings). */
export const IDENTITY_PERSONA_ALLOWLIST_KEY = 'identity.persona_allowlist' as const;

/** Config cascade key for the operator persona to pin in new worktrees (`{ name, email }` object). */
export const IDENTITY_PERSONA_KEY = 'identity.persona' as const;

/**
 * Resolve the configured persona allowlist from the config cascade.
 * Mirrors `resolveProvisioningManifest(projectId)`: opens the cascade, reads the key, closes.
 * Default is `[]` (guard skipped) when unconfigured.
 */
export function resolvePersonaAllowlist(projectId: string): string[] {
  const store = openConfigStore();
  try {
    const raw = store.resolveEffective(projectId)[IDENTITY_PERSONA_ALLOWLIST_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter((v): v is string => typeof v === 'string');
  } finally {
    store.close();
  }
}

/** The operator persona shape stored under `identity.persona`. */
export interface PersonaIdentity {
  readonly name: string;
  readonly email: string;
}

/**
 * Resolve the configured operator persona from the config cascade.
 * Returns `undefined` when unconfigured (pinning is a no-op in that case).
 */
export function resolvePersona(projectId: string): PersonaIdentity | undefined {
  const store = openConfigStore();
  try {
    const raw = store.resolveEffective(projectId)[IDENTITY_PERSONA_KEY];
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const obj = raw as Record<string, unknown>;
    if (typeof obj['name'] !== 'string' || typeof obj['email'] !== 'string') return undefined;
    return { name: obj['name'], email: obj['email'] };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Commit identity types
// ---------------------------------------------------------------------------

/** The identity fields extracted from a single commit, sufficient for the allowlist check. */
export interface CommitIdentity {
  readonly sha: string;
  /** Author identity as `Name <email>`. */
  readonly author: string;
  /** Committer identity as `Name <email>`. */
  readonly committer: string;
  /** Each `Signed-off-by:` trailer value as `Name <email>`. */
  readonly signoffs: readonly string[];
}

/** A single allowlist violation: one identity on one field of one commit is not in the allowlist. */
export interface IdentityViolation {
  readonly sha: string;
  readonly field: 'author' | 'committer' | 'signed-off-by';
  /** The offending identity as it appeared in the commit (not normalized). */
  readonly identity: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Pure guard
// ---------------------------------------------------------------------------

/**
 * Normalize an identity string for allowlist comparison: trim whitespace and lowercase the email
 * portion only (names are conventionally case-sensitive; emails are not — RFC 5321 §2.4).
 */
function normalizeIdentity(identity: string): string {
  return identity
    .trim()
    .replace(/<([^>]*)>/u, (_, email: string) => `<${email.toLowerCase().trim()}>`);
}

/**
 * Pure guard (AC-L6a-7): for every commit in `commits`, check that every author, committer, and
 * `Signed-off-by` identity is a member of `allowlist` (after whitespace/email-case normalization).
 * An EMPTY `allowlist` means "nothing allowed" → every identity is a violation. The CALL SITE
 * decides whether to invoke the guard (skip when allowlist is empty — see push.ts / pr-merge.ts).
 */
export function checkPublishIdentities(
  commits: readonly CommitIdentity[],
  allowlist: readonly string[],
): IdentityViolation[] {
  const normalizedAllowlist = new Set(allowlist.map(normalizeIdentity));
  const violations: IdentityViolation[] = [];

  const check = (sha: string, field: IdentityViolation['field'], identity: string): void => {
    if (!normalizedAllowlist.has(normalizeIdentity(identity))) {
      violations.push({
        sha,
        field,
        identity,
        reason: `identity '${identity}' is not in the configured persona allowlist`,
      });
    }
  };

  for (const commit of commits) {
    check(commit.sha, 'author', commit.author);
    check(commit.sha, 'committer', commit.committer);
    for (const signoff of commit.signoffs) {
      check(commit.sha, 'signed-off-by', signoff);
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Git seam for reading commit identities
// ---------------------------------------------------------------------------

/** Injectable seam for reading commit identities over a git range. */
export interface CommitIdentityReader {
  /**
   * Read the commit identities for the given `range` (e.g. `baseSha..branchHead`) in `repoCwd`.
   * Returns an empty array when the range is empty or the range cannot be resolved.
   * MUST NOT throw on an empty range (an unconditionally failing seam breaks the guard).
   */
  read(repoCwd: string, range: string): readonly CommitIdentity[];
}

// Field and commit separators (ASCII control chars, safe in git commit messages).
const FIELD_SEP = '\x1e'; // ASCII Record Separator
const COMMIT_SEP = '\x1f'; // ASCII Unit Separator

/** Parse `Signed-off-by:` trailer lines from a commit body. */
function parseSignoffs(body: string): readonly string[] {
  return [...body.matchAll(/^Signed-off-by:\s*(.+)$/gmu)].map((m) => m[1]!.trim());
}

/**
 * The production `CommitIdentityReader`: runs `git log` with a stable format that emits sha,
 * author, committer, and body per commit, then parses `Signed-off-by:` trailers from the body.
 * Injectable so tests pass pre-built fixtures with no real git.
 */
export const defaultCommitIdentityReader: CommitIdentityReader = {
  read(repoCwd: string, range: string): readonly CommitIdentity[] {
    let raw: string;
    try {
      raw = execFileSync(
        'git',
        [
          'log',
          range,
          `--pretty=tformat:%H${FIELD_SEP}%an <%ae>${FIELD_SEP}%cn <%ce>${FIELD_SEP}%b${COMMIT_SEP}`,
        ],
        { cwd: repoCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch {
      // Empty range, nonexistent ref, or git unavailable → no commits to check.
      return [];
    }

    const commits: CommitIdentity[] = [];
    for (const block of raw.split(COMMIT_SEP)) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      const [sha, author, committer, ...bodyParts] = trimmed.split(FIELD_SEP);
      if (!sha?.trim()) continue;
      const body = bodyParts.join(FIELD_SEP);
      commits.push({
        sha: sha.trim(),
        author: author?.trim() ?? '',
        committer: committer?.trim() ?? '',
        signoffs: parseSignoffs(body),
      });
    }
    return commits;
  },
};
