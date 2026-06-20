import { validateCriteria } from '../plans/criteria.js';
import type { SpecRecord } from './events.js';
import type { SpecStore } from './specs-store.js';

/**
 * The shared spec-lock primitive (L6b F2 · RG-4 join): freeze a draft spec's acceptance criteria.
 *
 * Single source of truth for the lock semantics, consumed by BOTH the operator MCP tool
 * (`co_spec_lock`) and the public operator CLI (`co spec lock`) so the two surfaces cannot drift.
 * Refuses a missing or non-draft spec, and refuses any fuzzy criterion — every criterion must carry a
 * wired verification command and non-vacuous acceptance text (the {@link validateCriteria} gate, D3).
 *
 * The caller owns the operator-identity gate (the MCP tool checks `ctx.agent === OPERATOR`; the CLI is
 * inherently the operator surface). This primitive takes the `lockedBy` actor and records the lock.
 */
export function lockSpec(specs: SpecStore, taskId: string, lockedBy: string): SpecRecord {
  const spec = specs.getSpec(taskId);
  if (spec == null) {
    throw new Error(`no spec record for task '${taskId}' — draft it before locking.`);
  }
  if (spec.state !== 'draft') {
    throw new Error(
      `spec '${taskId}' is in state '${spec.state}', not 'draft' — only a draft can be locked.`,
    );
  }

  // The RG-4 validator gate: a spec cannot be locked with fuzzy criteria (D3).
  const violations = validateCriteria(spec.criteria);
  if (violations.length > 0) {
    const enumerated = violations
      .map((v) => `  - criterion ${v.index} ("${v.text}"): ${v.reason}`)
      .join('\n');
    throw new Error(
      `refusing to lock '${taskId}' — ${violations.length} criterion violation(s); fix the ` +
        `criteria and re-draft:\n${enumerated}`,
    );
  }

  return specs.recordLock(taskId, lockedBy);
}
