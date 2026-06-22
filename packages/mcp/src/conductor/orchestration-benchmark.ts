/**
 * The MULTI-LEVEL ORCHESTRATION-benchmark driver — the v1 centerpiece. Where {@link runWorkerBenchmark}
 * grades ONE implementer writing ONE module, this drives the WHOLE spawn chain for an
 * {@link OrchestrationScenario}: a COORDINATOR is given a general task, decomposes it, dispatches a LEAD,
 * the lead fans out two IMPLEMENTERS who each own a module, the reviewed implementer branches are MERGED
 * UP into the lead's barrel, and the lead's branch is MERGED UP into the coordinator's integration
 * branch. The driver automates the operator gates (spec-lock + review-PASS), detects completion, scrapes
 * per-agent / per-merge metrics from the program-data stores + the git log, grades the MERGED artifact by
 * EXECUTING it against the scenario's hidden oracle (Principle 9 — no LLM judge, no silent green), and
 * returns an {@link OrchestrationScorecard}.
 *
 * ONE CODE PATH, TWO SEAM BUNDLES (mirrors {@link runWorkerBenchmark} + the sh1-dry-run harness):
 *   - SANDBOX: the caller injects a {@link FakePty} + {@link InMemoryTransport} pair + a counter clock +
 *     a SCRIPTED-MCP-CLIENT automation that plays every agent's tool-calls over each hosted pane's
 *     transport (the only honest sandbox option — FakePty panes can't self-drive). Fidelity is stamped
 *     `sandbox-fake` and is STRUCTURALLY barred from host-live evidence (Principle 2).
 *   - LIVE: the caller resolves the real {@link resolveHostLiveSeams} bundle (real node-pty + socket
 *     bridge transport + real timers) and lets REAL provider binaries self-drive the chain through
 *     {@link serveConductor}. Fidelity is DERIVED from the resolved pty host — a fake can never be
 *     host-live.
 *
 * The chain-driving itself is the injected {@link OrchestrationAutomation} seam: the driver owns
 * provisioning, gate automation, metrics aggregation, grading, and teardown; the automation owns ONLY
 * "advance the chain one step at a time until it quiesces". This keeps the sandbox/live split to the seam
 * bundle (exactly like worker-benchmark) without duplicating the driver.
 *
 * Fidelity is DERIVED from the resolved pty host (never a flag); `pnpm test` stays hermetic because the
 * real seams are imported lazily by the LIVE automation, never by this module.
 */
import {
  OPERATOR,
  budgetTokensForScenario,
  buildTokenEconomy,
  buildToolEfficiency,
  openDispatchStore,
  openMailStore,
  openPlanStore,
  openReviewStore,
  openRosterStore,
  openWorktreeStore,
  summarizeRun,
  type AgentRunMetric,
  type MergeOutcome,
  type OrchestrationScenario,
  type OrchestrationScorecard,
  type ProjectId,
  type ProviderMode,
  type RunFidelity,
  type StopReason,
} from '@co/core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PtyHost } from '@co/core';
import { FakePty, NodePtyHost } from '@co/core';

/** Env override for the per-run tick budget (deterministic step bound); default {@link ORCH_BENCH_DEFAULTS}. */
export const CO_BENCH_MAX_TICKS_ENV = 'CO_BENCH_MAX_TICKS';
/** Env override (ms) for the overall wall-clock budget; default {@link ORCH_BENCH_DEFAULTS}. */
export const CO_BENCH_WALLCLOCK_MS_ENV = 'CO_BENCH_WALLCLOCK_MS';
/** Env override (ms) for the per-step (per-tick / per-turn) timeout; default {@link ORCH_BENCH_DEFAULTS}. */
export const CO_BENCH_PER_STEP_MS_ENV = 'CO_BENCH_PER_STEP_MS';

/**
 * Default budgets (overridable via the `CO_BENCH_*` envs). Generous on purpose: a live multi-level chain
 * runs many real turns (coordinator + lead + 2 implementers + reviewers). Exported so the live test
 * derives its outer timeout from the SAME numbers (no drift).
 */
export const ORCH_BENCH_DEFAULTS = {
  maxTicks: 64,
  wallClockMs: 1_800_000,
  perStepMs: 240_000,
} as const;

/** Why the orchestration-benchmark drive loop stopped — mapped 1:1 onto the scorecard {@link StopReason}. */
export type OrchestrationStopReason = StopReason;

/**
 * The fixed task id the benchmark uses for the scenario's plan/spec. Stable so the gate automation can
 * lock the spec and complete the task without guessing an id the coordinator invented.
 */
export const ORCH_BENCH_TASK_ID = 'orchestration-benchmark-task';

/**
 * The result of one chain-driving pass, handed back by the {@link OrchestrationAutomation}. The driver
 * does NOT trust these as the verdict — it independently re-reads the stores + git to aggregate the
 * scorecard. They only tell the driver WHY the loop stopped and which clock to report.
 */
export interface AutomationDriveResult {
  /** Why the chain-drive loop stopped (mapped onto the scorecard stop-reason). */
  readonly stopReason: OrchestrationStopReason;
  /** Per-agent wall-clock + turn counts the automation measured (the only metrics it owns). */
  readonly agentTurns: Readonly<Record<string, AgentTurnSample>>;
  /** The resolved integration branch name (the branch the merged artifact lands on). */
  readonly integrationBranch: string;
  /** Optional diagnostic when the loop stopped on an error. */
  readonly error?: string;
}

/** The per-agent turn + wall-clock sample the automation measured for one agent. */
export interface AgentTurnSample {
  readonly turnsUsed: number;
  readonly wallClockMs: number;
}

/**
 * The injected chain-driving seam. The driver provisions the root coordinator + seeds its kickoff, then
 * hands control to `drive`, which advances the chain (sandbox: scripted MCP tool-calls over FakePty
 * panes; live: real provider turns via serveConductor) until it quiesces or a budget is hit. `pty` lets
 * the driver derive fidelity; `teardown` releases panes/sockets.
 */
export interface OrchestrationAutomation {
  /** The resolved pty host — fidelity is DERIVED from this (FakePty ⇒ sandbox-fake, NodePtyHost ⇒ host-live). */
  readonly pty: PtyHost;
  /**
   * Drive the chain to quiescence (or a budget) and return the structured drive result. The driver has
   * ALREADY provisioned + registered the root coordinator and seeded its kickoff mail before this runs.
   */
  readonly drive: (input: AutomationDriveInput) => Promise<AutomationDriveResult>;
  /** Tear down panes / sockets / servers. Always called in the driver's `finally`. */
  readonly teardown: () => Promise<void>;
}

/** What the driver hands the automation's `drive`. The automation owns provisioning (it knows the seams). */
export interface AutomationDriveInput {
  readonly projectId: ProjectId;
  readonly scenario: OrchestrationScenario;
  readonly nonce: string;
  /** The integration branch the chain merges up into (the coordinator's base). */
  readonly integrationBranch: string;
  /** The repo cwd (the throwaway tmp repo — NEVER the co repo). */
  readonly repoCwd: string;
  readonly maxTicks: number;
  readonly wallClockBudgetMs: number;
  readonly perStepTimeoutMs: number;
}

/** Options for {@link runOrchestrationBenchmark}. Mirrors {@link WorkerBenchmarkOptions}' shape. */
export interface OrchestrationBenchmarkOptions {
  readonly projectId: ProjectId;
  readonly scenario: OrchestrationScenario;
  /** The per-run nonce the chain echoes in its completion mail (proves THIS run). */
  readonly nonce: string;
  /** Which provider roster the run pinned (recorded in the scorecard — NOT used to derive fidelity). */
  readonly providerMode: ProviderMode;
  /** The repo cwd — a throwaway tmp git repo (NEVER the co repo; Principle 12). */
  readonly repoCwd: string;
  /** The integration branch the chain merges up into. Default: the scenario's detected base. */
  readonly integrationBranch: string;
  /**
   * The injected chain-driving seam (sandbox = scripted-MCP automation over FakePty; live = serveConductor
   * over real seams). The driver derives fidelity from `automation.pty`.
   */
  readonly automation: OrchestrationAutomation;
  /** Tick budget (default {@link ORCH_BENCH_DEFAULTS} / {@link CO_BENCH_MAX_TICKS_ENV}). */
  readonly maxTicks?: number;
  /** Wall-clock budget in ms (default {@link ORCH_BENCH_DEFAULTS} / {@link CO_BENCH_WALLCLOCK_MS_ENV}). */
  readonly wallClockBudgetMs?: number;
  /** Per-step timeout in ms (default {@link ORCH_BENCH_DEFAULTS} / {@link CO_BENCH_PER_STEP_MS_ENV}). */
  readonly perStepTimeoutMs?: number;
  /** A unique run id for the scorecard. Default: `${scenario.id}-${nonce}`. */
  readonly runId?: string;
}

/**
 * Derive the run fidelity from the RESOLVED pty host — NEVER from a flag (Principle 2 / Principle 9). A
 * {@link FakePty} ⇒ `sandbox-fake`; a {@link NodePtyHost} ⇒ `host-live`. THROWS if the host is neither, so
 * a sandbox run can never be mislabeled as live evidence and a misconfigured live run that fell back to a
 * fake host fails loud rather than banking a fake pass.
 */
export function deriveRunFidelity(pty: PtyHost): RunFidelity {
  if (pty instanceof FakePty) return 'sandbox-fake';
  if (pty instanceof NodePtyHost) return 'host-live';
  const ctor = (pty as { constructor?: { name?: string } }).constructor;
  throw new Error(
    `runOrchestrationBenchmark: cannot derive a run fidelity — the resolved pty host ` +
      `'${ctor?.name ?? typeof pty}' is neither a FakePty (sandbox-fake) nor a NodePtyHost (host-live). ` +
      'Fail-loud (Principle 9): a scorecard must carry an authentic fidelity tier.',
  );
}

/**
 * Drive the full coordinator → lead → 2-implementers → merge-up chain for one scenario and return the
 * graded {@link OrchestrationScorecard}.
 *
 * Sequence:
 *   1. Provision + register the root coordinator (`startCoordinatorSession`) and seed its kickoff mail.
 *   2. Hand control to `opts.automation.drive`, which advances the chain to quiescence within budget
 *      (sandbox: scripted MCP tool-calls + operator-IPC PASS; live: real provider turns via serveConductor).
 *   3. Aggregate per-agent / per-merge metrics from the program-data stores + the git log (NEVER from the
 *      automation's claims — the stores are the objective record).
 *   4. Detect chain completion (`task.completed` in the plan store).
 *   5. Grade the merged artifact by EXECUTING it under a THROWAWAY worktree of the integration branch
 *      (never the co repo — Principle 12) via `scenario.evaluate`.
 *   6. Tear down (panes/sockets) and return `summarizeRun(input)`.
 *
 * The artifact is ALWAYS graded after the loop (even when the chain never completed), so the scorecard is
 * never a silent hang. Fidelity is DERIVED from `automation.pty`.
 */
export async function runOrchestrationBenchmark(
  opts: OrchestrationBenchmarkOptions,
): Promise<OrchestrationScorecard> {
  const { projectId, scenario, nonce, providerMode, repoCwd, integrationBranch, automation } = opts;
  const maxTicks = opts.maxTicks ?? envInt(CO_BENCH_MAX_TICKS_ENV, ORCH_BENCH_DEFAULTS.maxTicks);
  const wallClockBudgetMs =
    opts.wallClockBudgetMs ?? envInt(CO_BENCH_WALLCLOCK_MS_ENV, ORCH_BENCH_DEFAULTS.wallClockMs);
  const perStepTimeoutMs =
    opts.perStepTimeoutMs ?? envInt(CO_BENCH_PER_STEP_MS_ENV, ORCH_BENCH_DEFAULTS.perStepMs);
  const runId = opts.runId ?? `${scenario.id}-${nonce}`;

  // Fidelity is derived BEFORE any drive — a misconfigured live run that fell back to FakePty is caught
  // here, not after spending tokens. A sandbox run is stamped sandbox-fake and can never be host-live.
  const fidelity = deriveRunFidelity(automation.pty);

  let driveResult: AutomationDriveResult | undefined;
  let driveError: string | undefined;
  try {
    // The automation owns provisioning + the chain-drive (it knows its seam bundle: sandbox slingDeps +
    // scripted MCP clients, or live slingDeps + serveConductor). This module stays free of the session
    // graph so the pure helpers unit-test without a host.
    driveResult = await automation.drive({
      projectId,
      scenario,
      nonce,
      integrationBranch,
      repoCwd,
      maxTicks,
      wallClockBudgetMs,
      perStepTimeoutMs,
    });
  } catch (error) {
    driveError = errorMessage(error);
  } finally {
    await automation.teardown();
  }

  // ── Aggregate the OBJECTIVE record from the stores + git (never the automation's claims). ──────────
  // The chain-completion verdict is read FIRST: it both gates the structural PASS and seeds the per-agent
  // `toolCallsPerCompletedTask` diagnostic (a run that completed the task divides tool calls by 1 completed
  // task; an incomplete run divides by 0 ⇒ the diagnostic is `null`, never a divide-by-zero Infinity).
  const completed = detectChainCompletion(projectId, ORCH_BENCH_TASK_ID);
  const completedTaskCount = completed ? 1 : 0;
  const agents = aggregateAgentMetrics(
    projectId,
    driveResult?.agentTurns ?? {},
    scenario.id,
    fidelity,
    completedTaskCount,
  );
  const merges = aggregateMergeOutcomes(projectId, integrationBranch, repoCwd);
  const implementerBranchesMergedUp = countImplementerBranchesMergedUp(
    projectId,
    integrationBranch,
  );

  // ── Grade the merged artifact under a throwaway worktree of the integration branch (Principle 12). ─
  const artifact = await gradeIntegrationBranch(scenario, repoCwd, integrationBranch);

  const stopReason: OrchestrationStopReason =
    driveError != null ? 'error' : (driveResult?.stopReason ?? 'error');

  return summarizeRun({
    runId,
    scenarioId: scenario.id,
    nonce,
    providerMode,
    fidelity,
    completed,
    artifact,
    agents,
    merges,
    stopReason,
    implementerBranchesMergedUp,
    requiredImplementerMerges: scenario.implementers.length,
  });
}

// ── Pure helpers (no pty — separately exported so they unit-test without a host graph). ───────────────

/**
 * Detect chain completion: `task.completed` recorded in the plan store. The plan store enforces that a
 * task can only complete once every phase merged + verified, so a non-null `completedTs` is a hard,
 * objective "the whole chain landed" — never the automation's say-so.
 */
export function detectChainCompletion(projectId: ProjectId, taskId: string): boolean {
  const store = openPlanStore(projectId);
  try {
    return store.getPlan(taskId)?.completedTs != null;
  } finally {
    store.close();
  }
}

/**
 * The PR B read-model surface this driver reads PER AGENT — declared HERE (not imported from B, and NOT
 * imported from `@co/core`: those shapes are deliberately bench-local + un-exported so B owns the canonical
 * export) so this module compiles on `dev` WITHOUT B. The shapes are STRUCTURAL copies of the bench-local
 * {@link AgentCostRollup}/{@link AgentToolUsage} contract — the driver reads via OPTIONAL CHAINING, so
 * structural compatibility with whatever the store actually returns is all that is required. Both methods
 * are OPTIONAL: when the store handle does not provide them (the surface that produces this data has not
 * landed yet, or it is the sandbox arm), the optional call short-circuits to `undefined` and the
 * corresponding three-score component becomes `null` (N/A) — never a silent zero; a `null` return is an
 * explicit "no rollup".
 */
interface AgentCostRollup {
  readonly agentId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number | null;
}
interface AgentToolUsage {
  readonly agentId: string;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly redundantReads: number;
  readonly permissionAsks: number;
  readonly turnsToFirstProductiveCoCall: number | null;
}
interface BenchEconStore {
  /** LIVE-ONLY per-agent token cost rollup, or `null` (sandbox / not yet recorded). */
  readonly getAgentCostRollup?: (agentId: string) => AgentCostRollup | null;
  /** Per-agent tool-usage rollup (both arms), or `null` (not yet recorded). */
  readonly getAgentToolUsage?: (agentId: string) => AgentToolUsage | null;
}

/**
 * How the driver opens the econ read-model — defaults to the real dispatch store cast to
 * {@link BenchEconStore}. A SEAM (not a runtime knob): the `sandbox-fake` cost-skip is enforced in
 * {@link readAgentEcon} regardless of what this returns, so a test can inject a store whose
 * `getAgentCostRollup` returns NON-null token data and still assert the sandbox arm forces `cost=null`.
 */
export type OpenBenchEcon = (projectId: ProjectId) => BenchEconStore & { close: () => void };

/** The production econ opener: the real dispatch store, structurally typed as a {@link BenchEconStore}. */
const openDispatchEcon: OpenBenchEcon = (projectId) =>
  openDispatchStore(projectId) as ReturnType<typeof openDispatchStore> & BenchEconStore;

/**
 * Aggregate the per-agent {@link AgentRunMetric}s from the roster (role) + the dispatch store (provider) +
 * the mail log (escalations) + PR B's per-agent cost/tool rollups, folding in the automation-measured
 * turn/wall samples. The roster is the authoritative agent set; provider/escalation come from the
 * objective record. An agent the automation never sampled still appears (turns/wall = 0) so the scorecard
 * reflects every registered agent.
 *
 * The token-economy + context/tool-efficiency raw signals are read via OPTIONAL CHAINING against an
 * extended store type ({@link BenchEconStore}) so this compiles on `dev` WITHOUT PR B: when the rollup
 * methods are absent (or return `null`), {@link buildTokenEconomy}/{@link buildToolEfficiency} fold a
 * `null` score — never a silent zero (the trap that already afflicts the live `turnsUsed`). `scenarioId`
 * resolves the (uncalibrated) per-scenario token budget the economy score is measured against.
 *
 * `fidelity` ENFORCES the N/A-in-sandbox rule IN CODE: a `sandbox-fake` run spends no real tokens, so the
 * cost read is SKIPPED entirely (forced to `null`) — token-economy is GUARANTEED `null`, not an accident of
 * B's store being absent. `completedTaskCount` seeds the per-agent `toolCallsPerCompletedTask` diagnostic
 * (derived here, since it is NOT a store field): `toolCalls / completedTaskCount`, or `null` when the run
 * completed no task (no divide-by-zero).
 */
export function aggregateAgentMetrics(
  projectId: ProjectId,
  agentTurns: Readonly<Record<string, AgentTurnSample>>,
  scenarioId: string,
  fidelity: RunFidelity,
  completedTaskCount: number,
  openEcon: OpenBenchEcon = openDispatchEcon,
): readonly AgentRunMetric[] {
  const roster = openRosterStore(projectId);
  const mail = openMailStore(projectId);
  const budgetTokens = budgetTokensForScenario(scenarioId);
  try {
    const escalationsBy = escalationCountsByAgent(mail);
    return roster
      .listAgents()
      .filter((a) => a.agentId !== OPERATOR)
      .map((a): AgentRunMetric => {
        const sample = agentTurns[a.agentId];
        const { cost, tool } = readAgentEcon(projectId, a.agentId, fidelity, openEcon);
        // The throughput diagnostic is DERIVED (not a store field): tool calls per completed task, or null
        // when there is no tool rollup / the run completed no task (never a divide-by-zero Infinity).
        const toolCallsPerCompletedTask =
          tool == null || completedTaskCount <= 0 ? null : tool.toolCalls / completedTaskCount;
        return {
          agentId: a.agentId,
          role: a.role,
          provider: providerForAgent(projectId, a.agentId),
          turnsUsed: sample?.turnsUsed ?? 0,
          wallClockMs: sample?.wallClockMs ?? 0,
          escalations: escalationsBy[a.agentId] ?? 0,
          tokenEconomy: buildTokenEconomy(cost, budgetTokens),
          toolEfficiency: buildToolEfficiency(tool, toolCallsPerCompletedTask),
        };
      });
  } finally {
    mail.close();
    roster.close();
  }
}

/**
 * Read PR B's per-agent cost + tool-usage rollups via OPTIONAL CHAINING against the dispatch store cast to
 * {@link BenchEconStore}. On `dev` WITHOUT B the methods are absent ⇒ both reads return `null` (the score
 * becomes N/A). Never throws: a store-open failure or a missing method degrades to `null`, never a crash.
 *
 * `fidelity` ENFORCES the N/A-in-sandbox rule IN CODE: a `sandbox-fake` run spends no real tokens, so the
 * cost read is SKIPPED entirely and `cost` is forced to `null` — token-economy is GUARANTEED `null`, not a
 * byproduct of B's store being absent. The tool rollup IS read in both arms (tool calls are observable in
 * the sandbox too).
 *
 * A store-open / read FAILURE is LOGGED (not silently swallowed; Principle 9 — no silent green): a
 * persistent read failure must be visible to the operator rather than degrading invisibly to an all-N/A
 * scorecard. We still degrade to `null` so the run is graded, but the error is surfaced on stderr.
 */
function readAgentEcon(
  projectId: ProjectId,
  agentId: string,
  fidelity: RunFidelity,
  openEcon: OpenBenchEcon = openDispatchEcon,
): { cost: AgentCostRollup | null; tool: AgentToolUsage | null } {
  let store: (BenchEconStore & { close: () => void }) | undefined;
  try {
    store = openEcon(projectId);
    // Sandbox runs spend no real tokens ⇒ skip the cost read entirely (forced null). The tool rollup is
    // observable in both arms, so it is always read.
    const cost = fidelity === 'sandbox-fake' ? null : (store.getAgentCostRollup?.(agentId) ?? null);
    const tool = store.getAgentToolUsage?.(agentId) ?? null;
    return { cost, tool };
  } catch (error) {
    // Surface, don't swallow: a persistent econ-read failure degrades the whole corpus to N/A invisibly.
    console.error(
      `[co orch-bench] econ read failed for agent '${agentId}' in project '${projectId}': ${errorMessage(error)}`,
    );
    return { cost: null, tool: null };
  } finally {
    store?.close();
  }
}

/** Count `escalation` mails each agent SENT (the durable RL-3 forward-up signal lives in the mail log). */
function escalationCountsByAgent(mail: ReturnType<typeof openMailStore>): Record<string, number> {
  const counts: Record<string, number> = {};
  // `inbox(OPERATOR)` + every parent inbox is expensive to enumerate; instead walk the sent log per
  // agent is also not exposed generically. The objective, cheap signal: escalation mails are addressed
  // UP and carry a sender; we scan the operator inbox (the structural top of the escalation chain) plus
  // any inbox we can reach. Simpler + robust: count escalations by sender across @operator's inbox, which
  // is where forward-up escalations terminate. (A deeper count would walk every roster inbox.)
  for (const item of mail.inbox(OPERATOR)) {
    if (item.type === 'escalation') counts[item.sender] = (counts[item.sender] ?? 0) + 1;
  }
  return counts;
}

/**
 * The provider an agent was placed on (from the dispatch store — the only place per-agent provider lives;
 * the roster knows only role/parent), or `'unknown'` when not placed. A not-yet-placed agent (e.g. a
 * never-spawned root in some sandbox shapes) reports `'unknown'` rather than failing the aggregation.
 */
function providerForAgent(projectId: ProjectId, agentId: string): string {
  let store: ReturnType<typeof openDispatchStore> | undefined;
  try {
    store = openDispatchStore(projectId);
    const placements = store.readPlacements(agentId);
    for (let i = placements.length - 1; i >= 0; i--) {
      const p = placements[i];
      if (p?.kind === 'placed' && p.provider != null) return p.provider;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    store?.close();
  }
}

/**
 * Aggregate the per-merge {@link MergeOutcome}s — one outcome per (target, branch) that was reviewed,
 * capturing BOTH merge levels (implementers→lead AND lead→integration). The review-ROUND history is read
 * from the durable, append-only MAIL log, NOT the review store: the `reviews` table UPSERTs (keeps only
 * the latest verdict) and its strike counter resets to 0 on a PASS, so neither retains the kickback
 * history after a merge lands. The mail log does: each review ROUND is a `review_request` mail (a new
 * `reviewId` per re-review), and each verdict is a `review_response` carrying `reviewVerdict: PASS|ISSUES`.
 * So `reviewRounds` = the request mails for (target, branch), `kickbacks` = the ISSUES responses, and
 * `firstTryPass` ⇔ the first verdict was PASS with no ISSUES before it.
 */
export function aggregateMergeOutcomes(
  projectId: ProjectId,
  integrationBranch: string,
  repoCwd: string,
): readonly MergeOutcome[] {
  const reviews = openReviewStore(projectId);
  const mail = openMailStore(projectId);
  try {
    const rounds = reviewRoundsByMerge(mail);
    const targets = discoverMergeTargets(projectId, integrationBranch);
    const outcomes: MergeOutcome[] = [];
    for (const target of targets) {
      // listVerdicts(target) returns one row per branch (the latest verdict); each is one reviewed merge.
      for (const latest of reviews.listVerdicts(target)) {
        // A merge only lands after a final PASS, so every round BEFORE the latest verdict was a kickback.
        const totalRounds = Math.max(1, rounds.get(`${target} ${latest.branch}`) ?? 1);
        const latestPassed = latest.verdict === 'PASS';
        const kickbacks = latestPassed ? totalRounds - 1 : totalRounds;
        const serialized = reviews.serializedBranches(target).includes(latest.branch);
        outcomes.push({
          branch: latest.branch,
          target,
          reviewRounds: totalRounds,
          kickbacks,
          firstTryPass: totalRounds === 1 && latestPassed,
          // Only a serialized (landed) branch has a merge commit; an un-landed PASS has no commit yet.
          mergeCommitSha: serialized ? resolveMergeCommitSha(repoCwd, target, latest.branch) : null,
        });
      }
    }
    return outcomes;
  } finally {
    mail.close();
    reviews.close();
  }
}

/**
 * The production `review_request` mail subject: `review requested: '<branch>' into '<target>'`. The
 * (target, branch) is parsed from THIS durable, append-only text because the review store's request
 * projection is keyed `(target, branch)` and UPSERTs — so an older round's `reviewId` is no longer
 * resolvable via `getReviewRequestById` after a re-review. The subject text is the only per-ROUND signal
 * that survives, so matching it is how the honest round history is reconstructed.
 */
const REVIEW_REQUEST_SUBJECT = /review requested: '([^']+)' into '([^']+)'/u;

/**
 * Count review ROUNDS per (target, branch) from the durable mail log. Each `review_request` mail to
 * @operator is one round; its (target, branch) is parsed from the mail subject (see
 * {@link REVIEW_REQUEST_SUBJECT}). Append-only mail is the only source that survives the review store's
 * UPSERT + strike-reset, so it is the honest round history. A mail whose subject does not match carries
 * no reconstructible (target, branch) and is skipped.
 */
function reviewRoundsByMerge(mail: ReturnType<typeof openMailStore>): Map<string, number> {
  const byMerge = new Map<string, number>();
  for (const item of mail.inbox(OPERATOR)) {
    if (item.type !== 'review_request') continue;
    const matched = REVIEW_REQUEST_SUBJECT.exec(item.subject);
    if (matched == null) continue;
    const [, branch, target] = matched;
    byMerge.set(`${target} ${branch}`, (byMerge.get(`${target} ${branch}`) ?? 0) + 1);
  }
  return byMerge;
}

/**
 * Count DISTINCT implementer branches that merged up the chain: implementer-role worktrees whose branch
 * carries a recorded PASS verdict on the lead branch (their merge target) AND was serialized there. This
 * is the structural merge-up floor the scorecard compares against `scenario.implementers.length`.
 */
export function countImplementerBranchesMergedUp(
  projectId: ProjectId,
  integrationBranch: string,
): number {
  const worktrees = openWorktreeStore(projectId);
  const reviews = openReviewStore(projectId);
  try {
    const implementerBranches = worktrees
      .listWorktrees()
      .filter((w) => w.role === 'implementer')
      .map((w) => w.branch);
    // Each implementer's merge target is its lead branch; the lead branch then merges into integration.
    // A branch "merged up" iff it has a PASS verdict on some target AND was serialized into that target.
    let merged = 0;
    for (const branch of new Set(implementerBranches)) {
      if (branchMergedUp(reviews, branch, integrationBranch)) merged += 1;
    }
    return merged;
  } finally {
    reviews.close();
    worktrees.close();
  }
}

/** True iff `branch` carries a PASS verdict on, and was serialized into, ANY of its candidate targets. */
function branchMergedUp(
  reviews: ReturnType<typeof openReviewStore>,
  branch: string,
  integrationBranch: string,
): boolean {
  // The branch's lead target is not known a priori from the review store alone; we test every target the
  // review store knows about (the integration branch + every serialized-into target). A PASS + serialized
  // pair on any of them is a merge-up.
  const candidateTargets = new Set<string>([integrationBranch]);
  // serializedBranches(target) lists branches serialized INTO target; we need the inverse (targets a
  // branch was serialized into). The review store keys verdicts by (target, branch), so a recorded PASS
  // for (target, branch) implies the branch was reviewed against that target. We scan the integration
  // branch's serialized list for the lead branch, and accept any target where the branch has PASS +
  // serialized. Because lead-branch targets are discovered transitively, we also probe the branch's own
  // recorded verdicts via the integration target's serialized leads.
  for (const lead of reviews.serializedBranches(integrationBranch)) candidateTargets.add(lead);
  for (const target of candidateTargets) {
    const verdict = reviews.getVerdict(target, branch);
    if (verdict?.verdict === 'PASS' && reviews.serializedBranches(target).includes(branch)) {
      return true;
    }
  }
  return false;
}

/**
 * Grade the merged artifact by EXECUTING it under a THROWAWAY worktree of the integration branch — NEVER
 * the co repo, NEVER the live agent worktrees (Principle 12). Adds a detached worktree of the integration
 * branch in a tmp dir, runs `scenario.evaluate(thatDir)` (the objective oracle), and removes the worktree.
 * On any git failure (the branch never landed) the oracle still runs against the (missing) artifact and
 * reports `correct:false` with a concrete reason — never a silent green.
 */
export async function gradeIntegrationBranch(
  scenario: OrchestrationScenario,
  repoCwd: string,
  integrationBranch: string,
): Promise<ReturnType<OrchestrationScenario['evaluate']>> {
  const graded = mkdtempSync(join(tmpdir(), 'co-orch-bench-grade-'));
  let addedWorktree = false;
  try {
    try {
      // A DETACHED worktree (no branch checkout) so it never conflicts with a live worktree on the same
      // branch and leaves the repo's branch refs untouched.
      gitQuiet(repoCwd, ['worktree', 'add', '--detach', graded, integrationBranch]);
      addedWorktree = true;
    } catch {
      // The integration branch may not exist (chain never landed) — grade against the empty dir so the
      // oracle reports a concrete "artifact not found" rather than throwing. addedWorktree stays false.
    }
    return await scenario.evaluate(graded);
  } finally {
    if (addedWorktree) {
      try {
        gitQuiet(repoCwd, ['worktree', 'remove', '--force', graded]);
      } catch {
        /* best-effort; the rmSync below still clears the dir */
      }
    }
    try {
      rmSync(graded, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────────────────────────────

/** The review targets we aggregate merges for: the integration branch + every lead branch serialized there. */
function discoverMergeTargets(projectId: ProjectId, integrationBranch: string): readonly string[] {
  const reviews = openReviewStore(projectId);
  const worktrees = openWorktreeStore(projectId);
  try {
    const targets = new Set<string>([integrationBranch]);
    // Lead branches are review TARGETS for their implementers, so add every lead-role branch.
    for (const w of worktrees.listWorktrees()) {
      if (w.role === 'lead') targets.add(w.branch);
    }
    // Plus any branch serialized into integration (defensive — covers leads with torn-down worktrees).
    for (const lead of reviews.serializedBranches(integrationBranch)) targets.add(lead);
    return [...targets];
  } finally {
    worktrees.close();
    reviews.close();
  }
}

/** The merge-commit sha for (target, branch), read from the git log of the throwaway repo, or `null`. */
function resolveMergeCommitSha(repoCwd: string, target: string, branch: string): string | null {
  // A `--no-ff` merge of `branch` into `target` leaves a merge commit on `target` whose message names the
  // branch. We read the most recent merge commit on `target` that has the branch as a second parent.
  try {
    const log = gitQuiet(repoCwd, ['log', '--merges', '--format=%H %P', '-n', '50', target]);
    for (const line of log.split('\n')) {
      const [sha, ...parents] = line.trim().split(/\s+/u);
      if (sha == null || sha.length === 0) continue;
      // The merge commit's second parent is the merged branch head; confirm it is an ancestor of `branch`.
      const second = parents[1];
      if (second == null) continue;
      if (isAncestorOrEqual(repoCwd, second, branch)) return sha;
    }
  } catch {
    /* the branch/target may not exist — no merge commit */
  }
  return null;
}

function isAncestorOrEqual(repoCwd: string, candidate: string, branch: string): boolean {
  try {
    const head = gitQuiet(repoCwd, ['rev-parse', branch]);
    if (head === candidate) return true;
    // `git merge-base --is-ancestor` exits 0 when candidate is an ancestor of branch head.
    execFileSync('git', ['merge-base', '--is-ancestor', candidate, branch], {
      cwd: repoCwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function gitQuiet(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
