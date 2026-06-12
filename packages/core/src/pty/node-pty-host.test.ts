import { describe, it, expect } from 'vitest';
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
    expect(call.options.env).toEqual({
      HOME: '/home/agent',
      CLAUDE_CONFIG_DIR: '/data/config/agent-1',
    });
    expect(call.options.cols).toBe(220);
    expect(call.options.rows).toBe(50);
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

    unsub();
    expect(mod.pty.disposedData).toBe(1);
    mod.pty.fireData('b');
    expect(got).toEqual(['a']);
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
