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
 * Both sides are CONFIG-DRIVEN (defaults: empty allowlist → publish still enforces Signed-off-by;
 * undefined persona → pinning no-op). No specific person is hardcoded in this module.
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
 * Default is `[]` when unconfigured: persona allowlisting is disabled, but callers still enforce
 * the DCO Signed-off-by floor.
 */
export function resolvePersonaAllowlist(projectId: string): string[] {
  const store = openConfigStore();
  try {
    const effective = store.resolveEffective(projectId);
    if (!Object.prototype.hasOwnProperty.call(effective, IDENTITY_PERSONA_ALLOWLIST_KEY)) {
      return [];
    }
    const raw = effective[IDENTITY_PERSONA_ALLOWLIST_KEY];
    if (!Array.isArray(raw)) {
      throw new Error(
        `${IDENTITY_PERSONA_ALLOWLIST_KEY}: expected an array of non-empty identity strings.`,
      );
    }
    return raw.map((v, index) => {
      if (typeof v !== 'string' || v.trim().length === 0) {
        throw new Error(
          `${IDENTITY_PERSONA_ALLOWLIST_KEY}: entry ${index + 1} must be a non-empty string.`,
        );
      }
      if (parseIdentity(v) == null) {
        throw new Error(
          `${IDENTITY_PERSONA_ALLOWLIST_KEY}: entry ${index + 1} must be ` +
            '`Name <email>` or `<email>`.',
        );
      }
      return v;
    });
  } finally {
    store.close();
  }
}

/** The operator persona shape stored under `identity.persona`. */
export interface PersonaIdentity {
  readonly name: string;
  readonly email: string;
}

export interface MergeCommitIdentity {
  readonly author: PersonaIdentity;
  readonly committer: PersonaIdentity;
  readonly signoff: PersonaIdentity;
}

export type GitConfigIdentity = PersonaIdentity | MergeCommitIdentity;

/**
 * Resolve the configured operator persona from the config cascade.
 * Returns `undefined` when unconfigured (pinning is a no-op in that case).
 */
export function resolvePersona(projectId: string): PersonaIdentity | undefined {
  const store = openConfigStore();
  try {
    const effective = store.resolveEffective(projectId);
    if (!Object.prototype.hasOwnProperty.call(effective, IDENTITY_PERSONA_KEY)) {
      return undefined;
    }
    const raw = effective[IDENTITY_PERSONA_KEY];
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${IDENTITY_PERSONA_KEY}: expected { name: string, email: string }.`);
    }
    const obj = raw as Record<string, unknown>;
    if (
      typeof obj['name'] !== 'string' ||
      obj['name'].trim().length === 0 ||
      typeof obj['email'] !== 'string' ||
      obj['email'].trim().length === 0
    ) {
      throw new Error(`${IDENTITY_PERSONA_KEY}: expected non-empty string fields name and email.`);
    }
    if (!isEmailAddress(obj['email'].trim())) {
      throw new Error(`${IDENTITY_PERSONA_KEY}: email must be a valid email address.`);
    }
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
  const parsed = parseIdentity(identity);
  if (parsed != null) return parsed.normalized;
  return identity
    .trim()
    .replace(/<([^>]*)>/u, (_, email: string) => `<${email.toLowerCase().trim()}>`);
}

interface ParsedIdentity {
  readonly normalized: string;
  readonly email: string;
  readonly bareEmail: boolean;
}

function parseIdentity(identity: string): ParsedIdentity | undefined {
  const trimmed = identity.trim();
  const match = /^(?:(.*?)\s*)?<([^<>]+)>$/u.exec(trimmed);
  if (match == null) return undefined;
  const name = match[1]?.trim() ?? '';
  const email = match[2]!.trim().toLowerCase();
  if (!isEmailAddress(email)) return undefined;
  return {
    normalized: name.length > 0 ? `${name} <${email}>` : `<${email}>`,
    email,
    bareEmail: name.length === 0,
  };
}

function isEmailAddress(email: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+$/u.test(email);
}

/**
 * Pure guard (AC-L6a-7): for every commit in `commits`, check that every author, committer, and
 * `Signed-off-by` identity is a member of `allowlist` (after whitespace/email-case normalization).
 * An EMPTY `allowlist` means "nothing allowed" → every identity is a violation. The CALL SITE
 * decides whether to enforce full persona allowlisting or only the DCO sign-off floor.
 */
export function checkPublishIdentities(
  commits: readonly CommitIdentity[],
  allowlist: readonly string[],
): IdentityViolation[] {
  const normalizedAllowlist = new Set<string>();
  const bareEmailAllowlist = new Set<string>();
  for (const entry of allowlist) {
    const parsed = parseIdentity(entry);
    if (parsed?.bareEmail) {
      bareEmailAllowlist.add(parsed.email);
    } else {
      normalizedAllowlist.add(normalizeIdentity(entry));
    }
  }
  const violations: IdentityViolation[] = [];

  const check = (sha: string, field: IdentityViolation['field'], identity: string): void => {
    const parsed = parseIdentity(identity);
    const allowedByEmail = parsed != null && bareEmailAllowlist.has(parsed.email);
    const allowedByIdentity = normalizedAllowlist.has(normalizeIdentity(identity));
    if (!allowedByEmail && !allowedByIdentity) {
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
    if (commit.signoffs.length === 0) {
      violations.push({
        sha: commit.sha,
        field: 'signed-off-by',
        identity: 'missing Signed-off-by trailer',
        reason: 'commit is missing a Signed-off-by trailer',
      });
    } else {
      for (const signoff of commit.signoffs) {
        check(commit.sha, 'signed-off-by', signoff);
      }
    }
  }

  return violations;
}

/** DCO floor used when no persona allowlist is configured: every published commit must be signed off. */
export function checkSignedOffCommits(commits: readonly CommitIdentity[]): IdentityViolation[] {
  const violations: IdentityViolation[] = [];
  for (const commit of commits) {
    if (commit.signoffs.length === 0) {
      violations.push({
        sha: commit.sha,
        field: 'signed-off-by',
        identity: 'missing Signed-off-by trailer',
        reason: 'commit is missing a Signed-off-by trailer',
      });
      continue;
    }
    for (const signoff of commit.signoffs) {
      if (parseIdentity(signoff) == null) {
        violations.push({
          sha: commit.sha,
          field: 'signed-off-by',
          identity: signoff,
          reason: `Signed-off-by trailer '${signoff}' is malformed`,
        });
      }
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
   * Returns an empty array when the range is valid and empty. Throws when the range cannot be
   * resolved/read, because a configured publish guard must never fail open.
   */
  read(repoCwd: string, range: string): readonly CommitIdentity[];
}

/** Injectable seam for reading the current repo-local git identity that would author a merge commit. */
export interface GitConfigIdentityReader {
  /** Read `user.name` + `user.email` from the target repo's effective git config. */
  read(repoCwd: string): GitConfigIdentity;
}

// Field and commit separators (ASCII control chars, safe in git commit messages).
const FIELD_SEP = '\x1e'; // ASCII Record Separator
const COMMIT_SEP = '\x1f'; // ASCII Unit Separator

/** Parse `Signed-off-by:` trailer lines from a commit body. */
function parseSignoffs(body: string): readonly string[] {
  return [...body.matchAll(/^Signed-off-by:\s*(.+)$/gimu)].map((m) => m[1]!.trim());
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
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `co identity guard: cannot inspect commit identities for range '${range}' in ` +
          `'${repoCwd}': ${detail}`,
        { cause },
      );
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

function readGitConfigValue(repoCwd: string, key: string): string {
  try {
    return execFileSync('git', ['config', '--get', key], {
      cwd: repoCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `co identity guard: cannot inspect current git identity '${key}' in '${repoCwd}': ${detail}`,
      { cause },
    );
  }
}

/** The production {@link GitConfigIdentityReader}: reads the identity git would use for new commits. */
export const defaultGitConfigIdentityReader: GitConfigIdentityReader = {
  read(repoCwd: string): GitConfigIdentity {
    const configName = readGitConfigValue(repoCwd, 'user.name');
    const configEmail = readGitConfigValue(repoCwd, 'user.email');
    if (configName.length === 0 || configEmail.length === 0) {
      throw new Error(
        `co identity guard: current git identity in '${repoCwd}' must include user.name and user.email.`,
      );
    }
    const author = effectiveGitEnvIdentity('GIT_AUTHOR', configName, configEmail);
    const committer = effectiveGitEnvIdentity('GIT_COMMITTER', configName, configEmail);
    return { author, committer, signoff: committer };
  },
};

function effectiveGitEnvIdentity(
  prefix: 'GIT_AUTHOR' | 'GIT_COMMITTER',
  configName: string,
  configEmail: string,
): PersonaIdentity {
  return {
    name: process.env[`${prefix}_NAME`] ?? configName,
    email: process.env[`${prefix}_EMAIL`] ?? configEmail,
  };
}

function identityString(identity: PersonaIdentity): string {
  return `${identity.name} <${identity.email}>`;
}

/**
 * Check the identity that will author/commit a local merge commit. With a persona allowlist it must
 * be an allowlisted author, committer, and signoff; without one it still must be a valid signoff.
 */
export function checkMergeCommitIdentity(
  identity: GitConfigIdentity,
  allowlist: readonly string[],
): IdentityViolation[] {
  const author = 'author' in identity ? identity.author : identity;
  const committer = 'committer' in identity ? identity.committer : identity;
  const signoff = 'signoff' in identity ? identity.signoff : committer;
  const commit: CommitIdentity = {
    sha: 'merge-commit',
    author: identityString(author),
    committer: identityString(committer),
    signoffs: [identityString(signoff)],
  };
  return allowlist.length > 0
    ? checkPublishIdentities([commit], allowlist)
    : checkSignedOffCommits([commit]);
}
