import { assertNever } from '../assert-never.js';
import type { Role } from './scoping.js';

/**
 * Role-scoped, WORKFLOW-ONLY orientation content (AC-L2-4). This is the single body behind the
 * `co_orient` tool: it teaches an orchestrated agent its lifecycle — when to send which mail type,
 * the finish → review → publish flow, how and when to escalate — scoped to the agent's base role
 * (agent-roles.md is the source for each mandate arc).
 *
 * Two HARD invariants this module is built to hold (they are the drift this phase exists to kill):
 *
 *   1. SCHEMA IS THE SINGLE SYNTAX SOURCE (Principle 5). orient teaches workflow ONLY and must NEVER
 *      restate a tool's argument / field list — the published zod schemas are the one syntax source.
 *      (Mail *type* names like `clarify_request` are workflow vocabulary, not tool fields, so naming
 *      them is teaching the workflow, not restating a schema.) The P5 anti-drift assertion enforces
 *      this against the live registry.
 *   2. PROMPTING SPLIT (Principle 11). `co` never bakes or mirrors a target repo's `CLAUDE.md` /
 *      `AGENTS.md`; the provider auto-loads that natively. So this is a PURE function of
 *      `(role, topic)` — it reads no file, no cwd, no env, and injects no project content. The
 *      prompting-split assertion proves the output is byte-identical regardless of a `CLAUDE.md`.
 *
 * `role` / `topic` are lenient free strings (an agent self-declaring what guidance it wants): an
 * unknown role gets sensible generic workflow guidance rather than an error. This is DISTINCT from
 * the mount-controlled tool-scoping role ({@link Role} in scoping.ts) — an agent cannot widen its
 * offered toolset by passing a role here.
 */

const SHARED_PREAMBLE = [
  'You are one agent in an orchestrated team. Coordinate entirely through mail — typed messages to',
  'other agents and the operator — and act only as yourself. Start by reading your inbox:',
  'acknowledge what you have read, and answer anything asked of you by replying in the same thread,',
  'so each question and its answer stay linked.',
].join('\n');

const CLOSING =
  'If you are waiting on a reply, end your turn; the response arrives in your next inbox.';

const GENERIC_GUIDANCE = [
  'Do the work in your worktree, raising a question to your parent the moment intent is genuinely',
  'ambiguous rather than guessing, and escalating a true blocker rather than dropping it silently.',
  'When the work is done and verified, finish through the gate; integrating or publishing a reviewed',
  'result is the job of the owner above you, not yours.',
].join('\n');

const COORDINATOR_GUIDANCE = [
  'As the coordinator you own the whole task: shape the operator’s intent into a locked spec, plan',
  'the phases yourself (spawning a researcher when you need investigation before you commit),',
  'dispatch a lead per phase — slinging an isolated worktree sandbox when a phase needs one — gate',
  'each returned result, then publish and close.',
  '',
  'You sit between the operator and the tree. The operator is the source of truth on intent, so',
  'forward genuine intent ambiguity up to them — but resolve everything the locked spec already',
  'settles: interpreting the spec within its lock, re-scoping a phase, acknowledging a',
  'baseline-confirmed known issue, deploying a fix agent. Filter decisions up so the operator sees',
  'the big-picture calls, not noise.',
  '',
  'By mail: report progress and surface a decision to the operator with an operator_message; request',
  'a bless with an approval before anything outward or irreversible; pass a worker’s escalation',
  'onward only when it truly needs authority you do not hold.',
].join('\n');

const LEAD_GUIDANCE = [
  'As a lead you own one phase: decompose it into worker-sized tasks, dispatch your workers one at a',
  'time, integrate each reviewed branch, verify the integrated whole, then report the phase ready to',
  'your coordinator.',
  '',
  'Dispatch sequentially: sling a fresh worktree sandbox for each worker and hand out one task at a',
  'time — only once a worker’s branch has been reviewed and merged do you hand out the next — so',
  'integration stays clean. A worker signals it is done with an informational worker_done; you then',
  'integrate that reviewed branch. You do not finish through the gate yourself; you stitch together',
  'the reviewed branches your workers produce.',
  '',
  'Resolve within the phase: how to implement, integration questions, approach, re-scoping a worker,',
  'or spawning a remediation worker. Forward upward anything that changes what the phase delivers or',
  'touches the spec’s intent. By mail: hand tasks to your workers, answer their clarify_request',
  'messages, and report the phase ready to your coordinator.',
].join('\n');

const IMPLEMENTER_GUIDANCE = [
  'As an implementer you change code in your own isolated worktree — the sandbox your parent slung',
  'for you — then finish through the gate. Read your inbox, make the focused change as small',
  'reviewable commits, and verify it with the project’s own test and check commands before you hand',
  'it back.',
  '',
  'Finish through the gate: when the work is verified, finish — that records your finish for review',
  'and sends a worker_done to your parent. The worker_done is an informational notice, not a request,',
  'so do not wait on a reply to it; integrating and publishing the branch is your parent’s job, never',
  'yours.',
  '',
  'Ask, never guess: on genuine intent ambiguity raise a clarify_request to your parent and wait for',
  'the answer, and note any assumption you had to make. If you are caught in an unwinnable',
  'review-kickback loop, the three-strike rule lifts you out — do not loop forever.',
].join('\n');

const REVIEWER_GUIDANCE = [
  'As a reviewer you are the gate. Inspect the target, run its tests, and return a verdict — pass or',
  'issues — by mail. Hold the strict line: the failure mode to avoid is leniency, not thoroughness,',
  'so when you flag issues name them specifically enough that the maker can fix and resubmit.',
  '',
  'Stay out of the code you review: read it, run it, judge it — but do not edit it; a reviewer who',
  'fixes the work cannot impartially gate it. Once you have returned your verdict, end your turn —',
  'review is turn-based.',
].join('\n');

const RESEARCHER_GUIDANCE = [
  'As a researcher you answer one scoped question with cited evidence, and you change nothing — you',
  'are read-only. Read the question, investigate within your scope, then reply with a findings report',
  'whose claims cite the evidence behind them, and stay warm for follow-ups in the same thread.',
  '',
  'You are a leaf: you do not spawn other agents. Surface evidence rather than making the call or',
  'doing the work yourself — the agent who asked decides what to do with what you find.',
].join('\n');

/** The role-specific lifecycle arc. Exhaustive over {@link Role} (assertNever — Principle 9). */
function roleGuidance(role: Role): string {
  switch (role) {
    case 'coordinator':
      return COORDINATOR_GUIDANCE;
    case 'lead':
      return LEAD_GUIDANCE;
    case 'implementer':
      return IMPLEMENTER_GUIDANCE;
    case 'reviewer':
      return REVIEWER_GUIDANCE;
    case 'researcher':
      return RESEARCHER_GUIDANCE;
    default:
      return assertNever(role);
  }
}

/** Leniently map a self-declared role string to a base {@link Role}, or undefined (→ generic). */
function asRole(input: string | undefined): Role | undefined {
  if (input == null) return undefined;
  switch (input.trim().toLowerCase()) {
    case 'coordinator':
      return 'coordinator';
    case 'lead':
      return 'lead';
    case 'implementer':
      return 'implementer';
    case 'reviewer':
      return 'reviewer';
    case 'researcher':
      return 'researcher';
    default:
      return undefined;
  }
}

/** An optional one-line focus for a known lifecycle topic; unknown topics add nothing (lenient). */
function topicFocus(topic: string): string {
  switch (topic.trim().toLowerCase()) {
    case 'finish':
      return 'Focus — finishing: commit your work, then hand off to the finisher, which dispatches review; do not publish or merge yourself.';
    case 'mail':
      return 'Focus — mail: every message is typed and threaded; reply within the thread you are answering so the conversation stays linked, and never invent a new mail type.';
    case 'review':
      return 'Focus — review: a result is done only once a reviewer returns a pass; on issues, fix and resubmit through the same gate.';
    case 'escalate':
    case 'escalation':
      return 'Focus — escalation: resolve what is within your mandate, forward what needs authority above you, and never drop or guess — keep the question threaded up the chain.';
    default:
      return '';
  }
}

/** The header naming the requested role / topic, or '' when neither was given. */
function header(role: string | undefined, topic: string | undefined): string {
  const hasRole = role != null && role.trim().length > 0;
  const hasTopic = topic != null && topic.trim().length > 0;
  if (!hasRole && !hasTopic) return '';
  const rolePart = hasRole ? ` for the ${role!.trim()} role` : '';
  const topicPart = hasTopic ? `${hasRole ? ',' : ''} focused on ${topic!.trim()}` : '';
  return `Guidance${rolePart}${topicPart}:\n\n`;
}

/**
 * Build the role-scoped, workflow-only orientation text. PURE function of `(role, topic)` — reads no
 * `CLAUDE.md` / `AGENTS.md`, no cwd, no env (the prompting split, Principle 11). A known base role
 * gets its lifecycle arc; an unknown / absent role gets generic workflow guidance.
 */
export function orientContent(role?: string, topic?: string): string {
  const body = asRole(role);
  const arc = body === undefined ? GENERIC_GUIDANCE : roleGuidance(body);
  const focus = topic != null ? topicFocus(topic) : '';
  const sections = [SHARED_PREAMBLE, arc];
  if (focus.length > 0) sections.push(focus);
  sections.push(CLOSING);
  return header(role, topic) + sections.join('\n\n');
}
