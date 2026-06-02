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

  it('throws on a future event version greater than the current version', () => {
    const v1ToV2: Upcaster = (p) => p;
    const reg: UpcasterRegistry = new Map([['counter', [v1ToV2]]]);
    // chain.length=1 → currentVersion=2; fromV=3 is future
    expect(() => upcast('counter', 3, {}, reg)).toThrow(
      /unsupported future event version.*counter.*v3.*v2/i,
    );
  });

  it('throws on a future version for a type with no registered chain', () => {
    const reg: UpcasterRegistry = new Map();
    // no chain → currentVersion=1; fromV=2 is future
    expect(() => upcast('some-type', 2, {}, reg)).toThrow(
      /unsupported future event version.*some-type.*v2.*v1/i,
    );
  });

  it('current-version events still pass (no throw, identity returned)', () => {
    const v1ToV2: Upcaster = () => ({ changed: true });
    const reg: UpcasterRegistry = new Map([['counter', [v1ToV2]]]);
    const payload = { value: 5 };
    expect(() => upcast('counter', 2, payload, reg)).not.toThrow();
    expect(upcast('counter', 2, payload, reg)).toBe(payload);
  });

  it('normal older-to-current upcast chain still works after adding the future-version guard', () => {
    const v1ToV2: Upcaster = (p) => ({ ...(p as object), label: 'added' });
    const v2ToV3: Upcaster = (p) => ({ ...(p as object), extra: true });
    const reg: UpcasterRegistry = new Map([['evt', [v1ToV2, v2ToV3]]]);
    expect(upcast('evt', 1, { count: 1 }, reg)).toEqual({ count: 1, label: 'added', extra: true });
    expect(upcast('evt', 2, { count: 1, label: 'added' }, reg)).toEqual({
      count: 1,
      label: 'added',
      extra: true,
    });
  });
});
