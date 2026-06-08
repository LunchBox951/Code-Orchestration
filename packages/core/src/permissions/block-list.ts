/**
 * L6a Phase D1 — Non-destructive block-list registry (permissions.md:24-40).
 *
 * This is the DECLARED LIST only. The PreToolUse enforcement hooks (Claude/Codex variants) that
 * actually block these at runtime are L7 (permissions.md:90-98) — NOT built here. This module
 * holds the canonical declared registry that the L7 hooks enforce and the drift check verifies.
 *
 * Philosophy: block ONLY the workarounds that bypass the gated/sanctioned path or destroy
 * state. Everything not on this list is permitted (Principle 6 — tools-do-the-work).
 */

/** The three non-destructive-boundary groupings (permissions.md:29-39). */
export type BlockCategory = 'destroys-repo-or-system' | 'bypasses-gate' | 'breaks-single-surface';

/** A single declared hard-block rule. */
export interface BlockRule {
  /** Stable unique id — also the key the drift check uses. */
  readonly id: string;
  readonly category: BlockCategory;
  readonly description: string;
  /** Pure predicate over the raw command string. Must not produce false positives. */
  readonly matches: (command: string) => boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Tokenize a shell command string into argv tokens, stripping leading
 * `KEY=VALUE` environment assignments so `FOO=bar git push` tokenizes as
 * `['git', 'push']`.
 */
function tokenize(command: string): string[] {
  const tokens = command.trim().split(/\s+/);
  const envAssign = /^[A-Z_][A-Z0-9_]*=/i;
  let i = 0;
  while (i < tokens.length && envAssign.test(tokens[i]!)) i++;
  return tokens.slice(i);
}

/** True iff any token in argv exactly equals one of the given flags. */
function hasFlag(argv: string[], ...flags: string[]): boolean {
  return argv.some((t) => flags.includes(t));
}

// ---------------------------------------------------------------------------
// The declared hard blocks — EXACTLY these eight, no more, no less.
// ---------------------------------------------------------------------------

export const BLOCK_LIST: readonly BlockRule[] = [
  // ── destroys-repo-or-system ───────────────────────────────────────────────

  {
    // Rewrites shared history. Force-push variants: --force, -f, --force-with-lease.
    id: 'git-force-push',
    category: 'destroys-repo-or-system',
    description: '`git push` with --force / -f / --force-with-lease rewrites shared history.',
    matches(command) {
      const argv = tokenize(command);
      if (argv[0] !== 'git' || argv[1] !== 'push') return false;
      return (
        hasFlag(argv, '--force', '-f', '--force-with-lease') ||
        // combined short flags like -fv, -vf
        argv.some((t) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t) && t !== '-f')
      );
    },
  },

  {
    // `rm -rf /` or `rm -rf ~`/`$HOME` — mass deletion of root or home.
    id: 'rm-rf-root-or-home',
    category: 'destroys-repo-or-system',
    description: '`rm` recursive+force targeting / or ~ / $HOME destroys the filesystem.',
    matches(command) {
      const argv = tokenize(command);
      if (argv[0] !== 'rm') return false;
      // Must have a recursive flag AND a force flag.
      const allFlags = argv.filter((t) => t.startsWith('-') && !t.startsWith('--')).join('');
      const hasRecursive = hasFlag(argv, '--recursive') || /r/i.test(allFlags);
      const hasForce = hasFlag(argv, '--force') || allFlags.includes('f');
      if (!hasRecursive || !hasForce) return false;
      // At least one target must be / ~ $HOME or exactly those path strings.
      const targets = argv.filter((t) => !t.startsWith('-'));
      targets.shift(); // remove 'rm'
      return targets.some((t) => t === '/' || t === '~' || t === '$HOME');
    },
  },

  {
    // Any command invoking sudo elevates privilege destructively.
    id: 'sudo',
    category: 'destroys-repo-or-system',
    description: 'Commands invoking `sudo` escalate privilege in ways agents must not do.',
    matches(command) {
      const argv = tokenize(command);
      return argv[0] === 'sudo';
    },
  },

  {
    // Invoking the router daemon directly (`co run …`); forces the MCP surface.
    id: 'daemon-direct',
    category: 'destroys-repo-or-system',
    description:
      '`co run` invokes the foreground router daemon directly — use the MCP surface instead.',
    matches(command) {
      const argv = tokenize(command);
      return argv[0] === 'co' && argv[1] === 'run';
    },
  },

  // ── bypasses-gate ─────────────────────────────────────────────────────────

  {
    // Raw `git merge` lets unreviewed code land. Forces `co_merge`.
    id: 'raw-git-merge',
    category: 'bypasses-gate',
    description: 'Raw `git merge` bypasses the review gate — use `co_merge` instead.',
    matches(command) {
      const argv = tokenize(command);
      return argv[0] === 'git' && argv[1] === 'merge';
    },
  },

  {
    // Raw `git push` (non-force) bypasses `co_push` which requires a PASS verdict.
    id: 'raw-git-push',
    category: 'bypasses-gate',
    description: 'Raw `git push` bypasses the review gate — use `co_push` instead.',
    matches(command) {
      const argv = tokenize(command);
      if (argv[0] !== 'git' || argv[1] !== 'push') return false;
      // A force-push is already caught by git-force-push; return true only for non-force pushes
      // so the more-specific rule takes priority when both would match.
      return !(
        hasFlag(argv, '--force', '-f', '--force-with-lease') ||
        argv.some((t) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t))
      );
    },
  },

  {
    // `gh pr merge` merges a PR without a recorded PASS. Forces `co_pr_merge`.
    id: 'raw-gh-pr-merge',
    category: 'bypasses-gate',
    description: '`gh pr merge` bypasses the review gate — use `co_pr_merge` instead.',
    matches(command) {
      const argv = tokenize(command);
      return argv[0] === 'gh' && argv[1] === 'pr' && argv[2] === 'merge';
    },
  },

  // ── breaks-single-surface ─────────────────────────────────────────────────

  {
    // An agent invoking the `co` CLI violates the single-surface decision (MCP only).
    id: 'co-in-shell',
    category: 'breaks-single-surface',
    description: 'Agents must use the MCP surface (`co_*` tools), not the `co` CLI in the shell.',
    matches(command) {
      const argv = tokenize(command);
      // `co run` is already caught by daemon-direct; any other `co <subcommand>` is still blocked.
      return argv[0] === 'co' && argv[1] !== undefined && argv[1] !== 'run';
    },
  },
];

// ---------------------------------------------------------------------------
// Public matcher
// ---------------------------------------------------------------------------

/**
 * Returns the first {@link BlockRule} that matches `command`, or `null` when nothing matches
 * (meaning the command is not hard-blocked and is freely permitted).
 *
 * Matching priority: `git-force-push` is tested before `raw-git-push` so that a force-push
 * resolves to the more-specific rule. The list order encodes this priority.
 */
export function matchBlock(command: string): BlockRule | null {
  for (const rule of BLOCK_LIST) {
    if (rule.matches(command)) return rule;
  }
  return null;
}
