import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDispatchStore, openRegistry } from '@co/core';
import type { UsageSnapshot } from '@co/core';
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
  account: 'default',
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

describe('co usage', () => {
  it('reports usage buckets for a registered project', () => {
    const { projectId, dir } = makeRegisteredProject();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(usageSnap);
    } finally {
      store.close();
    }

    const result = run(['usage'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/claude/i);
    expect(result.output).toMatch(/30/);
  });

  it('reports "no usage data" for a registered project with no samples', () => {
    const { dir } = makeRegisteredProject();
    const result = run(['usage'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/no usage/i);
  });

  it('exits with code 1 for an unregistered cwd', () => {
    const unregistered = mkdtempSync(join(tmpdir(), 'co-cli-unregistered-'));
    tmpDirs.push(unregistered);
    const result = run(['usage'], unregistered);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/not a registered project/i);
  });
});

describe('co cost', () => {
  it('reports cost rollups for a registered project', () => {
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

    const result = run(['cost'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/agent-1/);
    expect(result.output).toMatch(/0\.025/);
  });

  it('exits with code 1 for an unregistered cwd', () => {
    const unregistered = mkdtempSync(join(tmpdir(), 'co-cli-unregistered2-'));
    tmpDirs.push(unregistered);
    const result = run(['cost'], unregistered);
    expect(result.exitCode).toBe(1);
  });
});

describe('co sling --dry-run', () => {
  it('reports PLACED for a healthy provider', () => {
    const { projectId, dir } = makeRegisteredProject();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(usageSnap);
    } finally {
      store.close();
    }

    const result = run(
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
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/placed/i);
    expect(result.output).toMatch(/claude/i);
  });

  it('reports WAITING for a maxed provider', () => {
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

    const result = run(
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
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/waiting/i);
  });

  it('exits with code 1 for an unregistered cwd', () => {
    const unregistered = mkdtempSync(join(tmpdir(), 'co-cli-unregistered3-'));
    tmpDirs.push(unregistered);
    const result = run(
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

  it('exits with code 1 and a readable message for a malformed --account value (P9 — no crash)', () => {
    const { dir } = makeRegisteredProject();
    // 'badformat' has no colon separator — parseAccounts should throw and be caught cleanly.
    const result = run(
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
});

describe('co help / unknown command', () => {
  it('shows help text for the --help flag', () => {
    const { dir } = makeRegisteredProject();
    const result = run(['--help'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/usage|cost|sling/i);
  });

  it('shows help text for no arguments', () => {
    const { dir } = makeRegisteredProject();
    const result = run([], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/usage|cost|sling/i);
  });

  it('shows unknown-command message for an unrecognized command', () => {
    const { dir } = makeRegisteredProject();
    const result = run(['unknown-cmd'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/unknown/i);
  });
});
