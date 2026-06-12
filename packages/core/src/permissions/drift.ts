/**
 * L6a Phase D1 — Drift check: declared registry vs. enforced config (permissions.md:90-94).
 * L7 Phase P1 — fills `readEnforcedConfig` with the real per-pane config reader.
 *
 * A declared block that isn't enforced, or an enforced id nobody declared, is the exact silent
 * drift this check kills (Principle 9 — no-silent-failures). The check is PURE over injected
 * inputs; `readEnforcedConfig` reads back the `enforcedIds` that {@link buildPaneLaunchConfig}
 * recorded, so the roundtrip is real: dropping a rule from the builder's output causes drift.
 */

import type { PaneLaunchConfig } from './pane-launch-config.js';
import type { BlockRule } from './block-list.js';

/** What the harness gate hooks actually enforce. Produced by L7; injected here for tests. */
export interface EnforcedConfig {
  readonly blockedIds: readonly string[];
}

/** A single drift mismatch between the declared registry and the enforced config. */
export interface DriftViolation {
  /** The block-list id involved. */
  readonly id: string;
  /** `declared-not-enforced`: in registry but missing from `EnforcedConfig.blockedIds`. */
  /** `enforced-not-declared`: in `EnforcedConfig.blockedIds` but absent from the registry. */
  readonly kind: 'declared-not-enforced' | 'enforced-not-declared';
  readonly reason: string;
}

/**
 * Pure drift check. Returns `[]` iff `enforced.blockedIds` exactly equals the set of ids in
 * `registry`. Otherwise returns one {@link DriftViolation} per mismatch.
 *
 * - A registry rule whose id is absent from `enforced` → `declared-not-enforced`.
 * - An enforced id not present in the registry → `enforced-not-declared`.
 */
export function checkBlockListDrift(
  registry: readonly BlockRule[],
  enforced: EnforcedConfig,
): DriftViolation[] {
  const violations: DriftViolation[] = [];
  const declaredIds = new Set(registry.map((r) => r.id));
  const enforcedIds = new Set(enforced.blockedIds);

  for (const rule of registry) {
    if (!enforcedIds.has(rule.id)) {
      violations.push({
        id: rule.id,
        kind: 'declared-not-enforced',
        reason: `Block rule '${rule.id}' is declared in the registry but absent from the enforced config.`,
      });
    }
  }

  for (const id of enforced.blockedIds) {
    if (!declaredIds.has(id)) {
      violations.push({
        id,
        kind: 'enforced-not-declared',
        reason: `Enforced id '${id}' has no matching rule in the declared registry.`,
      });
    }
  }

  return violations;
}

/**
 * Read the {@link EnforcedConfig} from a {@link PaneLaunchConfig} produced by
 * {@link buildPaneLaunchConfig}.
 *
 * The builder records every block-rule id it enforces in `config.enforcedIds`; this reader
 * returns them as `blockedIds`. The meaningful roundtrip: if the builder drops a rule id,
 * this reader returns fewer ids and {@link checkBlockListDrift} flags `declared-not-enforced`.
 *
 * Fail-loud (Principle 9): the function has no silent default — passing a config with an empty
 * `enforcedIds` returns an empty set, which drift will immediately flag as a full mismatch.
 */
export function readEnforcedConfig(config: PaneLaunchConfig): EnforcedConfig {
  return { blockedIds: config.enforcedIds };
}
