import { describe, expect, it } from 'vitest';
import type { ProjectId, ProjectRegistry } from '@co/core';
import type { AppShell } from './app-shell.js';
import type { DaemonStatus } from './daemon-supervisor.js';
import {
  createProjectController,
  type CurrentProjectState,
  type DaemonStatusPayload,
  type ProjectControllerDeps,
  type SupervisorLike,
} from './open-project.js';

/**
 * P-ON2 acceptance coverage for the in-app repo picker. Every external effect is an injected fake — NO
 * real Electron dialog, NO real `co-mcp serve`, NO real registry write — so the register → openProject
 * path is exercised headlessly (HOST-LIVE GUARDRAIL). A shared `events` log captures cross-seam ordering
 * (teardown-before-build) that per-object spies cannot.
 */

/** A daemon supervisor stand-in: records start/stop, drives the controller's onStatus, no real child. */
class FakeSupervisor implements SupervisorLike {
  detail: string | null = null;
  readonly startCalls: ProjectId[] = [];
  lastProjectId: ProjectId | null = null;
  stopCount = 0;

  constructor(
    private readonly events: string[],
    private readonly onStatus: (status: DaemonStatus) => void,
    private readonly startResult: (projectId: ProjectId, attempt: number) => DaemonStatus,
    private readonly startError?: Error,
  ) {}

  async start(projectId: ProjectId): Promise<DaemonStatus> {
    this.startCalls.push(projectId);
    this.lastProjectId = projectId;
    this.events.push(`supervisor.start:${projectId}`);
    if (this.startError != null) throw this.startError;
    this.onStatus('starting');
    const result = this.startResult(projectId, this.startCalls.length);
    this.detail = result === 'failed' ? 'fake daemon did not become healthy' : null;
    this.onStatus(result);
    return result;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.events.push(`supervisor.stop:${this.lastProjectId ?? 'none'}`);
    this.onStatus('stopped');
  }

  /** Drive an out-of-band status (e.g. a post-restart `healthy`) the way the real supervisor would. */
  emit(status: DaemonStatus): void {
    this.onStatus(status);
  }
}

/** An app-shell stand-in: records start/close + connection.refresh; the rest of AppShell is unused here. */
class FakeShell {
  started = false;
  closed = false;
  refreshCalls = 0;
  readonly connection = {
    refresh: async (): Promise<void> => {
      this.refreshCalls += 1;
    },
  };

  constructor(
    private readonly label: string,
    private readonly events: string[],
    private readonly startError?: Error,
  ) {}

  async start(): Promise<void> {
    if (this.startError != null) throw this.startError;
    this.started = true;
    this.events.push(`shell.start:${this.label}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.events.push(`shell.close:${this.label}`);
  }
}

/** A project-registry stand-in: register/pathFor are configurable; register may throw to model a failure. */
class FakeRegistry implements ProjectRegistry {
  closed = false;
  readonly registerCalls: string[] = [];

  constructor(
    private readonly events: string[],
    private readonly behavior: {
      register?: (absPath: string) => ProjectId;
      pathFor?: (projectId: ProjectId) => string | undefined;
    },
  ) {}

  register(absPath: string): ProjectId {
    this.registerCalls.push(absPath);
    this.events.push(`registry.register:${absPath}`);
    if (this.behavior.register == null) throw new Error('register behavior not configured');
    return this.behavior.register(absPath);
  }

  relink(): void {
    throw new Error('relink must not be used by the open path (SH-4: local-only)');
  }

  resolve(): ProjectId | undefined {
    throw new Error('resolve must not be used by the open path');
  }

  pathFor(projectId: ProjectId): string | undefined {
    return this.behavior.pathFor?.(projectId);
  }

  dataDirFor(projectId: ProjectId): string {
    return `/fake-data/${projectId}`;
  }

  close(): void {
    this.closed = true;
    this.events.push('registry.close');
  }
}

interface HarnessOptions {
  pick?: () => Promise<string | null>;
  registerImpl?: (absPath: string) => ProjectId;
  pathForImpl?: (projectId: ProjectId) => string | undefined;
  startResult?: (projectId: ProjectId, attempt: number) => DaemonStatus;
  supervisorStartThrows?: boolean;
  createShellThrows?: boolean;
  shellStartThrows?: boolean;
  openRegistryThrows?: boolean;
}

function makeHarness(opts: HarnessOptions = {}) {
  const events: string[] = [];
  const supervisors: FakeSupervisor[] = [];
  const shells: FakeShell[] = [];
  const registries: FakeRegistry[] = [];
  const daemonStatuses: DaemonStatusPayload[] = [];
  const currentProjects: CurrentProjectState[] = [];
  const errors: string[] = [];
  const startResult = opts.startResult ?? ((): DaemonStatus => 'healthy');

  const deps: ProjectControllerDeps = {
    createSupervisor: ({ onStatus }) => {
      const sup = new FakeSupervisor(
        events,
        onStatus,
        startResult,
        opts.supervisorStartThrows === true ? new Error('daemon spawn exploded') : undefined,
      );
      supervisors.push(sup);
      return sup;
    },
    createShell: (projectId) => {
      if (opts.createShellThrows === true) throw new Error('shell factory exploded');
      const shell = new FakeShell(
        projectId,
        events,
        opts.shellStartThrows === true ? new Error('shell start exploded') : undefined,
      );
      shells.push(shell);
      return shell as unknown as AppShell;
    },
    openRegistry: () => {
      if (opts.openRegistryThrows === true) throw new Error('global store unavailable');
      const reg = new FakeRegistry(events, {
        ...(opts.registerImpl != null ? { register: opts.registerImpl } : {}),
        ...(opts.pathForImpl != null ? { pathFor: opts.pathForImpl } : {}),
      });
      registries.push(reg);
      return reg;
    },
    pickDirectory: opts.pick ?? (async () => null),
    onDaemonStatus: (payload) => daemonStatuses.push(payload),
    onCurrentProject: (state) => currentProjects.push(state),
    onError: (message) => errors.push(message),
  };

  return {
    events,
    supervisors,
    shells,
    registries,
    daemonStatuses,
    currentProjects,
    errors,
    controller: createProjectController(deps),
  };
}

describe('open-project — picker registers and opens the chosen directory', () => {
  it('registers the picked dir and opens THAT project (daemon started, current-project pushed)', async () => {
    const PID = 'pid-from-registry' as ProjectId;
    const h = makeHarness({
      pick: async () => '/repo/alpha',
      registerImpl: (absPath) => {
        expect(absPath).toBe('/repo/alpha');
        return PID;
      },
    });

    await h.controller.pickAndOpenProject();

    // The picked dir was registered through the @co/core registry, which was then closed.
    expect(h.registries).toHaveLength(1);
    expect(h.registries[0]!.registerCalls).toEqual(['/repo/alpha']);
    expect(h.registries[0]!.closed).toBe(true);

    // A supervisor + shell were built for THAT id, and the daemon started for it (assert the VALUE).
    expect(h.supervisors).toHaveLength(1);
    expect(h.supervisors[0]!.startCalls).toEqual([PID]);
    expect(h.shells).toHaveLength(1);
    expect(h.shells[0]!.started).toBe(true);

    // Current-project state pushed with the id + path.
    expect(h.controller.currentProject).toEqual({ projectId: PID, path: '/repo/alpha' });
    expect(h.currentProjects.at(-1)).toEqual({ projectId: PID, path: '/repo/alpha' });
    expect(h.errors).toEqual([]);
  });

  it('cancelling the picker is a no-op — no registration, no switch, no error', async () => {
    const h = makeHarness({ pick: async () => null });

    await h.controller.pickAndOpenProject();

    expect(h.registries).toHaveLength(0);
    expect(h.supervisors).toHaveLength(0);
    expect(h.shells).toHaveLength(0);
    expect(h.currentProjects).toEqual([]);
    expect(h.errors).toEqual([]);
    expect(h.controller.currentProject).toBeNull();
  });

  it('SH-4: the open path is purely LOCAL — only registry + supervisor + shell seams, no network', async () => {
    const h = makeHarness({
      pick: async () => '/repo/offline',
      registerImpl: () => 'pid-off' as ProjectId,
    });

    await h.controller.pickAndOpenProject();

    // The entire effect log is the local registry write + the local daemon/shell bring-up. `relink`/`resolve`
    // (the only registry methods that could imply remote reconciliation here) throw if touched, so a green
    // run proves the open path needs nothing remote.
    expect(h.events).toEqual([
      'registry.register:/repo/offline',
      'registry.close',
      'supervisor.start:pid-off',
      'shell.start:pid-off',
    ]);
  });
});

describe('open-project — switching projects tears the old one down first', () => {
  it('closes the A shell AND stops the A daemon BEFORE the B daemon starts (no leak, no double shell)', async () => {
    const A = 'pid-A' as ProjectId;
    const B = 'pid-B' as ProjectId;
    const h = makeHarness();

    await h.controller.openProject(A, '/repo/a');
    await h.controller.openProject(B, '/repo/b');

    expect(h.supervisors).toHaveLength(2);
    expect(h.shells).toHaveLength(2);

    // Ordering: A daemon stopped, then A shell closed, then B daemon starts.
    const stopA = h.events.indexOf('supervisor.stop:pid-A');
    const closeA = h.events.indexOf('shell.close:pid-A');
    const startB = h.events.indexOf('supervisor.start:pid-B');
    expect(stopA).toBeGreaterThanOrEqual(0);
    expect(closeA).toBeGreaterThan(stopA);
    expect(startB).toBeGreaterThan(closeA);

    // Exactly one live project (B): A torn down, B intact.
    expect(h.supervisors[0]!.stopCount).toBe(1);
    expect(h.shells[0]!.closed).toBe(true);
    expect(h.shells[1]!.closed).toBe(false);
    expect(h.controller.shell).toBe(h.shells[1] as unknown as AppShell);
    expect(h.controller.currentProject).toEqual({ projectId: B, path: '/repo/b' });
  });

  it('serializes concurrent opens — the first fully opens before the second tears it down', async () => {
    const A = 'pid-A' as ProjectId;
    const B = 'pid-B' as ProjectId;
    const h = makeHarness();

    // Fire BOTH without awaiting the first (the picker fired while the env project is still starting up).
    const p1 = h.controller.openProject(A, '/repo/a');
    const p2 = h.controller.openProject(B, '/repo/b');
    await Promise.all([p1, p2]);

    // A came fully up (shell started) BEFORE its teardown, and B starts only after A is fully down — no
    // interleaving that would start an already-closed shell or stop an already-replaced daemon.
    const shellStartA = h.events.indexOf('shell.start:pid-A');
    const closeA = h.events.indexOf('shell.close:pid-A');
    const startB = h.events.indexOf('supervisor.start:pid-B');
    expect(shellStartA).toBeGreaterThanOrEqual(0);
    expect(closeA).toBeGreaterThan(shellStartA);
    expect(startB).toBeGreaterThan(closeA);
    expect(h.controller.currentProject).toEqual({ projectId: B, path: '/repo/b' });
    expect(h.shells[0]!.closed).toBe(true);
    expect(h.shells[1]!.closed).toBe(false);
  });

  it('shutdown stops the daemon then closes the shell (inverse of the open order)', async () => {
    const h = makeHarness();
    await h.controller.openProject('pid-s' as ProjectId, '/repo/s');
    h.events.length = 0;

    await h.controller.shutdown();

    expect(h.events).toEqual(['supervisor.stop:pid-s', 'shell.close:pid-s']);
    expect(h.controller.shell).toBeNull();
  });
});

describe('open-project — no-project on-ramp (startup without CO_PROJECT_ID)', () => {
  it('showNoProject surfaces the empty state (current-project null, daemon stopped) and stays usable', async () => {
    const h = makeHarness({
      pick: async () => '/repo/late',
      registerImpl: () => 'pid-late' as ProjectId,
    });

    h.controller.showNoProject();

    expect(h.controller.currentProject).toBeNull();
    expect(h.currentProjects.at(-1)).toBeNull();
    expect(h.daemonStatuses.at(-1)).toEqual({ status: 'stopped', detail: null });
    expect(h.shells).toHaveLength(0); // no shell/daemon built when there is no project
    expect(h.supervisors).toHaveLength(0);
    expect(h.errors).toEqual([]);

    // Clicking "Open project" then drives a normal open.
    await h.controller.pickAndOpenProject();
    expect(h.shells).toHaveLength(1);
    expect(h.supervisors[0]!.startCalls).toEqual(['pid-late']);
    expect(h.controller.currentProject).toEqual({ projectId: 'pid-late', path: '/repo/late' });
  });
});

describe('open-project — failures are visible (Principle 9) and leave the app usable', () => {
  it('a register failure is surfaced and does NOT tear down the current project', async () => {
    const A = 'pid-A' as ProjectId;
    const h = makeHarness({
      pick: async () => '/repo/broken',
      registerImpl: () => {
        throw new Error('disk full');
      },
    });

    await h.controller.openProject(A, '/repo/a');
    const shellsBefore = h.shells.length;
    const supervisorsBefore = h.supervisors.length;

    await h.controller.pickAndOpenProject();

    // Visible error, registry still closed (try/finally), and the prior project is untouched.
    expect(h.errors.some((m) => m.includes('disk full'))).toBe(true);
    expect(h.registries.at(-1)!.closed).toBe(true);
    expect(h.shells).toHaveLength(shellsBefore);
    expect(h.supervisors).toHaveLength(supervisorsBefore);
    expect(h.shells[0]!.closed).toBe(false);
    expect(h.controller.currentProject).toEqual({ projectId: A, path: '/repo/a' });
  });

  it('a picker failure is surfaced and changes nothing', async () => {
    const h = makeHarness({
      pick: async () => {
        throw new Error('dialog crashed');
      },
    });

    await h.controller.pickAndOpenProject();

    expect(h.errors.some((m) => m.includes('dialog crashed'))).toBe(true);
    expect(h.registries).toHaveLength(0);
    expect(h.shells).toHaveLength(0);
    expect(h.controller.currentProject).toBeNull();
  });

  it('a shell factory failure cleans up the partial supervisor and resets to no-project', async () => {
    const h = makeHarness({ createShellThrows: true });

    await expect(
      h.controller.openProject('pid-bad-shell' as ProjectId, '/repo/bad'),
    ).rejects.toThrow(/shell factory exploded/);

    expect(h.supervisors).toHaveLength(1);
    expect(h.supervisors[0]!.stopCount).toBe(1);
    expect(h.shells).toHaveLength(0);
    expect(h.controller.shell).toBeNull();
    expect(h.controller.currentProject).toBeNull();
    expect(h.currentProjects.at(-1)).toBeNull();
    expect(h.daemonStatuses.at(-1)).toEqual({ status: 'stopped', detail: null });
  });

  it('a daemon start exception closes the new shell and resets to no-project', async () => {
    const h = makeHarness({ supervisorStartThrows: true });

    await expect(
      h.controller.openProject('pid-bad-daemon' as ProjectId, '/repo/bad'),
    ).rejects.toThrow(/daemon spawn exploded/);

    expect(h.supervisors).toHaveLength(1);
    expect(h.supervisors[0]!.stopCount).toBe(1);
    expect(h.shells).toHaveLength(1);
    expect(h.shells[0]!.closed).toBe(true);
    expect(h.controller.shell).toBeNull();
    expect(h.controller.currentProject).toBeNull();
    expect(h.currentProjects.at(-1)).toBeNull();
    expect(h.daemonStatuses.at(-1)).toEqual({ status: 'stopped', detail: null });
  });

  it('a shell start exception stops the daemon, closes the shell, and resets to no-project', async () => {
    const h = makeHarness({ shellStartThrows: true });

    await expect(
      h.controller.openProject('pid-bad-start' as ProjectId, '/repo/bad'),
    ).rejects.toThrow(/shell start exploded/);

    expect(h.supervisors).toHaveLength(1);
    expect(h.supervisors[0]!.stopCount).toBe(1);
    expect(h.shells).toHaveLength(1);
    expect(h.shells[0]!.closed).toBe(true);
    expect(h.controller.shell).toBeNull();
    expect(h.controller.currentProject).toBeNull();
    expect(h.currentProjects.at(-1)).toBeNull();
    expect(h.daemonStatuses.at(-1)).toEqual({ status: 'stopped', detail: null });
  });
});

describe('open-project — P-ON1 invariants preserved across the refactor', () => {
  it('a failed daemon start still brings up the (degraded) shell with a visible failed status', async () => {
    const h = makeHarness({ startResult: () => 'failed' });

    await h.controller.openProject('pid-x' as ProjectId, '/repo/x');

    expect(h.shells[0]!.started).toBe(true); // the window still comes up
    expect(h.controller.shell).not.toBeNull();
    expect(h.daemonStatuses.map((s) => s.status)).toContain('failed');
    expect(h.daemonStatuses.at(-1)).toEqual({
      status: 'failed',
      detail: 'fake daemon did not become healthy',
    });
  });

  it('does NOT refresh the connection during the initial start (shell not up when the first healthy fires)', async () => {
    const h = makeHarness();
    await h.controller.openProject('pid-i' as ProjectId, '/repo/i');
    expect(h.shells[0]!.refreshCalls).toBe(0);
  });

  it('a healthy transition AFTER the shell is up refreshes the operator-IPC connection', async () => {
    const h = makeHarness();
    await h.controller.openProject('pid-h' as ProjectId, '/repo/h');
    const before = h.shells[0]!.refreshCalls;

    h.supervisors[0]!.emit('healthy'); // a post-restart recovery
    await Promise.resolve();

    expect(h.shells[0]!.refreshCalls).toBe(before + 1);
  });
});

describe('open-project — daemon Retry + env-path resolution', () => {
  it('retryDaemon re-arms the current supervisor and refreshes the shell on healthy', async () => {
    const h = makeHarness();
    await h.controller.openProject('pid-r' as ProjectId, '/repo/r');

    const result = await h.controller.retryDaemon();

    expect(result).toEqual({ ok: true });
    expect(h.supervisors[0]!.startCalls).toEqual(['pid-r', 'pid-r']); // initial + retry
    expect(h.shells[0]!.refreshCalls).toBeGreaterThanOrEqual(1);
  });

  it('retryDaemon is a visible no-op when no project is open', async () => {
    const h = makeHarness();
    const result = await h.controller.retryDaemon();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/No project is open/);
  });

  it('openProject without a known path resolves it from the registry (local read)', async () => {
    const h = makeHarness({
      pathForImpl: (id) => (id === 'pid-env' ? '/repo/env' : undefined),
    });

    await h.controller.openProject('pid-env' as ProjectId);

    expect(h.controller.currentProject).toEqual({ projectId: 'pid-env', path: '/repo/env' });
  });

  it('openProject path is null when the registry has no record for the id (no throw)', async () => {
    const h = makeHarness({ pathForImpl: () => undefined });

    await h.controller.openProject('pid-unknown' as ProjectId);

    expect(h.controller.currentProject).toEqual({ projectId: 'pid-unknown', path: null });
  });
});
