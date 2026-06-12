/**
 * L7 Phase P1 tests — per-pane permission enforcement (AC-L7-6 [sandbox]).
 *
 * Covers:
 *   1. Drift-clean roundtrip: buildPaneLaunchConfig → readEnforcedConfig → checkBlockListDrift = []
 *   2. Drift catches a dropped rule (proves the check is real, not a tautology)
 *   3. Isolation: env references isolatedHomeDir only — never the user's global config
 *   4. SpawnSpec composition: builder output merges into a SpawnSpec without conflict
 */

import { describe, expect, it } from 'vitest';
import { BLOCK_LIST } from './block-list.js';
import { checkBlockListDrift, readEnforcedConfig } from './drift.js';
import { buildPaneLaunchConfig, type PaneLaunchConfig } from './pane-launch-config.js';
import type { SpawnSpec } from '../pty/pty-host.js';

const ISOLATED_HOME = '/tmp/co-pane-isolated-test';
const PANE_CWD = '/tmp/co-worktree-test';

const BASE_IDENTITY = {
  cwd: PANE_CWD,
  isolatedHomeDir: ISOLATED_HOME,
} as const;

// ---------------------------------------------------------------------------
// 1. Drift-clean roundtrip
// ---------------------------------------------------------------------------

describe('buildPaneLaunchConfig drift-clean roundtrip (AC-L7-6)', () => {
  it('claude: readEnforcedConfig → checkBlockListDrift returns []', () => {
    const config = buildPaneLaunchConfig('claude', BASE_IDENTITY);
    const enforced = readEnforcedConfig(config);
    const violations = checkBlockListDrift(BLOCK_LIST, enforced);
    expect(violations).toEqual([]);
  });

  it('codex: readEnforcedConfig → checkBlockListDrift returns []', () => {
    const config = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const enforced = readEnforcedConfig(config);
    const violations = checkBlockListDrift(BLOCK_LIST, enforced);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Drift catches a dropped rule
// ---------------------------------------------------------------------------

describe('drift catches a dropped rule (proves check is not a tautology)', () => {
  it('config with a missing id → declared-not-enforced violation', () => {
    const droppedId = 'sudo';
    const config: PaneLaunchConfig = {
      provider: 'claude',
      enforcedIds: BLOCK_LIST.map((r) => r.id).filter((id) => id !== droppedId),
      args: [],
      env: { CLAUDE_CONFIG_DIR: ISOLATED_HOME },
    };
    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: droppedId, kind: 'declared-not-enforced' });
  });

  it('config with an extra id → enforced-not-declared violation', () => {
    const phantomId = 'phantom-rule-not-in-registry';
    const config: PaneLaunchConfig = {
      provider: 'codex',
      enforcedIds: [...BLOCK_LIST.map((r) => r.id), phantomId],
      args: [],
      env: { CODEX_HOME: ISOLATED_HOME },
    };
    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: phantomId, kind: 'enforced-not-declared' });
  });
});

// ---------------------------------------------------------------------------
// 3. Isolation — env references only the isolated dir (Codex-blocked-before-work must-not-regress)
// ---------------------------------------------------------------------------

describe('isolation: no user-global config paths (AC-L7-6)', () => {
  const userHome = process.env['HOME'] ?? '/home/user';

  it('claude: CLAUDE_CONFIG_DIR is isolated, not the user home', () => {
    const config = buildPaneLaunchConfig('claude', BASE_IDENTITY);
    expect(config.env['CLAUDE_CONFIG_DIR']).toBe(ISOLATED_HOME);
    expect(config.env['CLAUDE_CONFIG_DIR']).not.toBe(userHome);
    expect(config.env['CLAUDE_CONFIG_DIR']).not.toContain('/.claude');
    // No user CODEX_HOME leaks into a claude config
    expect(config.env['CODEX_HOME']).toBeUndefined();
  });

  it('claude: args include --strict-mcp-config and --disallowedTools', () => {
    const config = buildPaneLaunchConfig('claude', BASE_IDENTITY);
    expect(config.args).toContain('--strict-mcp-config');
    const disallowedIdx = config.args.indexOf('--disallowedTools');
    expect(disallowedIdx).toBeGreaterThanOrEqual(0);
    expect(config.args[disallowedIdx + 1]).toBeTruthy();
  });

  it('claude: --mcp-config forwarded when coMcpConfig is set', () => {
    const mcpPath = '/tmp/co-mcp.json';
    const config = buildPaneLaunchConfig('claude', { ...BASE_IDENTITY, coMcpConfig: mcpPath });
    expect(config.args).toContain('--mcp-config');
    expect(config.args[config.args.indexOf('--mcp-config') + 1]).toBe(mcpPath);
  });

  it('codex: CODEX_HOME is isolated, not the user home', () => {
    const config = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    expect(config.env['CODEX_HOME']).toBe(ISOLATED_HOME);
    expect(config.env['CODEX_HOME']).not.toBe(userHome);
    // No user CLAUDE_CONFIG_DIR leaks into a codex config
    expect(config.env['CLAUDE_CONFIG_DIR']).toBeUndefined();
  });

  it('codex: config.toml carries sandbox_mode, approval_policy, and pre-seeded trust', () => {
    const config = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const toml = config.codexConfigToml;
    expect(toml).toBeDefined();
    expect(toml).toContain('sandbox_mode');
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain(PANE_CWD);
    expect(toml).toContain('trust_level = "trusted"');
  });
});

// ---------------------------------------------------------------------------
// 4. SpawnSpec composition — builder output merges without conflict
// ---------------------------------------------------------------------------

describe('SpawnSpec composition (AC-L7-6)', () => {
  it('claude: env + args compose into a valid SpawnSpec', () => {
    const config = buildPaneLaunchConfig('claude', BASE_IDENTITY);
    const spec: SpawnSpec = {
      command: 'claude',
      args: [...config.args],
      cwd: PANE_CWD,
      env: { ...config.env },
    };
    expect(spec.command).toBe('claude');
    expect(spec.env['CLAUDE_CONFIG_DIR']).toBe(ISOLATED_HOME);
    expect(spec.args).toContain('--strict-mcp-config');
  });

  it('codex: env + args compose into a valid SpawnSpec', () => {
    const config = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const spec: SpawnSpec = {
      command: 'codex',
      args: [...config.args],
      cwd: PANE_CWD,
      env: { ...config.env },
    };
    expect(spec.command).toBe('codex');
    expect(spec.env['CODEX_HOME']).toBe(ISOLATED_HOME);
    expect(spec.args).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Completeness guard — CLAUDE_RULE_PATTERNS must cover every BLOCK_LIST rule
// ---------------------------------------------------------------------------

describe('CLAUDE_RULE_PATTERNS completeness (Principle 9 guard)', () => {
  it('throws if a block rule has no --disallowedTools pattern', () => {
    const orphanRule = {
      id: 'orphan-rule-no-pattern',
      category: 'bypasses-gate' as const,
      description: 'A synthetic rule without a CLAUDE_RULE_PATTERNS entry.',
      matches: () => false,
    };
    expect(() => buildPaneLaunchConfig('claude', BASE_IDENTITY, [orphanRule])).toThrow(
      /orphan-rule-no-pattern/,
    );
  });

  it('all BLOCK_LIST rules have a CLAUDE_RULE_PATTERNS entry (no silent gaps)', () => {
    // If this test throws, a rule was added to BLOCK_LIST without a corresponding pattern.
    expect(() => buildPaneLaunchConfig('claude', BASE_IDENTITY)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. TOML string escaping — special chars in cwd / coMcpConfig
// ---------------------------------------------------------------------------

describe('Codex config.toml string escaping', () => {
  it('escapes double-quotes and backslashes in cwd', () => {
    const identity = {
      cwd: '/tmp/path with "quotes" and \\backslash',
      isolatedHomeDir: ISOLATED_HOME,
    };
    const config = buildPaneLaunchConfig('codex', identity);
    expect(config.codexConfigToml).not.toContain('"/tmp/path with "quotes"');
    expect(config.codexConfigToml).toContain('\\"quotes\\"');
  });

  it('escapes double-quotes in coMcpConfig path', () => {
    const identity = {
      cwd: PANE_CWD,
      isolatedHomeDir: ISOLATED_HOME,
      coMcpConfig: '/tmp/co-mcp-"config".json',
    };
    const config = buildPaneLaunchConfig('codex', identity);
    expect(config.codexConfigToml).toContain('\\"config\\"');
  });
});
