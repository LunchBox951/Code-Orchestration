import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { ProjectId } from '@co/core';
import { defaultOperatorSocketPath } from './app-shell.js';
import {
  buildDaemonSpawnDescriptor,
  createDaemonSupervisor,
  defaultCoMcpBinPath,
  probeOperatorSocketHealthy,
  type DaemonSpawnHandle,
  type DaemonStatus,
  type SpawnDescriptor,
} from './daemon-supervisor.js';

const PROJECT_ID = 'a1b2c3d4-0000-0000-0000-000000000000' as ProjectId;

/** A bare child stand-in: an EventEmitter + `kill()` + `pid` — NO real process, NO real Electron. */
class FakeChild extends EventEmitter implements DaemonSpawnHandle {
  readonly pid = 4242;
  readonly kill = vi.fn((signal?: NodeJS.Signals | number): boolean => {
    if (this.exitOnKill) this.crash(null, typeof signal === 'string' ? signal : null);
    return true;
  });
  constructor(private readonly exitOnKill = true) {
    super();
  }
  /** Simulate an UNEXPECTED crash (the daemon process going away on its own). */
  crash(code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.emit('exit', code, signal);
  }
}

/** Flush queued microtasks so the immediate-promise seam chains settle deterministically (no real time). */
async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

/** A spawn seam that records descriptors and hands back fresh fake children. */
function recordingSpawn(options: { readonly exitOnKill?: boolean } = {}): {
  seam: (descriptor: SpawnDescriptor) => DaemonSpawnHandle;
  spy: ReturnType<typeof vi.fn>;
  children: FakeChild[];
  descriptors: SpawnDescriptor[];
  current: () => FakeChild;
} {
  const children: FakeChild[] = [];
  const descriptors: SpawnDescriptor[] = [];
  const spy = vi.fn((descriptor: SpawnDescriptor): DaemonSpawnHandle => {
    descriptors.push(descriptor);
    const child = new FakeChild(options.exitOnKill ?? true);
    children.push(child);
    return child;
  });
  return {
    seam: spy,
    spy,
    children,
    descriptors,
    current: () => {
      const child = children.at(-1);
      if (child == null) throw new Error('no child spawned yet');
      return child;
    },
  };
}

const immediateDelay = (): Promise<void> => Promise.resolve();

function deferredDelay(): {
  delay: (ms: number) => Promise<void>;
  resolveOne: () => void;
  pendingCount: () => number;
} {
  const pending: Array<() => void> = [];
  const delay = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
      }),
  );
  return {
    delay,
    resolveOne: () => {
      const resolve = pending.shift();
      if (resolve == null) throw new Error('no pending delay');
      resolve();
    },
    pendingCount: () => pending.length,
  };
}

// ── DEFAULT-PATH correctness (guards the PRODUCTION default, not just an injected seam) ─────────────

describe('daemon-supervisor — production default path', () => {
  it('resolves the @co/mcp bin to the dist/bin.js entrypoint', () => {
    const binPath = defaultCoMcpBinPath();
    expect(binPath).toMatch(/mcp[/\\]dist[/\\]bin\.js$/);
  });

  it('builds EXACTLY [execPath, resolved bin, serve, projectId] with ELECTRON_RUN_AS_NODE=1', () => {
    const binPath = defaultCoMcpBinPath();
    const descriptor = buildDaemonSpawnDescriptor(PROJECT_ID, binPath);
    expect(descriptor.command).toBe(process.execPath);
    expect(descriptor.args).toEqual([binPath, 'serve', PROJECT_ID]);
    expect(descriptor.env['ELECTRON_RUN_AS_NODE']).toBe('1');
  });

  it('carries the parent environment through under ELECTRON_RUN_AS_NODE', () => {
    const descriptor = buildDaemonSpawnDescriptor(PROJECT_ID, '/x/bin.js', {
      PATH: '/usr/bin',
      CUSTOM: 'kept',
    });
    expect(descriptor.env['PATH']).toBe('/usr/bin');
    expect(descriptor.env['CUSTOM']).toBe('kept');
    expect(descriptor.env['ELECTRON_RUN_AS_NODE']).toBe('1');
  });

  it('the supervisor spawns with the DEFAULT descriptor (default bin resolution), without a real spawn', async () => {
    const spawn = recordingSpawn();
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam, // capture only — the default child_process.spawn never runs
      probeHealth: vi.fn().mockResolvedValue(true),
      delay: immediateDelay,
      // resolveBinPath + socketPathFor left at their PRODUCTION defaults
    });

    await supervisor.start(PROJECT_ID);

    const descriptor = spawn.descriptors[0]!;
    expect(descriptor.command).toBe(process.execPath);
    expect(descriptor.args).toEqual([defaultCoMcpBinPath(), 'serve', PROJECT_ID]);
    expect(descriptor.env['ELECTRON_RUN_AS_NODE']).toBe('1');
  });

  it('probes health at the SAME socket path the daemon listens on (defaultOperatorSocketPath)', async () => {
    const probeHealth = vi.fn().mockResolvedValue(true);
    const supervisor = createDaemonSupervisor({
      spawn: recordingSpawn().seam,
      probeHealth,
      delay: immediateDelay,
      // socketPathFor left at the PRODUCTION default
    });

    await supervisor.start(PROJECT_ID);

    expect(probeHealth).toHaveBeenCalledWith(defaultOperatorSocketPath(PROJECT_ID));
  });

  it('default health probe resolves false for an absent socket — no hang, no throw', async () => {
    await expect(
      probeOperatorSocketHealthy('/nonexistent/co-daemon-supervisor-probe.sock'),
    ).resolves.toBe(false);
  });
});

// ── Lifecycle with injected fake child + fake health ────────────────────────────────────────────────

describe('daemon-supervisor — start() health-wait', () => {
  it('resolves "healthy" once the health seam returns true, emitting starting → healthy in order', async () => {
    const spawn = recordingSpawn();
    const statuses: DaemonStatus[] = [];
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockResolvedValue(true),
      delay: immediateDelay,
      onStatus: (s) => statuses.push(s),
    });

    const result = await supervisor.start(PROJECT_ID);

    expect(result).toBe('healthy');
    expect(supervisor.status).toBe('healthy');
    expect(statuses).toEqual(['starting', 'healthy']);
    expect(spawn.spy).toHaveBeenCalledTimes(1);
  });

  it('polls until health flips true (waits across initial false probes)', async () => {
    const probeHealth = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const supervisor = createDaemonSupervisor({
      spawn: recordingSpawn().seam,
      probeHealth,
      delay: immediateDelay,
      healthTimeoutMs: 1_000,
      healthIntervalMs: 10,
    });

    const result = await supervisor.start(PROJECT_ID);

    expect(result).toBe('healthy');
    expect(probeHealth).toHaveBeenCalledTimes(3);
  });

  it('a health seam that never succeeds within the budget resolves "failed" and never hangs', async () => {
    const spawn = recordingSpawn();
    const probeHealth = vi.fn().mockResolvedValue(false);
    const statuses: DaemonStatus[] = [];
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth,
      delay: immediateDelay,
      healthTimeoutMs: 30,
      healthIntervalMs: 10, // → 3 bounded poll attempts
      onStatus: (s) => statuses.push(s),
    });

    const result = await supervisor.start(PROJECT_ID);

    expect(result).toBe('failed');
    expect(supervisor.status).toBe('failed');
    expect(statuses).toEqual(['starting', 'failed']);
    expect(probeHealth).toHaveBeenCalledTimes(3);
    expect(spawn.current().kill).toHaveBeenCalled(); // the unhealthy child is reaped
    expect(supervisor.detail).toMatch(/did not become healthy/i);
  });

  it('waits for an unhealthy child to exit before failed status and retry replacement', async () => {
    const spawn = recordingSpawn({ exitOnKill: false });
    const delays = deferredDelay();
    const statuses: DaemonStatus[] = [];
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockResolvedValue(false),
      delay: delays.delay,
      healthTimeoutMs: 10,
      healthIntervalMs: 10,
      killGraceMs: 100,
      onStatus: (s) => statuses.push(s),
    });

    const firstStart = supervisor.start(PROJECT_ID);
    await flush();

    expect(spawn.spy).toHaveBeenCalledTimes(1);
    expect(spawn.current().kill).toHaveBeenCalledWith('SIGTERM');
    expect(statuses).toEqual(['starting']);
    expect(delays.pendingCount()).toBe(1);
    expect(supervisor.start(PROJECT_ID)).toBe(firstStart); // retry is still serialized behind cleanup
    expect(spawn.spy).toHaveBeenCalledTimes(1);

    spawn.current().crash(null, 'SIGTERM');
    await expect(firstStart).resolves.toBe('failed');
    expect(statuses).toEqual(['starting', 'failed']);

    const retry = supervisor.start(PROJECT_ID);
    await flush();
    expect(spawn.spy).toHaveBeenCalledTimes(2);
    expect(spawn.current().kill).toHaveBeenCalledWith('SIGTERM');
    spawn.current().crash(null, 'SIGTERM');
    await expect(retry).resolves.toBe('failed');
  });

  it('clears stale failure detail before a retry emits "starting"', async () => {
    const spawn = recordingSpawn();
    const details: Array<{ status: DaemonStatus; detail: string | null }> = [];
    const probeHealth = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth,
      delay: immediateDelay,
      healthTimeoutMs: 10,
      healthIntervalMs: 10,
      onStatus: (status) => details.push({ status, detail: supervisor.detail }),
    });

    await supervisor.start(PROJECT_ID);
    expect(supervisor.status).toBe('failed');
    expect(supervisor.detail).toMatch(/did not become healthy/i);

    await supervisor.start(PROJECT_ID);

    expect(details).toEqual([
      { status: 'starting', detail: null },
      {
        status: 'failed',
        detail: 'Conductor daemon did not become healthy within 10ms.',
      },
      { status: 'starting', detail: null },
      { status: 'healthy', detail: null },
    ]);
  });
});

// ── Bounded restart on unexpected crash ──────────────────────────────────────────────────────────────

describe('daemon-supervisor — bounded restart on crash', () => {
  it('respawns after an unexpected exit, then recovers to healthy', async () => {
    const spawn = recordingSpawn();
    const statuses: DaemonStatus[] = [];
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockResolvedValue(true),
      delay: immediateDelay,
      maxRetries: 3,
      onStatus: (s) => statuses.push(s),
    });

    await supervisor.start(PROJECT_ID);
    expect(spawn.spy).toHaveBeenCalledTimes(1);

    spawn.current().crash();
    await flush();

    expect(spawn.spy).toHaveBeenCalledTimes(2); // RESPAWNED
    expect(supervisor.status).toBe('healthy');
    expect(statuses).toEqual(['starting', 'healthy', 'restarting', 'healthy']);
  });

  it('applies exponential backoff across consecutive failed restarts (a crash loop)', async () => {
    const spawn = recordingSpawn();
    const delay = vi.fn(immediateDelay);
    // Healthy initial start, then every respawn fails its health-wait: a genuine crash loop, so the
    // consecutive-failure budget climbs and the backoff grows within one un-recovered episode.
    const probeHealth = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth,
      delay,
      maxRetries: 5,
      backoffBaseMs: 500,
      backoffMaxMs: 8_000,
      healthTimeoutMs: 10,
      healthIntervalMs: 10, // 1 poll per attempt
    });

    await supervisor.start(PROJECT_ID);
    spawn.current().crash();
    await flush();

    // First restart backs off 500ms (500 * 2^0), second 1000ms (500 * 2^1) — climbing because the
    // restarts FAIL consecutively (a successful recovery would reset the budget back to 500).
    expect(delay).toHaveBeenCalledWith(500);
    expect(delay).toHaveBeenCalledWith(1_000);
  });

  it('after MAX consecutive failed restarts the daemon is "failed" with NO further respawn', async () => {
    const spawn = recordingSpawn();
    // Healthy initial start, then every respawn fails its health-wait — a crash loop that the budget
    // is meant to cap (vs. a daemon that recovers each time, which must never reach "failed").
    const probeHealth = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth,
      delay: immediateDelay,
      maxRetries: 3,
      healthTimeoutMs: 10,
      healthIntervalMs: 10,
    });

    await supervisor.start(PROJECT_ID);

    // One crash that never recovers runs the 3-restart budget straight to exhaustion.
    spawn.current().crash();
    await flush();

    expect(supervisor.status).toBe('failed');
    expect(spawn.spy).toHaveBeenCalledTimes(4); // 1 initial + 3 failed restarts, NO further respawn
    expect(supervisor.detail).toMatch(/exhausted 3 restart attempts/i);

    // A late exit after "failed" must not resurrect it.
    spawn.current().crash();
    await flush();
    expect(spawn.spy).toHaveBeenCalledTimes(4);
    expect(supervisor.status).toBe('failed');
  });

  it('resets the restart budget on each successful recovery — recovered crashes never exhaust it', async () => {
    const spawn = recordingSpawn();
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockResolvedValue(true), // every restart recovers to healthy
      delay: immediateDelay,
      maxRetries: 3,
    });

    await supervisor.start(PROJECT_ID);

    // Far more distinct, fully-recovered crashes than maxRetries. Each recovery clears the budget,
    // so the supervisor stays healthy — the bound is for a crash LOOP, not lifetime crashes.
    for (let i = 0; i < 10; i++) {
      spawn.current().crash();
      await flush();
      expect(supervisor.status).toBe('healthy');
    }
    expect(spawn.spy).toHaveBeenCalledTimes(11); // 1 initial + 10 successful restarts, never "failed"
  });

  it('a respawn that never becomes healthy consumes the budget and ends in "failed"', async () => {
    const spawn = recordingSpawn();
    // Healthy on the initial start, then every respawn fails its health-wait.
    const probeHealth = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth,
      delay: immediateDelay,
      maxRetries: 2,
      healthTimeoutMs: 10,
      healthIntervalMs: 10, // 1 poll per attempt
    });

    await supervisor.start(PROJECT_ID);
    expect(supervisor.status).toBe('healthy');

    spawn.current().crash();
    await flush();

    expect(supervisor.status).toBe('failed');
    expect(spawn.spy).toHaveBeenCalledTimes(3); // 1 initial + 2 failed restarts
  });

  it('emits repeated "restarting" updates when the operator-visible detail changes', async () => {
    const spawn = recordingSpawn();
    const details: Array<{ status: DaemonStatus; detail: string | null }> = [];
    // Healthy on the initial start, then every respawn fails its health-wait.
    const probeHealth = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth,
      delay: immediateDelay,
      maxRetries: 2,
      healthTimeoutMs: 10,
      healthIntervalMs: 10,
      onStatus: (status) => details.push({ status, detail: supervisor.detail }),
    });

    await supervisor.start(PROJECT_ID);
    spawn.current().crash();
    await flush();

    const restartingDetails = details
      .filter((entry) => entry.status === 'restarting')
      .map((entry) => entry.detail);
    expect(restartingDetails).toEqual([
      'Conductor daemon exited (code=1 signal=null). Restart attempt 1/2.',
      'Conductor daemon exited (code=1 signal=null). Restart attempt 2/2.',
    ]);
    expect(details.at(-1)).toEqual({
      status: 'failed',
      detail: 'Conductor daemon exited (code=1 signal=null). Exhausted 2 restart attempts.',
    });
  });

  it('preserves the specific child-exit detail when the initial daemon dies before health', async () => {
    const spawn = recordingSpawn();
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockImplementation(async () => {
        spawn.current().crash(127, null);
        return false;
      }),
      delay: immediateDelay,
      healthTimeoutMs: 10,
      healthIntervalMs: 10,
    });

    await supervisor.start(PROJECT_ID);

    expect(supervisor.status).toBe('failed');
    expect(supervisor.detail).toContain('Conductor daemon exited (code=127 signal=null).');
    expect(supervisor.detail).not.toContain('did not become healthy');
  });

  it('does not wait for kill grace when the child already exited before health returns false', async () => {
    const spawn = recordingSpawn({ exitOnKill: false });
    const delays = deferredDelay();
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockImplementation(async () => {
        spawn.current().crash(127, null);
        return false;
      }),
      delay: delays.delay,
      healthTimeoutMs: 10,
      healthIntervalMs: 10,
      killGraceMs: 100,
    });

    await expect(supervisor.start(PROJECT_ID)).resolves.toBe('failed');
    expect(delays.pendingCount()).toBe(0);
    expect(spawn.current().kill).not.toHaveBeenCalled();
    expect(supervisor.detail).toContain('Conductor daemon exited (code=127 signal=null).');
  });
});

// ── stop() disarms restart ───────────────────────────────────────────────────────────────────────────

describe('daemon-supervisor — stop()', () => {
  it('kills the child with SIGTERM and reports "stopped"', async () => {
    const spawn = recordingSpawn();
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockResolvedValue(true),
      delay: immediateDelay,
    });

    await supervisor.start(PROJECT_ID);
    const child = spawn.current();
    await supervisor.stop();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.status).toBe('stopped');
  });

  it('clears stale failure detail before reporting "stopped"', async () => {
    const spawn = recordingSpawn();
    const details: Array<{ status: DaemonStatus; detail: string | null }> = [];
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockResolvedValue(false),
      delay: immediateDelay,
      healthTimeoutMs: 10,
      healthIntervalMs: 10,
      onStatus: (status) => details.push({ status, detail: supervisor.detail }),
    });

    await supervisor.start(PROJECT_ID);
    expect(supervisor.status).toBe('failed');
    expect(supervisor.detail).toMatch(/did not become healthy/i);

    await supervisor.stop();

    expect(details.at(-1)).toEqual({ status: 'stopped', detail: null });
    expect(supervisor.detail).toBeNull();
  });

  it('prevents a restart — a subsequent exit after stop() does NOT respawn', async () => {
    const spawn = recordingSpawn();
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockResolvedValue(true),
      delay: immediateDelay,
    });

    await supervisor.start(PROJECT_ID);
    const child = spawn.current();
    await supervisor.stop();

    child.crash(); // late exit arriving after the intentional kill
    await flush();

    expect(spawn.spy).toHaveBeenCalledTimes(1); // NO respawn
    expect(supervisor.status).toBe('stopped');
  });

  it('is idempotent — a second stop() is a harmless no-op', async () => {
    const spawn = recordingSpawn();
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockResolvedValue(true),
      delay: immediateDelay,
    });

    await supervisor.start(PROJECT_ID);
    await supervisor.stop();
    await expect(supervisor.stop()).resolves.toBeUndefined();
    expect(supervisor.status).toBe('stopped');
  });
});

// ── idempotency + restart(projectId) ──────────────────────────────────────────────────────────────────

describe('daemon-supervisor — idempotency & restart(projectId)', () => {
  it('start() while healthy for the same project does not respawn', async () => {
    const spawn = recordingSpawn();
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockResolvedValue(true),
      delay: immediateDelay,
    });

    await supervisor.start(PROJECT_ID);
    const second = await supervisor.start(PROJECT_ID);

    expect(second).toBe('healthy');
    expect(spawn.spy).toHaveBeenCalledTimes(1);
  });

  it('concurrent start() calls share one in-flight spawn', async () => {
    const spawn = recordingSpawn();
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockResolvedValue(true),
      delay: immediateDelay,
    });

    const [a, b] = await Promise.all([supervisor.start(PROJECT_ID), supervisor.start(PROJECT_ID)]);

    expect(a).toBe('healthy');
    expect(b).toBe('healthy');
    expect(spawn.spy).toHaveBeenCalledTimes(1);
  });

  it('restart(projectId) stops the old daemon and starts a fresh one for the new project', async () => {
    const spawn = recordingSpawn();
    const seenSockets: string[] = [];
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn((socketPath: string) => {
        seenSockets.push(socketPath);
        return Promise.resolve(true);
      }),
      delay: immediateDelay,
    });

    await supervisor.start(PROJECT_ID);
    const firstChild = spawn.current();
    const OTHER = 'ffffffff-1111-2222-3333-444444444444' as ProjectId;

    const result = await supervisor.restart(OTHER);

    expect(result).toBe('healthy');
    expect(firstChild.kill).toHaveBeenCalledWith('SIGTERM'); // old one reaped
    expect(spawn.spy).toHaveBeenCalledTimes(2);
    expect(seenSockets).toContain(defaultOperatorSocketPath(OTHER)); // health follows the new project
  });

  it('a direct start() for a different project (no stop) still reaps the prior live child', async () => {
    const spawn = recordingSpawn();
    const supervisor = createDaemonSupervisor({
      spawn: spawn.seam,
      probeHealth: vi.fn().mockResolvedValue(true),
      delay: immediateDelay,
    });

    await supervisor.start(PROJECT_ID);
    const first = spawn.current();
    const OTHER = 'ffffffff-1111-2222-3333-444444444444' as ProjectId;

    await supervisor.start(OTHER);

    expect(first.kill).toHaveBeenCalledWith('SIGTERM'); // no leaked daemon
    expect(spawn.spy).toHaveBeenCalledTimes(2);
    expect(supervisor.status).toBe('healthy');
  });
});
