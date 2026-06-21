import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfigStore } from '../config/config-store.js';
import {
  resolveEnabledProviders,
  resolveMaxedThresholdPct,
  resolveModels,
  resolveDefaultWorkSize,
  resolveDefaultReasoningBudget,
  DISPATCH_ENABLED_PROVIDERS_KEY,
  DISPATCH_MAXED_THRESHOLD_PCT_KEY,
  DISPATCH_MODELS_CLAUDE_KEY,
  DISPATCH_DEFAULT_WORK_SIZE_KEY,
  DISPATCH_DEFAULT_REASONING_BUDGET_KEY,
} from './dispatch-config.js';
import { validateSettingValue } from '../config/settings-registry.js';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-dispatch-config-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

describe('resolveEnabledProviders', () => {
  it('defaults to claude+codex when unset', () => {
    const c = openConfigStore();
    try {
      expect(resolveEnabledProviders('p', c)).toEqual(['claude', 'codex']);
    } finally {
      c.close();
    }
  });

  it('honors a project override and de-dupes', () => {
    const c = openConfigStore();
    try {
      c.setProjectOverride('p', DISPATCH_ENABLED_PROVIDERS_KEY, ['claude', 'claude']);
      expect(resolveEnabledProviders('p', c)).toEqual(['claude']);
    } finally {
      c.close();
    }
  });

  it('rejects an empty set and an unknown provider (Principle 9)', () => {
    const c = openConfigStore();
    try {
      c.setProjectOverride('p', DISPATCH_ENABLED_PROVIDERS_KEY, []);
      expect(() => resolveEnabledProviders('p', c)).toThrow(/non-empty/);
      c.setProjectOverride('p', DISPATCH_ENABLED_PROVIDERS_KEY, ['bogus']);
      expect(() => resolveEnabledProviders('p', c)).toThrow(/provider/);
    } finally {
      c.close();
    }
  });
});

describe('resolveMaxedThresholdPct', () => {
  it('defaults to 95 and honors an override', () => {
    const c = openConfigStore();
    try {
      expect(resolveMaxedThresholdPct('p', c)).toBe(95);
      c.setGlobal(DISPATCH_MAXED_THRESHOLD_PCT_KEY, 88);
      expect(resolveMaxedThresholdPct('p', c)).toBe(88);
    } finally {
      c.close();
    }
  });

  it('rejects out-of-range and non-number values', () => {
    const c = openConfigStore();
    try {
      c.setGlobal(DISPATCH_MAXED_THRESHOLD_PCT_KEY, 150);
      expect(() => resolveMaxedThresholdPct('p', c)).toThrow();
      c.setGlobal(DISPATCH_MAXED_THRESHOLD_PCT_KEY, 'high');
      expect(() => resolveMaxedThresholdPct('p', c)).toThrow();
    } finally {
      c.close();
    }
  });
});

describe('resolveModels', () => {
  it('reads partial per-provider tables; empty when unset', () => {
    const c = openConfigStore();
    try {
      expect(resolveModels('p', c)).toEqual({});
      c.setGlobal(DISPATCH_MODELS_CLAUDE_KEY, { technical: 'claude-x' });
      expect(resolveModels('p', c)).toEqual({ claude: { technical: 'claude-x' } });
    } finally {
      c.close();
    }
  });

  it('rejects an empty model id and unknown tier keys', () => {
    const c = openConfigStore();
    try {
      c.setGlobal(DISPATCH_MODELS_CLAUDE_KEY, { technical: '' });
      expect(() => resolveModels('p', c)).toThrow();
      c.setGlobal(DISPATCH_MODELS_CLAUDE_KEY, { huge: 'x' });
      expect(() => resolveModels('p', c)).toThrow();
    } finally {
      c.close();
    }
  });

  it('a project override of one provider does not affect the other', () => {
    const c = openConfigStore();
    try {
      c.setGlobal(DISPATCH_MODELS_CLAUDE_KEY, { simple: 'g-claude' });
      c.setProjectOverride('p', DISPATCH_MODELS_CLAUDE_KEY, { simple: 'p-claude' });
      expect(resolveModels('p', c)).toEqual({ claude: { simple: 'p-claude' } });
      expect(resolveModels('other', c)).toEqual({ claude: { simple: 'g-claude' } });
    } finally {
      c.close();
    }
  });
});

describe('resolveDefaultWorkSize / resolveDefaultReasoningBudget', () => {
  it('default + enum validation', () => {
    const c = openConfigStore();
    try {
      expect(resolveDefaultWorkSize('p', c)).toBe('average');
      expect(resolveDefaultReasoningBudget('p', c)).toBe('standard');
      c.setGlobal(DISPATCH_DEFAULT_WORK_SIZE_KEY, 'technical');
      expect(resolveDefaultWorkSize('p', c)).toBe('technical');
      c.setGlobal(DISPATCH_DEFAULT_REASONING_BUDGET_KEY, 'deep');
      expect(resolveDefaultReasoningBudget('p', c)).toBe('deep');
      c.setGlobal(DISPATCH_DEFAULT_WORK_SIZE_KEY, 'huge');
      expect(() => resolveDefaultWorkSize('p', c)).toThrow();
      c.setGlobal(DISPATCH_DEFAULT_REASONING_BUDGET_KEY, 'unlimited');
      expect(() => resolveDefaultReasoningBudget('p', c)).toThrow();
    } finally {
      c.close();
    }
  });
});

// AC-SET-4: the settings registry's write-gate (validateSettingValue) must accept/reject EXACTLY what
// the dispatch resolvers fail loud on. They now share the same schemas; this pins that they cannot drift.
describe('settings validators mirror the dispatch resolvers (AC-SET-4 parity)', () => {
  const cases: {
    key: string;
    value: unknown;
    resolve: (c: ReturnType<typeof openConfigStore>) => unknown;
  }[] = [
    {
      key: DISPATCH_ENABLED_PROVIDERS_KEY,
      value: ['claude'],
      resolve: (c) => resolveEnabledProviders('p', c),
    },
    {
      key: DISPATCH_ENABLED_PROVIDERS_KEY,
      value: ['claude', 'codex'],
      resolve: (c) => resolveEnabledProviders('p', c),
    },
    {
      key: DISPATCH_ENABLED_PROVIDERS_KEY,
      value: [],
      resolve: (c) => resolveEnabledProviders('p', c),
    },
    {
      key: DISPATCH_ENABLED_PROVIDERS_KEY,
      value: ['bogus'],
      resolve: (c) => resolveEnabledProviders('p', c),
    },
    {
      key: DISPATCH_MAXED_THRESHOLD_PCT_KEY,
      value: 95,
      resolve: (c) => resolveMaxedThresholdPct('p', c),
    },
    {
      key: DISPATCH_MAXED_THRESHOLD_PCT_KEY,
      value: 0,
      resolve: (c) => resolveMaxedThresholdPct('p', c),
    },
    {
      key: DISPATCH_MAXED_THRESHOLD_PCT_KEY,
      value: 100,
      resolve: (c) => resolveMaxedThresholdPct('p', c),
    },
    {
      key: DISPATCH_MAXED_THRESHOLD_PCT_KEY,
      value: 101,
      resolve: (c) => resolveMaxedThresholdPct('p', c),
    },
    {
      key: DISPATCH_MAXED_THRESHOLD_PCT_KEY,
      value: 'high',
      resolve: (c) => resolveMaxedThresholdPct('p', c),
    },
    {
      key: DISPATCH_MODELS_CLAUDE_KEY,
      value: { technical: 'm' },
      resolve: (c) => resolveModels('p', c),
    },
    { key: DISPATCH_MODELS_CLAUDE_KEY, value: {}, resolve: (c) => resolveModels('p', c) },
    {
      key: DISPATCH_MODELS_CLAUDE_KEY,
      value: { technical: '' },
      resolve: (c) => resolveModels('p', c),
    },
    {
      key: DISPATCH_MODELS_CLAUDE_KEY,
      value: { huge: 'm' },
      resolve: (c) => resolveModels('p', c),
    },
    {
      key: DISPATCH_DEFAULT_WORK_SIZE_KEY,
      value: 'simple',
      resolve: (c) => resolveDefaultWorkSize('p', c),
    },
    {
      key: DISPATCH_DEFAULT_WORK_SIZE_KEY,
      value: 'huge',
      resolve: (c) => resolveDefaultWorkSize('p', c),
    },
    {
      key: DISPATCH_DEFAULT_REASONING_BUDGET_KEY,
      value: 'deep',
      resolve: (c) => resolveDefaultReasoningBudget('p', c),
    },
    {
      key: DISPATCH_DEFAULT_REASONING_BUDGET_KEY,
      value: 'unlimited',
      resolve: (c) => resolveDefaultReasoningBudget('p', c),
    },
  ];

  for (const { key, value, resolve } of cases) {
    it(`${key} = ${JSON.stringify(value)}: UI validator agrees with the resolver`, () => {
      const c = openConfigStore();
      try {
        c.setProjectOverride('p', key, value);
        let resolverThrew = false;
        try {
          resolve(c);
        } catch {
          resolverThrew = true;
        }
        expect(validateSettingValue(key, value).ok).toBe(!resolverThrew);
      } finally {
        c.close();
      }
    });
  }
});
