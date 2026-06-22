/**
 * Stage 14 · P1 (KEYSTONE) — the operator-only START PRIMITIVE: launch a ROOT coordinator (no warm
 * parent) from an operator prompt OR a draft spec. Ladders acceptance criterion AC-S14-1.
 *
 * This is the `@co/core` source of truth the `co-mcp start-session` verb (`packages/mcp`) wraps and
 * that Stage 14 P4's desktop operator-IPC path reuses UNCHANGED — so it lives here in core, never in
 * an adapter (single source of truth; the verb is a thin parse-and-call shell over this).
 *
 * What it does, given `{ projectId, repoCwd, name?, coordinatorId?, prompt? | specBody? }`:
 *   1. PROVISION the root's worktree via {@link slingWorktree} (a real worktree record + checkout under
 *      program-data) so the daemon's cold-start launch has a recorded cwd + placement to host into.
 *   2. SEED an ACTIONABLE `clarify_request` kickoff addressed to the root, FROM `@operator`, carrying the
 *      prompt (or the draft-spec brief) as `{ subject, body }`. This is what makes the root selectable by
 *      the daemon's run-cycle: selection reads `store.outstanding`, which is ACTIONABLE-only. An
 *      `operator_message` is classified INFORMATIONAL and would NOT drive a turn — so the kickoff must be
 *      a `clarify_request` (the same actionable kickoff the harnesses use).
 *   3. RECORD the root dispatch placement so cold-start honors provider pins / enabled-provider settings.
 *   4. REGISTER the root in the roster as a `coordinator` whose parent is {@link OPERATOR} (idempotent —
 *      re-asserting the same agent is safe).
 *
 * ⚠ It deliberately DOES NOT mint a `session.created` record. Minting the session is the daemon's job
 * when it cold-starts the registered-but-unhosted root (`ensureHosted → hostSession`, which mints the
 * `session.created` AND idempotently re-asserts the roster entry). A SECOND `session.created` for one
 * active agent FAILS LOUD (session-store), and re-warming an existing session is deferred to v1 — so the
 * start primitive leaves the root REGISTERED (roster + worktree) but UN-SESSIONED. After the first
 * driven tick, both the session and roster records exist (satisfies AC-S14-1).
 *
 * Ordering note: the worktree is provisioned BEFORE the roster registration, so a `slingWorktree`
 * failure leaves NO dangling root coordinator (which the daemon would otherwise try — and fail-loud — to
 * cold-start, having no provisioned cwd). On success all four records exist; the set matches the frozen
 * contract regardless of order.
 *
 * DETERMINISTIC (no `Math.random()` / wall clock): the adapter may pass a name-derived
 * `coordinatorId`; otherwise this preserves the legacy deterministic {@link rootCoordinatorId}
 * fallback for direct callers and fixtures.
 */
import { createHash } from 'node:crypto';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import {
  defaultProviderAccounts,
  placeAgent,
  resolvePinTable,
  type ProviderAccount,
  type ProviderHeadroom,
} from '../dispatch/balancer.js';
import {
  resolveDefaultReasoningBudget,
  resolveDefaultWorkSize,
  resolveEnabledProviders,
  resolveModels,
} from '../dispatch/dispatch-config.js';
import { openDispatchStore, type DispatchStore } from '../dispatch/dispatch-store.js';
import type { PlacementDecided } from '../dispatch/events.js';
import {
  MAIL_CLARIFY_REQUEST,
  OPERATOR,
  turnKickoffCorrelationId,
  type DeliveredMail,
} from '../mail/events.js';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { openRosterStore, type RosterStore } from '../roles/roster-store.js';
import {
  defaultGitExec,
  slingWorktree,
  type SlingDeps,
  type SlingResult,
} from '../worktrees/sling.js';
import { openWorktreeStore, type WorktreeStore } from '../worktrees/worktree-store.js';
import { rollbackError, throwWithRollbackErrors } from '../rollback-errors.js';

/** Inputs to {@link startCoordinatorSession}. Exactly one of `prompt` / `specBody` (Principle 9). */
export interface StartCoordinatorSessionParams {
  /** The registered project whose root coordinator is launched. */
  readonly projectId: string;
  /** The main repo to cut the root's worktree from (the operator's repo cwd). */
  readonly repoCwd: string;
  /** The operator's free-form kickoff prompt. Exactly one of `prompt` / `specBody`. */
  readonly prompt?: string;
  /** A draft-spec brief to kick off from. Exactly one of `prompt` / `specBody`. */
  readonly specBody?: string;
  /** Base ref for the root's worktree; omitted ⇒ {@link slingWorktree} auto-detects. */
  readonly base?: string;
  /** Override the derived root coordinator id (mainly for tests / deterministic fixtures). */
  readonly coordinatorId?: string;
  /** Human-readable name for the coordinator (e.g. 'Auth Refactor'). Persisted in the roster record. */
  readonly name?: string;
}

/** Injectable store/sling seams for {@link startCoordinatorSession}; all default to production. */
export interface StartCoordinatorSessionDeps {
  readonly openRoster?: (projectId: string) => RosterStore;
  readonly openWorktrees?: (projectId: string) => WorktreeStore;
  readonly openMail?: (projectId: string) => MailStore;
  readonly openDispatch?: (projectId: string) => DispatchStore;
  readonly openConfig?: () => ConfigStore;
  /** Seams forwarded to {@link slingWorktree} (git/probe/provisioner) — defaults to production. */
  readonly slingDeps?: SlingDeps;
}

/** The structured facts of a started root coordinator (the verb prints these; tests assert them). */
export interface StartCoordinatorSessionResult {
  /** The deterministic root coordinator id, now registered (roster) + provisioned (worktree). */
  readonly coordinator: string;
  /** Absolute path of the root's provisioned worktree (the daemon's cold-start cwd). */
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseSha: string;
}

/**
 * The deterministic root-coordinator id for a project: `coord-root-<sha256(projectId)[0..8]>`. Stable
 * per project, branch-safe (hex suffix), and free of `Math.random()` / wall clock so the start verb,
 * the daemon's discovery, and the tests all agree without coordination.
 */
export function rootCoordinatorId(projectId: string): string {
  const digest = createHash('sha256').update(projectId).digest('hex').slice(0, 8);
  return `coord-root-${digest}`;
}

/**
 * Start a ROOT coordinator session (the operator entry point). See the file docstring for the full
 * contract; in short: provision the worktree → seed the actionable `clarify_request` kickoff → record root
 * placement → register the roster coordinator (parent `@operator`) — but mint NO session (the daemon does
 * that on cold start). Fails loud (Principle 9) unless exactly one of `prompt` / `specBody` is supplied.
 */
export function startCoordinatorSession(
  params: StartCoordinatorSessionParams,
  deps: StartCoordinatorSessionDeps = {},
): StartCoordinatorSessionResult {
  const { projectId, repoCwd, base } = params;
  // Default the two sources to '' so the survivor narrows to `string` (no non-null assertion below).
  const prompt = params.prompt?.trim() ?? '';
  const specBody = params.specBody?.trim() ?? '';
  const fromPrompt = prompt.length > 0;
  const fromSpec = specBody.length > 0;
  if (fromPrompt === fromSpec) {
    throw new Error(
      'startCoordinatorSession: exactly one of `prompt` / `specBody` is required ' +
        '(Principle 9 — fail loud; a root coordinator is started from a prompt OR a draft spec).',
    );
  }
  if (projectId.length === 0 || repoCwd.length === 0) {
    throw new Error('startCoordinatorSession: `projectId` and `repoCwd` are both required.');
  }

  const coordinator = params.coordinatorId ?? rootCoordinatorId(projectId);
  const branch = `co/${coordinator}`;
  const openRoster = deps.openRoster ?? openRosterStore;
  const openWorktrees = deps.openWorktrees ?? openWorktreeStore;
  const openMail = deps.openMail ?? openMailStore;
  const openDispatch = deps.openDispatch ?? openDispatchStore;
  const openConfig = deps.openConfig ?? openConfigStore;

  // 1) PROVISION the root's worktree FIRST (before any roster/mail write) so a sling failure leaves no
  //    dangling root for the daemon to cold-start. slingWorktree records the worktree keyed to `agent`.
  const worktreeStore = openWorktrees(projectId);
  let slung: SlingResult;
  try {
    slung = slingWorktree(
      worktreeStore,
      {
        parent: OPERATOR,
        agent: coordinator,
        role: 'coordinator',
        branch,
        ...(base != null ? { base } : {}),
        repoCwd,
        projectId,
      },
      deps.slingDeps ?? {},
    );
  } finally {
    worktreeStore.close();
  }

  let kickoff: DeliveredMail | undefined;
  try {
    // 2) SEED the ACTIONABLE kickoff `clarify_request` (NOT `operator_message` — that is informational and
    //    would not drive a turn). To the root, from @operator, carrying the prompt / draft-spec brief.
    const mail = openMail(projectId);
    try {
      kickoff = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: coordinator,
        from: OPERATOR,
        subject: fromPrompt ? 'Operator kickoff' : 'Operator kickoff (draft spec)',
        body: fromPrompt ? prompt : specBody,
        correlationId: turnKickoffCorrelationId(coordinator),
        // F5 defense-in-depth: a stable per-coordinator idempotency key so the read-model dedup
        // (partial UNIQUE index + ON CONFLICT collapse) folds any repeated kickoff seed for this
        // coordinator to a single inbox row — the deterministic coordinator id makes a re-issued
        // kickoff (e.g. an operator-IPC retry) a no-op rather than a second actionable item.
        idempotencyKey: `kickoff:${coordinator}`,
      });
    } finally {
      mail.close();
    }

    // 3) RECORD the root dispatch placement. Root start is operator-initiated, so it is not usage-gated;
    //    it still uses the shared dispatch config/tier policy to honor coordinator pins and provider-only
    //    settings before the daemon cold-starts the registered root.
    const placement = rootCoordinatorPlacement(projectId, openConfig);
    const dispatch = openDispatch(projectId);
    try {
      dispatch.recordPlacement(coordinator, placement);
    } finally {
      dispatch.close();
    }

    // 4) REGISTER the root in the roster (idempotent): a coordinator parented to @operator.
    const roster = openRoster(projectId);
    try {
      roster.recordAgent({
        agentId: coordinator,
        role: 'coordinator',
        parent: OPERATOR,
        ...(params.name != null ? { name: params.name } : {}),
      });
    } finally {
      roster.close();
    }
  } catch (cause) {
    const rollbackErrors = [
      ...cleanupFailedStartWorktree(openWorktrees, projectId, branch, repoCwd),
      ...retractStartKickoff(openMail, projectId, kickoff),
    ];
    throwWithRollbackErrors('startCoordinatorSession: setup failed', cause, rollbackErrors);
  }

  return {
    coordinator,
    worktreePath: slung.worktreePath,
    branch: slung.branch,
    baseRef: slung.baseRef,
    baseSha: slung.baseSha,
  };
}

const ROOT_COORDINATOR_SYNTHETIC_RESET_AT = '9999-12-31T23:59:59.999Z';

function rootCoordinatorPlacement(
  projectId: string,
  openConfig: () => ConfigStore,
): PlacementDecided {
  const config = openConfig();
  try {
    const enabled = new Set(resolveEnabledProviders(projectId, config));
    const accounts = defaultProviderAccounts().filter((account) => enabled.has(account.provider));
    if (accounts.length === 0) {
      throw new Error(
        `startCoordinatorSession: no enabled provider account is available for root coordinator ` +
          `placement (project '${projectId}').`,
      );
    }
    const workSize = resolveDefaultWorkSize(projectId, config);
    const reasoningBudget = resolveDefaultReasoningBudget(projectId, config);
    const decision = placeAgent({
      role: 'coordinator',
      workSize,
      reasoningBudget,
      pins: resolvePinTable(projectId, config),
      candidates: accounts.map(rootCandidate),
      nowMs: 0,
      modelOverrides: resolveModels(projectId, config),
    });
    if (decision.kind === 'no-candidate') {
      throw new Error(
        `startCoordinatorSession: could not place root coordinator: ${decision.reason}`,
      );
    }
    return {
      kind: 'placed',
      role: 'coordinator',
      work_size: workSize,
      reasoning_budget: reasoningBudget,
      provider: decision.placement.provider,
      account: decision.placement.account,
      model: decision.placement.model,
      effort: decision.placement.effort,
      context: decision.placement.context,
    };
  } finally {
    config.close();
  }
}

function rootCandidate(account: ProviderAccount): ProviderHeadroom {
  return {
    provider: account.provider,
    account: account.account,
    available: true,
    headroom: {
      kind: 'known',
      used_pct: 0,
      reset_at: ROOT_COORDINATOR_SYNTHETIC_RESET_AT,
    },
  };
}

function retractStartKickoff(
  openMail: (projectId: string) => MailStore,
  projectId: string,
  kickoff: DeliveredMail | undefined,
): Error[] {
  if (kickoff == null) return [];
  const errors: Error[] = [];
  const mail = openMail(projectId);
  try {
    mail.retract(OPERATOR, kickoff.seq);
  } catch (cause) {
    errors.push(rollbackError(`retract root kickoff seq ${kickoff.seq}`, cause));
  } finally {
    mail.close();
  }
  return errors;
}

function cleanupFailedStartWorktree(
  openWorktrees: (projectId: string) => WorktreeStore,
  projectId: string,
  branch: string,
  repoCwd: string,
): Error[] {
  const errors: Error[] = [];
  const worktrees = openWorktrees(projectId);
  try {
    try {
      worktrees.removeWorktree(branch, { repoCwd, force: true });
    } catch (cause) {
      errors.push(rollbackError(`remove root worktree '${branch}'`, cause));
    }
  } finally {
    worktrees.close();
  }
  try {
    defaultGitExec(repoCwd, ['branch', '-D', branch]);
  } catch (cause) {
    errors.push(rollbackError(`git branch -D '${branch}'`, cause));
  }
  return errors;
}
