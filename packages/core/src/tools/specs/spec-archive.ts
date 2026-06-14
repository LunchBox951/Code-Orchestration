import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import {
  specRecordOutputSchema,
  specRecordToOutput,
  type SpecRecordOutput,
} from './spec-record-output.js';

const specArchiveInput = z
  .object({
    task_id: z
      .string()
      .min(1)
      .describe('The task id of the locked spec to archive (marks it no longer active).'),
  })
  .strict();
type SpecArchiveInput = z.infer<typeof specArchiveInput>;

/**
 * `co_spec_archive` (L9 tail, SH-2 / RG-4): the coordinator verb that archives a locked spec,
 * completing the `draft → locked → archived` lifecycle. Only a locked spec can be archived.
 * The archived spec remains queryable via `co_spec_get`. Loud-fails when `ctx.specs`/`ctx.roster`
 * are absent (Principle 9 — the mount assembles the context).
 *
 * Scoped to: coordinator (the spec owner that drafted it and runs the task).
 */
export const specArchiveTool: ToolSpec<SpecArchiveInput, SpecRecordOutput> = {
  name: 'co_spec_archive',
  title: 'Archive a spec',
  description:
    'Archive a locked spec, completing the draft → locked → archived lifecycle. Only a locked spec ' +
    'can be archived; archiving a draft or already-archived spec is refused loud. The archived spec ' +
    'remains queryable via co_spec_get. Only a coordinator may archive a spec.',
  inputSchema: specArchiveInput,
  outputSchema: specRecordOutputSchema,
  handler: (ctx, input): SpecRecordOutput => {
    if (!ctx.specs) {
      throw new Error('co_spec_archive: the mount did not inject a spec store (ctx.specs absent).');
    }
    if (!ctx.roster) {
      throw new Error(
        'co_spec_archive: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_spec_archive', ctx.roster, ctx.agent, ['coordinator']);

    const spec = ctx.specs.getSpec(input.task_id);
    if (spec == null) {
      throw new Error(
        `co_spec_archive: no spec record for task '${input.task_id}' — draft and lock it before archiving.`,
      );
    }
    if (spec.state !== 'locked') {
      throw new Error(
        `co_spec_archive: spec '${input.task_id}' is in state '${spec.state}', not 'locked' — only a ` +
          'locked spec can be archived.',
      );
    }

    const archived = ctx.specs.recordArchive(input.task_id);
    return specRecordToOutput(archived);
  },
};
