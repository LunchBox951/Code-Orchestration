import { describe, it, expect } from 'vitest';
import {
  checkLocatorMap,
  citedAnswerSchema,
  locatorMapSchema,
  type LocatorMap,
} from './map-contract.js';

// L6b H — the locator map output contract (research.md: "files + one-line *why* each + key
// symbols + suggested read order. Pointers, not a content dump."). The structural rules a map
// must satisfy beyond shape are pure violations, mirroring checkToolCompleteness (AC-L6b-H1).

const GOOD_MAP: LocatorMap = {
  question: 'where does mail delivery happen?',
  entries: [
    {
      path: 'packages/core/src/mail/delivery.ts',
      why: 'the injectable delivery seam every send routes through',
      symbols: ['Delivery', 'InProcessDelivery'],
    },
    {
      path: 'packages/core/src/mail/mail-store.ts',
      why: 'the facade that wires the seam',
      symbols: ['openMailStore'],
    },
  ],
  readOrder: ['packages/core/src/mail/mail-store.ts', 'packages/core/src/mail/delivery.ts'],
};

describe('locatorMapSchema — shape', () => {
  it('accepts a well-formed map', () => {
    expect(locatorMapSchema.parse(GOOD_MAP)).toEqual(GOOD_MAP);
  });

  it('rejects an empty entry list (a map with no pointers is not a map)', () => {
    expect(() => locatorMapSchema.parse({ ...GOOD_MAP, entries: [] })).toThrow();
  });

  it('rejects a multi-line why (one-line why each — pointers, not a dump)', () => {
    const bad = {
      ...GOOD_MAP,
      entries: [{ path: 'a.ts', why: 'line one\nline two', symbols: [] }],
    };
    expect(() => locatorMapSchema.parse(bad)).toThrow();
  });

  it('rejects a why beyond the one-line budget (content dumps are not maps)', () => {
    const bad = {
      ...GOOD_MAP,
      entries: [{ path: 'a.ts', why: 'x'.repeat(300), symbols: [] }],
    };
    expect(() => locatorMapSchema.parse(bad)).toThrow();
  });
});

describe('checkLocatorMap — structural violations beyond shape', () => {
  it('returns [] for a coherent map', () => {
    expect(checkLocatorMap(GOOD_MAP)).toEqual([]);
  });

  it('flags a read-order entry that references no map entry', () => {
    const violations = checkLocatorMap({
      ...GOOD_MAP,
      readOrder: ['packages/core/src/mail/mail-store.ts', 'ghost.ts'],
    });
    expect(violations.map((v) => v.reason)).toEqual(
      expect.arrayContaining([expect.stringMatching(/ghost\.ts/)]),
    );
  });

  it('flags an entry path missing from readOrder', () => {
    const missing = GOOD_MAP.entries[1]!.path;
    const violations = checkLocatorMap({
      ...GOOD_MAP,
      readOrder: [GOOD_MAP.entries[0]!.path],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(new RegExp(missing));
  });

  it('flags duplicate readOrder paths', () => {
    const duplicate = GOOD_MAP.entries[0]!.path;
    const violations = checkLocatorMap({
      ...GOOD_MAP,
      readOrder: [duplicate, duplicate, GOOD_MAP.entries[1]!.path],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(/duplicate.*readOrder/i);
  });

  it('flags duplicate entry paths', () => {
    const dupEntry = GOOD_MAP.entries[0]!;
    const violations = checkLocatorMap({
      ...GOOD_MAP,
      entries: [dupEntry, dupEntry],
      readOrder: [dupEntry.path],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toMatch(/duplicate/i);
  });
});

describe('citedAnswerSchema — a cited answer needs citations', () => {
  it('accepts an answer with at least one citation', () => {
    const answer = {
      text: 'delivery is in-process at L1; the seam is injectable for L7',
      citations: [{ source: 'packages/core/src/mail/delivery.ts', detail: 'lines 10-40' }],
    };
    expect(citedAnswerSchema.parse(answer)).toEqual(answer);
  });

  it('rejects an answer with no citations (read-only, cited — research.md)', () => {
    expect(() => citedAnswerSchema.parse({ text: 'trust me', citations: [] })).toThrow();
  });
});
