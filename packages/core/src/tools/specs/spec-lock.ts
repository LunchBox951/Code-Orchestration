import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { OPERATOR } from '../../mail/events.js';
import { lockSpec } from '../../specs/lock-spec.js';
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

    // Lock semantics live in the shared core primitive so the tool and the `co spec lock` CLI
    // cannot drift (not-found / non-draft / fuzzy-criteria refusals, then recordLock).
    return specRecordToOutput(lockSpec(ctx.specs, input.task_id, OPERATOR));
  },
};
