import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountForProvider,
  FakeUsageSource,
  openDispatchStore,
  openConfigStore,
  openRegistry,
  UsageUnavailableError,
} from '@co/core';
import type { Provider, UsageSnapshot } from '@co/core';
import { run } from './run.js';

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  const dir = mkdtempSync(join(tmpdir(), 'co-cli-test-data-'));
  tmpDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function makeRegisteredProject(): { projectId: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'co-cli-test-repo-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const registry = openRegistry();
  const projectId = registry.register(dir);
  registry.close();
  return { projectId, dir };
}

const usageSnap: UsageSnapshot = {
  provider: 'claude',
  account: accountForProvider('claude'),
  available: true,
  source: 'fake',
  sampled_at: new Date().toISOString(),
  windows: [
    {
      kind: 'five_hour',
      used_pct: 30,
      reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
    },
  ],
};

const codexUnavailable: UsageSnapshot = {
  provider: 'codex',
  account: accountForProvider('codex'),
  available: false,
  source: 'fake',
  sampled_at: new Date().toISOString(),
  windows: [],
};

function fakeUsageOptions(
  snapshots: Partial<Record<Provider, UsageSnapshot>> = {},
  errors: Partial<Record<Provider, Error>> = {},
) {
  const source = new FakeUsageSource({ snapshots, errors });
  return { usageSourceFactory: () => source };
}

function writeRulesFile(ids: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-cli-hook-'));
  tmpDirs.push(dir);
  const path = join(dir, 'rules.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      tool: 'shell',
      matcher: '@co/core/permissions/matchBlock',
      rules: ids.map((id) => ({ id })),
    }),
  );
  return path;
}

describe('co hook codex-block-list', () => {
  it('denies blocked Bash commands using the canonical block-list matcher', async () => {
    const rules = writeRulesFile(['raw-git-merge']);
    const result = await run(['hook', 'codex-block-list', '--rules', rules], process.cwd(), {
      stdin: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git merge feature' },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/permissionDecision.*deny|decision.*block/s);
    expect(result.output).toMatch(/raw-git-merge/);
  });

  it('denies blocked lowercase bash hook payloads', async () => {
    const rules = writeRulesFile(['raw-git-merge']);
    const result = await run(['hook', 'codex-block-list', '--rules', rules], process.cwd(), {
      stdin: JSON.stringify({
        tool_name: 'bash',
        tool_input: { command: 'git merge feature' },
      }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/permissionDecision.*deny|decision.*block/s);
    expect(result.output).toMatch(/raw-git-merge/);
  });

  it('allows safe Bash commands and non-Bash tool payloads', async () => {
    const rules = writeRulesFile(['raw-git-merge']);
    const safe = await run(['hook', 'codex-block-list', '--rules', rules], process.cwd(), {
      stdin: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git status --short' },
      }),
    });
    const nonShell = await run(['hook', 'codex-block-list', '--rules', rules], process.cwd(), {
      stdin: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'README.md' } }),
    });

    expect(safe).toEqual({ output: '', exitCode: 0 });
    expect(nonShell).toEqual({ output: '', exitCode: 0 });
  });

  it('fails closed when the rules file is missing or invalid', async () => {
    const result = await run(
      ['hook', 'codex-block-list', '--rules', '/tmp/no-such-co-rules.json'],
      process.cwd(),
      {
        stdin: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'git status --short' },
        }),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/permissionDecision.*deny|decision.*block/s);
    expect(result.output).toMatch(/failed closed/);
  });
});

describe('co usage', () => {
  it('reports usage buckets for a registered project', async () => {
    const { projectId, dir } = makeRegisteredProject();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(usageSnap);
    } finally {
      store.close();
    }

    const result = await run(['usage'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/claude/i);
    expect(result.output).toMatch(/30/);
  });

  it('reports "no usage data" for a registered project with no samples', async () => {
    const { dir } = makeRegisteredProject();
    const result = await run(['usage'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/no usage/i);
  });

  it('exits with code 1 for an unregistered cwd', async () => {
    const unregistered = mkdtempSync(join(tmpdir(), 'co-cli-unregistered-'));
    tmpDirs.push(unregistered);
    const result = await run(['usage'], unregistered);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/not a registered project/i);
    expect(result.output).not.toMatch(/co init/i);
  });

  it('exits with code 1 for unknown flags or stray args', async () => {
    const { dir } = makeRegisteredProject();
    const unknown = await run(['usage', '--bogus'], dir);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toMatch(/usage|unknown option|unexpected argument|--bogus/i);

    const stray = await run(['usage', 'stray'], dir);
    expect(stray.exitCode).toBe(1);
    expect(stray.output).toMatch(/usage|unexpected argument|stray/i);
  });
});

describe('co cost', () => {
  it('reports cost rollups for a registered project', async () => {
    const { projectId, dir } = makeRegisteredProject();
    const store = openDispatchStore(projectId);
    try {
      store.recordCost({
        provider: 'claude',
        agent: 'agent-1',
        task: 'task-1',
        turn: 1,
        cost_usd: 0.025,
        total_tokens: 800,
      });
    } finally {
      store.close();
    }

    const result = await run(['cost'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/agent-1/);
    expect(result.output).toMatch(/0\.025/);
  });

  it('exits with code 1 for an unregistered cwd', async () => {
    const unregistered = mkdtempSync(join(tmpdir(), 'co-cli-unregistered2-'));
    tmpDirs.push(unregistered);
    const result = await run(['cost'], unregistered);
    expect(result.exitCode).toBe(1);
  });

  it('exits with code 1 for unknown flags or stray args', async () => {
    const { dir } = makeRegisteredProject();
    const unknown = await run(['cost', '--bogus'], dir);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toMatch(/cost|unknown option|unexpected argument|--bogus/i);

    const stray = await run(['cost', 'stray'], dir);
    expect(stray.exitCode).toBe(1);
    expect(stray.output).toMatch(/cost|unexpected argument|stray/i);
  });
});

describe('co sling --dry-run', () => {
  it('reports PLACED for a healthy provider', async () => {
    const { projectId, dir } = makeRegisteredProject();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(usageSnap);
    } finally {
      store.close();
    }

    const result = await run(
      [
        'sling',
        '--dry-run',
        '--role',
        'implementer',
        '--work-size',
        'average',
        '--reasoning-budget',
        'standard',
      ],
      dir,
      fakeUsageOptions({ codex: codexUnavailable }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/placed/i);
    expect(result.output).toMatch(/claude/i);
  });

  it('surfaces usage-source diagnostics even when another provider can be placed', async () => {
    const { projectId, dir } = makeRegisteredProject();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(usageSnap);
    } finally {
      store.close();
    }

    const result = await run(
      [
        'sling',
        '--dry-run',
        '--role',
        'implementer',
        '--work-size',
        'average',
        '--reasoning-budget',
        'standard',
      ],
      dir,
      fakeUsageOptions(
        {},
        {
          codex: new UsageUnavailableError('codex', 'logs database missing', {
            account: accountForProvider('codex'),
          }),
        },
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/placed/i);
    expect(result.output).toMatch(/warning/i);
    expect(result.output).toMatch(/usage_source_unavailable/);
    expect(result.output).toMatch(/codex/);
    expect(result.output).toMatch(/logs database missing/);
  });

  it('refreshes and places a custom --account through the requested account label', async () => {
    const { dir } = makeRegisteredProject();
    const requested: Array<{ provider: Provider; account: string }> = [];
    const result = await run(['sling', '--dry-run', '--account', 'claude:team'], dir, {
      usageSourceFactory: (account) => {
        requested.push(account);
        return new FakeUsageSource({
          snapshots: {
            claude: {
              provider: 'claude',
              account: account.account,
              available: true,
              source: 'fake',
              sampled_at: new Date().toISOString(),
              windows: [
                {
                  kind: 'five_hour',
                  used_pct: 5,
                  reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
                },
              ],
            },
          },
        });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/placed/i);
    expect(result.output).toMatch(/claude/i);
    expect(result.output).toMatch(/account=claude:team/i);
    expect(requested).toEqual([{ provider: 'claude', account: 'claude:team' }]);
  });

  it('round-trips explicit default --account labels to the usage source factory', async () => {
    const { dir } = makeRegisteredProject();
    const requested: Array<{ provider: Provider; account: string }> = [];

    const result = await run(['sling', '--dry-run', '--account', 'claude:max,codex:pro'], dir, {
      usageSourceFactory: (account) => {
        requested.push(account);
        return new FakeUsageSource({
          snapshots: {
            [account.provider]: {
              provider: account.provider,
              account: account.account,
              available: true,
              source: 'fake',
              sampled_at: new Date().toISOString(),
              windows: [
                {
                  kind: account.provider === 'claude' ? 'five_hour' : 'primary',
                  used_pct: account.provider === 'claude' ? 5 : 7,
                  reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
                },
              ],
            },
          },
        });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(requested).toEqual([
      { provider: 'claude', account: accountForProvider('claude') },
      { provider: 'codex', account: accountForProvider('codex') },
    ]);
  });

  it('places a pinned role on the requested custom account', async () => {
    const { projectId, dir } = makeRegisteredProject();
    const config = openConfigStore();
    try {
      config.setProjectOverride(projectId, 'dispatch.pins', {
        implementer: { provider: 'claude' },
      });
    } finally {
      config.close();
    }

    const result = await run(['sling', '--dry-run', '--account', 'claude:team'], dir, {
      usageSourceFactory: (account) =>
        new FakeUsageSource({
          snapshots: {
            claude: {
              provider: 'claude',
              account: account.account,
              available: true,
              source: 'fake',
              sampled_at: new Date().toISOString(),
              windows: [
                {
                  kind: 'five_hour',
                  used_pct: 5,
                  reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
                },
              ],
            },
          },
        }),
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/placed/i);
    expect(result.output).toMatch(/account=claude:team/i);
  });

  it('reports WAITING for a maxed provider', async () => {
    const { projectId, dir } = makeRegisteredProject();
    const maxedSnap: UsageSnapshot = {
      ...usageSnap,
      windows: [
        {
          kind: 'five_hour',
          used_pct: 99,
          reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
        },
      ],
    };
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(maxedSnap);
    } finally {
      store.close();
    }

    const result = await run(
      [
        'sling',
        '--dry-run',
        '--role',
        'implementer',
        '--work-size',
        'average',
        '--reasoning-budget',
        'standard',
      ],
      dir,
      fakeUsageOptions({ codex: codexUnavailable }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/waiting/i);
    expect(result.output).toMatch(/maxed_accounts=claude:max/i);
  });

  it('reports unavailable usage sources distinctly from capacity waits', async () => {
    const { dir } = makeRegisteredProject();
    const result = await run(
      [
        'sling',
        '--dry-run',
        '--role',
        'implementer',
        '--work-size',
        'average',
        '--reasoning-budget',
        'standard',
      ],
      dir,
      fakeUsageOptions(
        {},
        {
          claude: new UsageUnavailableError('claude', 'statusLine file missing', {
            account: accountForProvider('claude'),
          }),
          codex: new UsageUnavailableError('codex', 'logs database missing', {
            account: accountForProvider('codex'),
          }),
        },
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/waiting/i);
    expect(result.output).toMatch(/usage source unavailable/i);
    expect(result.output).toMatch(/usage_source_unavailable/);
    expect(result.output).toMatch(/statusLine file missing/);
    expect(result.output).not.toMatch(/all providers at capacity/i);
    expect(result.output).not.toMatch(/maxed_providers/);
    expect(result.output).toMatch(/unavailable_providers=claude, codex/);
    expect(result.output).toMatch(/unavailable_accounts=claude:max, codex:pro/);
    expect(result.output.match(/warning:/g)).toHaveLength(2);
  });

  it('exits with code 1 for an unregistered cwd', async () => {
    const unregistered = mkdtempSync(join(tmpdir(), 'co-cli-unregistered3-'));
    tmpDirs.push(unregistered);
    const result = await run(
      [
        'sling',
        '--dry-run',
        '--role',
        'implementer',
        '--work-size',
        'average',
        '--reasoning-budget',
        'standard',
      ],
      unregistered,
    );
    expect(result.exitCode).toBe(1);
  });

  it('exits with code 1 and a readable message for a malformed --account value (P9 — no crash)', async () => {
    const { dir } = makeRegisteredProject();
    // 'badformat' has no colon separator — parseAccounts should throw and be caught cleanly.
    const result = await run(
      [
        'sling',
        '--dry-run',
        '--role',
        'implementer',
        '--work-size',
        'average',
        '--reasoning-budget',
        'standard',
        '--account',
        'badformat',
      ],
      dir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/badformat|invalid.*account|account.*format/i);
  });

  it('exits with code 1 for an unknown provider in --account', async () => {
    const { dir } = makeRegisteredProject();
    const result = await run(['sling', '--dry-run', '--account', 'gemini:pro'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/provider|claude|codex/i);
  });

  it('exits with code 1 for duplicate same-provider --account entries until same-provider routing exists', async () => {
    const { dir } = makeRegisteredProject();
    const result = await run(['sling', '--dry-run', '--account', 'claude:max,claude:team'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/duplicate provider|claude|same-provider/i);
    expect(result.output).not.toMatch(/account-aware placement output is not yet supported/i);
  });

  it('exits with code 1 for a missing --account value', async () => {
    const { dir } = makeRegisteredProject();
    const result = await run(['sling', '--dry-run', '--account'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/account/i);
  });

  it('exits with code 1 for missing role and tier option values', async () => {
    const { dir } = makeRegisteredProject();
    const missingRole = await run(['sling', '--dry-run', '--role'], dir);
    expect(missingRole.exitCode).toBe(1);
    expect(missingRole.output).toMatch(/--role/i);

    const missingWorkSize = await run(['sling', '--dry-run', '--work-size'], dir);
    expect(missingWorkSize.exitCode).toBe(1);
    expect(missingWorkSize.output).toMatch(/--work-size/i);

    const missingReasoning = await run(['sling', '--dry-run', '--reasoning-budget'], dir);
    expect(missingReasoning.exitCode).toBe(1);
    expect(missingReasoning.output).toMatch(/--reasoning-budget/i);
  });

  it('exits with code 1 for unknown options, misspelled flags, stray args, and duplicate value flags', async () => {
    const { dir } = makeRegisteredProject();
    const unknown = await run(['sling', '--dry-run', '--bogus'], dir);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toMatch(/unknown option|--bogus/i);

    const misspelled = await run(['sling', '--dry-run', '--reasoning-budgt', 'deep'], dir);
    expect(misspelled.exitCode).toBe(1);
    expect(misspelled.output).toMatch(/unknown option|reasoning-budgt/i);

    const stray = await run(['sling', '--dry-run', 'deep'], dir);
    expect(stray.exitCode).toBe(1);
    expect(stray.output).toMatch(/unexpected argument|deep/i);

    const duplicate = await run(
      ['sling', '--dry-run', '--role', 'implementer', '--role', 'reviewer'],
      dir,
    );
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.output).toMatch(/duplicate|--role/i);
  });

  it('exits with code 1 for invalid work size and reasoning budget values', async () => {
    const { dir } = makeRegisteredProject();
    const badWorkSize = await run(['sling', '--dry-run', '--work-size', 'huge'], dir);
    expect(badWorkSize.exitCode).toBe(1);
    expect(badWorkSize.output).toMatch(/work-size|simple|average|technical/i);

    const badReasoning = await run(['sling', '--dry-run', '--reasoning-budget', 'reckless'], dir);
    expect(badReasoning.exitCode).toBe(1);
    expect(badReasoning.output).toMatch(/reasoning-budget|economy|standard|deep/i);
  });

  it('exits with code 1 when sling is invoked without --dry-run', async () => {
    const { dir } = makeRegisteredProject();
    const result = await run(['sling'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/dry-run/i);
  });
});

describe('co help / unknown command', () => {
  it('shows help text for the --help flag', async () => {
    const { dir } = makeRegisteredProject();
    const result = await run(['--help'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/usage|cost|sling/i);
    expect(result.output).toMatch(/refreshes usage cache/i);
  });

  it('shows help text for no arguments', async () => {
    const { dir } = makeRegisteredProject();
    const result = await run([], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/usage|cost|sling/i);
  });

  it('shows unknown-command message for an unrecognized command', async () => {
    const { dir } = makeRegisteredProject();
    const result = await run(['unknown-cmd'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/unknown/i);
  });
});
