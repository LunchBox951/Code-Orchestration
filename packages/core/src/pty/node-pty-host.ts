/**
 * L7 B1 — `NodePtyHost`: the ONE real-binary adapter, implementing the frozen {@link PtyHost} over a
 * real `node-pty` `IPty`. This is the single place the native pty substrate is touched; everything
 * else in L7 talks to the `PtyHost`/`Pane` interface and is sandbox-testable over `FakePty`.
 *
 * Sandbox-gate safety (the 5-command gate must pass WITHOUT node-pty's native module built or even
 * present):
 *   1. node-pty is reached ONLY via a lazy dynamic `import()` (never a top-level import), behind a
 *      LOCAL type shim ({@link NodePtyModule} / {@link IPtyLike}) — so `tsc`/`build` carry no hard
 *      type- or module-dependency on node-pty.
 *   2. The module is constructor-INJECTED ({@link NodePtyHost} takes a {@link NodePtyModule}); the
 *      real import is isolated in {@link NodePtyHost.create}'s default loader. Sandbox tests inject a
 *      FAKE module + IPty and assert the spec→spawn arg mapping and the IPty→Pane adapter wiring, with
 *      no real process and no real node-pty import.
 *
 * The real authed claude/codex reaching `ready` in a real node-pty is the operator's host-side proof
 * (AC-L7-1 `[host-live]`), not a sandbox job.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { Pane, PrelaunchFile, PtyExit, PtyHost, SpawnSpec } from './pty-host.js';

/** node-pty `IDisposable`: returned by `onData`/`onExit`, cancels the subscription. */
export interface IDisposableLike {
  dispose(): void;
}

/** The node-pty `onExit` event payload (`exitCode` + optional `signal`). */
export interface IPtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number;
}

/** The fork options we pass to `node-pty.spawn` (subset of node-pty's `IPtyForkOptions`). */
export interface IPtyForkOptionsLike {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly cols?: number;
  readonly rows?: number;
  readonly name?: string;
}

/** The minimal surface of node-pty's `IPty` that the adapter actually uses. */
export interface IPtyLike {
  write(data: string): void;
  onData(listener: (data: string) => void): IDisposableLike;
  onExit(listener: (event: IPtyExitEvent) => void): IDisposableLike;
  kill(signal?: string): void;
}

/** The minimal surface of the `node-pty` module that the adapter actually uses. */
export interface NodePtyModule {
  spawn(file: string, args: readonly string[], options: IPtyForkOptionsLike): IPtyLike;
}

/** Lazily produces a {@link NodePtyModule}; the default loads real node-pty via dynamic `import()`. */
export type NodePtyModuleLoader = () => Promise<NodePtyModule>;

/** Default terminal geometry when a {@link SpawnSpec} does not specify it (a roomy TUI viewport). */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const PTY_NAME = 'xterm-256color';
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin';

let nodePaneCounter = 0;

/**
 * The lazy default loader: a dynamic `import('node-pty')` via a string-typed specifier so neither
 * `tsc` nor the bundler statically resolves (and thus hard-depends on) node-pty. The native module is
 * loaded ONLY when this runs — i.e. host-side, never in the sandbox gate.
 */
const defaultLoader: NodePtyModuleLoader = async () => {
  const moduleId: string = 'node-pty';
  return (await import(moduleId)) as unknown as NodePtyModule;
};

/** Wraps a node-pty `IPty` as a {@link Pane}, adapting events to the frozen interface. */
class NodePtyPane implements Pane {
  readonly id: string;
  readonly #pty: IPtyLike;
  #earlyDataSub: IDisposableLike | undefined;
  #earlyDataChunks: string[] = [];
  #earlyReplay: string | undefined;

  constructor(id: string, pty: IPtyLike) {
    this.id = id;
    this.#pty = pty;
    this.#earlyDataSub = pty.onData((chunk) => {
      this.#earlyDataChunks.push(chunk);
    });
  }

  write(data: string): void {
    this.#pty.write(data);
  }

  onData(cb: (chunk: string) => void): () => void {
    const sub = this.#pty.onData(cb);
    let replay = this.#earlyReplay;
    if (this.#earlyDataSub != null) {
      replay = this.#earlyDataChunks.join('');
      this.#earlyDataChunks = [];
      this.#earlyDataSub.dispose();
      this.#earlyDataSub = undefined;
      this.#earlyReplay = replay;
      queueMicrotask(() => {
        if (this.#earlyReplay === replay) this.#earlyReplay = undefined;
      });
    }
    if (replay != null && replay.length > 0) cb(replay);
    return () => sub.dispose();
  }

  onExit(cb: (ev: PtyExit) => void): () => void {
    const sub = this.#pty.onExit((event) =>
      cb({ code: event.exitCode, signal: event.signal ?? null }),
    );
    return () => sub.dispose();
  }

  kill(signal?: string): void {
    this.#pty.kill(signal);
  }

  signal(sig: string): void {
    // node-pty has no separate signal channel; delivering the signal IS `kill(sig)` (e.g. SIGSTOP).
    this.#pty.kill(sig);
  }
}

/**
 * A {@link PtyHost} backed by real node-pty. Construct with an injected {@link NodePtyModule} (tests),
 * or via {@link NodePtyHost.create} which lazily imports the real module (production, host-side).
 */
export class NodePtyHost implements PtyHost {
  readonly #mod: NodePtyModule;

  constructor(mod: NodePtyModule) {
    this.#mod = mod;
  }

  /** Build a host, lazily loading node-pty via `loader` (default: dynamic `import('node-pty')`). */
  static async create(loader: NodePtyModuleLoader = defaultLoader): Promise<NodePtyHost> {
    return new NodePtyHost(await loader());
  }

  spawn(spec: SpawnSpec): Pane {
    materializePrelaunchFiles(spec.prelaunchFiles ?? []);
    const pty = this.#mod.spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: sanitizedSpawnEnv(spec.env),
      cols: spec.cols ?? DEFAULT_COLS,
      rows: spec.rows ?? DEFAULT_ROWS,
      name: PTY_NAME,
    });
    return new NodePtyPane(`node-pane-${nodePaneCounter++}`, pty);
  }
}

function sanitizedSpawnEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  return {
    PATH: env['PATH'] ?? process.env.PATH ?? DEFAULT_PATH,
    ...env,
  };
}

function materializePrelaunchFiles(files: readonly PrelaunchFile[]): void {
  for (const file of files) {
    if (!isAbsolute(file.path)) {
      throw new Error(`NodePtyHost.spawn: prelaunch file path must be absolute: '${file.path}'`);
    }
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents, {
      encoding: 'utf8',
      mode: file.mode ?? 0o600,
    });
    chmodSync(file.path, file.mode ?? 0o600);
    const installed = readFileSync(file.path, 'utf8');
    if (installed !== file.contents) {
      throw new Error(`NodePtyHost.spawn: prelaunch file verification failed for '${file.path}'`);
    }
  }
}
