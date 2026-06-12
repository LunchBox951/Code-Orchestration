/**
 * L7 Phase P1 — per-pane permission enforcement: isolated launch-config builder.
 *
 * The builder is PURE: it takes a provider, a pane identity, and the declared block list, and
 * returns {@link PaneLaunchConfig} — plain data that composes into a {@link SpawnSpec}. No I/O.
 *
 * Isolation is the point (permissions.md:90-98): the produced env/args reference ONLY isolated
 * config homes — none of the user's allow-rules, hooks, or MCP servers ever reach the pane.
 *
 *   Claude — `--strict-mcp-config` suppresses user MCP servers; `--disallowedTools` denies the
 *     call pre-exec; isolated `CLAUDE_CONFIG_DIR` prevents user allow-rules/hooks from leaking.
 *   Codex  — isolated `CODEX_HOME` carries a config.toml whose `sandbox_mode` and
 *     `approval_policy = "never"` enforce at the syscall boundary; the `[projects] trust_level`
 *     pre-seeds trust to skip the interstitial.
 *
 * The builder records every {@link BlockRule} id it enforces in {@link PaneLaunchConfig.enforcedIds}.
 * {@link readEnforcedConfig} reads them back; {@link checkBlockListDrift} then verifies that the
 * declared registry and the enforced set are identical. Dropping a rule from `enforcedIds` causes
 * drift to flag `declared-not-enforced` — the check is real, not a tautology.
 */

import { assertNever } from '../assert-never.js';
import type { Provider } from '../dispatch/usage-source.js';
import type { BlockRule } from './block-list.js';
import { BLOCK_LIST } from './block-list.js';

/** Per-launch context the builder needs from the pane. */
export interface PaneIdentity {
  /** The pane's working directory (agent's worktree). */
  readonly cwd: string;
  /**
   * Isolated config/home dir for this pane — NEVER the user's global config dir.
   * Claude uses it as `CLAUDE_CONFIG_DIR`; Codex uses it as `CODEX_HOME`.
   */
  readonly isolatedHomeDir: string;
  /** Path to the co MCP JSON config; forwarded to Claude `--mcp-config` when set. */
  readonly coMcpConfig?: string;
}

/**
 * Pure data that composes directly into a {@link SpawnSpec}: merge `env`, append `args`.
 * Host-side I/O (writing `CODEX_HOME/config.toml`, copying credentials) is out of scope here.
 */
export interface PaneLaunchConfig {
  readonly provider: Provider;
  /**
   * Block-rule ids this config enforces. Consumed by {@link readEnforcedConfig} to produce an
   * {@link EnforcedConfig} for the drift check. Dropping an id here causes drift to flag it as
   * `declared-not-enforced` — the builder MUST list every rule it handles.
   */
  readonly enforcedIds: readonly string[];
  /** CLI args to append to `SpawnSpec.args` (provider-specific flags). */
  readonly args: readonly string[];
  /**
   * Env vars to merge into `SpawnSpec.env`. Always references the isolated dir from
   * {@link PaneIdentity.isolatedHomeDir} — never the user's `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Codex only: TOML content to write to `${CODEX_HOME}/config.toml` before launch.
   * The caller (host-side) performs the actual write; this builder is pure.
   */
  readonly codexConfigToml?: string;
}

// ---------------------------------------------------------------------------
// Claude --disallowedTools patterns
// ---------------------------------------------------------------------------
//
// Each block rule maps to one or more --disallowedTools patterns. Format: `ToolName(prefix*)`.
// Where a rule is not perfectly representable as a simple glob, the most specific covering
// patterns are used. The isolated CLAUDE_CONFIG_DIR prevents user allow-rules from overriding.

const CLAUDE_RULE_PATTERNS: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'git-force-push',
    ['Bash(git push --force*)', 'Bash(git push -f*)', 'Bash(git push --force-with-lease*)'],
  ],
  ['rm-rf-root-or-home', ['Bash(rm -rf /*)', 'Bash(rm -rf ~*)', 'Bash(rm -rf $HOME*)']],
  ['sudo', ['Bash(sudo*)']],
  ['daemon-direct', ['Bash(co run*)']],
  ['raw-git-merge', ['Bash(git merge*)', 'Bash(git pull*)']],
  ['raw-git-push', ['Bash(git push*)']],
  ['raw-gh-pr-merge', ['Bash(gh pr merge*)', 'Bash(gh pr create*)', 'Bash(gh api*)']],
  ['co-in-shell', ['Bash(co *)']],
]);

function claudeDisallowedPatterns(blockList: readonly BlockRule[]): string[] {
  const patterns: string[] = [];
  for (const rule of blockList) {
    const rulePatterns = CLAUDE_RULE_PATTERNS.get(rule.id);
    // Fail-loud (Principle 9): a rule without a corresponding pattern would produce a
    // drift-clean but under-enforced Claude config. Throw immediately so the developer
    // knows to add an entry to CLAUDE_RULE_PATTERNS.
    if (rulePatterns == null) {
      throw new Error(
        `buildPaneLaunchConfig(claude): no --disallowedTools pattern for block rule '${rule.id}'. ` +
          `Add an entry to CLAUDE_RULE_PATTERNS to keep the config fully enforced (Principle 9).`,
      );
    }
    patterns.push(...rulePatterns);
  }
  return patterns;
}

// ---------------------------------------------------------------------------
// Codex config.toml builder
// ---------------------------------------------------------------------------

/** Escape a value for interpolation into a TOML double-quoted string. */
function tomlStringEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function buildCodexConfigToml(identity: PaneIdentity): string {
  const lines: string[] = [
    'sandbox_mode = "workspace-write"',
    'approval_policy = "never"',
    '',
    `[projects."${tomlStringEscape(identity.cwd)}"]`,
    'trust_level = "trusted"',
    '',
    '[mcp_servers.co]',
    'type = "stdio"',
  ];
  if (identity.coMcpConfig != null) {
    lines.push(`config_path = "${tomlStringEscape(identity.coMcpConfig)}"`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Per-provider builders
// ---------------------------------------------------------------------------

function buildClaudeLaunchConfig(
  identity: PaneIdentity,
  blockList: readonly BlockRule[],
): PaneLaunchConfig {
  const args: string[] = ['--strict-mcp-config'];
  const patterns = claudeDisallowedPatterns(blockList);
  if (patterns.length > 0) {
    args.push('--disallowedTools', patterns.join(','));
  }
  if (identity.coMcpConfig != null) {
    args.push('--mcp-config', identity.coMcpConfig);
  }
  return {
    provider: 'claude',
    enforcedIds: blockList.map((r) => r.id),
    args,
    env: { CLAUDE_CONFIG_DIR: identity.isolatedHomeDir },
  };
}

function buildCodexLaunchConfig(
  identity: PaneIdentity,
  blockList: readonly BlockRule[],
): PaneLaunchConfig {
  return {
    provider: 'codex',
    enforcedIds: blockList.map((r) => r.id),
    args: [],
    env: { CODEX_HOME: identity.isolatedHomeDir },
    codexConfigToml: buildCodexConfigToml(identity),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the per-pane isolated launch config for `provider`.
 *
 * Pure — no I/O. The returned `.env` and `.args` compose directly into a `SpawnSpec`.
 * The returned `.enforcedIds` lists every block rule this config enforces; the L7 drift
 * check ({@link readEnforcedConfig} + {@link checkBlockListDrift}) verifies the set matches
 * the declared registry.
 *
 * @param provider - 'claude' or 'codex'
 * @param identity - Pane-specific context: cwd, isolated home dir, optional co MCP config path
 * @param blockList - Defaults to {@link BLOCK_LIST}; inject a subset to test partial coverage
 */
export function buildPaneLaunchConfig(
  provider: Provider,
  identity: PaneIdentity,
  blockList: readonly BlockRule[] = BLOCK_LIST,
): PaneLaunchConfig {
  switch (provider) {
    case 'claude':
      return buildClaudeLaunchConfig(identity, blockList);
    case 'codex':
      return buildCodexLaunchConfig(identity, blockList);
    default:
      return assertNever(provider);
  }
}
