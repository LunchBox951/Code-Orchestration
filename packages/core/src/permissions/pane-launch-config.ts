/**
 * L7 Phase P1 — per-pane permission enforcement: isolated launch-config builder.
 *
 * The builder is PURE: it takes a provider, a pane identity, and the declared block list, and
 * returns {@link PaneLaunchConfig} — plain data that composes into a {@link SpawnSpec}. No I/O.
 *
 * Isolation is the point (permissions.md:90-98): the produced env/args reference ONLY isolated
 * config homes — none of the user's allow-rules, hooks, or MCP servers ever reach the pane.
 *
 *   Claude — `--permission-mode bypassPermissions` runs the pane NON-INTERACTIVELY (no per-call
 *     permission prompts — the load-bearing fix for autonomous drive); deny rules still apply in
 *     bypass mode, so `--disallowedTools` hard-denies the block-list pre-exec. `--strict-mcp-config`
 *     suppresses user MCP servers; isolated `CLAUDE_CONFIG_DIR` prevents user allow-rules/hooks from
 *     leaking.
 *   Codex  — isolated `CODEX_HOME` carries a config.toml whose `sandbox_mode` and
 *     `approval_policy = "never"` enforce at the syscall boundary (also non-interactive); the
 *     `[projects] trust_level` pre-seeds trust to skip the interstitial, `[mcp_servers.co]` points at
 *     the co MCP command, and inline Codex hooks run the hard-block gate with `matchBlock`.
 *     `--dangerously-bypass-hook-trust` lets that orchestrator-GENERATED PreToolUse hook execute in
 *     the ephemeral isolated `CODEX_HOME` without a persisted-trust prompt (the orchestrator vets the
 *     hook source) — without it the block-list either silently never runs or deadlocks on a trust
 *     prompt.
 *
 * {@link readEnforcedConfig} reads concrete provider artifacts back (Claude deny patterns / Codex
 * isolated hooks), then {@link checkBlockListDrift} verifies declared vs enforced ids.
 */

import { assertNever } from '../assert-never.js';
import type { Provider } from '../dispatch/usage-source.js';
import type { PrelaunchFile } from '../pty/pty-host.js';
import { ROLE_PROFILES, type Capability } from '../roles/profile.js';
import type { BlockRule } from './block-list.js';
import { BLOCK_LIST } from './block-list.js';
import { basename, isAbsolute } from 'node:path';

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
  /** Codex MCP server command. Must be a host-injected trusted absolute path. */
  readonly coMcpCommand: string;
  /** Codex MCP server args. Defaults to none. */
  readonly coMcpArgs?: readonly string[];
  /** Environment variables passed to the scoped co MCP stdio server. */
  readonly coMcpEnv?: Readonly<Record<string, string>>;
  /** Codex hook CLI command. Must be a host-injected trusted absolute path. */
  readonly coCliCommand: string;
  /** Optional trusted absolute arguments that precede the Codex hook subcommand. */
  readonly coCliArgs?: readonly string[];
  /**
   * The pane role's effective capability set (#7 §5 #3). Drives the explicit built-in web-tool
   * decision below. Absent ⇒ empty set. Threaded from the role profile by the placement launcher.
   */
  readonly capabilities?: ReadonlySet<Capability>;
}

/**
 * Pure data that composes directly into a {@link SpawnSpec}: merge `env`, append `args`.
 * Host-side I/O (writing `CODEX_HOME/config.toml`, copying credentials) is out of scope here.
 */
export interface PaneLaunchConfig {
  readonly provider: Provider;
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
  /** Codex only: destination path for {@link codexConfigToml} under isolated CODEX_HOME. */
  readonly codexConfigTomlPath?: string;
  /** Codex only: rule-id sidecar consumed by the generated hook command. */
  readonly codexBlockListRulesJson?: string;
  /** Codex only: destination path for {@link codexBlockListRulesJson} under isolated CODEX_HOME. */
  readonly codexBlockListRulesPath?: string;
  /** Codex only: trusted host-injected MCP command expected in `config.toml`. */
  readonly codexMcpCommand?: string;
  /** Codex only: trusted host-injected MCP args expected in `config.toml`. */
  readonly codexMcpArgs?: readonly string[];
  /** Codex only: trusted hook command expected in `config.toml`. */
  readonly codexHookCommand?: string;
  /** Claude only: generated stdio MCP config content, when `coMcpConfig` is set. */
  readonly claudeMcpConfigJson?: string;
  /** Claude only: generated stdio MCP config destination path. */
  readonly claudeMcpConfigPath?: string;
  /** Claude only: isolated `settings.json` content that pre-accepts the bypassPermissions warning. */
  readonly claudeSettingsJson?: string;
  /** Claude only: isolated `settings.json` destination path under `CLAUDE_CONFIG_DIR`. */
  readonly claudeSettingsPath?: string;
  /** Files the real host must materialize before spawning the pane. */
  readonly prelaunchFiles?: readonly PrelaunchFile[];
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
    // Belt-and-suspenders: Bash(git push*) from raw-git-push already subsumes these
    // force-push variants, but explicit patterns ensure pre-exec denial fires on the
    // more specific rule id even if raw-git-push is somehow absent.
    'git-force-push',
    ['Bash(git push --force*)', 'Bash(git push -f*)', 'Bash(git push --force-with-lease*)'],
  ],
  ['rm-rf-root-or-home', ['Bash(rm -rf /*)', 'Bash(rm -rf ~*)', 'Bash(rm -rf $HOME*)']],
  ['sudo', ['Bash(sudo*)']],
  [
    // Belt-and-suspenders: Bash(co *) from co-in-shell subsumes this, but explicit
    // pattern ensures daemon-direct is denied even when co-in-shell is absent.
    'daemon-direct',
    ['Bash(co run*)'],
  ],
  ['raw-git-merge', ['Bash(git merge*)', 'Bash(git pull*)']],
  ['raw-git-push', ['Bash(git push*)']],
  ['raw-gh-pr-merge', ['Bash(gh pr merge*)', 'Bash(gh pr create*)', 'Bash(gh api*)']],
  ['co-in-shell', ['Bash(co *)']],
]);

const CLAUDE_ALLOWED_CO_MCP_TOOLS = Array.from(
  new Set(Object.values(ROLE_PROFILES).flatMap((profile) => profile.toolset)),
)
  .sort()
  .map((tool) => `mcp__co__${tool}`);

export function claudeDisallowedPatternsForRule(ruleId: string): readonly string[] | undefined {
  return CLAUDE_RULE_PATTERNS.get(ruleId);
}

/** The provider built-in web tools gated by the `web-search` capability (#7 §5 #3). */
export const WEB_SEARCH_TOOLS = ['WebSearch', 'WebFetch'] as const;

/**
 * Whether a pane with these capabilities may use the built-in web tools (#7 §5 #3).
 *
 * Closes the finding that, under `--permission-mode bypassPermissions`, `WebSearch`/`WebFetch`
 * were neither allowed NOR denied — an undefined posture. The launch config now ALWAYS states the
 * decision explicitly (the tools appear in `--allowedTools` or `--disallowedTools`).
 *
 * POLICY (operator decision): GRANT to all roles. The decision is intentionally routed through the
 * capability set so tightening to least-privilege is a one-line change — return
 * `capabilities.has('web-search')` here and only the Researcher (the sole `web-search` holder)
 * keeps web access.
 */
export function paneMayUseWebTools(capabilities: ReadonlySet<Capability>): boolean {
  void capabilities; // grant-all today; flip to `capabilities.has('web-search')` to enforce
  return true;
}

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

function tomlArray(values: readonly string[]): string {
  return `[${values.map((value) => `"${tomlStringEscape(value)}"`).join(', ')}]`;
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

function requireAbsoluteCommand(name: string, command: string): string {
  if (!isAbsolute(command)) {
    throw new Error(`buildPaneLaunchConfig: ${name} must be an absolute path, got '${command}'.`);
  }
  if (command.endsWith('/env')) {
    throw new Error(`buildPaneLaunchConfig: ${name} must not delegate through /usr/bin/env.`);
  }
  return command;
}

const CODEX_MCP_DELEGATING_COMMANDS = new Set([
  'bash',
  'bun',
  'deno',
  'node',
  'nodejs',
  'python',
  'python3',
  'sh',
  'ts-node',
  'tsx',
]);

function requireTrustedMcpExecutableArgs(
  provider: Provider,
  command: string,
  args: readonly string[],
): void {
  const executable = basename(command).replace(/\.exe$/iu, '');
  if (!CODEX_MCP_DELEGATING_COMMANDS.has(executable)) return;
  const delegatedExecutable = args.find((arg) => arg !== '--' && !arg.startsWith('-'));
  if (delegatedExecutable == null || !isAbsolute(delegatedExecutable)) {
    throw new Error(
      `buildPaneLaunchConfig(${provider}): coMcpArgs must include an absolute path when ` +
        `coMcpCommand delegates through '${command}'.`,
    );
  }
  if (delegatedExecutable.endsWith('/env')) {
    throw new Error(
      `buildPaneLaunchConfig(${provider}): coMcpArgs must not delegate through /usr/bin/env.`,
    );
  }
}

interface CodexConfigArtifacts {
  readonly codexConfigToml: string;
  readonly codexMcpCommand: string;
  readonly codexMcpArgs: readonly string[];
  readonly codexHookCommand: string;
}

function sortedEnvEntries(
  env: Readonly<Record<string, string>> | undefined,
): Array<[string, string]> {
  if (env == null) return [];
  const entries = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  for (const [key] of entries) requireEnvVarName(key);
  return entries;
}

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function requireEnvVarName(key: string): string {
  if (!ENV_VAR_NAME.test(key)) {
    throw new Error(
      `buildPaneLaunchConfig: coMcpEnv key '${key}' is not a valid environment ` + 'variable name.',
    );
  }
  return key;
}

function buildCodexConfigArtifacts(identity: PaneIdentity): CodexConfigArtifacts {
  const command = requireAbsoluteCommand('coMcpCommand', identity.coMcpCommand);
  const args = [...(identity.coMcpArgs ?? [])];
  requireTrustedMcpExecutableArgs('codex', command, args);
  const rulesPath = buildCodexBlockListRulesPath(identity);
  const hookCli = requireAbsoluteCommand('coCliCommand', identity.coCliCommand);
  const hookArgs = [...(identity.coCliArgs ?? [])];
  requireTrustedHookExecutableArgs(hookArgs);
  const hookExecutable = [hookCli, ...hookArgs].map(shellDoubleQuote).join(' ');
  const hookCommand = `${hookExecutable} hook codex-block-list --rules ${shellDoubleQuote(rulesPath)}`;
  const mcpEnvLines = sortedEnvEntries(identity.coMcpEnv).flatMap(([key, value]) => [
    `${key} = "${tomlStringEscape(value)}"`,
  ]);
  const lines: string[] = [
    'sandbox_mode = "workspace-write"',
    'approval_policy = "never"',
    '',
    '[features]',
    'hooks = true',
    '',
    `[projects."${tomlStringEscape(identity.cwd)}"]`,
    'trust_level = "trusted"',
    '',
    '[mcp_servers.co]',
    'type = "stdio"',
    `command = "${tomlStringEscape(command)}"`,
    `args = ${tomlArray(args)}`,
    'required = true',
    'startup_timeout_sec = 60',
    '',
    ...(mcpEnvLines.length > 0 ? ['[mcp_servers.co.env]', ...mcpEnvLines, ''] : []),
    '[[hooks.PreToolUse]]',
    'matcher = "Bash"',
    '',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    `command = "${tomlStringEscape(hookCommand)}"`,
  ];
  return {
    codexConfigToml: lines.join('\n') + '\n',
    codexMcpCommand: command,
    codexMcpArgs: args,
    codexHookCommand: hookCommand,
  };
}

function requireTrustedHookExecutableArgs(args: readonly string[]): void {
  if (args.length === 0) return;
  if (args.length > 1) {
    throw new Error('buildPaneLaunchConfig: coCliArgs may contain at most one executable script.');
  }
  const [script] = args;
  if (script == null || !isAbsolute(script)) {
    throw new Error('buildPaneLaunchConfig: coCliArgs must contain an absolute script path.');
  }
  if (script.endsWith('/env')) {
    throw new Error('buildPaneLaunchConfig: coCliArgs must not delegate through /usr/bin/env.');
  }
}

function buildCodexBlockListRulesJson(blockList: readonly BlockRule[]): string {
  return (
    JSON.stringify(
      {
        version: 1,
        tool: 'shell',
        matcher: '@co/core/permissions/matchBlock',
        rules: blockList.map((rule) => ({
          id: rule.id,
          category: rule.category,
          description: rule.description,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}

function buildCodexBlockListRulesPath(identity: PaneIdentity): string {
  return `${identity.isolatedHomeDir.replace(/\/+$/u, '')}/hooks/co-block-list-rules.json`;
}

function buildCodexConfigTomlPath(identity: PaneIdentity): string {
  return `${identity.isolatedHomeDir.replace(/\/+$/u, '')}/config.toml`;
}

function buildClaudeMcpConfigJson(identity: PaneIdentity): string {
  const command = requireAbsoluteCommand('coMcpCommand', identity.coMcpCommand);
  const args = [...(identity.coMcpArgs ?? [])];
  requireTrustedMcpExecutableArgs('claude', command, args);
  const envEntries = sortedEnvEntries(identity.coMcpEnv);
  return (
    JSON.stringify(
      {
        mcpServers: {
          co: {
            command,
            args,
            ...(envEntries.length > 0 ? { env: Object.fromEntries(envEntries) } : {}),
          },
        },
      },
      null,
      2,
    ) + '\n'
  );
}

// ---------------------------------------------------------------------------
// Per-provider builders
// ---------------------------------------------------------------------------

function buildClaudeLaunchConfig(
  identity: PaneIdentity,
  blockList: readonly BlockRule[],
): PaneLaunchConfig {
  // `bypassPermissions` makes the pane non-interactive (no per-call permission prompts) so an
  // unattended autonomous agent never deadlocks waiting for an operator to approve a `Read`/`Bash`.
  // Deny rules apply in EVERY mode including bypassPermissions, so the `--disallowedTools` block-list
  // below still hard-denies the dangerous commands pre-exec (the gated-merge invariant is preserved).
  const args: string[] = ['--strict-mcp-config', '--permission-mode', 'bypassPermissions'];
  // Built-in web tools (#7 §5 #3): state the decision EXPLICITLY rather than leaving it undefined
  // under bypassPermissions — allow when the role may browse, hard-deny otherwise.
  const webAllowed = paneMayUseWebTools(identity.capabilities ?? new Set<Capability>());
  const allowedTools = [...CLAUDE_ALLOWED_CO_MCP_TOOLS, ...(webAllowed ? WEB_SEARCH_TOOLS : [])];
  if (allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }
  const patterns = [
    ...claudeDisallowedPatterns(blockList),
    ...(webAllowed ? [] : WEB_SEARCH_TOOLS),
  ];
  if (patterns.length > 0) {
    args.push('--disallowedTools', patterns.join(','));
  }
  const claudeMcpConfigPath = identity.coMcpConfig;
  if (claudeMcpConfigPath != null) {
    args.push('--mcp-config', claudeMcpConfigPath);
  }
  // Pre-accept the bypassPermissions acknowledgment in the isolated settings.json so the pane starts
  // STRAIGHT TO READY instead of blocking on the one-time interactive "Yes, I accept" warning that
  // `--permission-mode bypassPermissions` raises on a fresh CLAUDE_CONFIG_DIR. (Onboarding state —
  // hasCompletedOnboarding — is seeded separately from the operator's ~/.claude.json via the conductor's
  // CLAUDE_STATE_ALLOWLIST.) Without this companion file the keystone deadlocks every agent on the
  // warning screen — verified against real claude 2.1.181.
  const claudeSettingsPath = `${identity.isolatedHomeDir.replace(/\/+$/u, '')}/settings.json`;
  const claudeSettingsJson = buildClaudeSettingsJson();
  const settingsPrelaunch: PrelaunchFile = {
    path: claudeSettingsPath,
    contents: claudeSettingsJson,
  };
  const base = {
    provider: 'claude',
    args,
    env: { CLAUDE_CONFIG_DIR: identity.isolatedHomeDir },
    claudeSettingsJson,
    claudeSettingsPath,
    prelaunchFiles: [settingsPrelaunch],
  } satisfies PaneLaunchConfig;
  if (claudeMcpConfigPath == null) return base;
  const claudeMcpConfigJson = buildClaudeMcpConfigJson(identity);
  return {
    ...base,
    claudeMcpConfigJson,
    claudeMcpConfigPath,
    prelaunchFiles: [
      settingsPrelaunch,
      { path: claudeMcpConfigPath, contents: claudeMcpConfigJson },
    ],
  };
}

// The isolated `settings.json` that makes a fresh-config-dir agent non-interactive: pre-accept the
// bypassPermissions warning + suppress the first-session nag dialogs. Deny rules (`--disallowedTools`)
// are unaffected — they apply in every mode, including bypassPermissions.
function buildClaudeSettingsJson(): string {
  return (
    JSON.stringify(
      {
        skipDangerousModePermissionPrompt: true,
        skipWorkflowUsageWarning: true,
        skipAutoPermissionPrompt: true,
      },
      null,
      2,
    ) + '\n'
  );
}

function buildCodexLaunchConfig(
  identity: PaneIdentity,
  blockList: readonly BlockRule[],
): PaneLaunchConfig {
  const { codexConfigToml, codexMcpCommand, codexMcpArgs, codexHookCommand } =
    buildCodexConfigArtifacts(identity);
  const codexConfigTomlPath = buildCodexConfigTomlPath(identity);
  const codexBlockListRulesJson = buildCodexBlockListRulesJson(blockList);
  const codexBlockListRulesPath = buildCodexBlockListRulesPath(identity);
  return {
    provider: 'codex',
    // Each pane gets a fresh, isolated CODEX_HOME with no persisted hook trust, so the
    // orchestrator-generated PreToolUse block-list hook would otherwise be skipped (a silent
    // guardrail hole) or deadlock on a trust prompt. The orchestrator vets the hook source (it
    // writes it), so bypass the trust prompt to guarantee the block-list actually runs.
    args: ['--dangerously-bypass-hook-trust'],
    env: { CODEX_HOME: identity.isolatedHomeDir },
    codexConfigToml,
    codexConfigTomlPath,
    codexBlockListRulesJson,
    codexBlockListRulesPath,
    codexMcpCommand,
    codexMcpArgs,
    codexHookCommand,
    prelaunchFiles: [
      { path: codexConfigTomlPath, contents: codexConfigToml },
      { path: codexBlockListRulesPath, contents: codexBlockListRulesJson },
    ],
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build the per-pane isolated launch config for `provider`.
 *
 * Pure — no I/O. The returned `.env` and `.args` compose directly into a `SpawnSpec`.
 * The L7 drift check ({@link readEnforcedConfig} + {@link checkBlockListDrift}) reads the concrete
 * provider artifacts back and verifies that they cover the declared registry.
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
