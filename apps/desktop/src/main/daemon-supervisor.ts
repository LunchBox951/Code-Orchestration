import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { ProjectId } from '@co/core';
import { ghCommandPathEnv, resolveGhTokenFromEnv } from '@co/core';
import { OperatorIpcConnection, defaultGhAuthTokenRunner, type GhAuthTokenRunner } from '@co/mcp';
import { defaultOperatorSocketPath } from './app-shell.js';

/**
 * P-ON1 — the Electron app OWNS the Conductor daemon lifecycle.
 *
 * The desktop app spawns + supervises `co-mcp serve <projectId>` as a child process: start it, wait
 * until the operator-IPC socket is healthy, RESTART it on an unexpected crash (bounded — never an
 * infinite respawn), STOP it on app quit, and surface a VISIBLE status to the operator. Before this,
 * `index.ts` only connected an {@link OperatorIpcClient} to a SEPARATELY-run daemon and dead-ended on
 * "Conductor not running — start `co-mcp serve`"; now the app is the daemon's supervisor.
 *
 * Every external effect is an INJECTABLE seam (spawn / bin-resolution / health-probe / delay) so the
 * supervisor is testable HEADLESSLY — no real Electron, no real `co-mcp serve`, no real pty hosting.
 * The production DEFAULT of each seam is the real implementation, asserted by the default-path tests.
 */

/** The operator-visible daemon lifecycle status. */
export type DaemonStatus = 'starting' | 'healthy' | 'restarting' | 'failed' | 'stopped';

/**
 * The minimal child-process surface the supervisor depends on — a strict subset of `ChildProcess`, so
 * the production seam returns a real `ChildProcess` and tests inject a bare `EventEmitter` + `kill()`.
 */
export interface DaemonSpawnHandle {
  readonly pid?: number | undefined;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/** A fully-resolved spawn command — computed PURELY so the default can be asserted without spawning. */
export interface SpawnDescriptor {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface GithubAuthStatus {
  readonly connected: boolean;
  readonly source: 'connected' | 'env' | 'gh' | 'stored-unreadable' | null;
}

/**
 * Resolve the absolute path to the `@co/mcp` daemon entrypoint. The package's `co-mcp` bin maps to
 * `./dist/bin.js`, and `co-mcp serve <projectId>` dispatches to `runServeConductor([projectId])`.
 * Real Node resolution (NOT a vitest alias) — `pnpm build` (run by `pretest`) materializes the file.
 */
export function defaultCoMcpBinPath(): string {
  return createRequire(import.meta.url).resolve('@co/mcp/dist/bin.js');
}

/**
 * Build the EXACT default spawn descriptor: run the resolved `@co/mcp` bin with the CURRENT executable
 * (`process.execPath`) under `ELECTRON_RUN_AS_NODE=1`. That env flag makes Electron's own binary run
 * the script as plain Node instead of launching a SECOND Electron app — the same pattern the
 * native-abi proof uses. Pure + side-effect-free so a test asserts the production default without
 * spawning a real daemon.
 *
 * `extraEnv` (#95/#71) merges the Connect-GitHub provisioning ({@link CO_GH_TOKEN} + a widened PATH so
 * the GUI-launched daemon can find `gh`) into the spawn env. It is applied AFTER `baseEnv` but BEFORE
 * `ELECTRON_RUN_AS_NODE` so the flag can never be clobbered. With NO token `extraEnv` omits
 * `CO_GH_TOKEN` entirely — the key is ABSENT, never an empty/blank value (which the daemon's
 * trim-and-drop resolver would reject anyway, but we never even emit it).
 */
export function buildDaemonSpawnDescriptor(
  projectId: ProjectId,
  coMcpBinPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  extraEnv: Readonly<Record<string, string>> = {},
): SpawnDescriptor {
  return {
    command: process.execPath,
    args: [coMcpBinPath, 'serve', projectId],
    env: { ...baseEnv, ...extraEnv, ELECTRON_RUN_AS_NODE: '1' },
  };
}

/**
 * Compute the GitHub provisioning env merged into each `co-mcp serve` spawn (#95/#71). Pure over its
 * inputs so it is unit-testable without spawning.
 *
 * Precedence (mirrors the daemon's own {@link resolveGhTokenFromEnv} policy so the GUI and CLI launch
 * paths agree on which token wins):
 *   1. A token the operator CONNECTED in Settings (`storedToken`) → injected as `CO_GH_TOKEN`.
 *   2. Else an EXPLICIT env token already present in `baseEnv` (`CO_GH_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`)
 *      → left as-is (we add nothing; the daemon's resolver picks it up).
 *   3. Else AUTO-PRIME (zero-config for `gh`-logged-in operators): run the bounded `gh auth token`
 *      resolver and, if it yields a token, inject it as `CO_GH_TOKEN` AND widen PATH to include the
 *      resolved `gh` directory so the daemon's own fallback can also find `gh`.
 *
 * Returns ONLY the additions; never an empty/blank `CO_GH_TOKEN`. The plaintext token is never logged.
 */
export function resolveSpawnGithubEnv(args: {
  readonly storedToken: string | null;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly runGhAuthToken?: GhAuthTokenRunner;
}): Record<string, string> {
  const stored = args.storedToken?.trim();
  if (stored != null && stored.length > 0) {
    return { CO_GH_TOKEN: stored };
  }
  // An explicit env token already present — the daemon's resolver will pick it up; add nothing.
  if (resolveGhTokenFromEnv(args.baseEnv) != null) return {};

  // Auto-prime: source the operator's existing `gh auth login` (GUI-PATH-safe absolute probes) and
  // inject it as CO_GH_TOKEN, widening PATH so the daemon's own gh fallback finds the same binary.
  const runner = args.runGhAuthToken ?? defaultGhAuthTokenRunner;
  const resolution = runner(args.baseEnv);
  if (resolution == null) return {};
  const token = resolution.token.trim();
  if (token.length === 0) return {};
  return { CO_GH_TOKEN: token, ...ghCommandPathEnv(resolution.command, args.baseEnv) };
}

export function resolveGithubAuthStatus(args: {
  readonly storedCredential: 'available' | 'missing' | 'unreadable';
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly runGhAuthToken?: GhAuthTokenRunner;
}): GithubAuthStatus {
  if (args.storedCredential === 'available') return { connected: true, source: 'connected' };
  if (args.storedCredential === 'unreadable') {
    return { connected: false, source: 'stored-unreadable' };
  }
  if (resolveGhTokenFromEnv(args.baseEnv) != null) return { connected: true, source: 'env' };
  const env = resolveSpawnGithubEnv({
    storedToken: null,
    baseEnv: args.baseEnv,
    ...(args.runGhAuthToken != null ? { runGhAuthToken: args.runGhAuthToken } : {}),
  });
  return env['CO_GH_TOKEN'] != null
    ? { connected: true, source: 'gh' }
    : { connected: false, source: null };
}

/**
 * The default health probe: open one operator-IPC connection to `socketPath` and immediately close it.
 * A resolve means the daemon is listening + accepting the JSON-RPC framing (healthy); a reject (socket
 * absent/refused) means it is not up yet. The probe MUST close — the daemon's operator-IPC server is
 * single-client (a new connection replaces the previous), so a lingering probe would fight the app's
 * own client. The default `socketPath` agrees with where `co-mcp serve` listens via
 * {@link defaultOperatorSocketPath}, so client ⇄ server ⇄ supervisor never silently diverge.
 */
export async function probeOperatorSocketHealthy(socketPath: string): Promise<boolean> {
  let connection: OperatorIpcConnection | undefined;
  try {
    connection = await OperatorIpcConnection.connect(socketPath);
    return true;
  } catch {
    return false;
  } finally {
    if (connection != null) {
      try {
        await connection.close();
      } catch {
        // Already gone — closing a never-established probe is best-effort.
      }
    }
  }
}

/** Real production default: spawn the daemon child, draining its stderr so the pipe never blocks it. */
function defaultSpawn(descriptor: SpawnDescriptor): DaemonSpawnHandle {
  const child = spawn(descriptor.command, [...descriptor.args], {
    env: descriptor.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Surface (never swallow — Principle 9) the daemon's own diagnostics, and drain the pipe so a full
  // buffer can never wedge the child. `co-mcp serve` reserves stdout for protocol, logging to stderr.
  const forward = (label: string) => (chunk: Buffer | string) => {
    process.stderr.write(`[co-mcp serve${label}] ${String(chunk)}`);
  };
  child.stderr?.on('data', forward(''));
  child.stdout?.on('data', forward(':out'));
  return child;
}

/** Injectable seams + tunables. Every seam DEFAULTS to the real production implementation. */
export interface DaemonSupervisorOptions {
  /** Status sink (e.g. push to the renderer over the `daemon:status` IPC channel). */
  readonly onStatus?: (status: DaemonStatus) => void;
  /** Spawn seam. Default: {@link defaultSpawn} (real `child_process.spawn`). */
  readonly spawn?: (descriptor: SpawnDescriptor) => DaemonSpawnHandle;
  /** Bin-resolution seam. Default: {@link defaultCoMcpBinPath}. */
  readonly resolveBinPath?: () => string;
  /**
   * Per-spawn extra-env seam (#95/#71). Resolved IMMEDIATELY BEFORE each `co-mcp serve` spawn so a
   * just-connected GitHub token (or a `gh auth token` auto-prime) takes effect on the next start /
   * restart without re-instantiating the supervisor. Defaults to `{}` (no additions). Production wires
   * {@link resolveSpawnGithubEnv} over the credential store. Must NOT emit a blank `CO_GH_TOKEN`.
   */
  readonly resolveExtraEnv?: () => Readonly<Record<string, string>>;
  /** Socket-path seam. Default: {@link defaultOperatorSocketPath} (the server's own formula). */
  readonly socketPathFor?: (projectId: ProjectId) => string;
  /** Health-probe seam. Default: {@link probeOperatorSocketHealthy}. */
  readonly probeHealth?: (socketPath: string) => Promise<boolean>;
  /** Clock seam — deterministic waits in tests. Default: real `setTimeout`. */
  readonly delay?: (ms: number) => Promise<void>;
  /** Max AUTOMATIC restarts per operator-initiated start before declaring `failed`. Default 5. */
  readonly maxRetries?: number;
  /** Approximate health-wait budget (realized as `ceil(timeout / interval)` poll attempts). Default 10s. */
  readonly healthTimeoutMs?: number;
  /** Delay between health polls. Default 250ms. */
  readonly healthIntervalMs?: number;
  /** Restart backoff base (doubles per attempt, capped at {@link backoffMaxMs}). Default 500ms. */
  readonly backoffBaseMs?: number;
  /** Restart backoff cap. Default 8s. */
  readonly backoffMaxMs?: number;
  /** Grace between SIGTERM and the SIGKILL escalation on stop. Default 5s. */
  readonly killGraceMs?: number;
}

function realDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns the `co-mcp serve <projectId>` child lifecycle. `start()`/`stop()`/`restart()` are idempotent
 * and re-entrancy-safe via a monotonic `generation` token: any in-flight health-wait or restart loop
 * from a superseded episode short-circuits when the generation moves, so a late `exit` can never
 * resurrect a stopped daemon.
 *
 * Designed so a later `restart(newProjectId)` (the P-ON2 repo picker) is natural: `start()` takes the
 * projectId, derives the socket path from it, and re-arms the retry budget.
 */
export class DaemonSupervisor {
  private readonly emitStatus: ((status: DaemonStatus) => void) | undefined;
  private readonly spawnFn: (descriptor: SpawnDescriptor) => DaemonSpawnHandle;
  private readonly resolveBinPath: () => string;
  private readonly resolveExtraEnv: () => Readonly<Record<string, string>>;
  private readonly socketPathFor: (projectId: ProjectId) => string;
  private readonly probeHealth: (socketPath: string) => Promise<boolean>;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly healthTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly killGraceMs: number;

  private _status: DaemonStatus = 'stopped';
  private _detail: string | null = null;
  private child: DaemonSpawnHandle | null = null;
  private projectId: ProjectId | null = null;
  private socketPath = '';
  private stopping = false;
  private retries = 0;
  private generation = 0;
  private starting: Promise<DaemonStatus> | null = null;
  private lastEmittedStatus: DaemonStatus = 'stopped';
  private lastEmittedDetail: string | null = null;
  private readonly exitedChildren = new WeakSet<DaemonSpawnHandle>();

  constructor(options: DaemonSupervisorOptions = {}) {
    this.emitStatus = options.onStatus;
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.resolveBinPath = options.resolveBinPath ?? defaultCoMcpBinPath;
    this.resolveExtraEnv = options.resolveExtraEnv ?? (() => ({}));
    this.socketPathFor = options.socketPathFor ?? defaultOperatorSocketPath;
    this.probeHealth = options.probeHealth ?? probeOperatorSocketHealthy;
    this.delay = options.delay ?? realDelay;
    this.maxRetries = options.maxRetries ?? 5;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 10_000;
    this.healthIntervalMs = options.healthIntervalMs ?? 250;
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.backoffMaxMs = options.backoffMaxMs ?? 8_000;
    this.killGraceMs = options.killGraceMs ?? 5_000;
  }

  get status(): DaemonStatus {
    return this._status;
  }

  /** A human-facing reason accompanying `restarting`/`failed` (for the operator-visible status line). */
  get detail(): string | null {
    return this._detail;
  }

  /**
   * Spawn the daemon for `projectId` and resolve once it is `healthy` or `failed`. Idempotent: a second
   * call while a start is in flight returns the same promise; a call while already healthy for the same
   * project is a no-op. Re-arms the retry budget — this is the operator's "Retry" entrypoint too.
   */
  start(projectId: ProjectId): Promise<DaemonStatus> {
    if (this.starting != null) return this.starting;
    if (this._status === 'healthy' && this.projectId === projectId && this.child != null) {
      return Promise.resolve('healthy');
    }
    const generation = ++this.generation;
    const run = this.startAfterTeardown(projectId, generation).finally(() => {
      if (this.starting === run) this.starting = null;
    });
    this.starting = run;
    return run;
  }

  private async startAfterTeardown(
    projectId: ProjectId,
    generation: number,
  ): Promise<DaemonStatus> {
    // Re-arming (Retry, or a direct project switch): reap any child left from a prior/failed episode and
    // wait for its exit before spawning the replacement. A real daemon may unlink its socket during exit,
    // so spawning before termination can race and remove the fresh daemon's healthy socket.
    const oldChild = this.child;
    if (oldChild != null) {
      this.child = null;
      await this.terminateChild(oldChild);
      if (generation !== this.generation) return this._status;
    }
    this.stopping = false;
    this.projectId = projectId;
    this.socketPath = this.socketPathFor(projectId);
    this.retries = 0;
    this._detail = null;
    return this.doStart(generation);
  }

  /**
   * Stop the daemon and DISARM restart: bump the generation (invalidating any in-flight wait/restart),
   * SIGTERM the child (escalating to SIGKILL after a grace), and mark `stopped` so a subsequent `exit`
   * does not respawn. Idempotent.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.generation++;
    this.starting = null;
    const child = this.child;
    this.child = null;
    if (child != null) await this.terminateChild(child);
    this._detail = null;
    this.setStatus('stopped');
    await Promise.resolve();
  }

  /** Stop the current daemon, then start one for `projectId` (the natural P-ON2 repo-switch path). */
  async restart(projectId: ProjectId): Promise<DaemonStatus> {
    await this.stop();
    return this.start(projectId);
  }

  private async doStart(generation: number): Promise<DaemonStatus> {
    this._detail = null;
    this.setStatus('starting');
    const child = this.spawnChild(generation);
    const healthy = await this.waitForHealth(child, generation);
    if (generation !== this.generation || this.stopping) return this._status;
    if (healthy) {
      this.retries = 0;
      this._detail = null;
      this.setStatus('healthy');
      return 'healthy';
    }
    // The initial daemon never became healthy within the budget — fail VISIBLY (never hang).
    if (this.child === child) this.child = null;
    await this.terminateChild(child);
    if (generation !== this.generation || this.stopping) return this._status;
    this._detail ??= `Conductor daemon did not become healthy within ${this.healthTimeoutMs}ms.`;
    this.setStatus('failed');
    return 'failed';
  }

  /** Spawn one child and wire its `exit`/`error` to the supervision path (guarded by generation). */
  private spawnChild(generation: number): DaemonSpawnHandle {
    // start() always sets projectId before any spawn; assert the invariant loudly (Principle 9) rather
    // than leaning on a cast, so a future caller that spawns without a project fails clearly, not silently.
    if (this.projectId == null) {
      throw new Error(
        'DaemonSupervisor.spawnChild: no projectId — start(projectId) must run first.',
      );
    }
    // Resolve the GitHub provisioning env at spawn time so a just-connected token (or a `gh auth token`
    // auto-prime) takes effect on the next start/restart. A throwing seam must never strand the daemon
    // unspawned (Principle 9 — degrade visibly, not silently) — fall back to no additions.
    let extraEnv: Readonly<Record<string, string>>;
    try {
      extraEnv = this.resolveExtraEnv();
    } catch (err) {
      process.stderr.write(`[daemon-supervisor] resolveExtraEnv threw: ${String(err)}\n`);
      extraEnv = {};
    }
    const descriptor = buildDaemonSpawnDescriptor(
      this.projectId,
      this.resolveBinPath(),
      process.env,
      extraEnv,
    );
    const child = this.spawnFn(descriptor);
    this.child = child;
    let settled = false;
    const onGone = (detail: string): void => {
      if (settled) return;
      settled = true;
      this.onChildGone(child, generation, detail);
    };
    child.on('exit', (code, signal) => {
      onGone(`Conductor daemon exited (code=${String(code)} signal=${String(signal)}).`);
    });
    child.on('error', (err) => {
      onGone(`Conductor daemon failed to spawn: ${err.message}`);
    });
    return child;
  }

  /**
   * React to a child going away. During start/restart (status not yet `healthy`) the active
   * `waitForHealth` resolves the outcome, so we only null the handle. An UNEXPECTED loss after we were
   * `healthy` drives the bounded restart loop.
   */
  private onChildGone(handle: DaemonSpawnHandle, generation: number, detail: string): void {
    this.exitedChildren.add(handle);
    if (generation !== this.generation || this.stopping) return;
    if (handle !== this.child) return;
    this.child = null;
    this._detail = detail;
    if (this._status !== 'healthy') return; // start/restart wait owns this episode's outcome
    void this.restartLoop(generation, detail);
  }

  /** Bounded restart: back off, respawn, re-health — until healthy or the retry budget is exhausted. */
  private async restartLoop(generation: number, detail: string): Promise<void> {
    while (true) {
      if (generation !== this.generation || this.stopping) return;
      if (this.retries >= this.maxRetries) {
        this._detail = `${detail} Exhausted ${this.maxRetries} restart attempts.`;
        this.setStatus('failed');
        return;
      }
      this.retries += 1;
      this._detail = `${detail} Restart attempt ${this.retries}/${this.maxRetries}.`;
      this.setStatus('restarting');
      await this.delay(this.backoffMs(this.retries - 1));
      if (generation !== this.generation || this.stopping) return;
      const child = this.spawnChild(generation);
      const healthy = await this.waitForHealth(child, generation);
      if (generation !== this.generation || this.stopping) return;
      if (healthy) {
        // A successful recovery CLEARS the budget — `retries` counts CONSECUTIVE failed restarts
        // (a crash loop), not lifetime crashes. Mirrors doStart's healthy branch; without this a
        // long-lived daemon that recovers from occasional crashes would spuriously hit `failed`
        // after maxRetries distinct (each-recovered) crashes.
        this.retries = 0;
        this._detail = null;
        this.setStatus('healthy');
        return;
      }
      // The respawn never became healthy — discard it and consume another attempt.
      if (this.child === child) this.child = null;
      await this.terminateChild(child);
      if (generation !== this.generation || this.stopping) return;
    }
  }

  /**
   * Poll the health seam until it succeeds or the budget (`ceil(timeout / interval)` attempts) is spent.
   * Iteration-count bounded — no wall-clock dependency — so a fake `delay` makes tests fully
   * deterministic and the wait can NEVER hang.
   */
  private async waitForHealth(child: DaemonSpawnHandle, generation: number): Promise<boolean> {
    const polls = Math.max(1, Math.ceil(this.healthTimeoutMs / this.healthIntervalMs));
    for (let i = 0; i < polls; i++) {
      if (generation !== this.generation || this.stopping) return false;
      if (this.child !== child) return false; // child exited / was replaced mid-wait
      let ok: boolean;
      try {
        ok = await this.probeHealth(this.socketPath);
      } catch {
        ok = false;
      }
      if (generation !== this.generation || this.stopping) return false;
      if (ok) return true;
      if (i < polls - 1) await this.delay(this.healthIntervalMs);
    }
    return false;
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** attempt);
  }

  /** SIGTERM the child; escalate to SIGKILL after the grace if it has not exited. Never throws. */
  private async terminateChild(child: DaemonSpawnHandle): Promise<void> {
    if (this.exitedChildren.has(child)) return;
    let exited = false;
    const exitedPromise = new Promise<void>((resolve) => {
      try {
        child.on('exit', () => {
          if (exited) return;
          exited = true;
          resolve();
        });
      } catch {
        // A handle without a usable emitter — escalation simply proceeds.
        exited = true;
        resolve();
      }
    });
    try {
      child.kill('SIGTERM');
    } catch (err) {
      process.stderr.write(`[daemon-supervisor] SIGTERM failed: ${String(err)}\n`);
    }
    await Promise.race([exitedPromise, this.delay(this.killGraceMs)]);
    if (exited) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
    await Promise.race([exitedPromise, this.delay(this.killGraceMs)]);
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  private setStatus(status: DaemonStatus): void {
    const detail = this._detail;
    const visibleStateChanged =
      this.lastEmittedStatus !== status || this.lastEmittedDetail !== detail;
    this._status = status;
    if (!visibleStateChanged) return;
    this.lastEmittedStatus = status;
    this.lastEmittedDetail = detail;
    if (this.emitStatus == null) return;
    try {
      this.emitStatus(status);
    } catch (err) {
      // A status listener must never crash the supervisor (Principle 9).
      process.stderr.write(`[daemon-supervisor] onStatus listener threw: ${String(err)}\n`);
    }
  }
}

/** Factory mirroring `createAppShell` — `index.ts` uses this; tests may use either. */
export function createDaemonSupervisor(options: DaemonSupervisorOptions = {}): DaemonSupervisor {
  return new DaemonSupervisor(options);
}
