/**
 * FROZEN cross-phase interface for the pty host abstraction. B1 (NodePtyHost) implements
 * PtyHost over a real node-pty IPty; B0 ships only this contract + FakePty.
 *
 * Type rationale: node-pty's IPty exposes `onData(s: string)` / `write(s: string)` — using
 * `string` here lets NodePtyHost implement PtyHost over IPty with no lossy adaptation.
 * `signal(sig)` may delegate to the same underlying mechanism as `kill`; the split exists so
 * callers can express "stop, don't kill" (e.g. SIGSTOP vs SIGKILL for the E1 liveness watchdog).
 */

/** A file the real host must install and verify before launching the pane. */
export interface PrelaunchFile {
  /** Absolute destination path. */
  readonly path: string;
  /** Complete UTF-8 file contents. */
  readonly contents: string;
  /** Optional file mode for newly-created files. */
  readonly mode?: number;
}

/** What a pane needs to launch. */
export interface SpawnSpec {
  /** 'claude' | 'codex' | absolute path */
  readonly command: string;
  readonly args: readonly string[];
  /** The agent's worktree. */
  readonly cwd: string;
  /** Per-pane isolated env (carries CODEX_HOME / CLAUDE_CONFIG_DIR for P1 isolation). */
  readonly env: Readonly<Record<string, string>>;
  /** Host-side launch artifacts to write and verify before spawn (e.g. Codex config.toml/hooks). */
  readonly prelaunchFiles?: readonly PrelaunchFile[];
  readonly cols?: number;
  readonly rows?: number;
}

export interface PtyExit {
  readonly code: number | null;
  readonly signal: number | null;
}

export interface Pane {
  readonly id: string;
  /** Send bytes into the pty (matches node-pty IPty.write). */
  write(data: string): void;
  /** Subscribe to output bytes; returns an unsubscribe function. */
  onData(cb: (chunk: string) => void): () => void;
  /** Subscribe to exit; returns an unsubscribe function. */
  onExit(cb: (ev: PtyExit) => void): () => void;
  /** Terminate the process (implementation chooses default signal). */
  kill(signal?: string): void;
  /** Send an arbitrary signal (e.g. 'SIGSTOP' / 'SIGCONT'). */
  signal(sig: string): void;
}

export interface PtyHost {
  spawn(spec: SpawnSpec): Pane;
}
