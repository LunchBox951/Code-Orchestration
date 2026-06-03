import { z } from 'zod';
import type { ToolSpec } from '../registry.js';

const orientInput = z.object({
  role: z
    .string()
    .optional()
    .describe('Your role (e.g. implementer, lead, researcher), to tailor the guidance.'),
  topic: z
    .string()
    .optional()
    .describe('A lifecycle topic to focus on (e.g. finish, mail, review, escalate).'),
});
type OrientInput = z.infer<typeof orientInput>;

const orientOutput = z.object({
  guidance: z.string().describe('Short workflow/lifecycle guidance for coordinating your work.'),
});
type OrientOutput = z.infer<typeof orientOutput>;

/**
 * WORKFLOW-ONLY guidance (Principle 5). This teaches the lifecycle — how to coordinate by
 * mail, finish through the gate, and escalate — and must NOT restate any tool's argument /
 * field list: the schemas are the single syntax source, and restating fields is the banned
 * drift. This is the MINIMAL but REAL handler; phase D replaces it with role-scoped,
 * anti-drift-checked content. Keep it workflow-only even as a placeholder.
 */
const ORIENT_GUIDANCE = [
  'You are one agent in an orchestrated team. Coordinate entirely through mail — typed',
  'messages to other agents — and act only as yourself.',
  '',
  'Lifecycle:',
  '- Start by reading your inbox. Acknowledge what you have read, and answer anything that',
  '  asks something of you by replying in the same thread so the question and its answer stay',
  '  linked.',
  '- Do the work in your worktree, committing small reviewable changes as you go.',
  '- When you genuinely cannot proceed — an ambiguous intent, a blocker, a decision above your',
  '  authority — raise it upward rather than guessing: ask your parent (a clarify request), and',
  '  escalate if it is a true blocker. Never silently drop an item that was asked of you.',
  '- When the work is done and verified, finish through the gate: commit, then hand off to the',
  '  finisher, which dispatches review. Do not publish or merge your own work.',
  '',
  'If you are waiting on a reply, end your turn; the response arrives in your next inbox.',
].join('\n');

export const orientTool: ToolSpec<OrientInput, OrientOutput> = {
  name: 'co_orient',
  title: 'Orient',
  description:
    'Get short workflow and lifecycle guidance for an orchestrated agent — how to coordinate ' +
    'by mail, finish through the gate, and escalate. Optionally tailored by role and topic.',
  inputSchema: orientInput,
  outputSchema: orientOutput,
  handler: (_ctx, input): OrientOutput => {
    const header =
      input.role != null || input.topic != null
        ? `Guidance${input.role != null ? ` for the ${input.role} role` : ''}` +
          `${input.topic != null ? ` on ${input.topic}` : ''}:\n\n`
        : '';
    return { guidance: header + ORIENT_GUIDANCE };
  },
};
