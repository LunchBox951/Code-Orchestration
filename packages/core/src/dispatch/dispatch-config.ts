import { z } from 'zod';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import type { Provider } from './usage-source.js';
import {
  workSizeSchema,
  reasoningBudgetSchema,
  type WorkSize,
  type ReasoningBudget,
  type ModelOverrides,
} from './tier.js';
import { MAXED_THRESHOLD_PCT_DEFAULT } from './throttle.js';

/**
 * Config-backed resolvers for the operator-facing dispatch settings (the `dispatch.*` keys the
 * desktop Settings tab edits). Each mirrors the `resolveMaxActiveChildren` template: read the
 * effective cascade for the project, fall back to the built-in default when the key is unset, and
 * fail loud on a malformed value (Principle 9). Resolvers open their own config store when one is
 * not injected — consistent with how `resolveMaxActiveChildren`/`resolvePinTable` are used.
 */

export const DISPATCH_ENABLED_PROVIDERS_KEY = 'dispatch.enabledProviders' as const;
export const DISPATCH_MAXED_THRESHOLD_PCT_KEY = 'dispatch.maxedThresholdPct' as const;
export const DISPATCH_MODELS_CLAUDE_KEY = 'dispatch.models.claude' as const;
export const DISPATCH_MODELS_CODEX_KEY = 'dispatch.models.codex' as const;
export const DISPATCH_DEFAULT_WORK_SIZE_KEY = 'dispatch.defaultWorkSize' as const;
export const DISPATCH_DEFAULT_REASONING_BUDGET_KEY = 'dispatch.defaultReasoningBudget' as const;

/** The complete provider set for v1 (Claude + Codex; provider breadth beyond these is a v1 non-goal). */
export const ALL_PROVIDERS: readonly Provider[] = ['claude', 'codex'];
/** Default: every provider is enabled. */
export const ENABLED_PROVIDERS_DEFAULT: readonly Provider[] = ['claude', 'codex'];
/** Defaults for the sling work-size / reasoning-budget knobs (canonical home for these literals). */
export const DEFAULT_WORK_SIZE_DEFAULT: WorkSize = 'average';
export const DEFAULT_REASONING_BUDGET_DEFAULT: ReasoningBudget = 'standard';

/** Run `fn` with a config store, opening (and closing) one only if not injected. */
function withConfig<T>(config: ConfigStore | undefined, fn: (cfg: ConfigStore) => T): T {
  const cfg = config ?? openConfigStore();
  const owns = config === undefined;
  try {
    return fn(cfg);
  } finally {
    if (owns) cfg.close();
  }
}

const providerSchema = z.enum(['claude', 'codex']);
const enabledProvidersSchema = z.array(providerSchema).nonempty();
const modelTierSchema = z
  .object({
    simple: z.string().min(1).optional(),
    average: z.string().min(1).optional(),
    technical: z.string().min(1).optional(),
  })
  .strict();

/** Which providers may float for dispatch. Default both; rejects an empty or unknown-member set. */
export function resolveEnabledProviders(
  projectId: string,
  config?: ConfigStore,
): readonly Provider[] {
  return withConfig(config, (cfg) => {
    const eff = cfg.resolveEffective(projectId);
    if (!Object.prototype.hasOwnProperty.call(eff, DISPATCH_ENABLED_PROVIDERS_KEY)) {
      return ENABLED_PROVIDERS_DEFAULT;
    }
    const parsed = enabledProvidersSchema.safeParse(eff[DISPATCH_ENABLED_PROVIDERS_KEY]);
    if (!parsed.success) {
      throw new Error(
        `${DISPATCH_ENABLED_PROVIDERS_KEY}: expected a non-empty array of providers from ` +
          `${JSON.stringify(ALL_PROVIDERS)}.`,
      );
    }
    return [...new Set(parsed.data)]; // de-dupe, preserve order
  });
}

/** Utilization % above which a provider window is treated as full. Default 95; range 0..100. */
export function resolveMaxedThresholdPct(projectId: string, config?: ConfigStore): number {
  return withConfig(config, (cfg) => {
    const eff = cfg.resolveEffective(projectId);
    if (!Object.prototype.hasOwnProperty.call(eff, DISPATCH_MAXED_THRESHOLD_PCT_KEY)) {
      return MAXED_THRESHOLD_PCT_DEFAULT;
    }
    const raw = eff[DISPATCH_MAXED_THRESHOLD_PCT_KEY];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) {
      throw new Error(`${DISPATCH_MAXED_THRESHOLD_PCT_KEY}: expected a number between 0 and 100.`);
    }
    return raw;
  });
}

/** Per-provider model-table overrides (partial; unset tiers keep the built-in defaults). */
export function resolveModels(projectId: string, config?: ConfigStore): ModelOverrides {
  return withConfig(config, (cfg) => {
    const eff = cfg.resolveEffective(projectId);
    const readProvider = (key: string): Partial<Record<WorkSize, string>> | undefined => {
      if (!Object.prototype.hasOwnProperty.call(eff, key)) return undefined;
      const parsed = modelTierSchema.safeParse(eff[key]);
      if (!parsed.success) {
        throw new Error(
          `${key}: expected an object mapping simple/average/technical to non-empty model ids.`,
        );
      }
      return parsed.data;
    };
    const out: {
      claude?: Partial<Record<WorkSize, string>>;
      codex?: Partial<Record<WorkSize, string>>;
    } = {};
    const claude = readProvider(DISPATCH_MODELS_CLAUDE_KEY);
    const codex = readProvider(DISPATCH_MODELS_CODEX_KEY);
    if (claude) out.claude = claude;
    if (codex) out.codex = codex;
    return out;
  });
}

/** Default work-size applied when a co_sling dispatch leaves it unspecified. */
export function resolveDefaultWorkSize(projectId: string, config?: ConfigStore): WorkSize {
  return withConfig(config, (cfg) => {
    const eff = cfg.resolveEffective(projectId);
    if (!Object.prototype.hasOwnProperty.call(eff, DISPATCH_DEFAULT_WORK_SIZE_KEY)) {
      return DEFAULT_WORK_SIZE_DEFAULT;
    }
    const parsed = workSizeSchema.safeParse(eff[DISPATCH_DEFAULT_WORK_SIZE_KEY]);
    if (!parsed.success) {
      throw new Error(
        `${DISPATCH_DEFAULT_WORK_SIZE_KEY}: expected one of simple|average|technical.`,
      );
    }
    return parsed.data;
  });
}

/** Default reasoning-budget applied when a co_sling dispatch leaves it unspecified. */
export function resolveDefaultReasoningBudget(
  projectId: string,
  config?: ConfigStore,
): ReasoningBudget {
  return withConfig(config, (cfg) => {
    const eff = cfg.resolveEffective(projectId);
    if (!Object.prototype.hasOwnProperty.call(eff, DISPATCH_DEFAULT_REASONING_BUDGET_KEY)) {
      return DEFAULT_REASONING_BUDGET_DEFAULT;
    }
    const parsed = reasoningBudgetSchema.safeParse(eff[DISPATCH_DEFAULT_REASONING_BUDGET_KEY]);
    if (!parsed.success) {
      throw new Error(
        `${DISPATCH_DEFAULT_REASONING_BUDGET_KEY}: expected one of economy|standard|deep.`,
      );
    }
    return parsed.data;
  });
}
