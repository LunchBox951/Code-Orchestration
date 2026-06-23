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
import { CO_CLAUDE_STATUSLINE_PATH_ENV } from '../dispatch/statusline-env.js';
import type { PrelaunchFile } from '../pty/pty-host.js';
import { ROLE_PROFILES, roleBasePrompt } from '../roles/profile.js';
import { findSubRole, roleMayResearchWeb } from '../roles/sub-roles.js';
import type { Role } from '../tools/scoping.js';
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
  /** Environment variables prefixed onto the Codex hook command itself. */
  readonly coCliEnv?: Readonly<Record<string, string>>;
  /**
   * The pane's base role. When set, the repo-agnostic {@link roleBasePrompt} is injected into the
   * launch args (Claude `--append-system-prompt`, Codex `developer_instructions` config override).
   * Absent ⇒ no base prompt is appended — so a PRODUCTION caller MUST set it or the prompt is a no-op.
   */
  readonly role?: Role;
  /** Optional sub-role token; when present, the shipped sub-role approach is appended to the prompt. */
  readonly subRole?: string;
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
 * Codex config key carrying the repo-agnostic base prompt, emitted as `-c <key>=<json-string>`.
 * `developer_instructions` is model-visible through `codex debug prompt-input`; the old
 * `experimental_instructions` key was ignored by Codex 0.141.0.
 */
export const CODEX_BASE_PROMPT_CONFIG_KEY = 'developer_instructions';

function rolePromptFor(identity: PaneIdentity): string | undefined {
  if (identity.role == null) {
    if (identity.subRole != null) {
      throw new Error('buildPaneLaunchConfig: subRole requires role.');
    }
    return undefined;
  }
  if (identity.subRole == null) return roleBasePrompt(identity.role);
  const subRole = findSubRole(identity.role, identity.subRole);
  if (subRole == null) {
    throw new Error(
      `buildPaneLaunchConfig: unknown sub-role '${identity.role}:${identity.subRole}'.`,
    );
  }
  return roleBasePrompt(identity.role, {
    subRole: subRole.name,
    subRoleApproach: subRole.approach,
  });
}

/**
 * Whether a pane may use provider-native web tools (#7 §5 #3).
 *
 * Closes the finding that, under `--permission-mode bypassPermissions`, `WebSearch`/`WebFetch`
 * were neither allowed NOR denied — an undefined posture. The launch config now ALWAYS states the
 * decision explicitly (the tools appear in `--allowedTools` or `--disallowedTools`).
 */
export function paneMayUseWebTools(identity: PaneIdentity): boolean {
  return paneMayResearchWeb(identity);
}

/**
 * Whether a pane may research the web (#127). Strictly least-privilege: true iff its RESOLVED
 * sub-role profile carries the `web-search` capability — today the sole holder is
 * `researcher:external` (research.md §"Sub-roles"). Code workers, bare researchers, and the non-web
 * researcher sub-roles (`codebase`/`diagnostic`/`decision`, which narrow `web-search` away) are denied.
 *
 * This drives all launch-time web gates: provider-native WebSearch/WebFetch, the Codex
 * `[sandbox_workspace_write] network_access` opening, and GH_TOKEN injection into the pane MCP/shell
 * envs (placement-launch.ts). Gating on the narrow-only-checked `web-search` capability keeps a live
 * token + explicit web affordances confined to the one sub-role that documents needing them.
 */
export function paneMayResearchWeb(identity: PaneIdentity): boolean {
  return roleMayResearchWeb(identity.role, identity.subRole);
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

// ---------------------------------------------------------------------------
// Codex MCP-tool pre-approval (#78)
// ---------------------------------------------------------------------------
//
// #78 ROOT CAUSE: Claude pre-grants the `co_*` MCP tools by name (`--allowedTools mcp__co__*`), so a
// hosted Claude pane never prompts to call `co_finish` / `co_sling` / …. Codex's `approval_policy =
// "never"` gates the SYSCALL/SANDBOX axis (the wrong axis) but says NOTHING about MCP-tool approval,
// so a hosted codex pane STILL raises an interactive "allow this MCP tool?" prompt and — with no
// operator at its stdin — deadlocks the turn. We need codex's MCP-tool AUTO-APPROVAL.
//
// Codex documents per-MCP-server tool approval as `default_tools_approval_mode`, with `approve`
// meaning calls from that server are pre-approved. This is the same axis Claude covers with
// `--allowedTools mcp__co__*`; do not confuse it with top-level `approval_policy`, which governs
// shell/sandbox approvals.
export const CODEX_MCP_DEFAULT_TOOLS_APPROVAL_KEY = 'default_tools_approval_mode';
export const CODEX_MCP_DEFAULT_TOOLS_APPROVAL_VALUE = 'approve';

/**
 * [PLACEHOLDER · #78] The codex CLI flag that runs the pane NON-INTERACTIVELY for tool approvals.
 * `--ask-for-approval never` is the documented codex approval-mode flag; whether it also suppresses
 * the MCP-tool prompt is pending live verification (see `needsLiveVerification`). Applied in the codex
 * launch args alongside `--dangerously-bypass-hook-trust`.
 */
export const CODEX_NON_INTERACTIVE_APPROVAL_ARGS: readonly string[] = [
  '--ask-for-approval',
  'never',
];

/**
 * #127 — the Codex config section that re-opens outbound network under `sandbox_mode =
 * "workspace-write"` (which otherwise default-denies egress). Emitted with `network_access = true`
 * ONLY for a web-research pane ({@link paneMayResearchWeb}); omitted entirely for everyone else so the
 * default-deny posture holds.
 */
export const CODEX_SANDBOX_NETWORK_SECTION = 'sandbox_workspace_write';

interface CodexConfigArtifacts {
  readonly codexConfigToml: string;
  readonly codexMcpCommand: string;
  readonly codexMcpArgs: readonly string[];
  readonly codexHookCommand: string;
}

function sortedEnvEntries(
  env: Readonly<Record<string, string>> | undefined,
  label: string,
): Array<[string, string]> {
  if (env == null) return [];
  const entries = Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
  for (const [key] of entries) requireEnvVarName(key, label);
  return entries;
}

const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function requireEnvVarName(key: string, label: string): string {
  if (!ENV_VAR_NAME.test(key)) {
    throw new Error(
      `buildPaneLaunchConfig: ${label} key '${key}' is not a valid environment ` + 'variable name.',
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
  const hookEnvPrefix = sortedEnvEntries(identity.coCliEnv, 'coCliEnv')
    .map(([key, value]) => `${key}=${shellDoubleQuote(value)}`)
    .join(' ');
  const hookInvocation = `${hookExecutable} hook codex-block-list --rules ${shellDoubleQuote(rulesPath)}`;
  const hookCommand =
    hookEnvPrefix.length > 0 ? `${hookEnvPrefix} ${hookInvocation}` : hookInvocation;
  const mcpEnvLines = sortedEnvEntries(identity.coMcpEnv, 'coMcpEnv').flatMap(([key, value]) => [
    `${key} = "${tomlStringEscape(value)}"`,
  ]);
  // #127: re-open outbound network ONLY for a web-research pane — Codex's workspace-write sandbox
  // default-denies egress, so a `researcher:external` pane cannot reach api.github.com / the web
  // without this. Default-deny holds for every other pane (the block is simply absent). Emitted after
  // the top-level policy scalars so `sandbox_mode`/`approval_policy` stay at the document root where
  // the drift check reads them.
  const networkLines = paneMayResearchWeb(identity)
    ? [`[${CODEX_SANDBOX_NETWORK_SECTION}]`, 'network_access = true', '']
    : [];
  const lines: string[] = [
    'sandbox_mode = "workspace-write"',
    'approval_policy = "never"',
    '',
    ...networkLines,
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
    // #78: Pre-approve the co MCP tools so a hosted codex pane never deadlocks on an interactive
    // "allow this MCP tool?" prompt. This is the documented MCP-tool approval axis; top-level
    // approval_policy = "never" covers shell/sandbox approval only.
    `${CODEX_MCP_DEFAULT_TOOLS_APPROVAL_KEY} = "${CODEX_MCP_DEFAULT_TOOLS_APPROVAL_VALUE}"`,
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
  const envEntries = sortedEnvEntries(identity.coMcpEnv, 'coMcpEnv');
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
  // Repo-agnostic base prompt (prompts-and-memory.md): `--append-system-prompt` ADDS to Claude's
  // built-in system prompt rather than replacing it, so the universal "how to be an orchestrated
  // agent" guidance rides on top of the native one. Only when the caller set the role — an unset
  // role makes this a deliberate no-op (the placement/host callers MUST thread `identity.role`).
  const basePrompt = rolePromptFor(identity);
  if (basePrompt != null) {
    args.push('--append-system-prompt', basePrompt);
  }
  // Built-in web tools (#7 §5 #3): state the decision EXPLICITLY rather than leaving it undefined
  // under bypassPermissions — allow when the role may browse, hard-deny otherwise.
  const webAllowed = paneMayUseWebTools(identity);
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
  const isolatedHome = identity.isolatedHomeDir.replace(/\/+$/u, '');
  const claudeSettingsPath = `${isolatedHome}/settings.json`;
  // #67 COLLECTION — the per-account file the statusLine command tees the live rate-limit payload to.
  // Sits under the isolated CLAUDE_CONFIG_DIR (never the user's home), and is named for the agent so a
  // re-used home never crosses accounts. `claude-source.ts`'s `realReadStatusLine` reads it back via the
  // CO_CLAUDE_STATUSLINE_PATH env set below.
  const statusLinePath = `${isolatedHome}/co-statusline.json`;
  const claudeSettingsJson = buildClaudeSettingsJson(statusLinePath);
  const settingsPrelaunch: PrelaunchFile = {
    path: claudeSettingsPath,
    contents: claudeSettingsJson,
  };
  const base = {
    provider: 'claude',
    args,
    // CLAUDE_CONFIG_DIR isolates the pane's config. CLAUDE_CODE_NO_FLICKER makes Claude emit
    // append-friendly output instead of the alternate-screen full-redraw stream (#66): the desktop
    // console reassembles an append-only offset transcript, so a redraw replayed as appended frames
    // renders garbled (codex, which is already append-friendly, looked fine). This makes Claude's
    // stream match that model at the source.
    // CO_CLAUDE_STATUSLINE_PATH (#67) names the file the statusLine command tees its payload to, so the
    // passive Claude usage source reads the live rate-limits without spending a turn (AC11).
    env: {
      CLAUDE_CONFIG_DIR: identity.isolatedHomeDir,
      CLAUDE_CODE_NO_FLICKER: '1',
      [CO_CLAUDE_STATUSLINE_PATH_ENV]: statusLinePath,
    },
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

/**
 * Env var naming the file the statusLine command tees the Claude Code rate-limit payload to. Re-exported
 * from the shared {@link CO_CLAUDE_STATUSLINE_PATH_ENV} leaf constant (the single source of truth shared
 * with `dispatch/claude-source.ts`) — imported, not re-declared, so the two can never drift while still
 * keeping the permissions module free of a dispatch-logic import.
 */
export { CO_CLAUDE_STATUSLINE_PATH_ENV } from '../dispatch/statusline-env.js';

/**
 * Build the Claude statusLine command (#67 COLLECTION). Claude Code pipes the statusLine JSON payload
 * (carrying `rate_limits`) to the command on STDIN every refresh; the command must print the status line
 * to STDOUT. This command TEES stdin to `statusLinePath` (the passive usage source reads it back) and
 * prints nothing (an empty status line) — so the collection is invisible to the operator and spends no
 * turn (AC11). `tee` writes the file atomically-enough for a single small JSON blob; `>/dev/null`
 * discards the echoed status. The path is shell-single-quoted (the isolated home is host-controlled, but
 * quoting keeps a path with spaces safe).
 */
export function buildClaudeStatusLineCommand(statusLinePath: string): string {
  return `tee ${shellSingleQuote(statusLinePath)} >/dev/null`;
}

/** Single-quote a string for safe POSIX-shell interpolation (`'` → `'\''`). */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// The isolated `settings.json` that makes a fresh-config-dir agent non-interactive: pre-accept the
// bypassPermissions warning + suppress the first-session nag dialogs. Deny rules (`--disallowedTools`)
// are unaffected — they apply in every mode, including bypassPermissions. It also carries the #67
// statusLine command that tees the rate-limit payload to `statusLinePath` for passive usage collection.
function buildClaudeSettingsJson(statusLinePath: string): string {
  return (
    JSON.stringify(
      {
        skipDangerousModePermissionPrompt: true,
        skipWorkflowUsageWarning: true,
        skipAutoPermissionPrompt: true,
        statusLine: {
          type: 'command',
          command: buildClaudeStatusLineCommand(statusLinePath),
        },
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
  // Each pane gets a fresh, isolated CODEX_HOME with no persisted hook trust, so the
  // orchestrator-generated PreToolUse block-list hook would otherwise be skipped (a silent
  // guardrail hole) or deadlock on a trust prompt. The orchestrator vets the hook source (it
  // writes it), so bypass the trust prompt to guarantee the block-list actually runs.
  // #78: also run NON-INTERACTIVELY for tool approvals — without it a hosted codex pane (no
  // operator at its stdin) deadlocks on the MCP-tool "allow?" prompt the config pre-approval aims
  // to suppress. PLACEHOLDER flag (`--ask-for-approval never`) pending live verification.
  const args: string[] = [
    '--dangerously-bypass-hook-trust',
    ...CODEX_NON_INTERACTIVE_APPROVAL_ARGS,
  ];
  // Repo-agnostic base prompt (prompts-and-memory.md), the Codex analogue of Claude's
  // `--append-system-prompt`: a `-c <key>=<json-string>` config override. Only when the caller set
  // the role — an unset role is a deliberate no-op (the placement/host callers MUST thread the role).
  const basePrompt = rolePromptFor(identity);
  if (basePrompt != null) {
    args.push('-c', `${CODEX_BASE_PROMPT_CONFIG_KEY}=${JSON.stringify(basePrompt)}`);
  }
  return {
    provider: 'codex',
    args,
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
