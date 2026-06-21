import { describe, it, expect } from 'vitest';
import {
  resolveTier,
  normalizeLegacyDifficulty,
  workSizeSchema,
  reasoningBudgetSchema,
  type WorkSize,
  type ReasoningBudget,
  type Effort,
  type ContextWindow,
  type TierPlacement,
} from './tier.js';
import type { Provider } from './usage-source.js';

// ─── Type smoke: ensure the exported schemas parse valid values ───────────────

describe('workSizeSchema / reasoningBudgetSchema (zod parse)', () => {
  it('parses every WorkSize value', () => {
    expect(workSizeSchema.parse('simple')).toBe('simple');
    expect(workSizeSchema.parse('average')).toBe('average');
    expect(workSizeSchema.parse('technical')).toBe('technical');
  });

  it('rejects an unknown WorkSize', () => {
    expect(() => workSizeSchema.parse('hard')).toThrow();
  });

  it('parses every ReasoningBudget value', () => {
    expect(reasoningBudgetSchema.parse('economy')).toBe('economy');
    expect(reasoningBudgetSchema.parse('standard')).toBe('standard');
    expect(reasoningBudgetSchema.parse('deep')).toBe('deep');
  });

  it('rejects an unknown ReasoningBudget', () => {
    expect(() => reasoningBudgetSchema.parse('unlimited')).toThrow();
  });

  it('schemas carry a describe() string (Phase-5 reuse signal)', () => {
    expect(workSizeSchema.description).toBeTruthy();
    expect(reasoningBudgetSchema.description).toBeTruthy();
  });
});

// ─── Full matrix table-test (WorkSize × ReasoningBudget × Provider = 18 rows) ─

/**
 * THE TIER MATRIX (the matrix is the spec — pin every cell).
 *
 * Effort mapping:
 *   | reasoning \ work | simple | average | technical |
 *   |------------------|--------|---------|-----------|
 *   | economy          | low    | medium  | high      |
 *   | standard         | high   | high    | xhigh     |
 *   | deep             | xhigh  | xhigh   | max       |
 *
 * Context window: 'extended' when workSize === 'technical' OR reasoningBudget === 'deep'.
 */
type MatrixRow = [WorkSize, ReasoningBudget, Provider, string, Effort, ContextWindow];

const MATRIX: MatrixRow[] = [
  // Claude ─ simple row
  ['simple', 'economy', 'claude', 'claude-haiku-4-5-20251001', 'low', 'standard'],
  ['simple', 'standard', 'claude', 'claude-haiku-4-5-20251001', 'high', 'standard'],
  ['simple', 'deep', 'claude', 'claude-haiku-4-5-20251001', 'xhigh', 'extended'],
  // Claude ─ average row
  ['average', 'economy', 'claude', 'claude-sonnet-4-6', 'medium', 'standard'],
  ['average', 'standard', 'claude', 'claude-sonnet-4-6', 'high', 'standard'],
  ['average', 'deep', 'claude', 'claude-sonnet-4-6', 'xhigh', 'extended'],
  // Claude ─ technical row
  ['technical', 'economy', 'claude', 'claude-opus-4-8', 'high', 'extended'],
  ['technical', 'standard', 'claude', 'claude-opus-4-8', 'xhigh', 'extended'],
  ['technical', 'deep', 'claude', 'claude-opus-4-8', 'max', 'extended'],
  // Codex ─ simple row
  ['simple', 'economy', 'codex', 'gpt-5.4-mini', 'low', 'standard'],
  ['simple', 'standard', 'codex', 'gpt-5.4-mini', 'high', 'standard'],
  ['simple', 'deep', 'codex', 'gpt-5.4-mini', 'xhigh', 'extended'],
  // Codex ─ average row
  ['average', 'economy', 'codex', 'gpt-5.4', 'medium', 'standard'],
  ['average', 'standard', 'codex', 'gpt-5.4', 'high', 'standard'],
  ['average', 'deep', 'codex', 'gpt-5.4', 'xhigh', 'extended'],
  // Codex ─ technical row
  ['technical', 'economy', 'codex', 'gpt-5.5', 'high', 'extended'],
  ['technical', 'standard', 'codex', 'gpt-5.5', 'xhigh', 'extended'],
  ['technical', 'deep', 'codex', 'gpt-5.5', 'max', 'extended'],
];

describe('resolveTier — full WorkSize × ReasoningBudget × Provider matrix (18 rows)', () => {
  it.each(MATRIX)(
    'resolveTier(%s, %s, %s) → model=%s effort=%s context=%s',
    (workSize, reasoningBudget, provider, model, effort, context) => {
      const placement = resolveTier(workSize, reasoningBudget, provider);
      expect(placement).toEqual<TierPlacement>({ provider, model, effort, context });
    },
  );
});

describe('resolveTier — determinism guarantees (AC10, Principle 16)', () => {
  it('identical inputs produce identical output on repeated calls', () => {
    const a = resolveTier('average', 'standard', 'claude');
    const b = resolveTier('average', 'standard', 'claude');
    expect(a).toEqual(b);
  });

  it('two calls produce distinct object references (no shared mutable state)', () => {
    const a = resolveTier('average', 'standard', 'claude');
    const b = resolveTier('average', 'standard', 'claude');
    expect(a).not.toBe(b);
  });
});

// ─── Model selection: work_size → model, NOT reasoning_budget ────────────────

describe('resolveTier — model is driven by work_size, not reasoning_budget', () => {
  const provider: Provider = 'claude';

  it('simple always resolves to Haiku regardless of budget', () => {
    const budgets: ReasoningBudget[] = ['economy', 'standard', 'deep'];
    for (const b of budgets) {
      expect(resolveTier('simple', b, provider).model).toBe('claude-haiku-4-5-20251001');
    }
  });

  it('average always resolves to Sonnet regardless of budget', () => {
    const budgets: ReasoningBudget[] = ['economy', 'standard', 'deep'];
    for (const b of budgets) {
      expect(resolveTier('average', b, provider).model).toBe('claude-sonnet-4-6');
    }
  });

  it('technical always resolves to Opus regardless of budget', () => {
    const budgets: ReasoningBudget[] = ['economy', 'standard', 'deep'];
    for (const b of budgets) {
      expect(resolveTier('technical', b, provider).model).toBe('claude-opus-4-8');
    }
  });
});

// ─── Context window ───────────────────────────────────────────────────────────

describe('resolveTier — context window rules', () => {
  it('deep always yields extended context (all work_sizes)', () => {
    const workSizes: WorkSize[] = ['simple', 'average', 'technical'];
    for (const w of workSizes) {
      expect(resolveTier(w, 'deep', 'claude').context).toBe('extended');
    }
  });

  it('technical always yields extended context (all budgets)', () => {
    const budgets: ReasoningBudget[] = ['economy', 'standard', 'deep'];
    for (const b of budgets) {
      expect(resolveTier('technical', b, 'claude').context).toBe('extended');
    }
  });

  it('simple/average + economy/standard → standard context', () => {
    expect(resolveTier('simple', 'economy', 'claude').context).toBe('standard');
    expect(resolveTier('simple', 'standard', 'claude').context).toBe('standard');
    expect(resolveTier('average', 'economy', 'claude').context).toBe('standard');
    expect(resolveTier('average', 'standard', 'claude').context).toBe('standard');
  });
});

// ─── Legacy shim ──────────────────────────────────────────────────────────────

describe('normalizeLegacyDifficulty — legacy → (workSize, reasoningBudget)', () => {
  // Spec-pinned alias: advanced → (technical, standard)
  it('advanced maps to (technical, standard) [spec-pinned alias]', () => {
    expect(normalizeLegacyDifficulty('advanced')).toEqual({
      workSize: 'technical',
      reasoningBudget: 'standard',
    });
  });

  it('simple maps to (simple, standard)', () => {
    expect(normalizeLegacyDifficulty('simple')).toEqual({
      workSize: 'simple',
      reasoningBudget: 'standard',
    });
  });

  it('standard maps to (average, standard)', () => {
    expect(normalizeLegacyDifficulty('standard')).toEqual({
      workSize: 'average',
      reasoningBudget: 'standard',
    });
  });

  it('an unrecognized legacy value throws loudly (P9 — no-silent-failures)', () => {
    expect(() => normalizeLegacyDifficulty('unknown_level')).toThrow();
    expect(() => normalizeLegacyDifficulty('')).toThrow();
    expect(() => normalizeLegacyDifficulty('ADVANCED')).toThrow(); // case-sensitive
  });

  it('the thrown error carries the unrecognized value', () => {
    expect(() => normalizeLegacyDifficulty('bogus')).toThrow(/bogus/);
  });
});

describe('resolveTier — model overrides (dispatch.models.*)', () => {
  it('applies a per-provider, per-tier override and falls back to defaults elsewhere', () => {
    const ov = { claude: { technical: 'claude-custom' } } as const;
    expect(resolveTier('technical', 'standard', 'claude', ov).model).toBe('claude-custom');
    // unset tier for the overridden provider keeps the default
    expect(resolveTier('simple', 'standard', 'claude', ov).model).toBe('claude-haiku-4-5-20251001');
    // the other provider is untouched
    expect(resolveTier('technical', 'standard', 'codex', ov).model).toBe('gpt-5.5');
  });

  it('ignores an empty-string override (keeps the default)', () => {
    const ov = { codex: { average: '' } } as const;
    expect(resolveTier('average', 'standard', 'codex', ov).model).toBe('gpt-5.4');
  });

  it('no overrides reproduces the v1 defaults (effort/context unaffected)', () => {
    const a = resolveTier('average', 'deep', 'claude');
    const b = resolveTier('average', 'deep', 'claude', {});
    expect(b).toEqual(a);
  });
});
