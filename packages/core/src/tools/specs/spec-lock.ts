import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { OPERATOR } from '../../mail/events.js';
import { validateCriteria } from '../../plans/criteria.js';
import {
  specRecordOutputSchema,
  specRecordToOutput,
  type SpecRecordOutput,
} from './spec-record-output.js';

const specLockInput = z
  .object({
    task_id: z
      .string()
      .min(1)
      .describe('The task id of the draft spec to lock (its criteria are frozen for review).'),
  })
  .strict();
type SpecLockInput = z.infer<typeof specLockInput>;

/**
 * `co_spec_lock` (L6b F2, RG-4 join): the OPERATOR-ONLY verb that locks a drafted spec so its
 * acceptance criteria are frozen for review. The structural join that makes acceptance-criteria
 * cohesion real: locking is REFUSED for fuzzy criteria (D3) — every criterion must carry a wired
 * verification command and non-vacuous text (the {@link validateCriteria} gate). Loud-fails when
 * `ctx.specs` is absent (Principle 9).
 *
 * Operator gate: the operator is NOT a roster agent, so the check is a direct `ctx.agent !== OPERATOR`
 * comparison (never `assertToolCallerRole`). This tool is in NO `ROLE_PROFILES` toolset — it is the
 * operator surface, offered through the mount's `OPERATOR_TOOL_NAMES`.
 */
export const specLockTool: ToolSpec<SpecLockInput, SpecRecordOutput> = {
  name: 'co_spec_lock',
  title: 'Lock a spec',
  description:
    'Lock a drafted spec so its acceptance criteria are frozen for review (operator-only). Refuses to ' +
    'lock unless every criterion carries a wired verification command and non-vacuous acceptance text — ' +
    'fuzzy criteria cannot be locked. Only the operator may lock a spec.',
  inputSchema: specLockInput,
  outputSchema: specRecordOutputSchema,
  handler: (ctx, input): SpecRecordOutput => {
    if (!ctx.specs) {
      throw new Error('co_spec_lock: the mount did not inject a spec store (ctx.specs absent).');
    }
    if (ctx.agent !== OPERATOR) {
      throw new Error(`co_spec_lock: only ${OPERATOR} may lock a spec (caller '${ctx.agent}').`);
    }

    const spec = ctx.specs.getSpec(input.task_id);
    if (spec == null) {
      throw new Error(
        `co_spec_lock: no spec record for task '${input.task_id}' — draft it before locking.`,
      );
    }
    if (spec.state !== 'draft') {
      throw new Error(
        `co_spec_lock: spec '${input.task_id}' is in state '${spec.state}', not 'draft' — only a ` +
          'draft can be locked.',
      );
    }

    // The RG-4 validator gate: a spec cannot be locked with fuzzy criteria (D3).
    const violations = validateCriteria(spec.criteria);
    if (violations.length > 0) {
      const enumerated = violations
        .map((v) => `  - criterion ${v.index} ("${v.text}"): ${v.reason}`)
        .join('\n');
      throw new Error(
        `co_spec_lock: refusing to lock '${input.task_id}' — ${violations.length} criterion ` +
          `violation(s); fix the criteria and re-draft:\n${enumerated}`,
      );
    }

    const locked = ctx.specs.recordLock(input.task_id, OPERATOR);
    return specRecordToOutput(locked);
  },
};
