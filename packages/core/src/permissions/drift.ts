/**
 * L6a Phase D1 — Drift check: declared registry vs. enforced config (permissions.md:90-94).
 *
 * A declared block that isn't enforced, or an enforced id nobody declared, is the exact silent
 * drift this check kills (Principle 9 — no-silent-failures). The check is PURE over injected
 * inputs; the `readEnforcedConfig` seam is the L7 plug-point that the harness gate hooks fill in
 * at runtime.
 */

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
 * The L7 enforcement seam — TYPED STUB that THROWS loudly.
 *
 * The production implementation reads the harness gate hooks' active config and returns an
 * {@link EnforcedConfig}. That reading logic depends on the runtime substrate (Claude/Codex
 * PreToolUse hook variants) and is built in L7 (permissions.md:90-98).
 *
 * In tests, inject an {@link EnforcedConfig} directly into {@link checkBlockListDrift} instead
 * of calling this seam — the drift check is pure over injected input. In production L7 wires
 * this seam to the real harness reader.
 *
 * Throws rather than returning a silent default because a silent no-op would mask the very
 * enforcement-layer absence this check exists to detect (Principle 9 / Principle 16).
 */
export function readEnforcedConfig(): EnforcedConfig {
  throw new Error(
    'readEnforcedConfig: the permission enforcement layer is L7 — inject the enforced config ' +
      'directly in tests, or wire the harness reader in L7 (permissions.md:90-98). ' +
      'This stub must never be a silent no-op (Principle 9).',
  );
}
