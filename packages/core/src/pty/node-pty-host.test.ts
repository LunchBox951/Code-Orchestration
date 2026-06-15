import { describe, it, expect } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodePtyHost } from './node-pty-host.js';
import type {
  IDisposableLike,
  IPtyExitEvent,
  IPtyForkOptionsLike,
  IPtyLike,
  NodePtyModule,
} from './node-pty-host.js';
import type { SpawnSpec } from './pty-host.js';

/** A fake node-pty `IPty` that records interactions and lets the test fire data/exit. */
class FakeIPty implements IPtyLike {
  readonly writes: string[] = [];
  readonly kills: Array<string | undefined> = [];
  disposedData = 0;
  disposedExit = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: IPtyExitEvent) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  onData(listener: (data: string) => void): IDisposableLike {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
        this.disposedData++;
      },
    };
  }

  onExit(listener: (event: IPtyExitEvent) => void): IDisposableLike {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
        this.disposedExit++;
      },
    };
  }

  kill(signal?: string): void {
    this.kills.push(signal);
  }

  fireData(data: string): void {
    for (const l of this.dataListeners) l(data);
  }

  fireExit(event: IPtyExitEvent): void {
    for (const l of this.exitListeners) l(event);
  }
}

/** A fake node-pty module that records spawn calls and hands back a single {@link FakeIPty}. */
class FakeNodePty implements NodePtyModule {
  readonly calls: Array<{ file: string; args: readonly string[]; options: IPtyForkOptionsLike }> =
    [];
  readonly pty = new FakeIPty();

  spawn(file: string, args: readonly string[], options: IPtyForkOptionsLike): IPtyLike {
    this.calls.push({ file, args, options });
    return this.pty;
  }
}

const FULL_SPEC: SpawnSpec = {
  command: 'claude',
  args: ['--disallowedTools', 'Bash'],
  cwd: '/work/agent-1',
  env: { HOME: '/home/agent', CLAUDE_CONFIG_DIR: '/data/config/agent-1' },
  cols: 220,
  rows: 50,
};

describe('NodePtyHost — spec → node-pty.spawn arg mapping', () => {
  it('maps command/args/cwd/env/cols/rows onto the spawn call', () => {
    const mod = new FakeNodePty();
    new NodePtyHost(mod).spawn(FULL_SPEC);

    expect(mod.calls).toHaveLength(1);
    const call = mod.calls[0]!;
    expect(call.file).toBe('claude');
    expect(call.args).toEqual(['--disallowedTools', 'Bash']);
    expect(call.options.cwd).toBe('/work/agent-1');
    expect(call.options.env).toMatchObject({
      HOME: '/home/agent',
      CLAUDE_CONFIG_DIR: '/data/config/agent-1',
    });
    expect(call.options.env?.PATH).toBeTruthy();
    expect(call.options.cols).toBe(220);
    expect(call.options.rows).toBe(50);
  });

  it('preserves a sanitized PATH while only using provider config homes from the spec', () => {
    const mod = new FakeNodePty();
    new NodePtyHost(mod).spawn({
      command: 'codex',
      args: [],
      cwd: '/work/agent-1',
      env: { CODEX_HOME: '/data/codex/agent-1' },
    });

    const env = mod.calls[0]!.options.env!;
    expect(env.PATH).toBeTruthy();
    expect(env.CODEX_HOME).toBe('/data/codex/agent-1');
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.HOME).toBeUndefined();
  });

  it('defaults cols/rows when the spec omits them', () => {
    const mod = new FakeNodePty();
    new NodePtyHost(mod).spawn({ command: 'codex', args: [], cwd: '/w', env: {} });

    const call = mod.calls[0]!;
    expect(call.options.cols).toBe(120);
    expect(call.options.rows).toBe(30);
  });

  it('passes COPIES of args/env (mutating the spec afterwards must not affect the spawn call)', () => {
    const mod = new FakeNodePty();
    new NodePtyHost(mod).spawn(FULL_SPEC);
    const call = mod.calls[0]!;
    expect(call.args).not.toBe(FULL_SPEC.args);
    expect(call.options.env).not.toBe(FULL_SPEC.env);
  });
});

describe('NodePtyHost — prelaunch artifacts', () => {
  it('materializes and verifies prelaunch files before spawning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'co-node-pty-prelaunch-'));
    const mod = new FakeNodePty();
    const configPath = join(dir, 'codex', 'config.toml');
    const rulesPath = join(dir, 'codex', 'hooks', 'co-block-list-rules.json');
    try {
      new NodePtyHost(mod).spawn({
        command: 'codex',
        args: [],
        cwd: '/work/agent-1',
        env: { CODEX_HOME: join(dir, 'codex') },
        prelaunchFiles: [
          { path: configPath, contents: 'sandbox_mode = "workspace-write"\n' },
          { path: rulesPath, contents: '{"version":1}\n' },
        ],
      });

      expect(readFileSync(configPath, 'utf8')).toBe('sandbox_mode = "workspace-write"\n');
      expect(readFileSync(rulesPath, 'utf8')).toBe('{"version":1}\n');
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(statSync(rulesPath).mode & 0o777).toBe(0o600);
      expect(mod.calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed before spawn when a prelaunch file cannot be installed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'co-node-pty-prelaunch-fail-'));
    const mod = new FakeNodePty();
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, 'file blocks mkdir');
    try {
      expect(() =>
        new NodePtyHost(mod).spawn({
          command: 'codex',
          args: [],
          cwd: '/work/agent-1',
          env: { CODEX_HOME: join(dir, 'codex') },
          prelaunchFiles: [{ path: join(blocker, 'config.toml'), contents: 'x' }],
        }),
      ).toThrow();

      expect(mod.calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tightens permissions when overwriting an existing prelaunch file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'co-node-pty-prelaunch-mode-'));
    const mod = new FakeNodePty();
    const authPath = join(dir, 'codex', 'auth.json');
    try {
      mkdirSync(join(dir, 'codex'), { recursive: true });
      writeFileSync(authPath, '{"old":true}\n', { mode: 0o644 });
      chmodSync(authPath, 0o644);

      new NodePtyHost(mod).spawn({
        command: 'codex',
        args: [],
        cwd: '/work/agent-1',
        env: { CODEX_HOME: join(dir, 'codex') },
        prelaunchFiles: [{ path: authPath, contents: '{"new":true}\n' }],
      });

      expect(readFileSync(authPath, 'utf8')).toBe('{"new":true}\n');
      expect(statSync(authPath).mode & 0o777).toBe(0o600);
      expect(mod.calls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('NodePtyHost — IPty → Pane adapter wiring', () => {
  it('Pane.write forwards to IPty.write', () => {
    const mod = new FakeNodePty();
    const pane = new NodePtyHost(mod).spawn(FULL_SPEC);
    pane.write('hello\r');
    expect(mod.pty.writes).toEqual(['hello\r']);
  });

  it('Pane.onData receives IPty data; unsubscribe disposes and stops delivery', () => {
    const mod = new FakeNodePty();
    const pane = new NodePtyHost(mod).spawn(FULL_SPEC);
    const got: string[] = [];
    const unsub = pane.onData((c) => got.push(c));

    mod.pty.fireData('a');
    expect(got).toEqual(['a']);

    const disposedBeforeUnsub = mod.pty.disposedData;
    unsub();
    expect(mod.pty.disposedData).toBe(disposedBeforeUnsub + 1);
    mod.pty.fireData('b');
    expect(got).toEqual(['a']);
  });

  it('Pane.onData replays output emitted before the startup driver subscribes', () => {
    const mod = new FakeNodePty();
    const pane = new NodePtyHost(mod).spawn(FULL_SPEC);

    mod.pty.fireData('early prompt');

    const got: string[] = [];
    pane.onData((c) => got.push(c));
    expect(got).toEqual(['early prompt']);
  });

  it('Pane.onData replays early output to multiple early subscribers', () => {
    const mod = new FakeNodePty();
    const pane = new NodePtyHost(mod).spawn(FULL_SPEC);

    mod.pty.fireData('early prompt');

    const transcript: string[] = [];
    const startup: string[] = [];
    pane.onData((c) => transcript.push(c));
    pane.onData((c) => startup.push(c));

    expect(transcript).toEqual(['early prompt']);
    expect(startup).toEqual(['early prompt']);
  });

  it('Pane.onExit maps {exitCode,signal} → {code,signal}; missing signal becomes null', () => {
    const mod = new FakeNodePty();
    const pane = new NodePtyHost(mod).spawn(FULL_SPEC);
    const events: Array<{ code: number | null; signal: number | null }> = [];
    const unsub = pane.onExit((ev) => events.push(ev));

    mod.pty.fireExit({ exitCode: 3, signal: 9 });
    mod.pty.fireExit({ exitCode: 0 });
    expect(events).toEqual([
      { code: 3, signal: 9 },
      { code: 0, signal: null },
    ]);

    unsub();
    expect(mod.pty.disposedExit).toBe(1);
  });

  it('Pane.kill(sig) and Pane.signal(sig) both deliver via IPty.kill; kill() with no arg passes undefined', () => {
    const mod = new FakeNodePty();
    const pane = new NodePtyHost(mod).spawn(FULL_SPEC);
    pane.kill('SIGKILL');
    pane.signal('SIGSTOP');
    pane.kill();
    expect(mod.pty.kills).toEqual(['SIGKILL', 'SIGSTOP', undefined]);
  });

  it('each spawned Pane has a non-empty, distinct id', () => {
    const mod = new FakeNodePty();
    const host = new NodePtyHost(mod);
    const a = host.spawn(FULL_SPEC);
    const b = host.spawn(FULL_SPEC);
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });
});

describe('NodePtyHost.create — lazy injected loader (no real node-pty)', () => {
  it('builds a host from an injected loader and spawns through the fake module', async () => {
    const mod = new FakeNodePty();
    const host = await NodePtyHost.create(async () => mod);
    const pane = host.spawn({ command: 'codex', args: ['proto'], cwd: '/w', env: {} });

    expect(mod.calls).toHaveLength(1);
    expect(mod.calls[0]!.file).toBe('codex');
    pane.write('x');
    expect(mod.pty.writes).toEqual(['x']);
  });
});
