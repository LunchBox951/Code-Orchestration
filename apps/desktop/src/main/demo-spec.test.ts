import { describe, expect, it } from 'vitest';
import type { StartSessionParams } from '@co/core';
import { bundledDemoSpecPath, startFromDemoSpec } from './demo-spec.js';

/**
 * P-ON3 acceptance coverage for "Start from demo spec". The spec read and the `startSession` client are
 * both injected fakes — NO real Electron, NO real `co-mcp serve`, NO real filesystem read — so the
 * launch path is exercised headlessly (HOST-LIVE GUARDRAIL).
 */

/** A `startSession` stand-in recording the exact params it was called with. */
class FakeStartSessionClient {
  readonly calls: StartSessionParams[] = [];
  async startSession(params: StartSessionParams): Promise<unknown> {
    this.calls.push(params);
    return {};
  }
}

describe('startFromDemoSpec (P-ON3 demo-spec launch)', () => {
  it('reads the bundled spec and starts a session with that EXACT specBody', async () => {
    const client = new FakeStartSessionClient();
    const result = await startFromDemoSpec({
      client,
      readDemoSpec: () => '# co improves its own docs\n\nbody',
    });
    expect(result).toEqual({ ok: true });
    // Assert the VALUE passed to startSession (not merely that it was called) — review craft.
    expect(client.calls).toEqual([{ specBody: '# co improves its own docs\n\nbody' }]);
  });

  it('returns a visible error and never reads the spec when no project is open', async () => {
    let readCalled = false;
    const result = await startFromDemoSpec({
      client: null,
      readDemoSpec: () => {
        readCalled = true;
        return 'x';
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(readCalled).toBe(false);
  });

  it('surfaces a missing/unreadable spec as a visible error and does NOT start a session (Principle 9)', async () => {
    const client = new FakeStartSessionClient();
    const result = await startFromDemoSpec({
      client,
      readDemoSpec: () => {
        throw new Error("ENOENT: no such file 'demo-spec.md'");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOENT');
    expect(client.calls).toEqual([]);
  });

  it('rejects an empty/whitespace-only spec without starting a session', async () => {
    const client = new FakeStartSessionClient();
    const result = await startFromDemoSpec({ client, readDemoSpec: () => '   \n  ' });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(client.calls).toEqual([]);
  });

  it('surfaces a startSession rejection as a visible error', async () => {
    const client = {
      startSession: async (): Promise<unknown> => {
        throw new Error('conductor unavailable');
      },
    };
    const result = await startFromDemoSpec({ client, readDemoSpec: () => 'spec body' });
    expect(result).toEqual({ ok: false, error: 'conductor unavailable' });
  });

  it('derives the bundled spec path from the main bundle dir (dist/main → dist/renderer)', () => {
    expect(bundledDemoSpecPath('/app/dist/main')).toBe('/app/dist/renderer/demo-spec.md');
  });
});
