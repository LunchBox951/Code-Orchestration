import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { MAIL_WORKER_DONE } from '../../mail/events.js';
import { openConfigStore, type ConfigStore } from '../../config/config-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openWorktreeStore, type WorktreeStore } from '../../worktrees/worktree-store.js';
import { WORKTREE_PROVISION_CONFIG_KEY } from '../../worktrees/provision.js';
import { worktreePathFor } from '../../worktrees/sling.js';
import { buildCoreRegistry } from '../core-registry.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// AC-L3-6 — co_finish END TO END through invokeTool over a REAL temp worktree (no MCP, no Conductor):
// it makes a house-style, DCO-signed commit rendered from intent, records the finish, and mails an
// informational worker_done to the recorded parent. Plus the loud-fail seams.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let mails: MailStore[] = [];
let worktreeStores: WorktreeStore[] = [];
let regs: ProjectRegistry[] = [];
let configs: ConfigStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  mails = [];
  worktreeStores = [];
  regs = [];
  configs = [];
  const data = mkdtempSync(join(tmpdir(), 'co-finish-tool-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const m of mails) m.close();
  for (const w of worktreeStores) w.close();
  for (const r of regs) r.close();
  for (const c of configs) c.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  mails = [];
  worktreeStores = [];
  regs = [];
  configs = [];
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A real main repo with a configured identity (so `git commit -s` in a linked worktree works). */
function makeMainRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-finish-tool-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** A headless ToolContext at `cwd`, sharing `repo`'s project stores (worktrees injected unless omitted). */
function makeContext(
  agent: string,
  repo: string,
  cwd: string,
  opts: { withWorktrees?: boolean } = {},
): ToolContext {
  const registry = openRegistry();
  regs.push(registry);
  const projectId = registry.register(repo);
  const mail = openMailStore(projectId);
  mails.push(mail);
  if (opts.withWorktrees === false) {
    return { agent, projectId, cwd, mail, registry };
  }
  const worktrees = openWorktreeStore(projectId);
  worktreeStores.push(worktrees);
  return { agent, projectId, cwd, mail, registry, worktrees };
}

function openConfig(): ConfigStore {
  const cfg = openConfigStore();
  configs.push(cfg);
  return cfg;
}

type FinishOut = {
  commit_sha: string;
  commit_message: string;
  worker_done_seq: number;
  finish_recorded: boolean;
};

describe('co_finish — via invokeTool over a real slung worktree', () => {
  it('commits (house-style, DCO-signed), records the finish, and pings the recorded parent', async () => {
    const repo = makeMainRepo();
    const reg = buildCoreRegistry();

    // 1) Sling a real sandbox from the main repo (records the worktree + the parent).
    const slingCtx = makeContext('lead-7', repo, repo);
    const sling = (await invokeTool(reg, slingCtx, 'co_sling', {
      parent: 'lead-7',
      branch: 'co/feature',
    })) as { worktree_path: string };
    const sandbox = sling.worktree_path;

    // 2) The worker makes a change in the sandbox (something to commit).
    writeFileSync(join(sandbox, 'feature.txt'), 'new work\n');

    // 3) Finish from INSIDE the sandbox, sharing the same project stores.
    const finishCtx = makeContext('impl-1', repo, sandbox);
    const out = (await invokeTool(reg, finishCtx, 'co_finish', {
      intent: { type: 'feat', scope: 'core', summary: 'add the feature file' },
      tests: [
        { name: 'unit', passed: true },
        { name: 'integration', passed: true },
      ],
      notes: 'all green',
    })) as FinishOut;

    expect(out.commit_message).toBe('feat(core): add the feature file');
    expect(out.finish_recorded).toBe(true);
    expect(out.commit_sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(typeof out.worker_done_seq).toBe('number');

    // The real commit landed on the branch, with the rendered message + a DCO sign-off trailer.
    expect(git(sandbox, 'rev-parse', 'HEAD')).toBe(out.commit_sha);
    expect(git(sandbox, 'log', '-1', '--pretty=%B')).toBe(
      'feat(core): add the feature file\n\nSigned-off-by: Test <t@example.com>',
    );
    // The worktree is clean after the finish (the change was committed, nothing dangling).
    expect(git(sandbox, 'status', '--porcelain')).toBe('');

    // The finish record is durable for L5 (commit + the finish's tests).
    const finish = finishCtx.worktrees?.getFinish('co/feature');
    expect(finish?.commitSha).toBe(out.commit_sha);
    expect(finish?.tests).toEqual([
      { name: 'unit', passed: true },
      { name: 'integration', passed: true },
    ]);

    // worker_done (informational) went to the recorded parent (lead-7), not @operator.
    const inbox = finishCtx.mail.inbox('lead-7');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.type).toBe(MAIL_WORKER_DONE);
    expect(inbox[0]?.sender).toBe('impl-1');
    expect(inbox[0]?.body).toContain(out.commit_sha);
  });

  it('loud-fails when the mount did not inject a worktree store (Principle 9)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('impl-1', repo, repo, { withWorktrees: false });
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_finish', {
        intent: { type: 'chore', summary: 'x' },
        tests: [],
      }),
    ).rejects.toThrow(/did not inject a worktree store/i);
  });

  it('loud-fails when finishing outside a slung sandbox (no worktree record for the branch)', async () => {
    const repo = makeMainRepo(); // on `main`, never slung → no worktree record
    const ctx = makeContext('impl-1', repo, repo);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_finish', {
        intent: { type: 'chore', summary: 'x' },
        tests: [],
      }),
    ).rejects.toThrow(/outside a slung sandbox/i);
  });

  it('rejects a commit intent with no type (input schema — fail loud)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('impl-1', repo, repo);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_finish', {
        intent: { summary: 'missing a type' },
        tests: [],
      }),
    ).rejects.toThrow(/input failed schema validation/i);
  });

  it('rejects commit-intent header injection (single-line conventional fields only)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('impl-1', repo, repo);

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_finish', {
        intent: { type: 'feat\nfix', summary: 'x' },
        tests: [],
      }),
    ).rejects.toThrow(/input failed schema validation/i);

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_finish', {
        intent: { type: 'feat', scope: 'core)', summary: 'x' },
        tests: [],
      }),
    ).rejects.toThrow(/input failed schema validation/i);

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_finish', {
        intent: { type: 'feat', summary: 'fix(core): smuggle a prebuilt header' },
        tests: [],
      }),
    ).rejects.toThrow(/input failed schema validation/i);
  });

  it('refuses to finish when a provisioned default path is visible to git', async () => {
    const repo = makeMainRepo();
    writeFileSync(join(repo, '.env'), 'SECRET=1\n'); // present but NOT ignored
    const reg = buildCoreRegistry();

    const slingCtx = makeContext('lead-7', repo, repo);
    const sling = (await invokeTool(reg, slingCtx, 'co_sling', {
      parent: 'lead-7',
      branch: 'co/leaky-env',
    })) as { worktree_path: string };

    const finishCtx = makeContext('impl-1', repo, sling.worktree_path);
    await expect(
      invokeTool(reg, finishCtx, 'co_finish', {
        intent: { type: 'feat', scope: 'core', summary: 'finish safely' },
        tests: [],
      }),
    ).rejects.toThrow(/provisioned|visible to git|\\.env/i);
  });

  it('refuses to finish when an override-added provisioned path is visible to git', async () => {
    const repo = makeMainRepo();
    writeFileSync(join(repo, '.npmrc'), '//registry.example/:_authToken=secret\n');
    const reg = buildCoreRegistry();

    const slingCtx = makeContext('lead-7', repo, repo);
    openConfig().setProjectOverride(slingCtx.projectId, WORKTREE_PROVISION_CONFIG_KEY, {
      '.npmrc': 'copy',
    });
    const sling = (await invokeTool(reg, slingCtx, 'co_sling', {
      parent: 'lead-7',
      branch: 'co/leaky-override',
    })) as { worktree_path: string };

    const finishCtx = makeContext('impl-1', repo, sling.worktree_path);
    await expect(
      invokeTool(reg, finishCtx, 'co_finish', {
        intent: { type: 'feat', scope: 'core', summary: 'finish safely' },
        tests: [],
      }),
    ).rejects.toThrow(/provisioned|visible to git|\\.npmrc/i);
  });

  it('uses the sling-recorded provisioned paths even if worktree.provision changes before finish', async () => {
    const repo = makeMainRepo();
    writeFileSync(join(repo, '.npmrc'), '//registry.example/:_authToken=secret\n');
    const reg = buildCoreRegistry();

    const slingCtx = makeContext('lead-7', repo, repo);
    const cfg = openConfig();
    cfg.setProjectOverride(slingCtx.projectId, WORKTREE_PROVISION_CONFIG_KEY, {
      '.npmrc': 'copy',
    });
    const sling = (await invokeTool(reg, slingCtx, 'co_sling', {
      parent: 'lead-7',
      branch: 'co/leaky-override-drift',
    })) as { worktree_path: string };
    expect(slingCtx.worktrees?.getWorktree('co/leaky-override-drift')?.provisioned).toEqual([
      { path: '.npmrc', mechanism: 'copy' },
    ]);

    cfg.setProjectOverride(slingCtx.projectId, WORKTREE_PROVISION_CONFIG_KEY, {
      '.npmrc': 'none',
    });

    const finishCtx = makeContext('impl-1', repo, sling.worktree_path);
    await expect(
      invokeTool(reg, finishCtx, 'co_finish', {
        intent: { type: 'feat', scope: 'core', summary: 'finish safely' },
        tests: [],
      }),
    ).rejects.toThrow(/provisioned|visible to git|\\.npmrc/i);
  });

  it('does not read malformed current worktree.provision when the sling record has provisioned paths', async () => {
    const repo = makeMainRepo();
    writeFileSync(join(repo, '.npmrc'), '//registry.example/:_authToken=secret\n');
    const reg = buildCoreRegistry();

    const slingCtx = makeContext('lead-7', repo, repo);
    const cfg = openConfig();
    cfg.setProjectOverride(slingCtx.projectId, WORKTREE_PROVISION_CONFIG_KEY, {
      '.npmrc': 'copy',
    });
    const sling = (await invokeTool(reg, slingCtx, 'co_sling', {
      parent: 'lead-7',
      branch: 'co/leaky-override-malformed-drift',
    })) as { worktree_path: string };

    cfg.setProjectOverride(slingCtx.projectId, WORKTREE_PROVISION_CONFIG_KEY, {
      '.npmrc': 'teleport',
    });

    const finishCtx = makeContext('impl-1', repo, sling.worktree_path);
    await expect(
      invokeTool(reg, finishCtx, 'co_finish', {
        intent: { type: 'feat', scope: 'core', summary: 'finish safely' },
        tests: [],
      }),
    ).rejects.toThrow(/provisioned|visible to git|\\.npmrc/i);
  });

  it('lazily uses the current provision manifest for old records without sling-recorded paths', async () => {
    const repo = makeMainRepo();
    const reg = buildCoreRegistry();
    const setupCtx = makeContext('lead-7', repo, repo);
    const branch = 'co/old-record-override';
    const sandbox = worktreePathFor(setupCtx.projectId, branch);
    mkdirSync(dirname(sandbox), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-b', branch, sandbox, 'main'], {
      cwd: repo,
      stdio: 'ignore',
    });
    setupCtx.worktrees?.recordWorktree({
      branch,
      baseRef: 'main',
      baseSha: git(repo, 'rev-parse', 'main'),
      path: sandbox,
      parent: 'lead-7',
    });
    openConfig().setProjectOverride(setupCtx.projectId, WORKTREE_PROVISION_CONFIG_KEY, {
      '.npmrc': 'copy',
    });
    writeFileSync(join(sandbox, '.npmrc'), '//registry.example/:_authToken=secret\n');

    const finishCtx = makeContext('impl-1', repo, sandbox);
    await expect(
      invokeTool(reg, finishCtx, 'co_finish', {
        intent: { type: 'feat', scope: 'core', summary: 'finish safely' },
        tests: [],
      }),
    ).rejects.toThrow(/provisioned|visible to git|\\.npmrc/i);
  });
});
