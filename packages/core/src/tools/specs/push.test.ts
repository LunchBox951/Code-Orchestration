import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfigStore, type ConfigStore } from '../../config/config-store.js';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import {
  IDENTITY_PERSONA_ALLOWLIST_KEY,
  type CommitIdentityReader,
  type CommitIdentity,
} from '../../permissions/identity-guard.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openReviewStore, type ReviewStore } from '../../review/review-store.js';
import { openWorktreeStore, type WorktreeStore } from '../../worktrees/worktree-store.js';
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
let regs: ProjectRegistry[] = [];
let configs: ConfigStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  mails = [];
  worktrees = [];
  reviews = [];
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
  for (const r of regs) r.close();
  for (const c of configs) c.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  mails = [];
  worktrees = [];
  reviews = [];
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

const PERSONA = 'Persona <persona@noreply.github.com>';
const FAKE_BASE_SHA = 'a'.repeat(40);

function makeCtx(
  cwd: string,
  commitIdentityReader?: CommitIdentityReader,
): { ctx: ToolContext; worktreeStore: WorktreeStore; reviewStore: ReviewStore } {
  const mail = openMailStore('p-push-guard');
  mails.push(mail);
  const registry = openRegistry();
  regs.push(registry);
  const worktreeStore = openWorktreeStore('p-push-guard');
  worktrees.push(worktreeStore);
  const reviewStore = openReviewStore('p-push-guard');
  reviews.push(reviewStore);

  // Seed a worktree record so the guard can determine baseSha.
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

  const ctx: ToolContext = {
    agent: 'lead-x',
    projectId: 'p-push-guard',
    cwd,
    mail,
    registry,
    worktrees: worktreeStore,
    reviews: reviewStore,
    ...(commitIdentityReader !== undefined ? { commitIdentityReader } : {}),
  };
  return { ctx, worktreeStore, reviewStore };
}

/** Fake reader that returns the supplied commits regardless of range. */
function fakeReader(commits: CommitIdentity[]): CommitIdentityReader {
  return { read: () => commits };
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

    const { ctx } = makeCtx(repo, fakeReader([cleanCommit]));
    const reg = buildCoreRegistry();

    // Guard passes → gate checks verdict → no PASS recorded → gate refuses (not the guard).
    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /no review verdict/i,
    );
  });

  it('skips the guard entirely when no allowlist is configured (non-breaking)', async () => {
    const repo = makeRepo();
    // Reader would return off-persona commits — but guard is skipped, so reader is never called.
    let readerCalled = false;
    const trackingReader: CommitIdentityReader = {
      read: () => {
        readerCalled = true;
        return [];
      },
    };

    // No allowlist config seeded.
    const { ctx } = makeCtx(repo, trackingReader);
    const reg = buildCoreRegistry();

    // Guard skipped → gate checks verdict → no PASS → gate refuses.
    await expect(invokeTool(reg, ctx, 'co_push', { branch: 'co/feature' })).rejects.toThrow(
      /no review verdict/i,
    );

    expect(readerCalled).toBe(false);
  });
});
