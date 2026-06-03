import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { orientContent } from '../orient-content.js';

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
 * WORKFLOW-ONLY orientation (Principle 5). The handler is a thin pass-through to {@link orientContent}
 * in core — which teaches the lifecycle (how to coordinate by mail, finish through the gate, and
 * escalate), role-scoped, and NEVER restates a tool's argument / field list: the published zod
 * schemas are the single syntax source, and restating fields is the banned drift the P5 anti-drift
 * assertion kills. `orientContent` is a pure function of (role, topic) — `co` never bakes a target
 * repo's `CLAUDE.md` / `AGENTS.md` into the guidance (the prompting split, Principle 11).
 *
 * The `role` input is a lenient self-declared string. It is NOT the mount-controlled scoping role:
 * an agent cannot widen its offered toolset by asking orient for another role's guidance.
 */
export const orientTool: ToolSpec<OrientInput, OrientOutput> = {
  name: 'co_orient',
  title: 'Orient',
  description:
    'Get short workflow and lifecycle guidance for an orchestrated agent — how to coordinate ' +
    'by mail, finish through the gate, and escalate. Optionally tailored by role and topic.',
  inputSchema: orientInput,
  outputSchema: orientOutput,
  handler: (_ctx, input): OrientOutput => ({ guidance: orientContent(input.role, input.topic) }),
};
