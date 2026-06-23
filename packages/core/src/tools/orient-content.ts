import { assertNever } from '../assert-never.js';
import { lifecycleVerbsFor } from '../roles/profile.js';
import { findSubRole, parseSubRoleId } from '../roles/sub-roles.js';
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
  'When the work is done and verified, use the completion or finalization path exposed by your',
  'mounted role (the tool schemas remain the only source of syntax); integrating or publishing a',
  'reviewed result is the job of the owner above you, not yours.',
].join('\n');

const COORDINATOR_GUIDANCE = [
  'As the coordinator you own the whole task end to end. Orient first, then drive this lifecycle —',
  'each step names the verb that advances it (the tool schemas remain the only source of syntax):',
  '',
  '  • SHAPE — turn the operator’s intent into a spec with co_spec_draft (spawn a researcher first',
  '    when you need investigation before you commit).',
  '  • LOCK — a spec is locked by the OPERATOR, not you: after drafting, use co_mail_send’s',
  '    spec-lock request path for the drafted task, then WAIT for the operator’s approval. You cannot',
  '    lock your own spec, and the steps below stay blocked until it is locked — planning against an',
  '    unlocked spec is wasted work.',
  '  • PLAN — once locked, lay out the phases with co_plan_ingest (a phase DAG whose criteria ladder',
  '    up to the locked spec).',
  '  • DISPATCH — per phase, co_sling an isolated worktree sandbox and hand it to a lead. A WAITING',
  '    result means NO sandbox was placed (capacity / health) — do not proceed as if it had been.',
  '  • GATE — a phase is done only when a reviewer records a PASS verdict; on issues, co_kickback the',
  '    branch with what must change rather than merging it.',
  '  • INTEGRATE — land a reviewed branch with co_merge (owner / offline mode — it refuses without a',
  '    recorded PASS); in contributor mode, publish through co_push then co_pr_merge.',
  '  • TRACK + CLOSE — advance phases with co_phase_update as they land, and co_task_complete once the',
  '    whole plan is merged.',
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
  'your coordinator. Each step names the verb that advances it (the tool schemas remain the only',
  'source of syntax):',
  '',
  '  • DISPATCH — co_sling a fresh worktree sandbox for each worker and hand out one task at a time;',
  '    only once a worker’s branch has been reviewed and merged do you hand out the next, so',
  '    integration stays clean. A WAITING result means NO sandbox was placed — do not proceed as if',
  '    it had been.',
  '  • GATE + INTEGRATE — a worker signals it is done with an informational worker_done; land its',
  '    reviewed branch with co_merge once a reviewer records a PASS, or co_kickback the branch with',
  '    what must change. In contributor mode, publish through co_push then co_pr_merge.',
  '  • FINISH — after worker branches are integrated and the phase branch is verified, co_finish',
  '    your own phase branch; it records your finish and notifies the coordinator, then stops before',
  '    review, merge, or publish.',
  '',
  'Do not finish on behalf of workers; you stitch together the reviewed branches they produce and',
  'finish only your own phase branch. Resolve within the phase: how to implement, integration',
  'questions, approach, re-scoping a worker, or spawning a remediation worker. Forward upward',
  'anything that changes what the phase delivers or touches the spec’s intent. By mail: hand tasks to',
  'your workers, answer their clarify_request messages, and report the phase ready to your',
  'coordinator.',
].join('\n');

const IMPLEMENTER_GUIDANCE = [
  'As an implementer you change code in your own isolated worktree — the sandbox your parent slung',
  'for you — then finish through the gate. Read your inbox, make the focused change as small',
  'reviewable commits, and verify it with the project’s own test and check commands before you hand',
  'it back. The verb that advances it is named below (the tool schemas remain the only source of',
  'syntax):',
  '',
  '  • FINISH — when the work is verified, co_finish: that records your finish for review and sends a',
  '    worker_done to your parent. The worker_done is an informational notice, not a request, so do',
  '    not wait on a reply to it; integrating and publishing the branch is your parent’s job, never',
  '    yours.',
  '',
  'Ask, never guess: on genuine intent ambiguity raise a clarify_request to your parent and wait for',
  'the answer, and note any assumption you had to make. If you are caught in an unwinnable',
  'review-kickback loop, the three-strike rule lifts you out — do not loop forever.',
].join('\n');

const REVIEWER_GUIDANCE = [
  'As a reviewer you are the gate. Inspect the target, run its tests, and record your verdict — pass',
  'or issues — through co_review_finalize using the review id from the review kickoff. PASS requires',
  'a verification marker; ISSUES requires at least one named blocker. Hold the strict line: the',
  'failure mode to avoid is leniency, not thoroughness, so when you flag issues name them',
  'specifically enough that the maker can fix and resubmit. A mailed PASS is not a recorded verdict;',
  'review-response mail is for operator-routed human review, not agent review verdicts.',
  '',
  'Stay out of the code you review: read it, run it, judge it — but do not edit it; a reviewer who',
  'fixes the work cannot impartially gate it. Once you have returned your verdict, end your turn —',
  'review is turn-based.',
].join('\n');

const RESEARCHER_GUIDANCE = [
  'As a researcher you answer one scoped question with cited evidence, and you change nothing — you',
  'are read-only. Read the question, investigate within your scope, then record your finished result',
  'with co_research_finalize so the requester and later agents can read it instead of re-searching',
  '(the tool schemas remain the only source of syntax), and stay warm for follow-ups in the same',
  'thread.',
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

interface ResolvedRole {
  readonly role?: Role;
  readonly subRole?: string;
  readonly subRoleApproach?: string;
}

function asBaseRole(input: string): Role | undefined {
  switch (input) {
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

/** Leniently map a self-declared role string to a base role plus known sub-role focus. */
function resolveRole(input: string | undefined): ResolvedRole {
  if (input == null) return {};
  const parsed = parseSubRoleId(input.trim().toLowerCase());
  const role = asBaseRole(parsed.baseRole);
  if (role == null) return {};
  if (parsed.name == null) return { role };
  const subRole = findSubRole(role, parsed.name);
  if (subRole == null) return { role };
  return { role, subRole: subRole.name, subRoleApproach: subRole.approach };
}

/** An optional one-line focus for a known lifecycle topic; unknown topics add nothing (lenient). */
function topicFocus(topic: string, role: Role | undefined): string {
  switch (topic.trim().toLowerCase()) {
    case 'finish':
      if (role === 'lead' || role === 'implementer') {
        return 'Focus — finishing: commit your work through co_finish; it records the finish, notifies your parent, and stops before review or publish.';
      }
      return 'Focus — finishing: use the completion or finalization verb exposed by your mounted role; record the result and stop before review or publish.';
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

/**
 * The #128 nudge: name THIS role's lifecycle verbs and tell the agent the co_* tools may be deferred
 * behind the provider harness's tool_search gate, so load them up front before acting. The verb list
 * is DERIVED from the authoritative profile via {@link lifecycleVerbsFor} so it can never drift from
 * the base prompt's identical nudge. Names verbs ONLY — never their fields (P5). '' for an unknown
 * role (no scoped toolset to surface).
 */
function lifecycleVerbsNudge(role: Role | undefined): string {
  if (role == null) return '';
  const verbs = lifecycleVerbsFor(role);
  if (verbs.length === 0) return '';
  return `Your lifecycle verbs (${verbs.join(', ')}) may be deferred behind the provider's tool_search gate — tool_search and load them up front before acting (names only; the schemas remain the syntax source).`;
}

function subRoleFocus(resolved: ResolvedRole): string {
  if (resolved.role == null || resolved.subRole == null || resolved.subRoleApproach == null) {
    return '';
  }
  return `Sub-role focus (${resolved.role}:${resolved.subRole}): ${resolved.subRoleApproach}.`;
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
  const resolved = resolveRole(role);
  const arc = resolved.role === undefined ? GENERIC_GUIDANCE : roleGuidance(resolved.role);
  const verbs = lifecycleVerbsNudge(resolved.role);
  const subRole = subRoleFocus(resolved);
  const focus = topic != null ? topicFocus(topic, resolved.role) : '';
  const sections = [SHARED_PREAMBLE, arc];
  if (verbs.length > 0) sections.push(verbs);
  if (subRole.length > 0) sections.push(subRole);
  if (focus.length > 0) sections.push(focus);
  sections.push(CLOSING);
  return header(role, topic) + sections.join('\n\n');
}
