/**
 * Stage 14 · P1 (KEYSTONE) — the `co-mcp start-session` verb arg-validation (the thin adapter over the
 * core {@link startCoordinatorSession} primitive). Proves the FROZEN signature:
 *   `co-mcp start-session <projectId> --name "Name" (--prompt "…" | --spec <path>)`
 * with EXACTLY ONE of `--prompt` / `--spec` — both or neither FAILS LOUD (Principle 9) — and that the
 * verb resolves/validates the project id against the registry (like `runServeConductor`) before calling
 * the core primitive. Heavy logic is covered by the core primitive's own unit test; here we only assert
 * the adapter's parse + wiring (injected seams — no real registry/git needed).
 */
import { describe, expect, it, vi } from 'vitest';
import type { ArchiveStore, ProjectRegistry, RosterStore } from '@co/core';
import {
  parseStartSessionArgs,
  runStartSessionCommand,
  type RunStartSessionDeps,
} from './start-session-command.js';

describe('parseStartSessionArgs — exactly one of --prompt / --spec', () => {
  it('parses a --prompt invocation', () => {
    expect(
      parseStartSessionArgs(['proj-1', '--name', 'auth refactor', '--prompt', 'do the thing']),
    ).toEqual({
      projectId: 'proj-1',
      name: 'auth refactor',
      prompt: 'do the thing',
    });
  });

  it('parses a --spec invocation', () => {
    expect(
      parseStartSessionArgs(['proj-1', '--name', 'demo spec', '--spec', '/tmp/spec.md']),
    ).toEqual({
      projectId: 'proj-1',
      name: 'demo spec',
      specPath: '/tmp/spec.md',
    });
  });

  it('fails loud when BOTH --prompt and --spec are supplied', () => {
    expect(() =>
      parseStartSessionArgs(['proj-1', '--name', 'n', '--prompt', 'a', '--spec', '/tmp/b.md']),
    ).toThrow(/exactly one of/i);
  });

  it('fails loud when NEITHER --prompt nor --spec is supplied', () => {
    expect(() => parseStartSessionArgs(['proj-1', '--name', 'n'])).toThrow(/exactly one of/i);
  });

  it('fails loud when --name is missing', () => {
    expect(() => parseStartSessionArgs(['proj-1', '--prompt', 'do the thing'])).toThrow(/name/i);
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
    expect(() => parseStartSessionArgs(['proj-1', '--name'])).toThrow(/requires a value/i);
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
      randomHex: () => '9f3a1c',
      log: (line) => logs.push(line),
    };

    await runStartSessionCommand(
      ['proj-1', '--name', 'auth refactor', '--prompt', 'orchestrate'],
      deps,
    );

    expect(calls).toEqual([
      {
        projectId: 'proj-1',
        repoCwd: '/repos/proj-1',
        name: 'auth refactor',
        coordinatorId: 'coord-auth-refactor-9f3a1c',
        prompt: 'orchestrate',
      },
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
      randomHex: () => '123abc',
      log: () => {},
    };

    await runStartSessionCommand(['proj-1', '--name', 'demo spec', '--spec', '/tmp/spec.md'], deps);

    expect(calls).toEqual([
      {
        projectId: 'proj-1',
        repoCwd: '/repos/proj-1',
        name: 'demo spec',
        coordinatorId: 'coord-demo-spec-123abc',
        specBody: 'SPEC@/tmp/spec.md',
      },
    ]);
  });

  it('re-rolls the coordinator id when the first random suffix collides with the roster', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const suffixes = ['aaaaaa', 'bbbbbb'];
    const deps = {
      openRegistry: fakeRegistry(() => '/repos/proj-1'),
      openRoster: () =>
        ({
          getAgent: (agentId: string) =>
            agentId === 'coord-auth-refactor-aaaaaa'
              ? { agentId, role: 'coordinator', parent: '@operator' }
              : undefined,
          close: () => {},
        }) as unknown as RosterStore,
      start: (params) => {
        calls.push({ ...params });
        return {
          coordinator: params.coordinatorId ?? 'coord-unknown',
          worktreePath: 'w',
          branch: `co/${params.coordinatorId ?? 'coord-unknown'}`,
          baseRef: 'main',
          baseSha: 'sha',
        };
      },
      randomHex: () => suffixes.shift() ?? 'cccccc',
      log: () => {},
    } satisfies RunStartSessionDeps & { openRoster: () => RosterStore };

    await runStartSessionCommand(
      ['proj-1', '--name', 'auth refactor', '--prompt', 'orchestrate'],
      deps,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.coordinatorId).toBe('coord-auth-refactor-bbbbbb');
  });

  it('re-rolls the coordinator id when the first suffix collides with an archived branch', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const suffixes = ['aaaaaa', 'bbbbbb'];
    const deps = {
      openRegistry: fakeRegistry(() => '/repos/proj-1'),
      openArchive: () =>
        ({
          listRecords: () => [
            {
              id: 'co/coord-auth-refactor-aaaaaa',
              name: 'auth refactor',
              branch: 'co/coord-auth-refactor-aaaaaa',
              baseRef: 'main',
              deletedAt: 1,
              expiresAt: 2,
            },
          ],
          close: () => {},
        }) as unknown as ArchiveStore,
      start: (params) => {
        calls.push({ ...params });
        return {
          coordinator: params.coordinatorId ?? 'coord-unknown',
          worktreePath: 'w',
          branch: `co/${params.coordinatorId ?? 'coord-unknown'}`,
          baseRef: 'main',
          baseSha: 'sha',
        };
      },
      randomHex: () => suffixes.shift() ?? 'cccccc',
      log: () => {},
    } satisfies RunStartSessionDeps & { openArchive: () => ArchiveStore };

    await runStartSessionCommand(
      ['proj-1', '--name', 'auth refactor', '--prompt', 'orchestrate'],
      deps,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.coordinatorId).toBe('coord-auth-refactor-bbbbbb');
  });

  it('prints the default launch note to stderr, not stdout', async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation((line) => {
      stderr.push(String(line));
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line) => {
      stdout.push(String(line));
    });
    try {
      await runStartSessionCommand(
        ['proj-1', '--name', 'auth refactor', '--prompt', 'orchestrate'],
        {
          openRegistry: fakeRegistry(() => '/repos/proj-1'),
          start: () => ({
            coordinator: 'coord-root-deadbeef',
            worktreePath: '/data/worktrees/co/coord-root-deadbeef',
            branch: 'co/coord-root-deadbeef',
            baseRef: 'main',
            baseSha: 'abc',
          }),
        },
      );
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(stderr.join('\n')).toContain('coord-root-deadbeef');
    expect(stdout).toEqual([]);
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
    await expect(
      runStartSessionCommand(['unknown-proj', '--name', 'n', '--prompt', 'x'], deps),
    ).rejects.toThrow(/unknown project id/i);
    expect(started).toBe(false);
  });
});
