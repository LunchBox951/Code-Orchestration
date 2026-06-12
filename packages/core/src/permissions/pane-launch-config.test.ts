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
const CO_MCP = '/opt/co/bin/co-mcp';
const CO_CLI = '/opt/co/bin/co';

const BASE_IDENTITY = {
  cwd: PANE_CWD,
  isolatedHomeDir: ISOLATED_HOME,
  coMcpCommand: CO_MCP,
  coCliCommand: CO_CLI,
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
  it('claude config with missing --disallowedTools → declared-not-enforced violations', () => {
    const config: PaneLaunchConfig = {
      provider: 'claude',
      args: ['--strict-mcp-config'],
      env: { CLAUDE_CONFIG_DIR: ISOLATED_HOME },
    };
    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
    expect(violations.map((v) => v.id)).toContain('sudo');
  });

  it('codex config missing approval_policy → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const config: PaneLaunchConfig = {
      ...good,
      codexConfigToml: good.codexConfigToml?.replace('approval_policy = "never"\n', ''),
    };
    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
  });

  it('codex config with commented approval_policy and active weaker policy → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const toml = good.codexConfigToml?.replace(
      'approval_policy = "never"',
      '# approval_policy = "never"\napproval_policy = "on-request"',
    );
    const config: PaneLaunchConfig = {
      ...good,
      codexConfigToml: toml,
      prelaunchFiles: (good.prelaunchFiles ?? []).map((file) =>
        file.path === good.codexConfigTomlPath ? { ...file, contents: toml ?? '' } : file,
      ),
    };

    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
  });

  it('codex config with disabled hooks and commented hook enablement → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const toml = good.codexConfigToml?.replace('hooks = true', 'hooks = false # hooks = true');
    const config: PaneLaunchConfig = {
      ...good,
      codexConfigToml: toml,
      prelaunchFiles: (good.prelaunchFiles ?? []).map((file) =>
        file.path === good.codexConfigTomlPath ? { ...file, contents: toml ?? '' } : file,
      ),
    };

    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
  });

  it('codex rule sidecar missing one rule → names that rule declared-not-enforced', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const artifact = JSON.parse(good.codexBlockListRulesJson ?? '{}') as {
      rules: Array<{ id: string }>;
    };
    artifact.rules = artifact.rules.filter((rule) => rule.id !== 'raw-git-merge');
    const rulesJson = JSON.stringify(artifact);
    const config: PaneLaunchConfig = {
      ...good,
      codexBlockListRulesJson: rulesJson,
      prelaunchFiles: (good.prelaunchFiles ?? []).map((file) =>
        file.path === good.codexBlockListRulesPath ? { ...file, contents: rulesJson } : file,
      ),
    };

    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations).toEqual([
      expect.objectContaining({
        id: 'raw-git-merge',
        kind: 'declared-not-enforced',
      }),
    ]);
  });

  it('codex config.toml missing inline hook command wiring → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const config: PaneLaunchConfig = {
      ...good,
      codexConfigToml: good.codexConfigToml?.replace(
        `command = "\\"${CO_CLI}\\" hook codex-block-list --rules \\"/tmp/co-pane-isolated-test/hooks/co-block-list-rules.json\\""\n`,
        '',
      ),
    };

    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
    expect(violations.map((v) => v.id)).toContain('raw-git-merge');
  });

  it('codex config missing prelaunch artifacts → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const config: PaneLaunchConfig = {
      ...good,
      prelaunchFiles: [],
    };

    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
  });

  it('codex rule sidecar outside CODEX_HOME → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const outsideRulesPath = '/tmp/user-global-codex/hooks/co-block-list-rules.json';
    const config: PaneLaunchConfig = {
      ...good,
      codexBlockListRulesPath: outsideRulesPath,
      codexConfigToml: good.codexConfigToml?.replace(
        '\\"/tmp/co-pane-isolated-test/hooks/co-block-list-rules.json\\"',
        '\\"/tmp/user-global-codex/hooks/co-block-list-rules.json\\"',
      ),
      prelaunchFiles: [
        {
          path: good.codexConfigTomlPath!,
          contents:
            good.codexConfigToml?.replace(
              '\\"/tmp/co-pane-isolated-test/hooks/co-block-list-rules.json\\"',
              '\\"/tmp/user-global-codex/hooks/co-block-list-rules.json\\"',
            ) ?? '',
        },
        { path: outsideRulesPath, contents: good.codexBlockListRulesJson ?? '' },
      ],
    };

    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
  });

  it('codex config with relative MCP command → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const toml = good.codexConfigToml?.replace(`command = "${CO_MCP}"`, 'command = "co-mcp"');
    const config: PaneLaunchConfig = {
      ...good,
      codexConfigToml: toml,
      prelaunchFiles: (good.prelaunchFiles ?? []).map((file) =>
        file.path === good.codexConfigTomlPath ? { ...file, contents: toml ?? '' } : file,
      ),
    };

    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
  });

  it('codex config with wrong absolute MCP command → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const toml = good.codexConfigToml?.replace(
      `command = "${CO_MCP}"`,
      'command = "/tmp/evil/co-mcp"',
    );
    const config: PaneLaunchConfig = {
      ...good,
      codexConfigToml: toml,
      prelaunchFiles: (good.prelaunchFiles ?? []).map((file) =>
        file.path === good.codexConfigTomlPath ? { ...file, contents: toml ?? '' } : file,
      ),
    };

    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
  });

  it('codex config with changed MCP args → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', {
      ...BASE_IDENTITY,
      coMcpArgs: ['--project', 'p1'],
    });
    const toml = good.codexConfigToml?.replace(
      'args = ["--project", "p1"]',
      'args = ["--project", "p2"]',
    );
    const config: PaneLaunchConfig = {
      ...good,
      codexConfigToml: toml,
      prelaunchFiles: (good.prelaunchFiles ?? []).map((file) =>
        file.path === good.codexConfigTomlPath ? { ...file, contents: toml ?? '' } : file,
      ),
    };

    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
  });

  it('codex config with wrong absolute hook command → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const toml = good.codexConfigToml?.replace(
      `\\"${CO_CLI}\\" hook codex-block-list`,
      '\\"/tmp/evil/co\\" hook codex-block-list',
    );
    const config: PaneLaunchConfig = {
      ...good,
      codexConfigToml: toml,
      prelaunchFiles: (good.prelaunchFiles ?? []).map((file) =>
        file.path === good.codexConfigTomlPath ? { ...file, contents: toml ?? '' } : file,
      ),
    };

    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
  });

  it('codex config with /usr/bin/env hook command → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const toml = good.codexConfigToml?.replace(
      `"\\"${CO_CLI}\\" hook codex-block-list`,
      '"/usr/bin/env co hook codex-block-list',
    );
    const config: PaneLaunchConfig = {
      ...good,
      codexConfigToml: toml,
      prelaunchFiles: (good.prelaunchFiles ?? []).map((file) =>
        file.path === good.codexConfigTomlPath ? { ...file, contents: toml ?? '' } : file,
      ),
    };

    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
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

  it('codex: config.toml carries sandbox_mode, approval_policy, pre-seeded trust, MCP, and inline hook', () => {
    const config = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const toml = config.codexConfigToml;
    expect(toml).toBeDefined();
    expect(toml).toContain('sandbox_mode');
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain(PANE_CWD);
    expect(toml).toContain('trust_level = "trusted"');
    expect(toml).toContain('[mcp_servers.co]');
    expect(toml).toContain(`command = "${CO_MCP}"`);
    expect(toml).toContain('args = []');
    expect(toml).toContain('[features]');
    expect(toml).toContain('hooks = true');
    expect(toml).toContain('[[hooks.PreToolUse]]');
    expect(toml).toContain('matcher = "Bash"');
    expect(toml).toContain('[[hooks.PreToolUse.hooks]]');
    expect(toml).toContain('type = "command"');
    expect(toml).toContain(
      `command = "\\"${CO_CLI}\\" hook codex-block-list --rules \\"/tmp/co-pane-isolated-test/hooks/co-block-list-rules.json\\""`,
    );
    expect(config.codexConfigTomlPath).toBe(`${ISOLATED_HOME}/config.toml`);
    expect(config.prelaunchFiles).toContainEqual({
      path: `${ISOLATED_HOME}/config.toml`,
      contents: toml,
    });
  });

  it('codex: rule sidecar lives under CODEX_HOME and mirrors the declared block list', () => {
    const config = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const rules = JSON.parse(config.codexBlockListRulesJson ?? '{}') as {
      version: number;
      matcher: string;
      rules: Array<{ id: string }>;
    };
    expect(config.codexBlockListRulesPath).toBe(`${ISOLATED_HOME}/hooks/co-block-list-rules.json`);
    expect(config.prelaunchFiles).toContainEqual({
      path: `${ISOLATED_HOME}/hooks/co-block-list-rules.json`,
      contents: config.codexBlockListRulesJson,
    });
    expect(rules.version).toBe(1);
    expect(rules.matcher).toBe('@co/core/permissions/matchBlock');
    expect(rules.rules.map((rule) => rule.id).sort()).toEqual(
      BLOCK_LIST.map((rule) => rule.id).sort(),
    );
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
      prelaunchFiles: config.prelaunchFiles,
    };
    expect(spec.command).toBe('codex');
    expect(spec.env['CODEX_HOME']).toBe(ISOLATED_HOME);
    expect(spec.args).toEqual([]);
    expect(spec.prelaunchFiles).toHaveLength(2);
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
      coMcpCommand: CO_MCP,
      coCliCommand: CO_CLI,
    };
    const config = buildPaneLaunchConfig('codex', identity);
    expect(config.codexConfigToml).not.toContain('"/tmp/path with "quotes"');
    expect(config.codexConfigToml).toContain('\\"quotes\\"');
  });

  it('escapes double-quotes in Codex MCP command and args', () => {
    const identity = {
      cwd: PANE_CWD,
      isolatedHomeDir: ISOLATED_HOME,
      coMcpCommand: '/tmp/co-mcp-"bin"',
      coCliCommand: CO_CLI,
      coMcpArgs: ['--config', '/tmp/co-mcp-"config".json'],
    };
    const config = buildPaneLaunchConfig('codex', identity);
    expect(config.codexConfigToml).toContain('command = "/tmp/co-mcp-\\"bin\\""');
    expect(config.codexConfigToml).toContain('\\"config\\"');
  });

  it('preserves additional args for the injected absolute Codex MCP command', () => {
    const config = buildPaneLaunchConfig('codex', {
      cwd: PANE_CWD,
      isolatedHomeDir: ISOLATED_HOME,
      coMcpCommand: CO_MCP,
      coCliCommand: CO_CLI,
      coMcpArgs: ['--project', 'p1'],
    });
    expect(config.codexConfigToml).toContain(`command = "${CO_MCP}"`);
    expect(config.codexConfigToml).toContain('args = ["--project", "p1"]');
  });

  it('rejects relative Codex command paths', () => {
    expect(() =>
      buildPaneLaunchConfig('codex', { ...BASE_IDENTITY, coMcpCommand: 'co-mcp' }),
    ).toThrow(/coMcpCommand.*absolute path/i);
    expect(() => buildPaneLaunchConfig('codex', { ...BASE_IDENTITY, coCliCommand: 'co' })).toThrow(
      /coCliCommand.*absolute path/i,
    );
  });

  it('rejects /usr/bin/env Codex command delegation', () => {
    expect(() =>
      buildPaneLaunchConfig('codex', { ...BASE_IDENTITY, coMcpCommand: '/usr/bin/env' }),
    ).toThrow(/coMcpCommand.*usr\/bin\/env/i);
    expect(() =>
      buildPaneLaunchConfig('codex', { ...BASE_IDENTITY, coCliCommand: '/usr/bin/env' }),
    ).toThrow(/coCliCommand.*usr\/bin\/env/i);
  });

  it('rejects PATH-dependent executable args for Codex MCP delegating commands', () => {
    expect(() =>
      buildPaneLaunchConfig('codex', {
        ...BASE_IDENTITY,
        coMcpCommand: '/usr/bin/node',
        coMcpArgs: ['co-mcp'],
      }),
    ).toThrow(/coMcpArgs.*absolute path/i);
    expect(() =>
      buildPaneLaunchConfig('codex', {
        ...BASE_IDENTITY,
        coMcpCommand: '/usr/bin/node',
        coMcpArgs: ['/usr/bin/env'],
      }),
    ).toThrow(/coMcpArgs.*usr\/bin\/env/i);
  });
});
