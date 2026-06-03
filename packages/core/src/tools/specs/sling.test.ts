import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openWorktreeStore, type WorktreeStore } from '../../worktrees/worktree-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// AC-L3-1, headless through invokeTool (no MCP server, no Conductor): co_sling slings from the
// auto-detected base, records the sandbox + a readable baseline, requires an explicit parent and a
// co/ branch, and loud-fails when the mount did not inject the worktree store.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let mails: MailStore[] = [];
let worktreeStores: WorktreeStore[] = [];
let regs: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  mails = [];
  worktreeStores = [];
  regs = [];
  const data = mkdtempSync(join(tmpdir(), 'co-sling-tool-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const m of mails) m.close();
  for (const w of worktreeStores) w.close();
  for (const r of regs) r.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  mails = [];
  worktreeStores = [];
  regs = [];
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function makeMainRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-sling-tool-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** A real headless ToolContext over `repo`, with the worktree store injected (unless omitted). */
function makeContext(
  agent: string,
  repo: string,
  opts: { withWorktrees?: boolean } = {},
): ToolContext {
  const registry = openRegistry();
  regs.push(registry);
  const projectId = registry.register(repo);
  const mail = openMailStore(projectId);
  mails.push(mail);
  if (opts.withWorktrees === false) {
    return { agent, projectId, cwd: repo, mail, registry };
  }
  const worktrees = openWorktreeStore(projectId);
  worktreeStores.push(worktrees);
  return { agent, projectId, cwd: repo, mail, registry, worktrees };
}

describe('co_sling — via invokeTool', () => {
  it('slings from auto-detected main, returns the structured facts, records branch + baseline', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo);
    const reg = buildCoreRegistry();
    const headSha = git(repo, 'rev-parse', 'HEAD');

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      branch: 'co/feature',
    })) as {
      branch: string;
      base_ref: string;
      base_sha: string;
      worktree_path: string;
      baseline_captured: boolean;
    };

    expect(out.branch).toBe('co/feature');
    expect(out.base_ref).toBe('main'); // auto-detected — NOT master
    expect(out.base_sha).toBe(headSha);
    expect(out.baseline_captured).toBe(true);
    expect(out.worktree_path).toContain(ctx.projectId);
    expect(out.worktree_path).toContain('co/feature');

    // Recorded per project + branch, with the explicit parent (no @operator default).
    expect(ctx.worktrees?.getWorktree('co/feature')?.parent).toBe('lead-7');
    expect(ctx.worktrees?.getBaseline('co/feature')).toBeDefined();
  });

  it('rejects a branch that does not start with co/ (input schema)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', { parent: 'lead-7', branch: 'feature' }),
    ).rejects.toThrow(/input failed schema validation/i);
  });

  it('requires an explicit parent — there is NO @operator default (input schema)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', { branch: 'co/x' }),
    ).rejects.toThrow(/input failed schema validation/i);
  });

  it('loud-fails when the mount did not inject a worktree store (Principle 9)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo, { withWorktrees: false });
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', { parent: 'lead-7', branch: 'co/x' }),
    ).rejects.toThrow(/did not inject a worktree store/i);
  });
});
