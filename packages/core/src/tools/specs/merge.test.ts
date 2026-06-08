import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openReviewStore, type ReviewStore } from '../../review/review-store.js';
import { openWorktreeStore, type WorktreeStore } from '../../worktrees/worktree-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// AC-L5-1 — co_merge through invokeTool over a REAL temp repo (no remote → offline mode): it gates on a
// recorded PASS and lands a real merge commit, refuses without one, and loud-fails without its stores.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let mails: MailStore[] = [];
let reviews: ReviewStore[] = [];
let worktrees: WorktreeStore[] = [];
let regs: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  mails = [];
  reviews = [];
  worktrees = [];
  regs = [];
  const data = mkdtempSync(join(tmpdir(), 'co-merge-tool-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const m of mails) m.close();
  for (const r of reviews) r.close();
  for (const w of worktrees) w.close();
  for (const r of regs) r.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  mails = [];
  reviews = [];
  worktrees = [];
  regs = [];
});

function git(cwd: string, ...args: string[]): string {
  // stderr ignored so git's "Switched to branch …" chatter does not pollute test output.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** A real repo (NO remote → resolves to offline mode), with `main` + a `co/feature` branch. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-merge-tool-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'chore: init');
  git(dir, 'checkout', '-b', 'co/feature');
  writeFileSync(join(dir, 'feature.txt'), 'work\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'feat: feature');
  git(dir, 'checkout', 'main');
  return dir;
}

type MergeOut = {
  merged: boolean;
  commit_sha: string;
  commit_message: string;
  mode: 'owner' | 'contributor' | 'offline';
};

interface CtxOpts {
  cwd: string;
  withReviews?: boolean;
  withWorktrees?: boolean;
}

function setup(agent: string, opts: CtxOpts): { ctx: ToolContext; reviewStore?: ReviewStore } {
  const mail = openMailStore('p-merge-tool');
  mails.push(mail);
  const registry = openRegistry();
  regs.push(registry);
  const ctx: { -readonly [K in keyof ToolContext]?: ToolContext[K] } = {
    agent,
    projectId: 'p-merge-tool',
    cwd: opts.cwd,
    mail,
    registry,
  };
  let reviewStore: ReviewStore | undefined;
  if (opts.withReviews ?? true) {
    reviewStore = openReviewStore('p-merge-tool');
    reviews.push(reviewStore);
    ctx.reviews = reviewStore;
  }
  if (opts.withWorktrees ?? true) {
    const w = openWorktreeStore('p-merge-tool');
    worktrees.push(w);
    ctx.worktrees = w;
  }
  return { ctx: ctx as ToolContext, ...(reviewStore ? { reviewStore } : {}) };
}

function recordPass(store: ReviewStore): void {
  store.recordVerdict({
    reviewId: 'rev-1',
    target: 'main',
    branch: 'co/feature',
    reviewer: 'rev-7',
    verdict: 'PASS',
    blockers: [],
    suggestions: [],
  });
}

describe('co_merge (AC-L5-1)', () => {
  it('merges a reviewed branch into the target on a recorded PASS (offline mode)', async () => {
    const repo = makeRepo();
    const reg = buildCoreRegistry();
    const { ctx, reviewStore } = setup('lead-2', { cwd: repo });
    recordPass(reviewStore!);

    const out = (await invokeTool(reg, ctx, 'co_merge', {
      branch: 'co/feature',
      into: 'main',
      intent: { summary: 'land the feature' },
    })) as MergeOut;

    expect(out.merged).toBe(true);
    expect(out.mode).toBe('offline');
    expect(out.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.commit_message).toContain('[reviewed: PASS]');
    // The merge really landed on main, with no orchestration file left in the tree (Principle 12).
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(out.commit_sha);
    expect(existsSync(join(repo, 'feature.txt'))).toBe(true);
    expect(existsSync(join(repo, '.co'))).toBe(false);
  });

  it('refuses the merge with no recorded PASS — HEAD is unchanged', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const reg = buildCoreRegistry();
    const { ctx } = setup('lead-2', { cwd: repo });

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      }),
    ).rejects.toThrow(/no review verdict is recorded/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('loud-fails when the mount injected no review store (Principle 9)', async () => {
    const reg = buildCoreRegistry();
    const { ctx } = setup('lead-2', { cwd: '/repo', withReviews: false });
    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'x' },
      }),
    ).rejects.toThrow(/ctx\.reviews absent/);
  });

  it('loud-fails when the mount injected no worktree store (Principle 9)', async () => {
    const reg = buildCoreRegistry();
    const { ctx } = setup('lead-2', { cwd: '/repo', withWorktrees: false });
    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'x' },
      }),
    ).rejects.toThrow(/ctx\.worktrees absent/);
  });
});
