import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRegistry } from '@co/core';
import { runProjectIdCommand } from './project-id-command.js';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

function useDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-project-id-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
  return dir;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  useDataDir();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('runProjectIdCommand', () => {
  it('registers a new repo path and prints its projectId', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'co-repo-'));
    dataDirs.push(repoPath);

    const lines: string[] = [];
    await runProjectIdCommand([repoPath], { print: (l) => lines.push(l) });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(UUID_RE);
  });

  it('is idempotent — re-running returns the same projectId', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'co-repo-'));
    dataDirs.push(repoPath);

    const lines1: string[] = [];
    await runProjectIdCommand([repoPath], { print: (l) => lines1.push(l) });

    const lines2: string[] = [];
    await runProjectIdCommand([repoPath], { print: (l) => lines2.push(l) });

    expect(lines1[0]).toBe(lines2[0]);
  });

  it('defaults to cwd when no repoPath argument is supplied', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'co-repo-'));
    dataDirs.push(repoPath);

    const lines: string[] = [];
    await runProjectIdCommand([], { cwd: repoPath, print: (l) => lines.push(l) });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(UUID_RE);
  });

  it('fails loud on extra repoPath arguments', async () => {
    await expect(runProjectIdCommand(['/tmp/a', '/tmp/b'])).rejects.toThrow(
      /at most one repoPath/i,
    );
  });

  it('prints the same id as the registry resolve after registration', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'co-repo-'));
    dataDirs.push(repoPath);

    const lines: string[] = [];
    await runProjectIdCommand([repoPath], { print: (l) => lines.push(l) });

    const registry = openRegistry();
    let resolved: string | undefined;
    try {
      resolved = registry.resolve(repoPath);
    } finally {
      registry.close();
    }

    expect(lines[0]).toBe(resolved);
  });
});
