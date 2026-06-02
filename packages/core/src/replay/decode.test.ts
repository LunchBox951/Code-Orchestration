import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { decode, type SchemaMap } from './decode.js';
import type { Upcaster, UpcasterRegistry } from './upcaster.js';
import type { StoredEvent } from '../store/types.js';

const NO_UPCASTERS: UpcasterRegistry = new Map();

function stored(overrides: Partial<StoredEvent> = {}): StoredEvent {
  return {
    seq: 1,
    ts: 1000,
    projectId: 'p',
    scope: 's',
    type: 'counter.inc',
    v: 1,
    payload: { by: 1 },
    ...overrides,
  };
}

describe('decode', () => {
  it('validates an already-current payload and returns the parsed value', () => {
    const schemas: SchemaMap = new Map([['counter.inc', z.object({ by: z.number() })]]);
    const event = stored({ payload: { by: 3 } });
    const out = decode(event, NO_UPCASTERS, schemas);
    expect(out.payload).toEqual({ by: 3 });
  });

  it('preserves every non-payload field of the event', () => {
    const schemas: SchemaMap = new Map([['counter.inc', z.object({ by: z.number() })]]);
    const event = stored({ seq: 7, ts: 4242, projectId: 'proj', scope: 'c:1', v: 1 });
    const out = decode(event, NO_UPCASTERS, schemas);
    expect(out).toMatchObject({
      seq: 7,
      ts: 4242,
      projectId: 'proj',
      scope: 'c:1',
      type: 'counter.inc',
      v: 1,
    });
  });

  it('upcasts a stored v1 payload to the current v2 shape, then validates it', () => {
    const v1ToV2: Upcaster = (p) => ({ amount: (p as { by: number }).by });
    const upcasters: UpcasterRegistry = new Map([['counter.inc', [v1ToV2]]]);
    const schemas: SchemaMap = new Map([['counter.inc', z.object({ amount: z.number() })]]);
    const event = stored({ v: 1, payload: { by: 5 } });
    const out = decode(event, upcasters, schemas);
    expect(out.payload).toEqual({ amount: 5 });
  });

  it('throws when the payload fails the current schema', () => {
    const schemas: SchemaMap = new Map([['counter.inc', z.object({ by: z.number() })]]);
    const event = stored({ payload: { by: 'not-a-number' } });
    expect(() => decode(event, NO_UPCASTERS, schemas)).toThrow();
  });

  it('throws for an event type with no registered schema (no-silent-failure policy)', () => {
    const schemas: SchemaMap = new Map();
    const event = stored({ type: 'mystery.event' });
    expect(() => decode(event, NO_UPCASTERS, schemas)).toThrow(/mystery\.event/);
  });
});
