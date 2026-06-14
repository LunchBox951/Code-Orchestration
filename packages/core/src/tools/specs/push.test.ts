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
import { worktreePathFor } from '../../worktrees/sling.js';
import { openProjectStore } from '../../store/sqlite-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// AC-L6a-7 — co_push identity guard: refuse on off-persona identities, pass through on clean commits,
// skip when no allowlist configured. Guard runs BEFORE the review-gate verdict check.

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
  const data = mkdtempSync(join(tmpdir(), 'co-push-guard-data-'));
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

/** A real repo with a `co/feature` branch — needed so resolveRefSha can determine branch HEAD. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-push-guard-repo-'));
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

function addOrigin(repo: string): string {
  const remote = mkdtempSync(join(tmpdir(), 'co-push-guard-remote-'));
  tmpDirs.push(remote);
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');
  return remote;
}

function setOriginHeadToMain(repo: string): void {
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

function mergeFeatureIntoMain(repo: string): void {
  git(repo, 'checkout', 'main');
  git(repo, 'merge', '--no-ff', '--no-edit', 'co/feature');
}

function commitSigned(repo: string, file: string, body: string, message: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, 'add', '.');
  git(repo, 'commit', '-s', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

const PERSONA = 'Persona <persona@noreply.github.com>';
const FAKE_BASE_SHA = 'a'.repeat(40);

function makeCtx(
  cwd: string,
  commitIdentityReader?: CommitIdentityReader,
  opts: {
    seedWorktree?: boolean;
    baseSha?: string;
    parent?: string;
    path?: string;
    registerCaller?: boolean;
    agent?: string;
    role?: 'coordinator' | 'lead';
  } = {},
): { ctx: ToolContext; worktreeStore: WorktreeStore; reviewStore: ReviewStore } {
  const agent = opts.agent ?? 'lead-x';
  const mail = openMailStore('p-push-guard');
  mails.push(mail);
  const registry = openRegistry();
  regs.push(registry);
  const worktreeStore = openWorktreeStore('p-push-guard');
  worktrees.push(worktreeStore);
  const reviewStore = openReviewStore('p-push-guard');
  reviews.push(reviewStore);
  const rosterStore = openRosterStore('p-push-guard');
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
    // Seed a worktree record so the guard can determine baseSha.
    worktreeStore.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: opts.baseSha ?? FAKE_BASE_SHA,
        path: opts.path ?? '/fake',
        parent: opts.parent ?? agent,
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: opts.baseSha ?? FAKE_BASE_SHA,
        tests: [],
      },
    );
  }

  const ctx: ToolContext = {
    agent,
    projectId: 'p-push-guard',
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

/** Fake reader that returns the supplied commits regardless of range. */
function fakeReader(commits: CommitIdentity[]): CommitIdentityReader {
  return { read: () => commits };
}

function removeRecordedWorktree(worktreeStore: WorktreeStore, repo: string): void {
  worktreeStore.removeWorktree('co/feature', {
    repoCwd: repo,
    gitExec: () => {},
    fs: {
      exists: () => false,
      isSymlink: () => false,
      realpath: (p) => p,
      removeDir: () => {},
    },
  });
}

describe('co_push identity guard (AC-L6a-7)', () => {
  it('refuses loudly when a commit has an off-persona Signed-off-by — named blocker in error', async () => {
    const repo = makeRepo();
    const offPersonaCommit: CommitIdentity = {
      sha: 'b'.repeat(40),
      author: PERSONA,
      committer: PERSONA,
      signoffs: ['Persona <personal@gmail.com>'],
    };

    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    addOrigin(repo);
    git(repo, 'push', '-u', 'origin', 'co/feature');
    const { ctx } = makeCtx(repo, fakeReader([offPersonaCommit]));
    const reg = buildCoreRegistry();

    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /blocked.*persona allowlist/i,
    );
  });

  it('the blocker error names the sha and offending identity', async () => {
    const repo = makeRepo();
    const badSha = 'c'.repeat(40);
    const offPersonaCommit: CommitIdentity = {
      sha: badSha,
      author: 'Leaker <personal@gmail.com>',
      committer: PERSONA,
      signoffs: [PERSONA],
    };

    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    addOrigin(repo);
    git(repo, 'push', '-u', 'origin', 'co/feature');
    const { ctx } = makeCtx(repo, fakeReader([offPersonaCommit]));
    const reg = buildCoreRegistry();

    let errorMessage = '';
    try {
      await invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' });
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : '';
    }
    expect(errorMessage).toContain(badSha.slice(0, 12));
    expect(errorMessage).toContain('personal@gmail.com');
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
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    addOrigin(repo);
    git(repo, 'push', '-u', 'origin', 'co/feature');
    const { ctx } = makeCtx(repo, fakeReader([cleanCommit]));
    const reg = buildCoreRegistry();

    // Guard passes → gate checks verdict → no PASS recorded → gate refuses (not the guard).
    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /no review verdict/i,
    );
  });

  it('rejects unsigned commits even when no allowlist is configured', async () => {
    const repo = makeRepo();
    const unsignedCommit: CommitIdentity = {
      sha: 'e'.repeat(40),
      author: PERSONA,
      committer: PERSONA,
      signoffs: [],
    };

    // No allowlist config seeded.
    const { ctx } = makeCtx(repo, fakeReader([unsignedCommit]));
    const reg = buildCoreRegistry();

    let errorMessage = '';
    try {
      await invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' });
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
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    const { ctx } = makeCtx(repo, fakeReader([]), { seedWorktree: false });
    const reg = buildCoreRegistry();

    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /worktree record/i,
    );
  });

  it('fails loud on missing worktree record even when the identity guard is unconfigured', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo, fakeReader([]), { seedWorktree: false });
    const reg = buildCoreRegistry();

    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /worktree record/i,
    );
  });

  it('rejects a branch owned by another parent before gate work', async () => {
    const repo = makeRepo();
    const { ctx } = makeCtx(repo, fakeReader([]), { parent: 'other-lead' });
    const reg = buildCoreRegistry();

    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /worktree parent/i,
    );
  });

  it('owner mode allows a removed source worktree so the integration branch can be pushed after merge', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');

    const { ctx, worktreeStore } = makeCtx(repo, fakeReader([]), {
      path: worktreePathFor('p-push-guard', 'co/feature'),
    });
    removeRecordedWorktree(worktreeStore, repo);
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_push', { branch: 'co/feature', into: 'main' }),
    ).rejects.toThrow(/no review verdict/i);
  });

  it('contributor mode still rejects a removed source worktree before publish', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'contributor');

    const { ctx, worktreeStore } = makeCtx(repo, fakeReader([]), {
      path: worktreePathFor('p-push-guard', 'co/feature'),
    });
    removeRecordedWorktree(worktreeStore, repo);
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_push', { branch: 'co/feature', into: 'main' }),
    ).rejects.toThrow(/live worktree record/i);
  });

  it('blocks an unsigned commit before publish', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    git(repo, 'push', '-u', 'origin', 'co/feature');
    const unsignedCommit: CommitIdentity = {
      sha: 'e'.repeat(40),
      author: PERSONA,
      committer: PERSONA,
      signoffs: [],
    };

    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    const { ctx } = makeCtx(repo, fakeReader([unsignedCommit]));
    const reg = buildCoreRegistry();

    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /missing signed-off-by/i,
    );
  });

  it('contributor first publish falls back to the branch base when the remote branch is absent', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const baseSha = git(repo, 'rev-parse', 'main');
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
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'contributor');

    const { ctx } = makeCtx(repo, trackingReader, { baseSha });
    const reg = buildCoreRegistry();

    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /no review verdict/i,
    );
    expect(seenRanges).toEqual([`${baseSha}..${branchHead}`]);
  });

  it('contributor first publish checks from the remote base when local main is ahead', async () => {
    const repo = makeRepo();
    addOrigin(repo);
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
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'contributor');

    const { ctx } = makeCtx(repo, trackingReader, { baseSha: localBase });
    const reg = buildCoreRegistry();

    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /no review verdict/i,
    );
    expect(seenRanges).toEqual([`${remoteBase}..${branchHead}`]);
    expect(seenRanges[0]).not.toContain(localBase);
  });

  it('contributor repeat publish still checks every commit since the PR base', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const remoteBase = git(repo, 'rev-parse', 'origin/main');
    git(repo, 'checkout', 'co/feature');
    git(repo, 'push', 'origin', 'co/feature');
    const existingForkHead = git(repo, 'rev-parse', 'origin/co/feature');
    const branchHead = commitSigned(repo, 'feat2.txt', 'more feature\n', 'feat: continue feature');
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
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'contributor');

    const { ctx } = makeCtx(repo, trackingReader, { baseSha: remoteBase });
    const reg = buildCoreRegistry();

    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /no review verdict/i,
    );
    expect(seenRanges).toEqual([`${remoteBase}..${branchHead}`]);
    expect(seenRanges[0]).not.toContain(existingForkHead);
  });

  it('contributor first publish refuses a fork base ahead of the upstream base', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const upstreamBase = git(repo, 'rev-parse', 'main');
    git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'fork-only-base.txt'), 'unsigned fork base\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'chore: fork-only base');
    git(repo, 'push', 'origin', 'main');
    git(repo, 'checkout', '-B', 'co/feature', 'main');
    const branchHead = commitSigned(repo, 'feature-after-fork.txt', 'feature\n', 'feat: feature');
    git(repo, 'checkout', 'main');
    git(repo, 'reset', '--hard', upstreamBase);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'contributor');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]), {
      baseSha: upstreamBase,
    });
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: upstreamBase,
      commitSha: branchHead,
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-fork-base-ahead-push',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', { branch: 'co/feature' }),
    ).rejects.toThrow(/upstream PR base|origin\/main.*ahead|upstream\/main/i);
    expect(() => git(repo, 'rev-parse', 'origin/co/feature')).toThrow();
  });

  it('owner mode checks the exact destination-to-integration push delta', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    git(repo, 'checkout', 'main');
    writeFileSync(join(repo, 'peer.txt'), 'already published peer commit\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'chore: peer commit');
    git(repo, 'push', 'origin', 'main');
    const destinationHead = git(repo, 'rev-parse', 'origin/main');
    writeFileSync(join(repo, 'integration.txt'), 'merge commit placeholder\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'merge: integration');
    const mainHead = git(repo, 'rev-parse', 'main');
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
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');

    const { ctx } = makeCtx(repo, trackingReader);
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_push', { branch: 'co/feature', into: 'main' }),
    ).rejects.toThrow(/no review verdict/i);
    expect(seenRanges).toEqual([`${destinationHead}..${mainHead}`]);
    expect(seenRanges[0]).not.toContain(FAKE_BASE_SHA);
  });

  it('owner mode blocks off-persona commits on the integration branch being pushed', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    mergeFeatureIntoMain(repo);
    const offPersonaCommit: CommitIdentity = {
      sha: 'f'.repeat(40),
      author: 'Leaker <personal@gmail.com>',
      committer: PERSONA,
      signoffs: [PERSONA],
    };
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx } = makeCtx(repo, fakeReader([offPersonaCommit]));

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', {
        branch: 'co/feature',
        into: 'main',
      }),
    ).rejects.toThrow(/persona allowlist/i);
  });

  it('uses the same resolved repo mode for identity inspection and the actual push', async () => {
    const repo = makeRepo();
    addOrigin(repo);

    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');

    const trackingReader: CommitIdentityReader = {
      read: () => {
        cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'contributor');
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
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, trackingReader);
    mergeFeatureIntoMain(repo);
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-pr-merge-pass',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_push', {
      branch: 'co/feature',
      into: 'main',
    })) as { mode: string };

    expect(out.mode).toBe('owner');
    expect(() => git(repo, 'rev-parse', 'origin/co/feature')).toThrow();
  });

  it('contributor mode refuses to push when the reviewed branch moved after the recorded PASS', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const reviewedHead = git(repo, 'rev-parse', 'co/feature');
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'contributor');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]));
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: reviewedHead,
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-stale-feature',
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
      invokeTool(buildCoreRegistry(), ctx, 'co_push', { branch: 'co/feature', into: 'main' }),
    ).rejects.toThrow(/reviewed commit|moved|stale/i);
    expect(() => git(repo, 'rev-parse', 'origin/co/feature')).toThrow();
  });

  it('contributor mode refuses to push when the branch was re-finished after the recorded PASS', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const reviewedHead = git(repo, 'rev-parse', 'co/feature');
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'contributor');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]));
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: reviewedHead,
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-stale-refinish-feature',
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
      invokeTool(buildCoreRegistry(), ctx, 'co_push', { branch: 'co/feature', into: 'main' }),
    ).rejects.toThrow(/finished after review|latest finish/i);
    expect(() => git(repo, 'rev-parse', 'origin/co/feature')).toThrow();
  });

  it('owner mode refuses to push extra integration commits beyond the reviewed merge', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const before = git(repo, 'rev-parse', 'origin/main');
    mergeFeatureIntoMain(repo);
    commitSigned(repo, 'unreviewed-main.txt', 'unreviewed\n', 'feat: unreviewed main');
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]));
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-extra-main',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', { branch: 'co/feature', into: 'main' }),
    ).rejects.toThrow(/reviewed merge|extra|unreviewed/i);
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(before);
  });

  it('owner mode refuses to push when the branch was re-finished after the recorded PASS', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const before = git(repo, 'rev-parse', 'origin/main');
    const reviewedHead = git(repo, 'rev-parse', 'co/feature');
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]));
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: reviewedHead,
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-stale-refinish-owner',
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
    mergeFeatureIntoMain(repo);

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', { branch: 'co/feature', into: 'main' }),
    ).rejects.toThrow(/finished after review|latest finish/i);
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(before);
  });

  it('owner mode refuses target-only commits before the reviewed merge', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const before = git(repo, 'rev-parse', 'origin/main');
    commitSigned(repo, 'unreviewed-main.txt', 'unreviewed\n', 'feat: unreviewed main');
    mergeFeatureIntoMain(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]));
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-pre-merge-main',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', { branch: 'co/feature', into: 'main' }),
    ).rejects.toThrow(/reviewed merge|remote|first parent|unreviewed/i);
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(before);
  });

  it('owner mode refuses first-pushing a new integration branch with target-only commits', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const base = git(repo, 'rev-parse', 'main');
    git(repo, 'checkout', '-b', 'release', 'main');
    commitSigned(repo, 'unreviewed-release.txt', 'unreviewed\n', 'feat: unreviewed release');
    git(repo, 'merge', '--no-ff', '--no-edit', 'co/feature');
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]), { baseSha: base });
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-new-branch-target-only',
      target: 'release',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', { branch: 'co/feature', into: 'release' }),
    ).rejects.toThrow(/reviewed merge|branch-off base|target-only|unreviewed/i);
    expect(() => git(repo, 'rev-parse', 'origin/release')).toThrow();
  });

  it('owner mode refuses octopus merges that include unreviewed extra parents', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const before = git(repo, 'rev-parse', 'origin/main');
    git(repo, 'checkout', '-b', 'unreviewed', 'main');
    commitSigned(repo, 'unreviewed-side.txt', 'unreviewed\n', 'feat: unreviewed side branch');
    git(repo, 'checkout', 'main');
    git(repo, 'merge', '--no-ff', '--no-edit', 'co/feature', 'unreviewed');
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]));
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-octopus-unreviewed-parent',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', { branch: 'co/feature', into: 'main' }),
    ).rejects.toThrow(/reviewed merge|extra parent|octopus|unreviewed/i);
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(before);
  });

  it('defaults omitted into to the local integration branch when origin/HEAD points at origin/main', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    setOriginHeadToMain(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]));
    mergeFeatureIntoMain(repo);
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

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_push', {
      branch: 'co/feature',
    })) as { pushed: boolean; mode: string };

    expect(out.pushed).toBe(true);
    expect(out.mode).toBe('owner');
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(git(repo, 'rev-parse', 'main'));
  });

  it('owner mode defaults omitted into to the current local integration branch, not origin/HEAD', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    setOriginHeadToMain(repo);
    const base = git(repo, 'rev-parse', 'main');
    git(repo, 'checkout', '-b', 'co/phase');
    git(repo, 'merge', '--no-ff', '--no-edit', 'co/feature');
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]), { baseSha: base });
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-current-branch-default',
      target: 'co/phase',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_push', {
      branch: 'co/feature',
    })) as { pushed: boolean; mode: string };

    expect(out.pushed).toBe(true);
    expect(out.mode).toBe('owner');
    expect(git(repo, 'rev-parse', 'origin/co/phase')).toBe(git(repo, 'rev-parse', 'co/phase'));
    expect(git(repo, 'rev-parse', 'origin/main')).not.toBe(git(repo, 'rev-parse', 'co/phase'));
  });

  it('lets a coordinator push a directly owned implementer branch after PASS', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]), {
      agent: 'coordinator-1',
      parent: 'coordinator-1',
    });
    mergeFeatureIntoMain(repo);
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

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_push', {
      branch: 'co/feature',
      into: 'main',
    })) as { pushed: boolean; mode: string };

    expect(out.pushed).toBe(true);
    expect(out.mode).toBe('owner');
  });

  it('owner mode refuses to push when the reviewed branch is not integrated into the target', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const before = git(repo, 'rev-parse', 'origin/main');
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]));
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [],
    });
    reviewStore.recordVerdict({
      reviewId: 'rev-unmerged-pass',
      target: 'main',
      branch: 'co/feature',
      scope: 'pr_merge',
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', { branch: 'co/feature', into: 'main' }),
    ).rejects.toThrow(/not integrated/i);
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(before);
  });

  it('refuses an unregistered caller before a clean PASS push side effect', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]), {
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

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', {
        branch: 'co/feature',
        into: 'main',
      }),
    ).rejects.toThrow(/not registered in the roster/i);
    expect(() => git(repo, 'rev-parse', 'origin/co/feature')).toThrow();
  });

  it('routes baseline-failure escalation to the caller parent from the roster', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore, reviewStore } = makeCtx(repo, fakeReader([]), {
      seedWorktree: false,
    });
    mergeFeatureIntoMain(repo);
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

    const out = (await invokeTool(reg, ctx, 'co_push', {
      branch: 'co/feature',
      into: 'main',
    })) as { escalated?: boolean; baseline_failures?: string[] };

    expect(out.escalated).toBe(true);
    expect(out.baseline_failures).toEqual(['existing-failure']);
    expect(ctx.mail!.inbox('coordinator-1').filter((m) => m.type === 'escalation')).toHaveLength(1);
    expect(ctx.mail!.inbox('lead-x').filter((m) => m.type === 'escalation')).toHaveLength(0);
  });

  it('agent-supplied operator override without a reason is rejected before identity inspection', async () => {
    const repo = makeRepo();
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', IDENTITY_PERSONA_ALLOWLIST_KEY, [PERSONA]);

    let readerCalled = false;
    const trackingReader: CommitIdentityReader = {
      read: () => {
        readerCalled = true;
        return [];
      },
    };
    const { ctx } = makeCtx(repo, trackingReader);
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_push', {
        branch: 'co/feature',
        operator_override: true,
      }),
    ).rejects.toThrow(/operator_override.*@operator|reserved for @operator/i);
    expect(readerCalled).toBe(false);
  });

  it('agent-supplied operator override is rejected even with a reason', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    let readerCalled = false;
    const reader: CommitIdentityReader = {
      read: () => {
        readerCalled = true;
        return [];
      },
    };
    const { ctx } = makeCtx(repo, reader);

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', {
        branch: 'co/feature',
        into: 'main',
        operator_override: true,
        reason: 'hotfix',
      }),
    ).rejects.toThrow(/operator_override.*@operator|reserved for @operator/i);
    expect(readerCalled).toBe(false);
  });

  it('@operator can use an audited override with a reason while identity checks still run', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    mergeFeatureIntoMain(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx } = makeCtx(
      repo,
      fakeReader([
        { sha: 'c'.repeat(40), author: PERSONA, committer: PERSONA, signoffs: [PERSONA] },
      ]),
      {
        agent: OPERATOR,
        registerCaller: false,
      },
    );

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_push', {
      branch: 'co/feature',
      into: 'main',
      operator_override: true,
      reason: 'hotfix',
    })) as { pushed: boolean; overridden?: boolean; override_reason?: string };

    expect(out.pushed).toBe(true);
    expect(out.overridden).toBe(true);
    expect(out.override_reason).toBe('hotfix');
  });

  it('@operator override surfaces verification regressions in structured output', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    mergeFeatureIntoMain(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx, worktreeStore } = makeCtx(
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
    worktreeStore.recordWorktreeAndBaseline(
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
    worktreeStore.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_BASE_SHA,
      commitSha: git(repo, 'rev-parse', 'co/feature'),
      tests: [{ name: 'test-a', passed: false }],
    });

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_push', {
      branch: 'co/feature',
      into: 'main',
      operator_override: true,
      reason: 'accept known regression',
    })) as { pushed: boolean; verification_failures?: string[]; escalated?: boolean };

    expect(out.pushed).toBe(true);
    expect(out.verification_failures).toEqual(['test-a']);
    expect(out.escalated).toBeUndefined();
    const audit = openProjectStore('p-push-guard');
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

  it('@operator override can push a lead-parented worktree while identity checks still run', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    mergeFeatureIntoMain(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx } = makeCtx(
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

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_push', {
      branch: 'co/feature',
      into: 'main',
      operator_override: true,
      reason: 'hotfix',
    })) as { pushed: boolean; overridden?: boolean };

    expect(out.pushed).toBe(true);
    expect(out.overridden).toBe(true);
  });

  it('@operator override still refuses owner push before the reviewed branch is integrated', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const before = git(repo, 'rev-parse', 'origin/main');
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    const { ctx } = makeCtx(repo, fakeReader([]), {
      agent: OPERATOR,
      registerCaller: false,
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', {
        branch: 'co/feature',
        into: 'main',
        operator_override: true,
        reason: 'hotfix',
      }),
    ).rejects.toThrow(/not integrated/i);
    expect(git(repo, 'rev-parse', 'origin/main')).toBe(before);
  });

  it('@operator override still refuses when no worktree record exists', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    let readerCalled = false;
    const reader: CommitIdentityReader = {
      read: () => {
        readerCalled = true;
        return [];
      },
    };
    const { ctx } = makeCtx(repo, reader, {
      agent: OPERATOR,
      registerCaller: false,
      seedWorktree: false,
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', {
        branch: 'co/feature',
        into: 'main',
        operator_override: true,
        reason: 'hotfix',
      }),
    ).rejects.toThrow(/worktree record/i);
    expect(readerCalled).toBe(false);
  });

  it('@operator override without a non-empty reason is rejected before identity inspection', async () => {
    const repo = makeRepo();
    addOrigin(repo);
    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'owner');
    let readerCalled = false;
    const reader: CommitIdentityReader = {
      read: () => {
        readerCalled = true;
        return [];
      },
    };
    const { ctx } = makeCtx(repo, reader, {
      agent: OPERATOR,
      registerCaller: false,
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', {
        branch: 'co/feature',
        into: 'main',
        operator_override: true,
      }),
    ).rejects.toThrow(/operator_override requires a non-empty reason/);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_push', {
        branch: 'co/feature',
        into: 'main',
        operator_override: true,
        reason: '   ',
      }),
    ).rejects.toThrow(/operator_override requires a non-empty reason/);
    expect(readerCalled).toBe(false);
  });
});

describe('AC-S10-5(a) — co_push uses recorded worktree baseRef (MNR #3/#6)', () => {
  it('resolves into from the recorded baseRef when input.into is omitted (contributor mode)', async () => {
    const repo = makeRepo();
    const { ctx, worktreeStore } = makeCtx(repo, fakeReader([]), { seedWorktree: false });

    const cfg = openConfigStore();
    configs.push(cfg);
    cfg.setProjectOverride('p-push-guard', REPO_MODE_CONFIG_KEY, 'contributor');

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
    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /co\/stage-x/,
    );
  });
});
