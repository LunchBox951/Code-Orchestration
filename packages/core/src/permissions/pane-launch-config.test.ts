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
import {
  buildPaneLaunchConfig,
  paneMayUseWebTools,
  CODEX_MCP_AUTO_APPROVE_CANDIDATE_KEYS,
  CODEX_NON_INTERACTIVE_APPROVAL_ARGS,
  type PaneLaunchConfig,
} from './pane-launch-config.js';
import { ROLE_PROFILES, type Capability } from '../roles/profile.js';
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

const SCOPED_MCP_ENV = {
  CO_AGENT: 'impl-1',
  CO_ROLE: 'implementer',
  CO_PARENT: 'lead-1',
  CO_PROJECT_ID: 'proj-1',
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
    // #66: Claude runs append-friendly (no alt-screen full-redraw) so the console renders cleanly.
    expect(config.env['CLAUDE_CODE_NO_FLICKER']).toBe('1');
  });

  it('claude: args include --strict-mcp-config and --disallowedTools', () => {
    const config = buildPaneLaunchConfig('claude', BASE_IDENTITY);
    expect(config.args).toContain('--strict-mcp-config');
    const disallowedIdx = config.args.indexOf('--disallowedTools');
    expect(disallowedIdx).toBeGreaterThanOrEqual(0);
    expect(config.args[disallowedIdx + 1]).toBeTruthy();
  });

  it('claude: runs non-interactively via --permission-mode bypassPermissions (deny-list still applies)', () => {
    const config = buildPaneLaunchConfig('claude', BASE_IDENTITY);
    const modeIdx = config.args.indexOf('--permission-mode');
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(config.args[modeIdx + 1]).toBe('bypassPermissions');
    // bypassPermissions auto-approves normal tool use but deny rules apply in every mode, so the
    // block-list is still enforced via --disallowedTools (the gated-merge invariant is preserved).
    expect(config.args).toContain('--disallowedTools');
  });

  it('claude: pre-accepts the bypassPermissions warning via an isolated settings.json', () => {
    const config = buildPaneLaunchConfig('claude', BASE_IDENTITY);
    expect(config.claudeSettingsPath).toBe(`${ISOLATED_HOME}/settings.json`);
    const settings = JSON.parse(config.claudeSettingsJson ?? '{}') as Record<string, unknown>;
    // Without this key, `--permission-mode bypassPermissions` blocks on the one-time interactive
    // "Yes, I accept" warning on a fresh CLAUDE_CONFIG_DIR — deadlocking the unattended agent.
    expect(settings['skipDangerousModePermissionPrompt']).toBe(true);
    // The other two suppress first-session nag dialogs that would also block an unattended startup;
    // lock all three so neither can silently regress out of the settings builder.
    expect(settings['skipWorkflowUsageWarning']).toBe(true);
    expect(settings['skipAutoPermissionPrompt']).toBe(true);
    expect(config.prelaunchFiles).toContainEqual({
      path: `${ISOLATED_HOME}/settings.json`,
      contents: config.claudeSettingsJson,
    });
  });

  it('claude: args allow the CO MCP bus without allowing shell tools', () => {
    const config = buildPaneLaunchConfig('claude', BASE_IDENTITY);
    const allowedIdx = config.args.indexOf('--allowedTools');
    expect(allowedIdx).toBeGreaterThanOrEqual(0);
    const allowed = config.args[allowedIdx + 1] ?? '';
    expect(allowed.split(',')).toContain('mcp__co__co_mail_send');
    expect(allowed).not.toMatch(/\bBash\b/);
  });

  it('claude: --mcp-config forwarded when coMcpConfig is set', () => {
    const mcpPath = '/tmp/co-mcp.json';
    const config = buildPaneLaunchConfig('claude', { ...BASE_IDENTITY, coMcpConfig: mcpPath });
    expect(config.args).toContain('--mcp-config');
    expect(config.args[config.args.indexOf('--mcp-config') + 1]).toBe(mcpPath);
  });

  it('claude: scoped MCP config is materialized with identity env when coMcpConfig is set', () => {
    const mcpPath = `${ISOLATED_HOME}/mcp/co-mcp.json`;
    const config = buildPaneLaunchConfig('claude', {
      ...BASE_IDENTITY,
      coMcpConfig: mcpPath,
      coMcpEnv: SCOPED_MCP_ENV,
    });

    expect(config.claudeMcpConfigPath).toBe(mcpPath);
    const parsed = JSON.parse(config.claudeMcpConfigJson ?? '{}') as {
      mcpServers?: { co?: { command?: string; args?: string[]; env?: Record<string, string> } };
    };
    expect(parsed.mcpServers?.co).toEqual({
      command: CO_MCP,
      args: [],
      env: SCOPED_MCP_ENV,
    });
    expect(config.prelaunchFiles).toContainEqual({
      path: mcpPath,
      contents: config.claudeMcpConfigJson,
    });
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
    expect(toml).toContain('required = true');
    expect(toml).toContain('startup_timeout_sec = 60');
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

  it('codex: hook command supports a node-launched absolute CLI script', () => {
    const config = buildPaneLaunchConfig('codex', {
      ...BASE_IDENTITY,
      coCliCommand: '/usr/bin/node',
      coCliArgs: ['/repo/packages/cli/dist/index.js'],
    });

    expect(config.codexConfigToml).toContain(
      `command = "\\"/usr/bin/node\\" \\"/repo/packages/cli/dist/index.js\\" hook codex-block-list --rules \\"/tmp/co-pane-isolated-test/hooks/co-block-list-rules.json\\""`,
    );
    expect(checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config))).toEqual([]);
  });

  it('codex: hook command can carry host-required env without leaking it into pane env', () => {
    const config = buildPaneLaunchConfig('codex', {
      ...BASE_IDENTITY,
      coCliCommand: '/electron',
      coCliArgs: ['/repo/packages/cli/dist/index.js'],
      coCliEnv: { ELECTRON_RUN_AS_NODE: '1' },
    });

    expect(config.codexConfigToml).toContain(
      `command = "ELECTRON_RUN_AS_NODE=\\"1\\" \\"/electron\\" \\"/repo/packages/cli/dist/index.js\\" hook codex-block-list --rules \\"/tmp/co-pane-isolated-test/hooks/co-block-list-rules.json\\""`,
    );
    expect(config.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #78 — codex MCP-tool pre-approval (deadlock fix) + tolerant drift
// ---------------------------------------------------------------------------

describe('#78 codex MCP-tool pre-approval', () => {
  it('codex config.toml pre-grants the co MCP tools under [mcp_servers.co] (best candidate key)', () => {
    const config = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const toml = config.codexConfigToml ?? '';
    // At least one candidate auto-approve key is present (the emitted best candidate).
    const present = CODEX_MCP_AUTO_APPROVE_CANDIDATE_KEYS.some((key) =>
      new RegExp(`^\\s*${key}\\s*=`, 'mu').test(toml),
    );
    expect(present).toBe(true);
  });

  it('codex args apply the non-interactive approval launch flag', () => {
    const config = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    // The full flag sequence appears contiguously in the codex launch args.
    const joined = config.args.join(' ');
    expect(joined).toContain(CODEX_NON_INTERACTIVE_APPROVAL_ARGS.join(' '));
    expect(config.args).toContain('--dangerously-bypass-hook-trust');
  });

  it('drift REQUIRES the pre-grant: removing it entirely → declared-not-enforced violations', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    // Strip EVERY candidate auto-approve assignment from the [mcp_servers.co] block.
    let toml = good.codexConfigToml ?? '';
    for (const key of CODEX_MCP_AUTO_APPROVE_CANDIDATE_KEYS) {
      toml = toml.replace(new RegExp(`^\\s*${key}\\s*=.*$\\n?`, 'mu'), '');
    }
    const config: PaneLaunchConfig = {
      ...good,
      codexConfigToml: toml,
      prelaunchFiles: good.prelaunchFiles?.map((file) =>
        file.path === good.codexConfigTomlPath ? { ...file, contents: toml } : file,
      ),
    };
    const violations = checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((v) => v.kind === 'declared-not-enforced')).toBe(true);
  });

  it('drift is TOLERANT of the key: swapping the emitted key for ANOTHER candidate stays drift-clean', () => {
    const good = buildPaneLaunchConfig('codex', BASE_IDENTITY);
    const emittedKey = CODEX_MCP_AUTO_APPROVE_CANDIDATE_KEYS.find((key) =>
      new RegExp(`^\\s*${key}\\s*=`, 'mu').test(good.codexConfigToml ?? ''),
    );
    expect(emittedKey).toBeDefined();
    const otherKey = CODEX_MCP_AUTO_APPROVE_CANDIDATE_KEYS.find((key) => key !== emittedKey);
    expect(otherKey).toBeDefined();
    // Swap the emitted candidate for a DIFFERENT candidate (simulating the real key landing later).
    const toml = (good.codexConfigToml ?? '').replace(
      new RegExp(`^(\\s*)${emittedKey}(\\s*=.*)$`, 'mu'),
      `$1${otherKey}$2`,
    );
    expect(toml).not.toBe(good.codexConfigToml); // the swap actually changed the TOML
    const config: PaneLaunchConfig = {
      ...good,
      codexConfigToml: toml,
      prelaunchFiles: good.prelaunchFiles?.map((file) =>
        file.path === good.codexConfigTomlPath ? { ...file, contents: toml } : file,
      ),
    };
    // Still drift-clean — the swap did NOT read as permanent drift (the whole point of #78 tolerance).
    expect(checkBlockListDrift(BLOCK_LIST, readEnforcedConfig(config))).toEqual([]);
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
    // The orchestrator-generated PreToolUse block-list hook needs the trust prompt bypassed to run
    // in the ephemeral isolated CODEX_HOME (the orchestrator vets the hook source); #78 also applies
    // the non-interactive approval flag so a hosted pane never deadlocks on the MCP-tool prompt.
    expect(spec.args).toEqual([
      '--dangerously-bypass-hook-trust',
      ...CODEX_NON_INTERACTIVE_APPROVAL_ARGS,
    ]);
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

  it('emits scoped Codex MCP env and escapes env values', () => {
    const config = buildPaneLaunchConfig('codex', {
      ...BASE_IDENTITY,
      coMcpEnv: {
        CO_AGENT: 'impl-"quoted"',
        CO_ROLE: 'implementer',
        CO_PARENT: 'lead\\one',
        CO_PROJECT_ID: 'proj-1',
      },
    });

    expect(config.codexConfigToml).toContain('[mcp_servers.co.env]');
    expect(config.codexConfigToml).toContain('CO_AGENT = "impl-\\"quoted\\""');
    expect(config.codexConfigToml).toContain('CO_PARENT = "lead\\\\one"');
    expect(config.codexConfigToml).toContain('CO_PROJECT_ID = "proj-1"');
    expect(config.prelaunchFiles).toContainEqual({
      path: `${ISOLATED_HOME}/config.toml`,
      contents: config.codexConfigToml,
    });
  });

  it('rejects invalid scoped MCP env names before writing provider config', () => {
    expect(() =>
      buildPaneLaunchConfig('codex', {
        ...BASE_IDENTITY,
        coMcpEnv: {
          CO_AGENT: 'impl-1',
          'bad.key': 'value',
        },
      }),
    ).toThrow(/coMcpEnv key 'bad\.key'.*environment variable name/i);

    expect(() =>
      buildPaneLaunchConfig('claude', {
        ...BASE_IDENTITY,
        coMcpConfig: `${ISOLATED_HOME}/mcp/co-mcp.json`,
        coMcpEnv: {
          '1_BAD': 'value',
        },
      }),
    ).toThrow(/coMcpEnv key '1_BAD'.*environment variable name/i);
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

  it('rejects PATH-dependent executable args for Claude MCP config with a Claude-scoped error', () => {
    expect(() =>
      buildPaneLaunchConfig('claude', {
        ...BASE_IDENTITY,
        coMcpConfig: `${ISOLATED_HOME}/mcp/co-mcp.json`,
        coMcpCommand: '/usr/bin/node',
        coMcpArgs: ['co-mcp'],
      }),
    ).toThrow(/buildPaneLaunchConfig\(claude\).*coMcpArgs.*absolute path/i);
  });
});

// ---------------------------------------------------------------------------
// Built-in web tools are explicitly decided at launch (#7 §5 #3)
// ---------------------------------------------------------------------------

describe('claude built-in web tools are explicitly decided at launch (#7 §5 #3)', () => {
  const flagValue = (args: readonly string[], flag: string): string[] => {
    const i = args.indexOf(flag);
    return i < 0 ? [] : (args[i + 1] ?? '').split(',');
  };

  it('a role with NO web-search capability still gets an EXPLICIT allow (grant-all policy)', () => {
    // The gap was that, under bypassPermissions, WebSearch/WebFetch were neither allowed nor
    // denied. Now the decision is always stated: grant-all puts them in --allowedTools.
    const config = buildPaneLaunchConfig('claude', {
      ...BASE_IDENTITY,
      capabilities: new Set<Capability>(),
    });
    const allowed = flagValue(config.args, '--allowedTools');
    expect(allowed).toContain('WebSearch');
    expect(allowed).toContain('WebFetch');
    const disallowed = flagValue(config.args, '--disallowedTools');
    expect(disallowed).not.toContain('WebSearch');
    expect(disallowed).not.toContain('WebFetch');
  });

  it('the researcher (the web-search holder) gets the same explicit allow', () => {
    const config = buildPaneLaunchConfig('claude', {
      ...BASE_IDENTITY,
      capabilities: ROLE_PROFILES.researcher.capabilities,
    });
    const allowed = flagValue(config.args, '--allowedTools');
    expect(allowed).toContain('WebSearch');
    expect(allowed).toContain('WebFetch');
  });

  it('paneMayUseWebTools is grant-all and capability-driven (one-line flip to least-privilege)', () => {
    expect(paneMayUseWebTools(new Set<Capability>())).toBe(true);
    expect(paneMayUseWebTools(ROLE_PROFILES.researcher.capabilities)).toBe(true);
  });
});
