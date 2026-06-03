import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createToolRegistry, notImplemented, type ToolSpec } from './registry.js';
import type { ToolContext } from './context.js';

// ── Synthetic tools (phase A proves the MECHANISM, not real tools) ────────────
// Tiny self-describing schemas + a trivial handler. Real `co_*` tools arrive in
// phase B; A's job is to show register/get/has/list + the fail-loud invariants.

function doublerTool(name: string): ToolSpec<{ x: number }, { y: number }> {
  return {
    name,
    title: `Synthetic doubler (${name})`,
    description:
      'A synthetic test tool that doubles its input. Exists only to exercise the registry mechanism.',
    inputSchema: z.object({ x: z.number().describe('the number to double') }),
    outputSchema: z.object({ y: z.number().describe('the doubled result') }),
    handler: (_ctx, input) => ({ y: input.x * 2 }),
  };
}

describe('createToolRegistry — the L2 tool registry mechanism', () => {
  it('registers a tool and finds it by name (has/get)', () => {
    const reg = createToolRegistry();
    const tool = doublerTool('co_double');
    expect(reg.has('co_double')).toBe(false);
    expect(reg.get('co_double')).toBeUndefined();

    reg.register(tool);

    expect(reg.has('co_double')).toBe(true);
    expect(reg.get('co_double')).toBe(tool);
  });

  it('get/has return nothing for an unregistered name', () => {
    const reg = createToolRegistry();
    reg.register(doublerTool('co_present'));
    expect(reg.has('co_absent')).toBe(false);
    expect(reg.get('co_absent')).toBeUndefined();
  });

  it('list() returns every tool in registration order', () => {
    const reg = createToolRegistry();
    const names = ['co_c', 'co_a', 'co_b']; // deliberately not sorted
    for (const n of names) reg.register(doublerTool(n));
    expect(reg.list().map((t) => t.name)).toEqual(names);
  });

  it('list() is a snapshot — mutating the returned array cannot corrupt the registry', () => {
    const reg = createToolRegistry();
    reg.register(doublerTool('co_one'));
    const snapshot = reg.list();
    (snapshot as ToolSpec[]).push(doublerTool('co_smuggled') as unknown as ToolSpec);
    expect(reg.list().map((t) => t.name)).toEqual(['co_one']);
    expect(reg.has('co_smuggled')).toBe(false);
  });

  it('throws on a duplicate name (fail loud — Principle 9)', () => {
    const reg = createToolRegistry();
    reg.register(doublerTool('co_dup'));
    expect(() => reg.register(doublerTool('co_dup'))).toThrow(/duplicate/i);
  });

  it("a registered tool's handler runs against its validated input", () => {
    const reg = createToolRegistry();
    reg.register(doublerTool('co_run'));
    const spec = reg.get('co_run')!;
    const input = spec.inputSchema.parse({ x: 21 });
    expect(spec.handler({} as ToolContext, input)).toEqual({ y: 42 });
  });
});

describe('notImplemented — the stub sentinel the L2 gate detects', () => {
  it('throws loudly if it is ever actually invoked', () => {
    expect(() => notImplemented({} as ToolContext, undefined)).toThrow(/not implemented/i);
  });

  it('is a single shared reference (phase C can identity-check a stubbed handler)', () => {
    const stub: ToolSpec = {
      name: 'co_stubbed',
      title: 'Declared-but-unimplemented',
      description: 'A tool declared with the stub sentinel; the completeness gate must fail it.',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      handler: notImplemented,
    };
    expect(stub.handler).toBe(notImplemented);
  });
});
