import { describe, it, expect } from 'vitest';
import { FakePty } from './fake-pty.js';
import type { SpawnSpec } from './pty-host.js';

const BASE_SPEC: SpawnSpec = {
  command: 'claude',
  args: ['--disallowedTools', 'Bash'],
  cwd: '/work/agent-1',
  env: { HOME: '/home/agent', CLAUDE_CONFIG_DIR: '/data/config/agent-1' },
  cols: 220,
  rows: 50,
};

const CODEX_SPEC: SpawnSpec = {
  command: 'codex',
  args: [],
  cwd: '/work/agent-2',
  env: { CODEX_HOME: '/data/codex/agent-2' },
};

describe('FakePty — spawn + SpawnSpec recording', () => {
  it('spawn returns a Pane with a non-empty id', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    expect(pane.id).toBeTruthy();
  });

  it('spawn records the SpawnSpec on the pane', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    expect(pane.spec.command).toBe('claude');
    expect(pane.spec.args).toEqual(['--disallowedTools', 'Bash']);
    expect(pane.spec.cwd).toBe('/work/agent-1');
    expect(pane.spec.env).toEqual({
      HOME: '/home/agent',
      CLAUDE_CONFIG_DIR: '/data/config/agent-1',
    });
    expect(pane.spec.cols).toBe(220);
    expect(pane.spec.rows).toBe(50);
  });

  it('spawn makes pane accessible via fake.panes', () => {
    const fake = new FakePty();
    const p1 = fake.spawn(BASE_SPEC);
    const p2 = fake.spawn(CODEX_SPEC);
    expect(fake.panes).toHaveLength(2);
    expect(fake.panes[0]).toBe(p1);
    expect(fake.panes[1]).toBe(p2);
  });

  it('each spawn produces a distinct pane id', () => {
    const fake = new FakePty();
    const ids = [fake.spawn(BASE_SPEC).id, fake.spawn(BASE_SPEC).id, fake.spawn(BASE_SPEC).id];
    expect(new Set(ids).size).toBe(3);
  });
});

describe('FakePtyPane — onData / emit / unsubscribe', () => {
  it('scripted output reaches a single onData subscriber in order', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    const received: string[] = [];
    pane.onData((chunk) => received.push(chunk));

    pane.emit('hello ');
    pane.emit('world');
    expect(received).toEqual(['hello ', 'world']);
  });

  it('scripted output reaches all onData subscribers', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    const a: string[] = [];
    const b: string[] = [];
    pane.onData((c) => a.push(c));
    pane.onData((c) => b.push(c));

    pane.emit('chunk1');
    pane.emit('chunk2');
    expect(a).toEqual(['chunk1', 'chunk2']);
    expect(b).toEqual(['chunk1', 'chunk2']);
  });

  it('unsubscribe stops onData delivery', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    const received: string[] = [];
    const unsub = pane.onData((c) => received.push(c));

    pane.emit('before');
    unsub();
    pane.emit('after');
    expect(received).toEqual(['before']);
  });

  it('unsubscribing one listener does not affect others', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    const a: string[] = [];
    const b: string[] = [];
    const unsubA = pane.onData((c) => a.push(c));
    pane.onData((c) => b.push(c));

    pane.emit('x');
    unsubA();
    pane.emit('y');
    expect(a).toEqual(['x']);
    expect(b).toEqual(['x', 'y']);
  });
});

describe('FakePtyPane — write / written capture', () => {
  it('write is captured; multiple writes preserved in order', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    pane.write('line 1\n');
    pane.write('line 2\n');
    pane.write('line 3\n');
    expect(pane.written).toEqual(['line 1\n', 'line 2\n', 'line 3\n']);
  });

  it('write on a different pane is not visible on another', () => {
    const fake = new FakePty();
    const p1 = fake.spawn(BASE_SPEC);
    const p2 = fake.spawn(CODEX_SPEC);
    p1.write('p1 data');
    expect(p2.written).toHaveLength(0);
    expect(p1.written).toHaveLength(1);
  });
});

describe('FakePtyPane — exit / onExit', () => {
  it('exit fires onExit with the right code and signal', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    const events: Array<{ code: number | null; signal: number | null }> = [];
    pane.onExit((ev) => events.push(ev));

    pane.exit(0, null);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ code: 0, signal: null });
  });

  it('exit fires all onExit subscribers', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    const a: Array<{ code: number | null; signal: number | null }> = [];
    const b: Array<{ code: number | null; signal: number | null }> = [];
    pane.onExit((ev) => a.push(ev));
    pane.onExit((ev) => b.push(ev));

    pane.exit(1, 2);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]).toEqual({ code: 1, signal: 2 });
  });

  it('exit is idempotent — only the first call fires onExit', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    let count = 0;
    pane.onExit(() => {
      count++;
    });

    pane.exit(0, null);
    pane.exit(1, null);
    expect(count).toBe(1);
  });

  it('unsubscribe stops onExit delivery', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    const events: Array<{ code: number | null; signal: number | null }> = [];
    const unsub = pane.onExit((ev) => events.push(ev));
    unsub();
    pane.exit(0, null);
    expect(events).toHaveLength(0);
  });
});

describe('FakePtyPane — signal SIGSTOP / SIGCONT', () => {
  it('starts not stopped', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    expect(pane.stopped).toBe(false);
  });

  it('SIGSTOP puts pane in stopped/quiescent state', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    pane.signal('SIGSTOP');
    expect(pane.stopped).toBe(true);
  });

  it('SIGCONT resumes from stopped state', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    pane.signal('SIGSTOP');
    pane.signal('SIGCONT');
    expect(pane.stopped).toBe(false);
  });

  it('unknown signal does not change stopped state', () => {
    const fake = new FakePty();
    const pane = fake.spawn(BASE_SPEC);
    pane.signal('SIGUSR1');
    expect(pane.stopped).toBe(false);
  });
});
