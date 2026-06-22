/**
 * L6a Phase D1 — Drift check: declared registry vs. enforced config (permissions.md:90-94).
 * L7 Phase P1 — fills `readEnforcedConfig` with the real per-pane config reader.
 *
 * A declared block that isn't enforced, or an enforced id nobody declared, is the exact silent
 * drift this check kills (Principle 9 — no-silent-failures). The check is PURE over injected
 * inputs; `readEnforcedConfig` derives ids from concrete provider launch artifacts (Claude deny
 * patterns / Codex isolated inline hooks), not a self-reported id list.
 */

import {
  claudeDisallowedPatternsForRule,
  CODEX_MCP_AUTO_APPROVE_CANDIDATE_KEYS,
  type PaneLaunchConfig,
} from './pane-launch-config.js';
import { BLOCK_LIST, type BlockRule } from './block-list.js';
import { assertNever } from '../assert-never.js';
import { isAbsolute, relative, resolve } from 'node:path';

/** What the harness gate hooks actually enforce. Produced by L7; injected here for tests. */
export interface EnforcedConfig {
  readonly blockedIds: readonly string[];
  /**
   * #78 (round-2): codex only — `true` iff the block list IS fully enforced (sandbox/approval policy,
   * isolated hook, rule sidecar) but the `[mcp_servers.co]` MCP-tool pre-grant is ABSENT. This is a
   * DISTINCT regression from block-list drift: the block list is intact, but a hosted codex pane would
   * deadlock on the interactive "allow this MCP tool?" prompt. Surfacing it separately stops a missing
   * pre-grant from masquerading as EVERY block rule being unenforced (a misleading operator signal).
   */
  readonly codexMcpPreGrantMissing?: boolean;
}

/** A single drift mismatch between the declared registry and the enforced config. */
export interface DriftViolation {
  /** The block-list id involved, or `@mcp-pre-grant` for the codex pre-grant regression. */
  readonly id: string;
  /** `declared-not-enforced`: in registry but missing from `EnforcedConfig.blockedIds`. */
  /** `enforced-not-declared`: in `EnforcedConfig.blockedIds` but absent from the registry. */
  /** `codex-mcp-pre-grant-missing`: codex block list IS enforced but the MCP-tool pre-grant regressed. */
  readonly kind: 'declared-not-enforced' | 'enforced-not-declared' | 'codex-mcp-pre-grant-missing';
  readonly reason: string;
}

/** Synthetic id for the codex MCP-pre-grant violation (it has no block-list rule of its own). */
export const CODEX_MCP_PRE_GRANT_VIOLATION_ID = '@mcp-pre-grant';

/**
 * Pure drift check. Returns `[]` iff `enforced.blockedIds` exactly equals the set of ids in
 * `registry`. Otherwise returns one {@link DriftViolation} per mismatch.
 *
 * - A registry rule whose id is absent from `enforced` → `declared-not-enforced`.
 * - An enforced id not present in the registry → `enforced-not-declared`.
 */
export function checkBlockListDrift(
  registry: readonly BlockRule[],
  enforced: EnforcedConfig,
): DriftViolation[] {
  const violations: DriftViolation[] = [];
  const declaredIds = new Set(registry.map((r) => r.id));
  const enforcedIds = new Set(enforced.blockedIds);

  for (const rule of registry) {
    if (!enforcedIds.has(rule.id)) {
      violations.push({
        id: rule.id,
        kind: 'declared-not-enforced',
        reason: `Block rule '${rule.id}' is declared in the registry but absent from the enforced config.`,
      });
    }
  }

  for (const id of enforced.blockedIds) {
    if (!declaredIds.has(id)) {
      violations.push({
        id,
        kind: 'enforced-not-declared',
        reason: `Enforced id '${id}' has no matching rule in the declared registry.`,
      });
    }
  }

  // #78 (round-2): a missing codex MCP-tool pre-grant is its OWN regression — the block list is intact,
  // but a hosted codex pane would deadlock on the interactive MCP-tool approval prompt. Report it with a
  // DISTINCT kind so the operator is not misled into blaming the (fully-enforced) block list.
  if (enforced.codexMcpPreGrantMissing === true) {
    violations.push({
      id: CODEX_MCP_PRE_GRANT_VIOLATION_ID,
      kind: 'codex-mcp-pre-grant-missing',
      reason:
        'Codex block list is enforced, but the [mcp_servers.co] MCP-tool pre-grant is absent — a ' +
        'hosted codex pane would deadlock on the interactive "allow this MCP tool?" prompt (#78). ' +
        'Restore an auto-approve assignment under [mcp_servers.co]; this is NOT block-list drift.',
    });
  }

  return violations;
}

/**
 * Read the {@link EnforcedConfig} from a {@link PaneLaunchConfig} produced by
 * {@link buildPaneLaunchConfig}. This is deliberately derived from concrete provider config:
 * removing Claude's deny patterns or Codex's isolated executable hook config makes the readback return
 * fewer ids and {@link checkBlockListDrift} flags `declared-not-enforced`.
 */
export function readEnforcedConfig(config: PaneLaunchConfig): EnforcedConfig {
  switch (config.provider) {
    case 'claude':
      return { blockedIds: readClaudeBlockedIds(config) };
    case 'codex':
      return readCodexEnforcedConfig(config);
    default:
      return assertNever(config.provider);
  }
}

function readClaudeBlockedIds(config: PaneLaunchConfig): string[] {
  if (config.env['CLAUDE_CONFIG_DIR'] == null) return [];
  const disallowedIdx = config.args.indexOf('--disallowedTools');
  const raw = disallowedIdx >= 0 ? config.args[disallowedIdx + 1] : undefined;
  if (raw == null || raw.trim() === '') return [];
  const actual = new Set(
    raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  );
  const ids: string[] = [];
  for (const rule of BLOCK_LIST) {
    const expected = claudeDisallowedPatternsForRule(rule.id);
    if (expected == null) {
      throw new Error(
        `readEnforcedConfig(claude): no --disallowedTools pattern for block rule '${rule.id}'.`,
      );
    }
    if (expected.every((pattern) => actual.has(pattern))) ids.push(rule.id);
  }
  return ids;
}

function readCodexEnforcedConfig(config: PaneLaunchConfig): EnforcedConfig {
  const codexHome = config.env['CODEX_HOME'];
  if (codexHome == null) return { blockedIds: [] };
  const toml = config.codexConfigToml ?? '';
  const configPath = config.codexConfigTomlPath;
  const rulesPath = config.codexBlockListRulesPath;
  const hasIsolatedPolicy =
    tomlActiveScalar(toml, '', 'sandbox_mode') === 'workspace-write' &&
    tomlActiveScalar(toml, '', 'approval_policy') === 'never' &&
    codexConfigTomlHasExpectedMcp(toml, config.codexMcpCommand, config.codexMcpArgs ?? []);
  if (!hasIsolatedPolicy) return { blockedIds: [] };
  if (configPath == null || resolve(configPath) !== resolve(codexHome, 'config.toml')) {
    return { blockedIds: [] };
  }
  if (rulesPath == null || !isPathInsideDir(codexHome, rulesPath)) return { blockedIds: [] };
  if (!hasPrelaunchFile(config, configPath, toml)) return { blockedIds: [] };
  if (!hasPrelaunchFile(config, rulesPath, config.codexBlockListRulesJson ?? '')) {
    return { blockedIds: [] };
  }
  if (!codexConfigTomlReferencesRuleFile(toml, rulesPath, config.codexHookCommand)) {
    return { blockedIds: [] };
  }
  // The block list is FULLY enforced (isolated policy + hook + rule sidecar): read the enforced ids.
  const blockedIds = readCodexHookRuleIds(config.codexBlockListRulesJson);
  // #78: REQUIRE the MCP-tool pre-grant (else a hosted codex pane deadlocks on the approval prompt),
  // but be TOLERANT of WHICH candidate key carries it — swapping a wrong guess for the real key (once
  // the capture harness identifies it) must not read as permanent drift. A MISSING pre-grant is its OWN
  // regression, DISTINCT from block-list drift: the block list above is intact, so we keep the enforced
  // ids (no false declared-not-enforced for every rule) and instead flag the pre-grant separately so the
  // drift check can raise a `codex-mcp-pre-grant-missing` violation. Blaming the block list when the
  // pre-grant is what regressed would be a misleading operator signal (Principle 9 — no-silent-failures
  // is about accurate signal, not just loud signal).
  return {
    blockedIds,
    ...(codexConfigTomlHasMcpAutoApprove(toml) ? {} : { codexMcpPreGrantMissing: true }),
  };
}

/**
 * #78 — TOLERANT check that `[mcp_servers.co]` carries an MCP-tool pre-approval. Accepts an active
 * assignment for ANY key in {@link CODEX_MCP_AUTO_APPROVE_CANDIDATE_KEYS} (the honored key is not yet
 * pinned). Loop-safety / block-list enforcement does not hinge on this; it guards the #78 deadlock fix.
 */
function codexConfigTomlHasMcpAutoApprove(toml: string): boolean {
  return CODEX_MCP_AUTO_APPROVE_CANDIDATE_KEYS.some(
    (key) => tomlActiveAssignmentValue(toml, 'mcp_servers.co', key) != null,
  );
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw == null || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed != null
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function codexConfigTomlReferencesRuleFile(
  toml: string,
  rulesPath: string | undefined,
  expectedHookCommand: string | undefined,
): boolean {
  if (rulesPath == null || rulesPath.length === 0) return false;
  return (
    tomlActiveScalar(toml, 'features', 'hooks') === true &&
    tomlActiveScalar(toml, 'hooks.PreToolUse', 'matcher') === 'Bash' &&
    tomlActiveScalar(toml, 'hooks.PreToolUse.hooks', 'type') === 'command' &&
    codexConfigTomlHasExpectedHookCommand(toml, rulesPath, expectedHookCommand)
  );
}

function codexConfigTomlHasExpectedMcp(
  toml: string,
  expectedCommand: string | undefined,
  expectedArgs: readonly string[],
): boolean {
  if (expectedCommand == null) return false;
  const command = tomlActiveScalar(toml, 'mcp_servers.co', 'command');
  if (typeof command !== 'string') return false;
  if (!isTrustedAbsoluteCommand(command) || command !== expectedCommand) return false;
  const args = tomlActiveStringArray(toml, 'mcp_servers.co', 'args');
  return args != null && arraysEqual(args, expectedArgs);
}

function codexConfigTomlHasExpectedHookCommand(
  toml: string,
  rulesPath: string,
  expectedHookCommand: string | undefined,
): boolean {
  if (expectedHookCommand == null) return false;
  const command = tomlActiveScalar(toml, 'hooks.PreToolUse.hooks', 'command');
  if (command !== expectedHookCommand) return false;
  if (!command.includes(`--rules ${shellDoubleQuote(rulesPath)}`)) return false;
  return hookCommandUsesTrustedExecutable(command);
}

function hookCommandUsesTrustedExecutable(command: string): boolean {
  const invocation = stripHookEnvPrefix(command);
  const direct = /^"([^"]+)" hook codex-block-list --rules /u.exec(invocation);
  if (direct?.[1] != null && isTrustedAbsoluteCommand(direct[1])) return true;
  const viaNode = /^"([^"]+)" "([^"]+)" hook codex-block-list --rules /u.exec(invocation);
  return (
    viaNode?.[1] != null &&
    viaNode[2] != null &&
    isTrustedAbsoluteCommand(viaNode[1]) &&
    isTrustedAbsoluteCommand(viaNode[2])
  );
}

function stripHookEnvPrefix(command: string): string {
  let rest = command;
  while (true) {
    const match = /^[A-Za-z_][A-Za-z0-9_]*="(?:\\.|[^"\\])*"\s+/u.exec(rest);
    if (match == null) return rest;
    rest = rest.slice(match[0].length);
  }
}

function isTrustedAbsoluteCommand(command: string): boolean {
  return isAbsolute(command) && !command.endsWith('/env');
}

function tomlActiveStringArray(toml: string, section: string, key: string): string[] | undefined {
  const value = tomlActiveAssignmentValue(toml, section, key);
  if (value == null) return undefined;
  const match = /^\[([\s\S]*)\]$/u.exec(value);
  if (match?.[1] == null) return undefined;
  return parseTomlStringArrayBody(match[1]);
}

function parseTomlStringArrayBody(raw: string): string[] | undefined {
  const values: string[] = [];
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/u.test(raw[index] ?? '')) index += 1;
  };

  skipWhitespace();
  while (index < raw.length) {
    if (raw[index] !== '"') return undefined;
    index += 1;
    let encoded = '';
    let closed = false;
    while (index < raw.length) {
      const char = raw[index]!;
      if (char === '\\') {
        const next = raw[index + 1];
        if (next == null) return undefined;
        encoded += char + next;
        index += 2;
        continue;
      }
      if (char === '"') {
        index += 1;
        closed = true;
        break;
      }
      encoded += char;
      index += 1;
    }
    if (!closed) return undefined;
    values.push(tomlStringUnescape(encoded));
    skipWhitespace();
    if (index >= raw.length) break;
    if (raw[index] !== ',') return undefined;
    index += 1;
    skipWhitespace();
    if (index >= raw.length) return undefined;
  }
  return values;
}

type TomlScalar = string | boolean;

function tomlActiveScalar(toml: string, section: string, key: string): TomlScalar | undefined {
  const value = tomlActiveAssignmentValue(toml, section, key);
  if (value == null) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const match = /^"((?:\\.|[^"\\])*)"$/.exec(value);
  return match?.[1] != null ? tomlStringUnescape(match[1]) : undefined;
}

function tomlActiveAssignmentValue(toml: string, section: string, key: string): string | undefined {
  let currentSection = '';
  let found: string | undefined;
  for (const rawLine of toml.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine).trim();
    if (line === '') continue;
    const sectionMatch = /^\[\[?([^\]]+?)\]\]?$/u.exec(line);
    if (sectionMatch?.[1] != null) {
      currentSection = sectionMatch[1];
      continue;
    }
    if (currentSection !== section) continue;
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*([\s\S]+)$/u.exec(line);
    if (assignment?.[1] !== key || assignment[2] == null) continue;
    if (found != null) return undefined;
    found = assignment[2].trim();
  }
  return found;
}

function stripTomlComment(line: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of line) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (inString && char === '\\') {
      out += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      out += char;
      inString = !inString;
      continue;
    }
    if (!inString && char === '#') break;
    out += char;
  }
  return out;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hasPrelaunchFile(config: PaneLaunchConfig, path: string, contents: string): boolean {
  return (config.prelaunchFiles ?? []).some(
    (file) => resolve(file.path) === resolve(path) && file.contents === contents,
  );
}

function isPathInsideDir(dir: string, child: string): boolean {
  const rel = relative(resolve(dir), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')}"`;
}

function tomlStringUnescape(value: string): string {
  return value
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function readCodexHookRuleIds(raw: string | undefined): string[] {
  const artifact = parseJsonObject(raw) as
    | {
        version?: unknown;
        tool?: unknown;
        matcher?: unknown;
        rules?: unknown;
      }
    | undefined;
  if (artifact == null) return [];
  const rulesArtifact = artifact as {
    version?: unknown;
    tool?: unknown;
    matcher?: unknown;
    rules?: unknown;
  };
  if (
    rulesArtifact.version !== 1 ||
    rulesArtifact.tool !== 'shell' ||
    rulesArtifact.matcher !== '@co/core/permissions/matchBlock' ||
    !Array.isArray(rulesArtifact.rules)
  ) {
    return [];
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of rulesArtifact.rules) {
    if (typeof item !== 'object' || item == null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
