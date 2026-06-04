import { z } from 'zod';
import { assertNever } from '../assert-never.js';
import type { Provider } from './usage-source.js';

/**
 * L4 Phase 2 — pure tier-matrix policy (AC10, Principle 16 — decisions-deferred).
 * Deterministic mapping: (WorkSize × ReasoningBudget) → {model, effort, context} per Provider.
 * No I/O, no clock, no randomness — identical inputs always produce identical outputs.
 *
 * This module owns ONLY the default capability matrix. Provider SELECTION (pinned/floating balancer)
 * is Phase 3. All model ids and effort values are operator-overridable defaults.
 *
 * Cited invariants: P13 (provider-neutral), P16 (decisions-deferred), P9 (no-silent-failures).
 */

// ─── Routing vocabulary (provider-neutral dispatch inputs) ────────────────────

/** Coarse work-complexity band driving model tier selection. */
export type WorkSize = 'simple' | 'average' | 'technical';

/** Reasoning depth / cost preference driving effort selection. */
export type ReasoningBudget = 'economy' | 'standard' | 'deep';

/** Provider-neutral WorkSize schema; .describe() surfaces for Phase-5 co_sling extension. */
export const workSizeSchema = z
  .enum(['simple', 'average', 'technical'])
  .describe(
    'Coarse task complexity: simple = routine/scripted, average = typical feature work, technical = deep multi-step reasoning.',
  );

/** Provider-neutral ReasoningBudget schema; .describe() surfaces for Phase-5 co_sling extension. */
export const reasoningBudgetSchema = z
  .enum(['economy', 'standard', 'deep'])
  .describe(
    'Reasoning depth preference: economy = fast/lower-effort, standard = documented baseline, deep = maximum reasoning (extended context).',
  );

// ─── Tier placement types ─────────────────────────────────────────────────────

/**
 * Ordered effort scale (ascending). The effort level drives the provider's reasoning-intensity
 * parameter (e.g. Claude's `thinking` budget, Codex's reasoning effort setting).
 *
 * Effort ← reasoning_budget with a work_size baseline floor:
 *
 *   | reasoning \ work | simple | average | technical |
 *   |------------------|--------|---------|-----------|
 *   | economy          | low    | medium  | high      |
 *   | standard         | high   | high    | xhigh     |
 *   | deep             | xhigh  | xhigh   | max       |
 *
 * The documented baseline is 'high' for simple/average and 'xhigh' for technical.
 * 'economy' steps below the baseline; 'deep' steps above (technical+deep ⇒ max).
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Context-window preference. 'extended' is selected when the reasoning budget is 'deep' OR when
 * the work size is 'technical' — either signals a task that benefits from a longer context window.
 */
export type ContextWindow = 'standard' | 'extended';

/** The resolved concrete dispatch target for one (workSize, reasoningBudget, provider) triple. */
export interface TierPlacement {
  readonly provider: Provider;
  /** v1 default model id — operator-overridable (Phase 3 pins/floating selection). */
  readonly model: string;
  /** Reasoning-intensity effort level derived from reasoningBudget with a workSize baseline. */
  readonly effort: Effort;
  /** Context-window preference; 'extended' when workSize=technical or reasoningBudget=deep. */
  readonly context: ContextWindow;
}

// ─── Default model tables (v1 defaults, operator-overridable) ─────────────────

// v1 default model ids — operator-overridable via Phase 3 pins; commented as such per spec.
const CLAUDE_MODELS: Record<WorkSize, string> = {
  simple: 'claude-haiku-4-5-20251001', // v1 default, operator-overridable
  average: 'claude-sonnet-4-6', // v1 default, operator-overridable
  technical: 'claude-opus-4-8', // v1 default, operator-overridable
};

// v1 placeholder model ids consistent with the prototype config — operator-overridable.
const CODEX_MODELS: Record<WorkSize, string> = {
  simple: 'gpt-5.4-mini', // v1 default, operator-overridable
  average: 'gpt-5.4', // v1 default, operator-overridable
  technical: 'gpt-5.5', // v1 default, operator-overridable
};

// ─── Effort resolution ────────────────────────────────────────────────────────

/**
 * Effort lookup table — the full (WorkSize × ReasoningBudget) matrix, keyed as `${workSize}:${reasoningBudget}`.
 * Every cell is explicitly enumerated; assertNever guards the key-construction switches so an
 * unhandled combination is a type error AND a loud runtime throw (P9).
 */
const EFFORT_TABLE: Record<`${WorkSize}:${ReasoningBudget}`, Effort> = {
  'simple:economy': 'low',
  'simple:standard': 'high',
  'simple:deep': 'xhigh',
  'average:economy': 'medium',
  'average:standard': 'high',
  'average:deep': 'xhigh',
  'technical:economy': 'high',
  'technical:standard': 'xhigh',
  'technical:deep': 'max',
};

/** Derive effort from (workSize, reasoningBudget) per the documented baseline table. */
function resolveEffort(workSize: WorkSize, reasoningBudget: ReasoningBudget): Effort {
  // Validate workSize and reasoningBudget are known values before lookup (P9 — no-silent-failures).
  switch (workSize) {
    case 'simple':
    case 'average':
    case 'technical':
      break;
    default:
      assertNever(workSize);
  }
  switch (reasoningBudget) {
    case 'economy':
    case 'standard':
    case 'deep':
      break;
    default:
      assertNever(reasoningBudget);
  }
  return EFFORT_TABLE[`${workSize}:${reasoningBudget}`];
}

// ─── Context window resolution ────────────────────────────────────────────────

function resolveContext(workSize: WorkSize, reasoningBudget: ReasoningBudget): ContextWindow {
  return workSize === 'technical' || reasoningBudget === 'deep' ? 'extended' : 'standard';
}

// ─── Model resolution ─────────────────────────────────────────────────────────

function resolveModel(workSize: WorkSize, provider: Provider): string {
  switch (provider) {
    case 'claude':
      return CLAUDE_MODELS[workSize];
    case 'codex':
      return CODEX_MODELS[workSize];
    default:
      assertNever(provider);
  }
}

// ─── Public resolver ──────────────────────────────────────────────────────────

/**
 * Resolve the default tier placement for a given (workSize, reasoningBudget, provider) triple.
 * Pure and deterministic — no I/O, no clock (AC10, Principle 16). Returns a new object on every
 * call (no shared mutable state). Phase 3 overlays operator pins on top of this default.
 */
export function resolveTier(
  workSize: WorkSize,
  reasoningBudget: ReasoningBudget,
  provider: Provider,
): TierPlacement {
  return {
    provider,
    model: resolveModel(workSize, provider),
    effort: resolveEffort(workSize, reasoningBudget),
    context: resolveContext(workSize, reasoningBudget),
  };
}

// ─── Legacy difficulty shim ───────────────────────────────────────────────────

/**
 * Normalize a legacy single-axis "difficulty" value into the v1 two-axis (workSize, reasoningBudget)
 * routing vocabulary. The prototype used a single 'difficulty' field; v1 splits it.
 *
 * Migration table:
 *   - 'simple'   → { workSize: 'simple',    reasoningBudget: 'standard' }
 *   - 'standard' → { workSize: 'average',   reasoningBudget: 'standard' }
 *   - 'advanced' → { workSize: 'technical', reasoningBudget: 'standard' }  ← spec-pinned alias
 *
 * An unrecognized legacy value throws loudly (Principle 9 — no-silent-failures).
 */
export function normalizeLegacyDifficulty(difficulty: string): {
  workSize: WorkSize;
  reasoningBudget: ReasoningBudget;
} {
  switch (difficulty) {
    case 'simple':
      return { workSize: 'simple', reasoningBudget: 'standard' };
    case 'standard':
      return { workSize: 'average', reasoningBudget: 'standard' };
    case 'advanced':
      return { workSize: 'technical', reasoningBudget: 'standard' };
    default:
      throw new Error(
        `normalizeLegacyDifficulty: unrecognized legacy difficulty value '${difficulty}'. ` +
          `Known values: 'simple', 'standard', 'advanced'.`,
      );
  }
}
