import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openConfigStore, type ConfigStore } from '../../config/config-store.js';
import { OPERATOR } from '../../mail/events.js';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import {
  IDENTITY_PERSONA_ALLOWLIST_KEY,
  type CommitIdentityReader,
  type CommitIdentity,
} from '../../permissions/identity-guard.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openReviewStore, type ReviewStore } from '../../review/review-store.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { openWorktreeStore, type WorktreeStore } from '../../worktrees/worktree-store.js';
import { REPO_MODE_CONFIG_KEY } from '../../worktrees/repo-mode.js';
import { openProjectStore } from '../../store/sqlite-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// AC-L6a-7 — co_pr_merge identity guard: mirror of push.test.ts for the PR path.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let mails: MailStore[] = [];
let worktrees: WorktreeStore[] = [];
let reviews: ReviewStore[] = [];
let rosters: RosterStore[] = [];
let regs: ProjectRegistry[] = [];
let configs: ConfigStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  mails = [];
  worktrees = [];
  reviews = [];
  rosters = [];
  regs = [];
  configs = [];
  const data = mkdtempSync(join(tmpdir(), 'co-prmerge-guard-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const m of mails) m.close();
  for (const w of worktrees) w.close();
  for (const r of reviews) r.close();
  for (const r of rosters) r.close();
  for (const r of regs) r.close();
  for (const c of configs) c.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  mails = [];
  worktrees = [];
  reviews = [];
  rosters = [];
  regs = [];
  configs = [];
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-prmerge-guard-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 'persona@noreply.github.com');
  git(dir, 'config', 'user.name', 'Persona');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'chore: init');
  git(dir, 'checkout', '-b', 'co/feature');
  writeFileSync(join(dir, 'feat.txt'), 'feat\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'feat: feature');
  git(dir, 'checkout', 'main');
  return dir;
}

function setOriginHeadToMain(repo: string): void {
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

function commitSigned(repo: string, file: string, body: string, message: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, 'add', '.');
  git(repo, 'commit', '-s', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

const PERSONA = 'Persona <persona@noreply.github.com>';
const FAKE_BASE_SHA = 'a'.repeat(40);

const SAMPLE_INTENT = {
  why: 'needed',
  what_changed: 'added feature',
  verification: 'pnpm test passed',
  conventions: 'follows style guide',
};

function makeCtxBundle(
  cwd: string,
  commitIdentityReader?: CommitIdentityReader,
  opts: {
    seedWorktree?: boolean;
    parent?: string;
    registerCaller?: boolean;
    agent?: string;
    role?: 'coordinator' | 'lead';
  } = {},
): { ctx: ToolContext; worktreeStore: WorktreeStore; reviewStore: ReviewStore } {
  const agent = opts.agent ?? 'lead-x';
  const mail = openMailStore('p-prmerge-guard');
  mails.push(mail);
  const registry = openRegistry();
  regs.push(registry);
  const worktreeStore = openWorktreeStore('p-prmerge-guard');
  worktrees.push(worktreeStore);
  const reviewStore = openReviewStore('p-prmerge-guard');
  reviews.push(reviewStore);
  const rosterStore = openRosterStore('p-prmerge-guard');
  rosters.push(rosterStore);
  rosterStore.recordAgent({ agentId: 'coordinator-1', role: 'coordinator', parent: '@operator' });
  if (opts.registerCaller !== false && agent !== 'coordinator-1') {
    rosterStore.recordAgent({
      agentId: agent,
      role: opts.role ?? 'lead',
      parent: 'coordinator-1',
    });
  }

  if (opts.seedWorktree !== false) {
    worktreeStore.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_BASE_SHA,
        path: '/fake',
        parent: opts.parent ?? agent,
      },
      { branch: 'co/feature', baseRef: 'main', baseSha: FAKE_BASE_SHA, tests: [] },
    );
  }

  const ctx: ToolContext = {
    agent,
    projectId: 'p-prmerge-guard',
    cwd,
    mail,
    registry,
    worktrees: worktreeStore,
    reviews: reviewStore,
    roster: rosterStore,
    ...(commitIdentityReader !== undefined ? { commitIdentityReader } : {}),
  };
  return { ctx, worktreeStore, reviewStore };
}

function makeCtx(
  cwd: string,
  commitIdentityReader?: CommitIdentityReader,
  opts: {
    seedWorktree?: boolean;
    parent?: string;
    registerCaller?: boolean;
    agent?: string;
    role?: 'coordinator' | 'lead';
  } = {},
): ToolContext {
  return makeCtxBundle(cwd, commitIdentityReader, opts).ctx;
}

function fakeReader(commits: CommitIdentity[]): CommitIdentityReader {
  return { read: () => commits };
}

describe('co_pr_merge identity guard (AC-L6a-7)', () => {
  it('refuses loudly when a commit has an off-persona identity — named blocker in error', async () => {
    const repo = makeRepo();
    const offPersonaCommit: CommitIdentity = {
      sha: 'b'.repeat(40),
      author: PERSONA,
      committer: 'Leaker <personal@gmail.com>',
      signoffs: [PERSONA],
    };

    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    const ctx = makeCtx(repo, fakeReader([offPersonaCommit]));
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/blocked.*persona allowlist/i);
  });

  it('passes the guard (proceeds to gate) when all commits are on-persona', async () => {
    const repo = makeRepo();
    const cleanCommit: CommitIdentity = {
      sha: 'd'.repeat(40),
      author: PERSONA,
      committer: PERSONA,
      signoffs: [PERSONA],
    };

    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    const ctx = makeCtx(repo, fakeReader([cleanCommit]));
    const reg = buildCoreRegistry();

    // Guard passes → gate checks verdict → no PASS recorded → gate refuses (not the guard).
    await expect(
      invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/no review verdict/i);
  });

  it('rejects unsigned commits even when no allowlist is configured', async () => {
    const repo = makeRepo();
    const unsignedCommit: CommitIdentity = {
      sha: 'e'.repeat(40),
      author: PERSONA,
      committer: PERSONA,
      signoffs: [],
    };

    const ctx = makeCtx(repo, fakeReader([unsignedCommit]));
    const reg = buildCoreRegistry();

    let errorMessage = '';
    try {
      await invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      });
    } catch (cause) {
      errorMessage = cause instanceof Error ? cause.message : String(cause);
    }
    expect(errorMessage).toMatch(/Signed-off-by/i);
    expect(errorMessage).not.toMatch(/persona allowlist/i);
  });

  it('fails loud when an allowlist is configured but the worktree record is missing', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    const ctx = makeCtx(repo, fakeReader([]), { seedWorktree: false });
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/worktree record/i);
  });

  it('fails loud on missing worktree record even when the identity guard is unconfigured', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo, fakeReader([]), { seedWorktree: false });
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/worktree record/i);
  });

  it('rejects a branch owned by another parent before gate work', async () => {
    const repo = makeRepo();
    const ctx = makeCtx(repo, fakeReader([]), { parent: 'other-lead' });
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/worktree parent/i);
  });

  it('routes baseline-failure escalation to the caller parent from the roster', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtxBundle(repo, fakeReader([]), {
      seedWorktree: false,
    });
    const toolCtx: ToolContext = {
      ...ctx,
      ghExec: () => 'https://fake/pr/18',
    };
    worktreeStore.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_BASE_SHA,
        path: '/fake',
        parent: 'lead-x',
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_BASE_SHA,
        tests: [{ name: 'existing-failure', passed: false }],
      },
    );
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [{ name: 'existing-failure', passed: false }],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-baseline-fail',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'fail', baseline_compared: true },
    });
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, toolCtx, 'co_pr_merge', {
      branch: 'co/feature',
      title: 'feat: my pr',
      intent: SAMPLE_INTENT,
    })) as { escalated?: boolean; baseline_failures?: string[] };

    expect(out.escalated).toBe(true);
    expect(out.baseline_failures).toEqual(['existing-failure']);
    expect(ctx.mail!.inbox('coordinator-1').filter((m) => m.type === 'escalation')).toHaveLength(1);
    expect(ctx.mail!.inbox('lead-x').filter((m) => m.type === 'escalation')).toHaveLength(0);
  });

  it('defaults omitted into to the local base branch when origin/HEAD points at origin/main', async () => {
    const repo = makeRepo();
    setOriginHeadToMain(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtxBundle(repo, fakeReader([]), {
      seedWorktree: false,
    });
    const ghCalls: string[][] = [];
    const toolCtx: ToolContext = {
      ...ctx,
      ghExec: (_cwd, args) => {
        ghCalls.push([...args]);
        return 'https://fake/pr/default-into';
      },
    };
    worktreeStore.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_BASE_SHA,
        path: '/fake',
        parent: 'lead-x',
      },
      { branch: 'co/feature', baseRef: 'main', baseSha: FAKE_BASE_SHA, tests: [] },
    );
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-origin-head-default',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    const out = (await invokeTool(buildCoreRegistry(), toolCtx, 'co_pr_merge', {
      branch: 'co/feature',
      title: 'feat: my pr',
      intent: SAMPLE_INTENT,
    })) as { pr_url: string };

    expect(out.pr_url).toBe('https://fake/pr/default-into');
    expect(ghCalls[0]).toContain('--base');
    expect(ghCalls[0]![ghCalls[0]!.indexOf('--base') + 1]).toBe('main');
  });

  it('refuses to open a PR when the reviewed branch moved after the recorded PASS', async () => {
    const repo = makeRepo();
    const reviewedHead = git(repo, 'rev-parse', 'co/feature');
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtxBundle(repo, fakeReader([]));
    const ghCalls: string[][] = [];
    const toolCtx: ToolContext = {
      ...ctx,
      ghExec: (_cwd, args) => {
        ghCalls.push([...args]);
        return 'https://fake/pr/stale';
      },
    };
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: reviewedHead,
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-stale-pr',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });
    git(repo, 'checkout', 'co/feature');
    commitSigned(repo, 'after-review.txt', 'late\n', 'feat: late');
    git(repo, 'checkout', 'main');

    await expect(
      invokeTool(buildCoreRegistry(), toolCtx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: stale pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/reviewed commit|moved|stale/i);
    expect(ghCalls).toEqual([]);
  });

  it('refuses to open a PR when the branch was re-finished after the recorded PASS', async () => {
    const repo = makeRepo();
    const reviewedHead = git(repo, 'rev-parse', 'co/feature');
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtxBundle(repo, fakeReader([]));
    const ghCalls: string[][] = [];
    const toolCtx: ToolContext = {
      ...ctx,
      ghExec: (_cwd, args) => {
        ghCalls.push([...args]);
        return 'https://fake/pr/stale-refinish';
      },
    };
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: reviewedHead,
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-stale-refinish-pr',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });
    git(repo, 'checkout', 'co/feature');
    const lateHead = commitSigned(repo, 'after-review.txt', 'late\n', 'feat: late');
    git(repo, 'checkout', 'main');
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: lateHead,
      tests: [],
    });

    await expect(
      invokeTool(buildCoreRegistry(), toolCtx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: stale pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/finished after review|latest finish/i);
    expect(ghCalls).toEqual([]);
  });

  it('lets a coordinator open a PR for a directly owned implementer branch after PASS', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtxBundle(repo, fakeReader([]), {
      agent: 'coordinator-1',
      parent: 'coordinator-1',
    });
    const toolCtx: ToolContext = {
      ...ctx,
      ghExec: () => 'https://fake/pr/coordinator',
    };
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-coordinator-pass',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    const out = (await invokeTool(buildCoreRegistry(), toolCtx, 'co_pr_merge', {
      branch: 'co/feature',
      title: 'feat: coordinator pr',
      intent: SAMPLE_INTENT,
    })) as { pr_url: string; mode: string };

    expect(out.pr_url).toBe('https://fake/pr/coordinator');
    expect(out.mode).toBe('owner');
  });

  it('refuses an unregistered caller before a clean PASS PR creation side effect', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtxBundle(repo, fakeReader([]), {
      registerCaller: false,
    });
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-clean-pass',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });
    const ghCalls: string[][] = [];
    const toolCtx: ToolContext = {
      ...ctx,
      ghExec: (_cwd, args) => {
        ghCalls.push([...args]);
        return 'https://fake/pr/unregistered';
      },
    };

    await expect(
      invokeTool(buildCoreRegistry(), toolCtx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/not registered in the roster/i);
    expect(ghCalls).toEqual([]);
  });

  it('blocks an unsigned commit before PR creation', async () => {
    const repo = makeRepo();
    const unsignedCommit: CommitIdentity = {
      sha: 'e'.repeat(40),
      author: PERSONA,
      committer: PERSONA,
      signoffs: [],
    };

    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    const ctx = makeCtx(repo, fakeReader([unsignedCommit]));
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/missing signed-off-by/i);
  });

  it('fails loud when git cannot resolve the current PR merge-base', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    const ctx = makeCtx(repo);
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        into: 'missing-base',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/cannot resolve PR merge-base/i);
  });

  it('checks identities on the current PR delta after the branch is rebased', async () => {
    const repo = makeRepo();
    git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'peer.txt'), 'base advanced before PR\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'chore: advance base');
    const mainHead = git(repo, 'rev-parse', 'main');
    git(repo, 'checkout', 'co/feature');
    git(repo, 'rebase', 'main');
    const branchHead = git(repo, 'rev-parse', 'co/feature');
    const seenRanges: string[] = [];
    const trackingReader: CommitIdentityReader = {
      read: (_cwd, range) => {
        seenRanges.push(range);
        return [
          {
            sha: 'd'.repeat(40),
            author: PERSONA,
            committer: PERSONA,
            signoffs: [PERSONA],
          },
        ];
      },
    };

    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    const ctx = makeCtx(repo, trackingReader);
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        into: 'main',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/no review verdict/i);
    expect(seenRanges).toEqual([`${mainHead}..${branchHead}`]);
    expect(seenRanges[0]).not.toContain(FAKE_BASE_SHA);
  });

  it('checks PR identities from the remote base when local main is ahead', async () => {
    const repo = makeRepo();
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    const remoteBase = git(repo, 'rev-parse', 'origin/main');
    git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'local-only-base.txt'), 'not yet on origin\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'chore: local base');
    const localBase = git(repo, 'rev-parse', 'main');
    git(repo, 'checkout', '-B', 'co/feature', 'main');
    writeFileSync(join(repo, 'feat2.txt'), 'feature after local base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'feat: after local base');
    const branchHead = git(repo, 'rev-parse', 'co/feature');
    const seenRanges: string[] = [];
    const trackingReader: CommitIdentityReader = {
      read: (_cwd, range) => {
        seenRanges.push(range);
        return [
          {
            sha: 'd'.repeat(40),
            author: PERSONA,
            committer: PERSONA,
            signoffs: [PERSONA],
          },
        ];
      },
    };

    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'contributor');

    const ctx = makeCtx(repo, trackingReader);
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        into: 'main',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/no review verdict/i);
    expect(seenRanges).toEqual([`${remoteBase}..${branchHead}`]);
    expect(seenRanges[0]).not.toContain(localBase);
  });

  it('refuses PR creation when the fork base is ahead of the upstream base', async () => {
    const repo = makeRepo();
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    const upstreamBase = git(repo, 'rev-parse', 'main');
    git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'fork-only-base.txt'), 'unsigned fork base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'chore: fork-only base');
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    git(repo, 'checkout', '-B', 'co/feature', 'main');
    const branchHead = commitSigned(repo, 'feature-after-fork.txt', 'feature\n', 'feat: feature');
    git(repo, 'checkout', 'main');
    git(repo, 'reset', '--hard', upstreamBase);
    let ghCalls = 0;
    const ctx: ToolContext = {
      ...makeCtx(repo, fakeReader([])),
      ghExec: () => {
        ghCalls++;
        return 'https://fake/pr/should-not-open';
      },
    };
    ctx.worktrees!.recordFinish({
      branch: 'co/feature',
      baseSha: upstreamBase,
      commitSha: branchHead,
      tests: [],
    });
    ctx.reviews!.recordVerdict({
      reviewId: 'rev-fork-base-ahead-pr',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'contributor');

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_pr_merge', {
        branch: 'co/feature',
        into: 'main',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/upstream PR base|origin\/main.*ahead|upstream\/main/i);
    expect(ghCalls).toBe(0);
  });

  it('agent-supplied operator override without a reason is rejected before identity inspection', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    let readerCalled = false;
    const trackingReader: CommitIdentityReader = {
      read: () => {
        readerCalled = true;
        return [];
      },
    };
    const ctx = makeCtx(repo, trackingReader);
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
        operator_override: true,
      }),
    ).rejects.toThrow(/operator_override.*@operator|reserved for @operator/i);
    expect(readerCalled).toBe(false);
  });

  it('agent-supplied operator override is rejected even with a reason', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    let readerCalled = false;
    const reader: CommitIdentityReader = {
      read: () => {
        readerCalled = true;
        return [];
      },
    };
    const ctx = makeCtx(repo, reader);

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
        operator_override: true,
        reason: 'hotfix',
      }),
    ).rejects.toThrow(/operator_override.*@operator|reserved for @operator/i);
    expect(readerCalled).toBe(false);
  });

  it('@operator can use an audited override with a reason while identity and gh paths still run', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const bundle = makeCtxBundle(
      repo,
      fakeReader([
        { sha: 'c'.repeat(40), author: PERSONA, committer: PERSONA, signoffs: [PERSONA] },
      ]),
      {
        agent: OPERATOR,
        registerCaller: false,
      },
    );
    const ghCalls: string[][] = [];
    const ctx: ToolContext = {
      ...bundle.ctx,
      ghExec: (_cwd, args) => {
        ghCalls.push([...args]);
        return 'https://fake/pr/operator-override';
      },
    };

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_pr_merge', {
      branch: 'co/feature',
      into: 'main',
      title: 'feat: operator override',
      intent: SAMPLE_INTENT,
      operator_override: true,
      reason: 'hotfix',
    })) as { pr_url: string; overridden?: boolean; override_reason?: string };

    expect(out.pr_url).toBe('https://fake/pr/operator-override');
    expect(out.overridden).toBe(true);
    expect(out.override_reason).toBe('hotfix');
    expect(ghCalls).toHaveLength(1);
  });

  it('@operator override surfaces verification regressions in structured output', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const bundle = makeCtxBundle(
      repo,
      fakeReader([
        { sha: 'c'.repeat(40), author: PERSONA, committer: PERSONA, signoffs: [PERSONA] },
      ]),
      {
        agent: OPERATOR,
        registerCaller: false,
        seedWorktree: false,
      },
    );
    bundle.worktreeStore.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_BASE_SHA,
        path: '/fake',
        parent: OPERATOR,
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_BASE_SHA,
        tests: [{ name: 'test-a', passed: true }],
      },
    );
    bundle.worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [{ name: 'test-a', passed: false }],
    });
    const ctx: ToolContext = {
      ...bundle.ctx,
      ghExec: () => 'https://fake/pr/operator-regression',
    };

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_pr_merge', {
      branch: 'co/feature',
      into: 'main',
      title: 'feat: operator override',
      intent: SAMPLE_INTENT,
      operator_override: true,
      reason: 'accept known regression',
    })) as { pr_url: string; verification_failures?: string[]; escalated?: boolean };

    expect(out.pr_url).toBe('https://fake/pr/operator-regression');
    expect(out.verification_failures).toEqual(['test-a']);
    expect(out.escalated).toBeUndefined();
    const audit = openProjectStore('p-prmerge-guard');
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

  it('@operator override can open a PR for a lead-parented worktree while identity checks still run', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const bundle = makeCtxBundle(
      repo,
      fakeReader([
        { sha: 'c'.repeat(40), author: PERSONA, committer: PERSONA, signoffs: [PERSONA] },
      ]),
      {
        agent: OPERATOR,
        parent: 'lead-x',
        registerCaller: false,
      },
    );
    const ghCalls: string[][] = [];
    const ctx: ToolContext = {
      ...bundle.ctx,
      ghExec: (_cwd, args) => {
        ghCalls.push([...args]);
        return 'https://fake/pr/operator-lead-parented';
      },
    };

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_pr_merge', {
      branch: 'co/feature',
      into: 'main',
      title: 'feat: operator override',
      intent: SAMPLE_INTENT,
      operator_override: true,
      reason: 'hotfix',
    })) as { pr_url: string; overridden?: boolean };

    expect(out.pr_url).toBe('https://fake/pr/operator-lead-parented');
    expect(out.overridden).toBe(true);
    expect(ghCalls).toHaveLength(1);
  });

  it('@operator override still refuses when no worktree record exists', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    let readerCalled = false;
    const reader: CommitIdentityReader = {
      read: () => {
        readerCalled = true;
        return [];
      },
    };
    const ctx = makeCtx(repo, reader, {
      agent: OPERATOR,
      registerCaller: false,
      seedWorktree: false,
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_pr_merge', {
        branch: 'co/feature',
        into: 'main',
        title: 'feat: operator override',
        intent: SAMPLE_INTENT,
        operator_override: true,
        reason: 'hotfix',
      }),
    ).rejects.toThrow(/worktree record/i);
    expect(readerCalled).toBe(false);
  });

  it('@operator override without a non-empty reason is rejected before identity inspection', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'owner');
    let readerCalled = false;
    const reader: CommitIdentityReader = {
      read: () => {
        readerCalled = true;
        return [];
      },
    };
    const ctx = makeCtx(repo, reader, {
      agent: OPERATOR,
      registerCaller: false,
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: operator override',
        intent: SAMPLE_INTENT,
        operator_override: true,
      }),
    ).rejects.toThrow(/operator_override requires a non-empty reason/);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: operator override',
        intent: SAMPLE_INTENT,
        operator_override: true,
        reason: '   ',
      }),
    ).rejects.toThrow(/operator_override requires a non-empty reason/);
    expect(readerCalled).toBe(false);
  });
});

describe('AC-S10-5(a) — co_pr_merge uses recorded worktree baseRef (MNR #3/#6)', () => {
  it('opens a PR against a real non-default recorded baseRef when input.into is omitted', async () => {
    const repo = makeRepo();
    git(repo, 'branch', 'co/stage-x', 'main');
    const stageBase = git(repo, 'rev-parse', 'co/stage-x');
    const featureHead = git(repo, 'rev-parse', 'co/feature');
    const { ctx, worktreeStore, reviewStore } = makeCtxBundle(repo, fakeReader([]), {
      seedWorktree: false,
    });
    const ghCalls: string[][] = [];
    const toolCtx: ToolContext = {
      ...ctx,
      ghExec: (_cwd, args) => {
        ghCalls.push([...args]);
        return 'https://fake/pr/stage-base';
      },
    };

    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-prmerge-guard', REPO_MODE_CONFIG_KEY, 'contributor');

    worktreeStore.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'co/stage-x',
        baseSha: stageBase,
        path: '/fake',
        parent: 'lead-x',
      },
      { branch: 'co/feature', baseRef: 'co/stage-x', baseSha: stageBase, tests: [] },
    );
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: stageBase,
      commitSha: featureHead,
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-stage-base-pr',
      target: 'co/stage-x',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    const out = (await invokeTool(buildCoreRegistry(), toolCtx, 'co_pr_merge', {
      branch: 'co/feature',
      title: 'feat: my pr',
      intent: SAMPLE_INTENT,
    })) as { pr_url: string; mode: string };

    expect(out.pr_url).toBe('https://fake/pr/stage-base');
    expect(out.mode).toBe('contributor');
    expect(ghCalls).toHaveLength(1);
    const baseIndex = ghCalls[0]!.indexOf('--base');
    expect(baseIndex).toBeGreaterThanOrEqual(0);
    expect(ghCalls[0]![baseIndex + 1]).toBe('co/stage-x');
  });

  it('resolves into from the recorded baseRef when input.into is omitted', async () => {
    const repo = makeRepo();
    const { ctx, worktreeStore } = makeCtxBundle(repo, fakeReader([]), { seedWorktree: false });

    // Record a worktree with a non-default baseRef that does NOT exist in the test repo.
    worktreeStore.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'co/stage-x',
        baseSha: FAKE_BASE_SHA,
        path: '/fake',
        parent: 'lead-x',
      },
      { branch: 'co/feature', baseRef: 'co/stage-x', baseSha: FAKE_BASE_SHA, tests: [] },
    );

    const reg = buildCoreRegistry();
    // Without input.into, the tool must pick up worktree.baseRef = 'co/stage-x'.
    // The identity-base lookup cannot resolve 'co/stage-x' (it doesn't exist), so the error
    // names it. If detectIntegrationTarget fell back to 'main' instead, the merge-base would
    // resolve cleanly and the error would be "no review verdict" — not naming 'co/stage-x'.
    await expect(
      invokeTool(reg, ctx, 'co_pr_merge', {
        branch: 'co/feature',
        title: 'feat: my pr',
        intent: SAMPLE_INTENT,
      }),
    ).rejects.toThrow(/co\/stage-x/);
  });
});
