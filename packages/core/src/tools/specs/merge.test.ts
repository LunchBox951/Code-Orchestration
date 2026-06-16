import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { OPERATOR } from '../../mail/events.js';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openConfigStore } from '../../config/config-store.js';
import { IDENTITY_PERSONA_ALLOWLIST_KEY } from '../../permissions/identity-guard.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openReviewStore, type ReviewStore } from '../../review/review-store.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { openWorktreeStore, type WorktreeStore } from '../../worktrees/worktree-store.js';
import { REPO_MODE_CONFIG_KEY } from '../../worktrees/repo-mode.js';
import { worktreePathFor } from '../../worktrees/sling.js';
import { openProjectStore } from '../../store/sqlite-store.js';
import { openDispatchStore } from '../../dispatch/dispatch-store.js';
import { accountForProvider } from '../../dispatch/provider-source.js';
import type { ReviewerSpawnGate } from '../../review/merge.js';
import { openSpecStore, type SpecStore } from '../../specs/specs-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// AC-L5-1, AC-L5-3 — co_merge through invokeTool over a REAL temp repo (no remote → offline mode): it
// gates on a recorded PASS, honest-verifies the finish against the baseline, refuses without a PASS or
// on a regression, and loud-fails without its stores.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let mails: MailStore[] = [];
let reviews: ReviewStore[] = [];
let worktrees: WorktreeStore[] = [];
let rosters: RosterStore[] = [];
let regs: ProjectRegistry[] = [];
let specs: SpecStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  mails = [];
  reviews = [];
  worktrees = [];
  rosters = [];
  regs = [];
  const data = mkdtempSync(join(tmpdir(), 'co-merge-tool-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const m of mails) m.close();
  for (const r of reviews) r.close();
  for (const w of worktrees) w.close();
  for (const r of rosters) r.close();
  for (const r of regs) r.close();
  for (const s of specs) s.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  mails = [];
  reviews = [];
  worktrees = [];
  rosters = [];
  regs = [];
  specs = [];
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
  git(dir, 'commit', '-m', 'chore: init', '-m', 'Signed-off-by: Test <t@example.com>');
  git(dir, 'checkout', '-b', 'co/feature');
  writeFileSync(join(dir, 'feature.txt'), 'work\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'feat: feature', '-m', 'Signed-off-by: Test <t@example.com>');
  git(dir, 'checkout', 'main');
  return dir;
}

function setOriginHeadToMain(repo: string): void {
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

const FAKE_SHA = 'a'.repeat(40);

type MergeOut = {
  merged: boolean;
  commit_sha: string;
  commit_message: string;
  mode: 'owner' | 'contributor' | 'offline';
  baseline_failures?: string[];
};

interface CtxOpts {
  cwd: string;
  withReviews?: boolean;
  withWorktrees?: boolean;
  registerCaller?: boolean;
  role?: 'coordinator' | 'lead';
  commitIdentityReader?: ToolContext['commitIdentityReader'];
}

function setup(
  agent: string,
  opts: CtxOpts,
): { ctx: ToolContext; reviewStore?: ReviewStore; worktreeStore?: WorktreeStore } {
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
    ...(opts.commitIdentityReader != null
      ? { commitIdentityReader: opts.commitIdentityReader }
      : {}),
  };
  let reviewStore: ReviewStore | undefined;
  let worktreeStore: WorktreeStore | undefined;
  if (opts.withReviews ?? true) {
    reviewStore = openReviewStore('p-merge-tool');
    reviews.push(reviewStore);
    ctx.reviews = reviewStore;
  }
  if (opts.withWorktrees ?? true) {
    worktreeStore = openWorktreeStore('p-merge-tool');
    worktrees.push(worktreeStore);
    ctx.worktrees = worktreeStore;
  }
  const rosterStore = openRosterStore('p-merge-tool');
  rosters.push(rosterStore);
  rosterStore.recordAgent({ agentId: 'coordinator-1', role: 'coordinator', parent: '@operator' });
  if (opts.registerCaller !== false && agent !== 'coordinator-1') {
    rosterStore.recordAgent({
      agentId: agent,
      role: opts.role ?? 'lead',
      parent: 'coordinator-1',
    });
  }
  ctx.roster = rosterStore;
  return {
    ctx: ctx as ToolContext,
    ...(reviewStore ? { reviewStore } : {}),
    ...(worktreeStore ? { worktreeStore } : {}),
  };
}

/** Seed a clean PASS: clean baseline + finish + verdict with verification marker. */
function recordPass(
  reviewStore: ReviewStore,
  worktreeStore: WorktreeStore,
  parent = 'lead-2',
  target = 'main',
  commitSha = 'b'.repeat(40),
): void {
  worktreeStore.recordWorktreeAndBaseline(
    {
      branch: 'co/feature',
      baseRef: target,
      baseSha: FAKE_SHA,
      path: '/tmp/fake',
      parent,
    },
    {
      branch: 'co/feature',
      baseRef: target,
      baseSha: FAKE_SHA,
      tests: [{ name: 'test-a', passed: true }],
    },
  );
  worktreeStore.recordFinish({
    branch: 'co/feature',
    baseSha: FAKE_SHA,
    commitSha,
    tests: [{ name: 'test-a', passed: true }],
  });
  reviewStore.recordVerdict({
    reviewId: 'rev-1',
    target,
    branch: 'co/feature',
    reviewer: 'rev-7',
    verdict: 'PASS',
    blockers: [],
    suggestions: [],
    verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
  });
}

function commitSigned(repo: string, file: string, body: string, message: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, 'add', '.');
  git(repo, 'commit', '-s', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function recordPassWithoutWorktree(reviewStore: ReviewStore, worktreeStore: WorktreeStore): void {
  worktreeStore.recordBaseline({
    branch: 'co/feature',
    baseRef: 'main',
    baseSha: FAKE_SHA,
    tests: [{ name: 'test-a', passed: true }],
  });
  worktreeStore.recordFinish({
    branch: 'co/feature',
    baseSha: FAKE_SHA,
    commitSha: 'b'.repeat(40),
    tests: [{ name: 'test-a', passed: true }],
  });
  reviewStore.recordVerdict({
    reviewId: 'rev-1',
    target: 'main',
    branch: 'co/feature',
    reviewer: 'rev-7',
    verdict: 'PASS',
    blockers: [],
    suggestions: [],
    verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
  });
}

describe('co_merge (AC-L5-1, AC-L5-3)', () => {
  it('metadata points contributor users at the available gated push/PR path', () => {
    const merge = buildCoreRegistry().get('co_merge');
    expect(merge?.description).toMatch(/co_push \/ co_pr_merge/);
    expect(merge?.description).not.toMatch(/later phase/i);
  });

  it('merges a reviewed branch into the target on a recorded PASS (offline mode)', async () => {
    const repo = makeRepo();
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    recordPass(
      reviewStore!,
      worktreeStore!,
      'lead-2',
      'main',
      git(repo, 'rev-parse', 'co/feature'),
    );

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
    expect(out.baseline_failures).toBeUndefined();
  });

  it('refuses a local merge when reviewed commits are missing Signed-off-by trailers', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', {
      cwd: repo,
      commitIdentityReader: {
        read: () => [
          {
            sha: 'c'.repeat(40),
            author: 'Test <t@example.com>',
            committer: 'Test <t@example.com>',
            signoffs: [],
          },
        ],
      },
    });
    recordPass(
      reviewStore!,
      worktreeStore!,
      'lead-2',
      'main',
      git(repo, 'rev-parse', 'co/feature'),
    );

    let errorMessage = '';
    try {
      await invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      });
    } catch (cause) {
      errorMessage = cause instanceof Error ? cause.message : String(cause);
    }
    expect(errorMessage).toMatch(/missing Signed-off-by|identity guard/i);
    expect(errorMessage).not.toMatch(/persona allowlist/i);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('uses the injected git-config identity reader for merge commit identity checks', async () => {
    const repo = makeRepo();
    git(repo, 'config', 'user.name', 'Intruder');
    git(repo, 'config', 'user.email', 'intruder@example.com');
    const cfg = openConfigStore();
    try {
      cfg.setProjectOverride('p-merge-tool', IDENTITY_PERSONA_ALLOWLIST_KEY, [
        'Injected <injected@example.com>',
        'Test <t@example.com>',
      ]);
    } finally {
      cfg.close();
    }
    let readerCalled = false;
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    const toolCtx = {
      ...ctx,
      gitConfigIdentityReader: {
        read: () => {
          readerCalled = true;
          return { name: 'Injected', email: 'injected@example.com' };
        },
      },
    };
    recordPass(
      reviewStore!,
      worktreeStore!,
      'lead-2',
      'main',
      git(repo, 'rev-parse', 'co/feature'),
    );

    const out = (await invokeTool(reg, toolCtx, 'co_merge', {
      branch: 'co/feature',
      into: 'main',
      intent: { summary: 'land the feature' },
    })) as MergeOut;

    expect(readerCalled).toBe(true);
    expect(out.merged).toBe(true);
  });

  it('refuses a local merge when the integration worktree identity is outside the persona allowlist', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'config', 'user.name', 'Intruder');
    git(repo, 'config', 'user.email', 'intruder@example.com');
    const cfg = openConfigStore();
    try {
      cfg.setProjectOverride('p-merge-tool', IDENTITY_PERSONA_ALLOWLIST_KEY, [
        'Test <t@example.com>',
      ]);
    } finally {
      cfg.close();
    }
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    recordPass(
      reviewStore!,
      worktreeStore!,
      'lead-2',
      'main',
      git(repo, 'rev-parse', 'co/feature'),
    );

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      }),
    ).rejects.toThrow(/merge commit identity|outside the persona allowlist/i);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('refuses a local merge when the reviewed branch moved after the recorded PASS', async () => {
    const repo = makeRepo();
    const reviewedHead = git(repo, 'rev-parse', 'co/feature');
    const mainBefore = git(repo, 'rev-parse', 'main');
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    recordPass(reviewStore!, worktreeStore!, 'lead-2', 'main', reviewedHead);
    git(repo, 'checkout', 'co/feature');
    commitSigned(repo, 'after-review.txt', 'late\n', 'feat: late');
    git(repo, 'checkout', 'main');

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      }),
    ).rejects.toThrow(/reviewed commit|moved|stale/i);
    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
  });

  it('refuses a local merge when the branch was re-finished after the recorded PASS', async () => {
    const repo = makeRepo();
    const reviewedHead = git(repo, 'rev-parse', 'co/feature');
    const mainBefore = git(repo, 'rev-parse', 'main');
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    const now = vi.spyOn(Date, 'now').mockReturnValue(123456);
    try {
      recordPass(reviewStore!, worktreeStore!, 'lead-2', 'main', reviewedHead);
      git(repo, 'checkout', 'co/feature');
      const lateHead = commitSigned(repo, 'after-review.txt', 'late\n', 'feat: late');
      git(repo, 'checkout', 'main');
      worktreeStore!.recordFinish({
        branch: 'co/feature',
        baseSha: FAKE_SHA,
        commitSha: lateHead,
        tests: [{ name: 'test-a', passed: true }],
      });
      const legacy = openProjectStore('p-merge-tool');
      try {
        legacy.transaction((tx) => {
          const db = tx.raw as DatabaseSync;
          db.exec('UPDATE reviews SET verdict_seq = NULL');
          db.exec('UPDATE finishes SET recorded_seq = NULL');
        });
      } finally {
        legacy.close();
      }

      await expect(
        invokeTool(reg, ctx, 'co_merge', {
          branch: 'co/feature',
          into: 'main',
          intent: { summary: 'land the feature' },
        }),
      ).rejects.toThrow(/finished after review|latest finish/i);
    } finally {
      now.mockRestore();
    }
    expect(git(repo, 'rev-parse', 'main')).toBe(mainBefore);
  });

  it('refuses a local merge when git author or committer env would override an allowlisted config identity', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const cfg = openConfigStore();
    try {
      cfg.setProjectOverride('p-merge-tool', IDENTITY_PERSONA_ALLOWLIST_KEY, [
        'Test <t@example.com>',
      ]);
    } finally {
      cfg.close();
    }
    process.env.GIT_AUTHOR_NAME = 'Leaker';
    process.env.GIT_AUTHOR_EMAIL = 'leak@example.com';
    process.env.GIT_COMMITTER_NAME = 'Leaker';
    process.env.GIT_COMMITTER_EMAIL = 'leak@example.com';
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    recordPass(
      reviewStore!,
      worktreeStore!,
      'lead-2',
      'main',
      git(repo, 'rev-parse', 'co/feature'),
    );

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      }),
    ).rejects.toThrow(/merge commit identity|outside the persona allowlist/i);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('refuses contributor-mode local merge before identity inspection', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    try {
      cfg.setProjectOverride('p-merge-tool', REPO_MODE_CONFIG_KEY, 'contributor');
    } finally {
      cfg.close();
    }
    let readerCalled = false;
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', {
      cwd: repo,
      commitIdentityReader: {
        read: () => {
          readerCalled = true;
          throw new Error('identity reader should not be called');
        },
      },
    });
    recordPass(
      reviewStore!,
      worktreeStore!,
      'lead-2',
      'main',
      git(repo, 'rev-parse', 'co/feature'),
    );

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      }),
    ).rejects.toThrow(/gated co_push \/ co_pr_merge path/);
    expect(readerCalled).toBe(false);
  });

  it('defaults omitted into to the local integration branch when origin/HEAD points at origin/main', async () => {
    const repo = makeRepo();
    setOriginHeadToMain(repo);
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    recordPass(
      reviewStore!,
      worktreeStore!,
      'lead-2',
      'main',
      git(repo, 'rev-parse', 'co/feature'),
    );

    const out = (await invokeTool(reg, ctx, 'co_merge', {
      branch: 'co/feature',
      intent: { summary: 'land the feature' },
    })) as MergeOut;

    expect(out.merged).toBe(true);
    expect(out.mode).toBe('offline');
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(out.commit_sha);
  });

  it('defaults omitted into to the current local integration branch, not the repo default', async () => {
    const repo = makeRepo();
    setOriginHeadToMain(repo);
    git(repo, 'checkout', '-b', 'co/phase');
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    recordPass(
      reviewStore!,
      worktreeStore!,
      'lead-2',
      'co/phase',
      git(repo, 'rev-parse', 'co/feature'),
    );

    const out = (await invokeTool(reg, ctx, 'co_merge', {
      branch: 'co/feature',
      intent: { summary: 'land the feature' },
    })) as MergeOut;

    expect(out.merged).toBe(true);
    expect(git(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('co/phase');
    expect(git(repo, 'rev-parse', 'co/phase')).toBe(out.commit_sha);
    expect(git(repo, 'rev-parse', 'main')).not.toBe(out.commit_sha);
  });

  it('lets a coordinator integrate a directly owned implementer branch after PASS', async () => {
    const repo = makeRepo();
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('coordinator-1', { cwd: repo });
    recordPass(
      reviewStore!,
      worktreeStore!,
      'coordinator-1',
      'main',
      git(repo, 'rev-parse', 'co/feature'),
    );

    const out = (await invokeTool(reg, ctx, 'co_merge', {
      branch: 'co/feature',
      into: 'main',
      intent: { summary: 'land direct worker output' },
    })) as MergeOut;

    expect(out.merged).toBe(true);
    expect(out.mode).toBe('offline');
  });

  it('refuses an unregistered caller before a clean PASS merge side effect', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', {
      cwd: repo,
      registerCaller: false,
    });
    recordPass(
      reviewStore!,
      worktreeStore!,
      'lead-2',
      'main',
      git(repo, 'rev-parse', 'co/feature'),
    );

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      }),
    ).rejects.toThrow(/not registered in the roster/i);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('refuses the merge with no recorded PASS — HEAD is unchanged', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const reg = buildCoreRegistry();
    const { ctx, worktreeStore } = setup('lead-2', { cwd: repo });
    worktreeStore!.recordWorktree({
      branch: 'co/feature',
      baseRef: 'main',
      baseSha: FAKE_SHA,
      path: '/tmp/fake',
      parent: 'lead-2',
    });

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      }),
    ).rejects.toThrow(/no review verdict is recorded/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('refuses a non-override merge when the source worktree record is missing', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    recordPassWithoutWorktree(reviewStore!, worktreeStore!);

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      }),
    ).rejects.toThrow(/worktree record/i);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('rejects a non-operator override before checking worktree records', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    recordPassWithoutWorktree(reviewStore!, worktreeStore!);

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
        operator_override: true,
        reason: 'operator accepted missing pass',
      }),
    ).rejects.toThrow(/operator_override.*@operator|reserved for @operator/i);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('allows @operator to use an audited override with a reason', async () => {
    const repo = makeRepo();
    const reg = buildCoreRegistry();
    const { ctx, worktreeStore } = setup(OPERATOR, { cwd: repo, registerCaller: false });
    worktreeStore!.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path: '/tmp/fake',
        parent: OPERATOR,
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        tests: [],
      },
    );

    const out = (await invokeTool(reg, ctx, 'co_merge', {
      branch: 'co/feature',
      into: 'main',
      intent: { summary: 'land the feature' },
      operator_override: true,
      reason: 'hotfix: prod down',
    })) as { merged: boolean; overridden?: boolean; override_reason?: string };

    expect(out.merged).toBe(true);
    expect(out.overridden).toBe(true);
    expect(out.override_reason).toBe('hotfix: prod down');
  });

  it('@operator override surfaces verification regressions in structured output', async () => {
    const repo = makeRepo();
    const reg = buildCoreRegistry();
    const { ctx, worktreeStore } = setup(OPERATOR, {
      cwd: repo,
      registerCaller: false,
      commitIdentityReader: {
        read: () => [
          {
            sha: 'd'.repeat(40),
            author: 'Test <t@example.com>',
            committer: 'Test <t@example.com>',
            signoffs: ['Test <t@example.com>'],
          },
        ],
      },
    });
    worktreeStore!.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path: '/tmp/fake',
        parent: OPERATOR,
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        tests: [{ name: 'test-a', passed: true }],
      },
    );
    worktreeStore!.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [{ name: 'test-a', passed: false }],
    });

    const out = (await invokeTool(reg, ctx, 'co_merge', {
      branch: 'co/feature',
      into: 'main',
      intent: { summary: 'land known regression' },
      operator_override: true,
      reason: 'accept known regression',
    })) as { merged: boolean; verification_failures?: string[]; escalated?: boolean };

    expect(out.merged).toBe(true);
    expect(out.verification_failures).toEqual(['test-a']);
    expect(out.escalated).toBeUndefined();
    const audit = openProjectStore('p-merge-tool');
    try {
      const row = audit.transaction(
        (tx) =>
          (tx.raw as DatabaseSync)
            .prepare(
              'SELECT override_verification_failures FROM reviews WHERE target = ? AND branch = ?',
            )
            .get('main', 'co/feature') as { override_verification_failures: string | null },
      );
      expect(JSON.parse(row.override_verification_failures ?? '[]')).toEqual(['test-a']);
    } finally {
      audit.close();
    }
  });

  it('@operator override surfaces baseline verification failures in structured output', async () => {
    const repo = makeRepo();
    const reg = buildCoreRegistry();
    const { ctx, worktreeStore } = setup(OPERATOR, {
      cwd: repo,
      registerCaller: false,
      commitIdentityReader: {
        read: () => [
          {
            sha: 'd'.repeat(40),
            author: 'Test <t@example.com>',
            committer: 'Test <t@example.com>',
            signoffs: ['Test <t@example.com>'],
          },
        ],
      },
    });
    worktreeStore!.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path: '/tmp/fake',
        parent: OPERATOR,
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        tests: [{ name: 'test-a', passed: false }],
      },
    );
    worktreeStore!.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [{ name: 'test-a', passed: false }],
    });

    const out = (await invokeTool(reg, ctx, 'co_merge', {
      branch: 'co/feature',
      into: 'main',
      intent: { summary: 'land known baseline failure' },
      operator_override: true,
      reason: 'accept known baseline failure',
    })) as {
      merged: boolean;
      baseline_failures?: string[];
      verification_failures?: string[];
    };

    expect(out.merged).toBe(true);
    expect(out.baseline_failures).toEqual(['test-a']);
    expect(out.verification_failures).toEqual(['test-a']);
  });

  it('@operator override can merge a lead-parented worktree while other guards still run', async () => {
    const repo = makeRepo();
    const reg = buildCoreRegistry();
    const { ctx, worktreeStore } = setup(OPERATOR, { cwd: repo, registerCaller: false });
    worktreeStore!.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path: '/tmp/fake',
        parent: 'lead-2',
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        tests: [],
      },
    );

    const out = (await invokeTool(reg, ctx, 'co_merge', {
      branch: 'co/feature',
      into: 'main',
      intent: { summary: 'land lead branch' },
      operator_override: true,
      reason: 'prod hotfix',
    })) as { merged: boolean; overridden?: boolean };

    expect(out.merged).toBe(true);
    expect(out.overridden).toBe(true);
  });

  it('@operator override without a non-empty reason is rejected before git ops', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const reg = buildCoreRegistry();
    const { ctx, worktreeStore } = setup(OPERATOR, { cwd: repo, registerCaller: false });
    worktreeStore!.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path: '/tmp/fake',
        parent: OPERATOR,
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        tests: [],
      },
    );

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
        operator_override: true,
      }),
    ).rejects.toThrow(/operator_override requires a non-empty reason/);
    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
        operator_override: true,
        reason: '   ',
      }),
    ).rejects.toThrow(/operator_override requires a non-empty reason/);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('rejects agent-supplied operator override even with a reason', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const reg = buildCoreRegistry();
    const { ctx } = setup('lead-2', { cwd: repo });

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
        operator_override: true,
        reason: 'hotfix',
      }),
    ).rejects.toThrow(/operator_override.*@operator|reserved for @operator/i);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('refuses a non-override merge when the source worktree record was removed', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    const path = worktreePathFor('p-merge-tool', 'co/feature');
    worktreeStore!.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path,
        parent: 'lead-2',
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        tests: [{ name: 'test-a', passed: true }],
      },
    );
    worktreeStore!.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [{ name: 'test-a', passed: true }],
    });
    reviewStore!.recordVerdict({
      reviewId: 'rev-1',
      target: 'main',
      branch: 'co/feature',
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });
    worktreeStore!.removeWorktree('co/feature', {
      repoCwd: repo,
      gitExec: () => {},
      fs: {
        exists: () => false,
        isSymlink: () => false,
        realpath: (p) => p,
        removeDir: () => {},
      },
    });

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      }),
    ).rejects.toThrow(/worktree record/i);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('refuses a non-override merge when the source worktree was spawned by another parent', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    worktreeStore!.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path: '/tmp/fake',
        parent: 'other-lead',
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        tests: [{ name: 'test-a', passed: true }],
      },
    );
    worktreeStore!.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [{ name: 'test-a', passed: true }],
    });
    reviewStore!.recordVerdict({
      reviewId: 'rev-1',
      target: 'main',
      branch: 'co/feature',
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      }),
    ).rejects.toThrow(/worktree parent/i);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('rejects an agent override before checking worktree parent ownership', async () => {
    const repo = makeRepo();
    const headBefore = git(repo, 'rev-parse', 'HEAD');
    const reg = buildCoreRegistry();
    const { ctx, worktreeStore } = setup('lead-2', { cwd: repo });
    worktreeStore!.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path: '/tmp/fake',
        parent: 'other-lead',
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        tests: [{ name: 'test-a', passed: true }],
      },
    );

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
        operator_override: true,
        reason: 'operator accepted missing pass',
      }),
    ).rejects.toThrow(/operator_override.*@operator|reserved for @operator/i);
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

  it('live co_merge: production resolver routes baseline-failure escalation to the caller parent (Phase D)', async () => {
    const repo = makeRepo();
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-1', { cwd: repo });
    worktreeStore!.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path: '/tmp/fake',
        parent: 'lead-1',
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        tests: [
          { name: 'test-a', passed: true },
          { name: 'test-b', passed: false }, // pre-existing baseline failure
        ],
      },
    );
    worktreeStore!.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [
        { name: 'test-a', passed: true },
        { name: 'test-b', passed: false }, // fail→fail: baseline failure (pre-existing)
      ],
    });
    reviewStore!.recordVerdict({
      reviewId: 'rev-1',
      target: 'main',
      branch: 'co/feature',
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'fail', baseline_compared: true },
    });

    const out = (await invokeTool(reg, ctx, 'co_merge', {
      branch: 'co/feature',
      into: 'main',
      intent: { summary: 'land the feature' },
    })) as MergeOut & { escalated?: boolean; baseline_failures?: string[] };

    // Merge proceeds (baseline failures are allowed — just flagged + escalated).
    expect(out.merged).toBe(true);
    expect(out.baseline_failures).toEqual(['test-b']);
    expect(out.escalated).toBe(true);

    // The production resolver routes from caller lead-1 to its roster parent coordinator-1.
    const escalations = ctx.mail!.inbox('coordinator-1').filter((m) => m.type === 'escalation');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.subject).toContain('baseline failure');
    expect(escalations[0]!.subject).toContain('co/feature');
  });

  it('refuses the merge on a regression (pass→fail finish) even with a PASS verdict', async () => {
    const repo = makeRepo();
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    // Baseline: test-a passes. Finish: test-a fails (regression).
    worktreeStore!.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path: '/tmp/fake',
        parent: 'lead-2',
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        tests: [{ name: 'test-a', passed: true }],
      },
    );
    worktreeStore!.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [{ name: 'test-a', passed: false }],
    });
    reviewStore!.recordVerdict({
      reviewId: 'rev-1',
      target: 'main',
      branch: 'co/feature',
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'fail', baseline_compared: true },
    });

    await expect(
      invokeTool(reg, ctx, 'co_merge', {
        branch: 'co/feature',
        into: 'main',
        intent: { summary: 'land the feature' },
      }),
    ).rejects.toThrow(/regression/);
  });
});

// ── P2 / AC-S10-2 — live reviewer trigger path ───────────────────────────────────────────────────────
describe('co_merge — P2 live reviewer trigger path (AC-S10-2)', () => {
  it.each([
    ['malformed', 'task-merge-live', false],
    ['missing locked spec', 'spec:missing-task#locked', false],
    ['draft spec', 'spec:task-draft#locked', true],
  ] as const)(
    'human reviewer refuses %s spec_ref before creating review mail',
    async (_label, specRef, seedDraft) => {
      const repo = makeRepo();
      const reg = buildCoreRegistry();
      const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
      worktreeStore!.recordWorktreeAndBaseline(
        {
          branch: 'co/feature',
          baseRef: 'main',
          baseSha: FAKE_SHA,
          path: '/tmp/fake',
          parent: 'lead-2',
        },
        { branch: 'co/feature', baseRef: 'main', baseSha: FAKE_SHA, tests: [] },
      );
      const specStore = openSpecStore('p-merge-tool');
      specs.push(specStore);
      if (seedDraft) {
        specStore.recordDraft({
          taskId: 'task-draft',
          title: 'Draft task',
          goal: 'not locked yet',
          criteria: [{ text: 'locked before review', verify: 'pnpm test' }],
          body: '',
          actor: OPERATOR,
        });
      }
      const cfg = openConfigStore();
      try {
        cfg.setProjectOverride('p-merge-tool', 'review.worker_merge.reviewer', 'human');
      } finally {
        cfg.close();
      }
      const toolCtx = {
        ...ctx,
        specs: specStore,
        reviewerSpawnGate: {
          spawn: () => {
            throw new Error('human review should not spawn an agent reviewer');
          },
        } satisfies ReviewerSpawnGate,
      };

      await expect(
        invokeTool(reg, toolCtx, 'co_merge', {
          branch: 'co/feature',
          into: 'main',
          spec_ref: specRef,
          intent: { summary: 'trigger a human review' },
        }),
      ).rejects.toThrow(/locked acceptance criteria|spec_ref|spec:<taskId>#locked/i);

      expect(reviewStore!.getReviewRequest('main', 'co/feature')).toBeUndefined();
      expect(ctx.mail.inbox(OPERATOR).filter((m) => m.type === 'review_request')).toHaveLength(0);
    },
  );

  it('AC-S10-2.1: returns review_pending:true and fires spawn gate when reviewerSpawnGate is wired and no PASS exists', async () => {
    // Freeze time at epoch 0 so the 1970-epoch snapshot timestamps are fresh (not stale) when the
    // handler calls Date.now() to build the trigger gate's nowMs. A healthy snapshot → dispatch policy
    // returns 'placed' → fireSpawn calls reviewerSpawnGate.spawn(), then co_merge drains the spawn.
    vi.useFakeTimers({ now: 0 });
    try {
      const repo = makeRepo();
      const reg = buildCoreRegistry();
      const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
      worktreeStore!.recordWorktreeAndBaseline(
        {
          branch: 'co/feature',
          baseRef: 'main',
          baseSha: FAKE_SHA,
          path: '/tmp/fake',
          parent: 'lead-2',
        },
        { branch: 'co/feature', baseRef: 'main', baseSha: FAKE_SHA, tests: [] },
      );
      const dispatch = openDispatchStore('p-merge-tool');
      dispatch.recordSnapshot({
        provider: 'claude',
        account: accountForProvider('claude'),
        available: true,
        source: 'test',
        sampled_at: '1970-01-01T00:00:00.000Z',
        windows: [{ kind: 'five_hour', used_pct: 0.1, reset_at: '1970-01-01T05:00:00.000Z' }],
      });
      const spawned: Array<{ projectId: string; agent: string }> = [];
      const spawnGate: ReviewerSpawnGate = {
        spawn(projectId, placement) {
          spawned.push({ projectId, agent: placement.agent });
          return Promise.resolve();
        },
      };
      const toolCtx = { ...ctx, dispatch, reviewerSpawnGate: spawnGate };
      try {
        const out = (await invokeTool(reg, toolCtx, 'co_merge', {
          branch: 'co/feature',
          into: 'main',
          spec_ref: 'spec:task-merge-live#locked',
          intent: { summary: 'trigger a review' },
        })) as { merged: boolean; review_pending?: boolean };
        expect(out.merged).toBe(false);
        expect(out.review_pending).toBe(true);
        expect(reviewStore!.getReviewRequest('main', 'co/feature')?.specRef).toEqual({
          kind: 'criteria',
          ref: 'spec:task-merge-live#locked',
        });
        // The spawn body runs before co_merge returns review_pending.
        expect(spawned).toHaveLength(1);
        expect(spawned[0]!.projectId).toBe('p-merge-tool');
        // Assert the agent id (reviewer seat) so a wrong-key regression is caught (spy-key-value-blind-spot).
        expect(spawned[0]!.agent).toMatch(/^reviewer@rev-/);
      } finally {
        dispatch.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC-S10-2.1b: an existing ISSUES verdict triggers a fresh reviewer spawn instead of reusing the stale review id', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const repo = makeRepo();
      const reg = buildCoreRegistry();
      const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
      worktreeStore!.recordWorktreeAndBaseline(
        {
          branch: 'co/feature',
          baseRef: 'main',
          baseSha: FAKE_SHA,
          path: '/tmp/fake',
          parent: 'lead-2',
        },
        {
          branch: 'co/feature',
          baseRef: 'main',
          baseSha: FAKE_SHA,
          tests: [{ name: 'test-a', passed: true }],
        },
      );
      reviewStore!.recordReviewRequested({
        reviewId: 'rev-stale',
        target: 'main',
        branch: 'co/feature',
        requestedBy: 'lead-2',
        scope: 'worker_merge',
      });
      reviewStore!.recordVerdict({
        reviewId: 'rev-stale',
        target: 'main',
        branch: 'co/feature',
        reviewer: 'rev-7',
        verdict: 'ISSUES',
        blockers: [{ summary: 'needs work' }],
        suggestions: [],
        verification: {
          commands_run: ['pnpm test'],
          suite_result: 'pass',
          baseline_compared: true,
        },
      });
      const dispatch = openDispatchStore('p-merge-tool');
      try {
        dispatch.recordSnapshot({
          provider: 'claude',
          account: accountForProvider('claude'),
          available: true,
          source: 'test',
          sampled_at: '1970-01-01T00:00:00.000Z',
          windows: [{ kind: 'five_hour', used_pct: 0.1, reset_at: '1970-01-01T05:00:00.000Z' }],
        });
        const spawnCalls: string[] = [];
        const spawnGate: ReviewerSpawnGate = {
          spawn: async (_projectId, placement) => {
            spawnCalls.push(placement.agent);
          },
        };
        const toolCtx = {
          ...ctx,
          dispatch,
          reviewerSpawnGate: spawnGate,
        } as ToolContext;

        const out = (await invokeTool(reg, toolCtx, 'co_merge', {
          branch: 'co/feature',
          into: 'main',
          intent: { summary: 'land the feature' },
        })) as { merged: boolean; review_pending?: boolean };
        const placements = dispatch.readPlacements();

        expect(out.review_pending).toBe(true);
        expect(spawnCalls).toHaveLength(1);
        expect(spawnCalls[0]).not.toContain('rev-stale');
        expect(placements).toHaveLength(1);
        expect(placements[0]!.reviewId).not.toBe('rev-stale');
      } finally {
        dispatch.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC-S10-2.1b: same-millisecond live review triggers use distinct review ids', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const repo = makeRepo();
      const reg = buildCoreRegistry();
      const { ctx, worktreeStore } = setup('lead-2', { cwd: repo });
      for (const branch of ['co/feature-a', 'co/feature-b'] as const) {
        worktreeStore!.recordWorktreeAndBaseline(
          {
            branch,
            baseRef: branch === 'co/feature-a' ? 'main' : 'co/target-b',
            baseSha: FAKE_SHA,
            path: `/tmp/${branch.replaceAll('/', '-')}`,
            parent: 'lead-2',
          },
          {
            branch,
            baseRef: branch === 'co/feature-a' ? 'main' : 'co/target-b',
            baseSha: FAKE_SHA,
            tests: [],
          },
        );
      }
      const dispatch = openDispatchStore('p-merge-tool');
      dispatch.recordSnapshot({
        provider: 'claude',
        account: accountForProvider('claude'),
        available: true,
        source: 'test',
        sampled_at: '1970-01-01T00:00:00.000Z',
        windows: [{ kind: 'five_hour', used_pct: 0.1, reset_at: '1970-01-01T05:00:00.000Z' }],
      });
      const spawnGate: ReviewerSpawnGate = {
        spawn: async () => {},
      };
      const toolCtx = { ...ctx, dispatch, reviewerSpawnGate: spawnGate } as ToolContext;
      try {
        await invokeTool(reg, toolCtx, 'co_merge', {
          branch: 'co/feature-a',
          into: 'main',
          intent: { summary: 'trigger first review' },
        });
        await invokeTool(reg, toolCtx, 'co_merge', {
          branch: 'co/feature-b',
          into: 'co/target-b',
          intent: { summary: 'trigger second review' },
        });

        const reviewIds = dispatch
          .readPlacements()
          .map((placement) => placement.reviewId)
          .filter((reviewId): reviewId is string => reviewId !== undefined);
        expect(reviewIds).toHaveLength(2);
        expect(new Set(reviewIds).size).toBe(2);
      } finally {
        dispatch.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC-S10-2.1b: rejects when the live reviewer spawn gate fails', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const repo = makeRepo();
      const reg = buildCoreRegistry();
      const { ctx, worktreeStore } = setup('lead-2', { cwd: repo });
      worktreeStore!.recordWorktreeAndBaseline(
        {
          branch: 'co/feature',
          baseRef: 'main',
          baseSha: FAKE_SHA,
          path: '/tmp/fake',
          parent: 'lead-2',
        },
        { branch: 'co/feature', baseRef: 'main', baseSha: FAKE_SHA, tests: [] },
      );
      const dispatch = openDispatchStore('p-merge-tool');
      dispatch.recordSnapshot({
        provider: 'claude',
        account: accountForProvider('claude'),
        available: true,
        source: 'test',
        sampled_at: '1970-01-01T00:00:00.000Z',
        windows: [{ kind: 'five_hour', used_pct: 0.1, reset_at: '1970-01-01T05:00:00.000Z' }],
      });
      const toolCtx = {
        ...ctx,
        dispatch,
        reviewerSpawnGate: {
          spawn: () => Promise.reject(new Error('reviewer spawn failed')),
        } satisfies ReviewerSpawnGate,
      };
      try {
        await expect(
          invokeTool(reg, toolCtx, 'co_merge', {
            branch: 'co/feature',
            into: 'main',
            intent: { summary: 'trigger a review' },
          }),
        ).rejects.toThrow(/reviewer spawn failed/);
      } finally {
        dispatch.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC-S10-2.1c: retries an already-recorded reviewer placement after a live spawn failure', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const repo = makeRepo();
      const reg = buildCoreRegistry();
      const { ctx, worktreeStore } = setup('lead-2', { cwd: repo });
      worktreeStore!.recordWorktreeAndBaseline(
        {
          branch: 'co/feature',
          baseRef: 'main',
          baseSha: FAKE_SHA,
          path: '/tmp/fake',
          parent: 'lead-2',
        },
        { branch: 'co/feature', baseRef: 'main', baseSha: FAKE_SHA, tests: [] },
      );
      const dispatch = openDispatchStore('p-merge-tool');
      dispatch.recordSnapshot({
        provider: 'claude',
        account: accountForProvider('claude'),
        available: true,
        source: 'test',
        sampled_at: '1970-01-01T00:00:00.000Z',
        windows: [{ kind: 'five_hour', used_pct: 0.1, reset_at: '1970-01-01T05:00:00.000Z' }],
      });
      let attempts = 0;
      const toolCtx = {
        ...ctx,
        dispatch,
        reviewerSpawnGate: {
          spawn: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('transient spawn failed');
          },
        } satisfies ReviewerSpawnGate,
      };
      try {
        await expect(
          invokeTool(reg, toolCtx, 'co_merge', {
            branch: 'co/feature',
            into: 'main',
            intent: { summary: 'trigger a review' },
          }),
        ).rejects.toThrow(/transient spawn failed/);

        const out = (await invokeTool(reg, toolCtx, 'co_merge', {
          branch: 'co/feature',
          into: 'main',
          intent: { summary: 'retry the same review placement' },
        })) as { merged: boolean; review_pending?: boolean };

        expect(out.merged).toBe(false);
        expect(out.review_pending).toBe(true);
        expect(attempts).toBe(2);
      } finally {
        dispatch.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC-S10-2.2: headless path (no reviewerSpawnGate) merges normally on recorded PASS — unchanged', async () => {
    // Confirms the P2 seam is purely ADDITIVE: absent gate → falls through to the existing merge gate.
    const repo = makeRepo();
    const reg = buildCoreRegistry();
    const { ctx, reviewStore, worktreeStore } = setup('lead-2', { cwd: repo });
    recordPass(
      reviewStore!,
      worktreeStore!,
      'lead-2',
      'main',
      git(repo, 'rev-parse', 'co/feature'),
    );
    const out = (await invokeTool(reg, ctx, 'co_merge', {
      branch: 'co/feature',
      into: 'main',
      intent: { summary: 'land the feature' },
    })) as { merged: boolean; review_pending?: boolean };
    expect(out.merged).toBe(true);
    expect(out.review_pending).toBeUndefined();
  });

  it('AC-S10-2.3: operator-override does not trigger the spawn gate even when reviewerSpawnGate is wired', async () => {
    // Defensive invariant (nit-a): the spawn gate must NOT fire on the operator-override path.
    // The operator bypasses the review gate entirely; spawning a reviewer would start an unwanted
    // review for a merge that the operator has already decided to force through.
    const repo = makeRepo();
    const reg = buildCoreRegistry();
    const { ctx, worktreeStore } = setup(OPERATOR, { cwd: repo, registerCaller: false });
    worktreeStore!.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path: '/tmp/fake',
        parent: OPERATOR,
      },
      { branch: 'co/feature', baseRef: 'main', baseSha: FAKE_SHA, tests: [] },
    );

    const spawned: Array<{ projectId: string; agent: string }> = [];
    const spawnGate: ReviewerSpawnGate = {
      spawn(projectId, placement) {
        spawned.push({ projectId, agent: placement.agent });
        return Promise.resolve();
      },
    };

    const toolCtx = { ...ctx, reviewerSpawnGate: spawnGate };
    const out = (await invokeTool(reg, toolCtx, 'co_merge', {
      branch: 'co/feature',
      into: 'main',
      intent: { summary: 'operator hotfix' },
      operator_override: true,
      reason: 'hotfix: prod down',
    })) as { merged: boolean; review_pending?: boolean; overridden?: boolean };

    expect(out.merged).toBe(true);
    expect(out.overridden).toBe(true);
    expect(out.review_pending).toBeUndefined();
    // The spawn gate must NOT fire on the operator-override path.
    expect(spawned).toHaveLength(0);
  });
});
