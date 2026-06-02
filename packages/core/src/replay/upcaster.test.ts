import { describe, it, expect } from 'vitest';
import { upcast, type Upcaster, type UpcasterRegistry } from './upcaster.js';

describe('upcast', () => {
  it('returns the payload unchanged when the type has no registered chain', () => {
    const reg: UpcasterRegistry = new Map();
    const payload = { count: 5 };
    const out = upcast('unknown', 1, payload, reg);
    // identity: same value (and the same reference, since nothing ran)
    expect(out).toBe(payload);
  });

  it('returns the payload unchanged when the chain is empty (already current)', () => {
    const reg: UpcasterRegistry = new Map([['counter', []]]);
    const payload = { count: 5 };
    expect(upcast('counter', 1, payload, reg)).toBe(payload);
  });

  it('applies a single v1->v2 upcaster (chain[0]) for a stored v1 payload', () => {
    const v1ToV2: Upcaster = (p) => ({ ...(p as object), label: 'n' });
    const reg: UpcasterRegistry = new Map([['counter', [v1ToV2]]]);
    expect(upcast('counter', 1, { count: 5 }, reg)).toEqual({ count: 5, label: 'n' });
  });

  it('walks a multi-step chain v1->v2->v3 from fromV=1', () => {
    const v1ToV2: Upcaster = (p) => ({ ...(p as object), label: 'n' });
    const v2ToV3: Upcaster = (p) => {
      const { count, ...rest } = p as { count: number };
      return { ...rest, value: count };
    };
    const reg: UpcasterRegistry = new Map([['counter', [v1ToV2, v2ToV3]]]);
    expect(upcast('counter', 1, { count: 5 }, reg)).toEqual({ value: 5, label: 'n' });
  });

  it('applies only the tail of the chain when fromV is mid-chain', () => {
    const v1ToV2: Upcaster = () => {
      throw new Error('v1->v2 must not run for a v2 payload');
    };
    const v2ToV3: Upcaster = (p) => ({ ...(p as object), value: 9 });
    const reg: UpcasterRegistry = new Map([['counter', [v1ToV2, v2ToV3]]]);
    expect(upcast('counter', 2, { label: 'n' }, reg)).toEqual({ label: 'n', value: 9 });
  });

  it('is a no-op when fromV is already the current version (past the chain end)', () => {
    const v1ToV2: Upcaster = () => ({ unreachable: true });
    const reg: UpcasterRegistry = new Map([['counter', [v1ToV2]]]);
    const payload = { value: 5, label: 'n' };
    expect(upcast('counter', 2, payload, reg)).toBe(payload);
  });
});
