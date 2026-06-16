/**
 * Stage 14 · P1 (KEYSTONE) — the `co-mcp start-session` verb arg-validation (the thin adapter over the
 * core {@link startCoordinatorSession} primitive). Proves the FROZEN signature:
 *   `co-mcp start-session <projectId> (--prompt "…" | --spec <path>)`
 * with EXACTLY ONE of `--prompt` / `--spec` — both or neither FAILS LOUD (Principle 9) — and that the
 * verb resolves/validates the project id against the registry (like `runServeConductor`) before calling
 * the core primitive. Heavy logic is covered by the core primitive's own unit test; here we only assert
 * the adapter's parse + wiring (injected seams — no real registry/git needed).
 */
import { describe, expect, it } from 'vitest';
import type { ProjectRegistry } from '@co/core';
import {
  parseStartSessionArgs,
  runStartSessionCommand,
  type RunStartSessionDeps,
} from './start-session-command.js';

describe('parseStartSessionArgs — exactly one of --prompt / --spec', () => {
  it('parses a --prompt invocation', () => {
    expect(parseStartSessionArgs(['proj-1', '--prompt', 'do the thing'])).toEqual({
      projectId: 'proj-1',
      prompt: 'do the thing',
    });
  });

  it('parses a --spec invocation', () => {
    expect(parseStartSessionArgs(['proj-1', '--spec', '/tmp/spec.md'])).toEqual({
      projectId: 'proj-1',
      specPath: '/tmp/spec.md',
    });
  });

  it('fails loud when BOTH --prompt and --spec are supplied', () => {
    expect(() => parseStartSessionArgs(['proj-1', '--prompt', 'a', '--spec', '/tmp/b.md'])).toThrow(
      /exactly one of/i,
    );
  });

  it('fails loud when NEITHER --prompt nor --spec is supplied', () => {
    expect(() => parseStartSessionArgs(['proj-1'])).toThrow(/exactly one of/i);
  });

  it('fails loud on a missing project id', () => {
    expect(() => parseStartSessionArgs(['--prompt', 'a'])).toThrow(/project id is required/i);
    expect(() => parseStartSessionArgs([])).toThrow(/project id is required/i);
  });

  it('fails loud on an unknown argument', () => {
    expect(() => parseStartSessionArgs(['proj-1', '--bogus', 'x'])).toThrow(/unknown argument/i);
  });

  it('fails loud when a flag is missing its value', () => {
    expect(() => parseStartSessionArgs(['proj-1', '--prompt'])).toThrow(/requires a value/i);
  });
});

describe('runStartSessionCommand — registry resolution + core wiring (injected seams)', () => {
  function fakeRegistry(pathFor: (id: string) => string | undefined): () => ProjectRegistry {
    return () =>
      ({
        pathFor,
        close: () => {},
      }) as unknown as ProjectRegistry;
  }

  it('resolves the project id and calls the core primitive with the repo cwd + prompt', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const logs: string[] = [];
    const deps: RunStartSessionDeps = {
      openRegistry: fakeRegistry((id) => (id === 'proj-1' ? '/repos/proj-1' : undefined)),
      start: (params) => {
        calls.push({ ...params });
        return {
          coordinator: 'coord-root-deadbeef',
          worktreePath: '/data/worktrees/co/coord-root-deadbeef',
          branch: 'co/coord-root-deadbeef',
          baseRef: 'main',
          baseSha: 'abc',
        };
      },
      log: (line) => logs.push(line),
    };

    await runStartSessionCommand(['proj-1', '--prompt', 'orchestrate'], deps);

    expect(calls).toEqual([
      { projectId: 'proj-1', repoCwd: '/repos/proj-1', prompt: 'orchestrate' },
    ]);
    expect(logs[0]).toContain('coord-root-deadbeef');
  });

  it('reads the spec file when --spec is given and forwards specBody', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const deps: RunStartSessionDeps = {
      openRegistry: fakeRegistry(() => '/repos/proj-1'),
      readSpecFile: (path) => `SPEC@${path}`,
      start: (params) => {
        calls.push({ ...params });
        return {
          coordinator: 'c',
          worktreePath: 'w',
          branch: 'co/c',
          baseRef: 'main',
          baseSha: 'sha',
        };
      },
      log: () => {},
    };

    await runStartSessionCommand(['proj-1', '--spec', '/tmp/spec.md'], deps);

    expect(calls).toEqual([
      { projectId: 'proj-1', repoCwd: '/repos/proj-1', specBody: 'SPEC@/tmp/spec.md' },
    ]);
  });

  it('fails loud on an unknown project id (never calls the core primitive)', async () => {
    let started = false;
    const deps: RunStartSessionDeps = {
      openRegistry: fakeRegistry(() => undefined),
      start: () => {
        started = true;
        throw new Error('should not be called');
      },
      log: () => {},
    };
    await expect(runStartSessionCommand(['unknown-proj', '--prompt', 'x'], deps)).rejects.toThrow(
      /unknown project id/i,
    );
    expect(started).toBe(false);
  });
});
