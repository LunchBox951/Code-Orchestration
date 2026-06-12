/**
 * In-sandbox test double for PtyHost + Pane. Deterministic: no real timers, no processes, no
 * node-pty. Tests drive output via `pane.emit(chunk)`, lifecycle via `pane.exit(code, signal)`
 * and stop/resume via `pane.signal('SIGSTOP' | 'SIGCONT')`. Later phases build realistic byte
 * fixtures (interstitial prompts, OSC0 edges, the 8s wedge) on top of this primitive.
 */
import type { Pane, PtyExit, PtyHost, SpawnSpec } from './pty-host.js';

/** A fake Pane with test-helper methods for scripted output, lifecycle injection, and inspection. */
export interface FakePtyPane extends Pane {
  /** Emit a chunk to all current `onData` subscribers (test-drive output). */
  emit(chunk: string): void;
  /** Fire `onExit` with the given code/signal (idempotent — only first call fires). */
  exit(code: number | null, signal: number | null): void;
  /** All data written via `write()`, in order. */
  readonly written: readonly string[];
  /** The SpawnSpec this pane was created with (P1 will assert env/args). */
  readonly spec: SpawnSpec;
  /** True while SIGSTOP is in effect (cleared by SIGCONT). */
  readonly stopped: boolean;
}

let paneCounter = 0;

class FakePtyPaneImpl implements FakePtyPane {
  readonly id: string;
  readonly spec: SpawnSpec;
  private _written: string[] = [];
  private _stopped = false;
  private _exited = false;
  private _dataListeners: Set<(chunk: string) => void> = new Set();
  private _exitListeners: Set<(ev: PtyExit) => void> = new Set();

  constructor(id: string, spec: SpawnSpec) {
    this.id = id;
    this.spec = spec;
  }

  get written(): readonly string[] {
    return this._written;
  }

  get stopped(): boolean {
    return this._stopped;
  }

  write(data: string): void {
    this._written.push(data);
  }

  onData(cb: (chunk: string) => void): () => void {
    this._dataListeners.add(cb);
    return () => {
      this._dataListeners.delete(cb);
    };
  }

  onExit(cb: (ev: PtyExit) => void): () => void {
    this._exitListeners.add(cb);
    return () => {
      this._exitListeners.delete(cb);
    };
  }

  kill(): void {
    this.exit(null, null);
  }

  signal(sig: string): void {
    if (sig === 'SIGSTOP') {
      this._stopped = true;
    } else if (sig === 'SIGCONT') {
      this._stopped = false;
    }
  }

  emit(chunk: string): void {
    for (const cb of this._dataListeners) {
      cb(chunk);
    }
  }

  exit(code: number | null, signal: number | null): void {
    if (this._exited) return;
    this._exited = true;
    for (const cb of this._exitListeners) {
      cb({ code, signal });
    }
  }
}

/** In-sandbox PtyHost test double. Spawn returns a FakePtyPane; all panes are accessible via `.panes`. */
export class FakePty implements PtyHost {
  private readonly _panes: FakePtyPaneImpl[] = [];

  /** All panes ever spawned, in spawn order. */
  get panes(): readonly FakePtyPane[] {
    return this._panes;
  }

  spawn(spec: SpawnSpec): FakePtyPane {
    const pane = new FakePtyPaneImpl(`fake-pane-${paneCounter++}`, spec);
    this._panes.push(pane);
    return pane;
  }
}
