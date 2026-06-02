import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRepoPristine } from './pristine.js';

const dirs: string[] = [];

/** A throwaway repo-like tree: a tracked file plus a `.git` dir with a HEAD ref. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-pristine-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('assertRepoPristine', () => {
  it('throws when fn writes a NEW file into the working tree (positive control)', () => {
    const repo = makeRepo();
    expect(() =>
      assertRepoPristine(repo, () => writeFileSync(join(repo, 'scratch'), '1')),
    ).toThrow(/modified|added/i);
  });

  it('throws when fn modifies an existing tracked file', () => {
    const repo = makeRepo();
    expect(() =>
      assertRepoPristine(repo, () => writeFileSync(join(repo, 'README.md'), 'changed\n')),
    ).toThrow(/modified/i);
  });

  it('throws when fn writes under .git (e.g. the index)', () => {
    const repo = makeRepo();
    expect(() =>
      assertRepoPristine(repo, () => writeFileSync(join(repo, '.git', 'index'), 'x')),
    ).toThrow(/modified|added|\.git/i);
  });

  it('throws when fn deletes a file', () => {
    const repo = makeRepo();
    expect(() => assertRepoPristine(repo, () => rmSync(join(repo, 'README.md')))).toThrow(
      /modified|removed/i,
    );
  });

  it('does not throw for a no-op fn and returns fn’s result', () => {
    const repo = makeRepo();
    const result = assertRepoPristine(repo, () => 42);
    expect(result).toBe(42);
  });

  it('does not throw when fn writes ONLY outside the repo (the real L0 case)', () => {
    const repo = makeRepo();
    const outside = makeDir('co-outside-');
    const result = assertRepoPristine(repo, () => {
      writeFileSync(join(outside, 'data.db'), 'program-data, not repo');
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('detects a change inside a NESTED directory', () => {
    const repo = makeRepo();
    expect(() =>
      assertRepoPristine(repo, () => writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), 'sha')),
    ).toThrow(/modified|added/i);
  });

  it('detects an added symlink without following it', () => {
    const repo = makeRepo();
    expect(() =>
      assertRepoPristine(repo, () => symlinkSync('README.md', join(repo, 'link'))),
    ).toThrow(/modified|added/i);
  });

  it('propagates fn’s own error unchanged when the repo stays pristine', () => {
    const repo = makeRepo();
    let thrown: unknown;
    try {
      assertRepoPristine(repo, () => {
        throw new Error('op failed');
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('op failed'); // NOT wrapped in a pristine error
  });

  it('still catches a repo write when fn throws afterward, preserving the op error as cause', () => {
    const repo = makeRepo();
    let thrown: unknown;
    try {
      assertRepoPristine(repo, () => {
        writeFileSync(join(repo, 'partial'), 'half-written');
        throw new Error('op failed after writing');
      });
    } catch (e) {
      thrown = e;
    }
    // The pristine violation surfaces (a throwing op cannot mutate the repo undetected)…
    expect((thrown as Error).message).toMatch(/modified|added/i);
    // …and fn's original error is not lost — it is the cause.
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect(((thrown as Error).cause as Error).message).toBe('op failed after writing');
  });
});
