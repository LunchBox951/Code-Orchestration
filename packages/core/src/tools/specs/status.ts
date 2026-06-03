import { z } from 'zod';
import type { ToolSpec } from '../registry.js';

const statusInput = z.object({});
type StatusInput = z.infer<typeof statusInput>;

const statusOutput = z.object({
  agent: z.string().describe('Your agent identity.'),
  project_id: z.string().describe('The resolved project id for this invocation.'),
  cwd: z.string().describe('The absolute path of the worktree you are operating in.'),
  outstanding: z.number().int().describe('Count of unresolved actionable items addressed to you.'),
  inbox_unread: z
    .number()
    .int()
    .describe('Count of inbox mail you have neither read nor resolved.'),
});
type StatusOutput = z.infer<typeof statusOutput>;

/**
 * SCOPE NOTE (L2): this is the HONEST L2 "agent record" — identity plus the live coordination
 * state that is derivable from L0/L1 (the event store + the mail bus). The richer
 * run/cost/sibling/task record is L3/L4 and is deliberately NOT included or declared here:
 * declaring an unbacked field now would later fail the completeness gate, so we ground every
 * field in something the bus can answer.
 */
export const statusTool: ToolSpec<StatusInput, StatusOutput> = {
  name: 'co_status',
  title: 'Agent status',
  description:
    'Report your own coordination record: who you are, the project and worktree you are in, ' +
    'how many actionable items are still outstanding for you, and how much inbox mail is unread.',
  inputSchema: statusInput,
  outputSchema: statusOutput,
  handler: (ctx): StatusOutput => {
    const inboxUnread = ctx.mail.inbox(ctx.agent).filter((m) => !m.read && !m.resolved).length;
    return {
      agent: ctx.agent,
      project_id: ctx.projectId,
      cwd: ctx.cwd,
      outstanding: ctx.mail.outstandingCount(ctx.agent),
      inbox_unread: inboxUnread,
    };
  },
};
