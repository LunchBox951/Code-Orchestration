import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../registry/registry.js';
import type { ToolContext } from './context.js';
import { buildCoreRegistry } from './core-registry.js';
import { invokeTool } from './invoke.js';
import { readWorktreeInfo } from './worktree.js';

// ── temp program-data dir + temp repos, per test (mirrors mail.test.ts) ───────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

function useDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-tools-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
  return dir;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  useDataDir();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of repoDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
});

/** Run git with a deterministic identity so the test never depends on ambient config. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'CO Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'CO Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

/** A real throwaway git repo on `main` with exactly one commit. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-tools-repo-'));
  repoDirs.push(dir);
  git(dir, ['init', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  return dir;
}

describe('readWorktreeInfo — read-only git facts', () => {
  it('reads branch / head sha / clean dirty flag from a one-commit repo', () => {
    const repo = makeGitRepo();
    const info = readWorktreeInfo(repo);
    expect(info.branch).toBe('main');
    expect(info.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(info.headSha).toBe(git(repo, ['rev-parse', 'HEAD']));
    expect(info.dirty).toBe(false);
  });

  it('reports dirty=true once the working tree has an uncommitted change', () => {
    const repo = makeGitRepo();
    expect(readWorktreeInfo(repo).dirty).toBe(false);
    writeFileSync(join(repo, 'new-file.txt'), 'untracked\n');
    expect(readWorktreeInfo(repo).dirty).toBe(true);
  });

  it('fails loud on a directory that is not a git repository (Principle 9)', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'co-tools-norepo-'));
    repoDirs.push(notRepo);
    expect(() => readWorktreeInfo(notRepo)).toThrow(/not a git repository|failed/i);
  });
});

describe('co_worktree_info — headless round-trip via invokeTool', () => {
  function makeContext(cwd: string): {
    ctx: ToolContext;
    close: () => void;
  } {
    const mail: MailStore = openMailStore('p-worktree');
    const registry: ProjectRegistry = openRegistry();
    const ctx: ToolContext = { agent: 'impl-1', projectId: 'p-worktree', cwd, mail, registry };
    return {
      ctx,
      close: () => {
        mail.close();
        registry.close();
      },
    };
  }

  it('returns path/project/branch/head_sha/dirty for the worktree at ctx.cwd', async () => {
    const repo = makeGitRepo();
    const { ctx, close } = makeContext(repo);
    try {
      const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_worktree_info', {})) as {
        path: string;
        project_id: string;
        branch: string;
        head_sha: string;
        dirty: boolean;
      };
      expect(out.path).toBe(repo);
      expect(out.project_id).toBe('p-worktree');
      expect(out.branch).toBe('main');
      expect(out.head_sha).toBe(git(repo, ['rev-parse', 'HEAD']));
      expect(out.dirty).toBe(false);
    } finally {
      close();
    }
  });
});
