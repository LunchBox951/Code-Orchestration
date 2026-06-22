/**
 * The LIVE worker BENCHMARK driver (gated behind `CO_LIVE_E2E` — see `worker-benchmark.live.test.ts`
 * and `docs/worker-benchmark.md`). Where {@link runHostProof} proves the host-live PLUMBING with a
 * scripted route-proof mail, this hosts a REAL implementer-role agent in a REAL node-pty through CO's
 * real socket-bridge MCP surface, gives it an actual coding task ({@link BenchmarkScenario}), lets it
 * work real turns until it signals done, then OBJECTIVELY grades the artifact it produced — so the
 * tokens a host-live run spends also measure whether a real worker can do real work end to end.
 *
 * It reuses the proven primitives unchanged: {@link resolveHostLiveSeams} (the one host-live wiring
 * path), {@link ConductorEngine.ensureHosted} + {@link ConductorEngine.runOneTurn} (loopable — each
 * turn yields the pane WARM with no teardown), and {@link buildHostProofSpawnSpec} for the isolated
 * provider spawn. The done-signal is a nonce-bearing `clarify_request` to the parent (NOT `worker_done`,
 * which `co_mail_send` rejects), detected exactly like {@link runHostProof}'s route proof: a NEW reply
 * FROM the hosted agent carrying the run nonce — never a tautological "queue is non-empty" check.
 *
 * Fidelity is DERIVED from the resolved {@link NodePtyHost} (`resolveHostLiveSeams`), never from a flag,
 * so a misconfigured run that fell back to a fake host could never be scored host-live (Principle 2).
 */
import {
  MAIL_CLARIFY_REQUEST,
  OPERATOR,
  budgetTokensForScenario,
  buildTokenEconomy,
  buildToolEfficiency,
  clamp01,
  defaultMailRenderer,
  openDispatchStore,
  openMailStore,
  toolsForRole,
  type AgentToolEfficiency,
  type AgentTokenEconomy,
  type ArtifactCheck,
  type BenchmarkScenario,
  type DeliveredMail,
  type MailRenderer,
  type ProjectId,
  type SpawnSpec,
  type ToolSpec,
} from '@co/core';
import { ConductorEngine, type TurnOutcome } from './engine.js';
import type { HostedIdentity } from '../live-session-host.js';
import { resolveHostLiveSeams } from './host-live-seams.js';
import {
  buildHostProofSpawnSpec,
  type HostProofLaunchPaths,
  type ProofFidelity,
} from './host-proof.js';

/** Env override for the per-run turn budget (number of turns); default {@link DEFAULT_MAX_TURNS}. */
export const CO_BENCH_MAX_TURNS_ENV = 'CO_BENCH_MAX_TURNS';
/** Env override (ms) for the overall wall-clock budget; default {@link DEFAULT_WALLCLOCK_MS}. */
export const CO_BENCH_WALLCLOCK_MS_ENV = 'CO_BENCH_WALLCLOCK_MS';
/** Env override (ms) for the per-turn timeout; default {@link DEFAULT_PER_TURN_MS}. */
export const CO_BENCH_PER_TURN_MS_ENV = 'CO_BENCH_PER_TURN_MS';

/**
 * Default budgets (overridable via the `CO_BENCH_*` envs). Generous on purpose: a real claude turn was
 * observed ~130s (startup + work + the conservative quiet/wedge windows), so the wall-clock budget
 * leaves headroom for a few turns. Exported so the live test derives its outer timeout + turn-bound from
 * the SAME numbers (no drift).
 */
export const WORKER_BENCH_DEFAULTS = {
  maxTurns: 8,
  wallClockMs: 600_000,
  perTurnMs: 180_000,
} as const;

/** Why the benchmark turn loop stopped. */
export type WorkerBenchmarkStopReason =
  | 'done-mail'
  | 'turn-budget'
  | 'time-budget'
  | 'pane-exit'
  | 'turn-error';

/** Options for {@link runWorkerBenchmark}. The caller assembles the same host-live launch inputs the
 *  `co-mcp host-proof` command builds (registry-scoped project, isolated home, bridge socket). */
export interface WorkerBenchmarkOptions {
  readonly projectId: ProjectId;
  readonly identity: HostedIdentity;
  /** The pluggable benchmark task (prompt + objective evaluator). */
  readonly scenario: BenchmarkScenario;
  /** The per-run nonce the agent must echo in its done-mail. */
  readonly nonce: string;
  /** The isolated provider spawn spec (from {@link buildWorkerSpawnSpec}). */
  readonly spawnSpec: SpawnSpec;
  /** The Conductor-owned bridge socket path for the host-live transport pair. */
  readonly socketPath: string;
  /** The bridge diagnostic log path. */
  readonly bridgeLogPath: string;
  /** The hosted session's tool surface. Default: the identity's full role toolset (e.g. implementer). */
  readonly sessionTools?: (identity: HostedIdentity) => readonly ToolSpec[] | undefined;
  /** Turn budget (default {@link DEFAULT_MAX_TURNS} / {@link CO_BENCH_MAX_TURNS_ENV}). */
  readonly maxTurns?: number;
  /** Wall-clock budget in ms (default {@link DEFAULT_WALLCLOCK_MS} / {@link CO_BENCH_WALLCLOCK_MS_ENV}). */
  readonly wallClockBudgetMs?: number;
  /** Per-turn timeout in ms (default {@link DEFAULT_PER_TURN_MS} / {@link CO_BENCH_PER_TURN_MS_ENV}). */
  readonly perTurnTimeoutMs?: number;
  /** Optional pane transcript hook for diagnostics. */
  readonly onPaneData?: (chunk: string) => void;
}

/** The per-provider benchmark scorecard. Plumbing fields are hard-asserted; quality fields are metrics. */
export interface WorkerBenchmarkResult {
  readonly provider: 'claude' | 'codex';
  readonly scenarioId: string;
  /** DERIVED from the resolved node-pty host; must be `'host-live'`. */
  readonly fidelity: ProofFidelity;
  /** Did the agent route its nonce done-mail through the live MCP surface within budget? */
  readonly completed: boolean;
  /** Turns driven (≥ 1 on any real attempt). */
  readonly turnsUsed: number;
  /** The OBJECTIVE artifact grade — the produced module, EXECUTED. */
  readonly artifact: ArtifactCheck;
  /** Wall-clock duration of the run (a reported metric, measured with the real clock). */
  readonly wallClockMs: number;
  /** Which terminal condition ended the turn loop. */
  readonly stopReason: WorkerBenchmarkStopReason;
  /** Diagnostic: the turn error, when a turn threw or timed out. */
  readonly turnError?: string;
  /**
   * The three comparable scores for the single-agent case (mirrors the orchestration scorecard so the
   * per-provider corpus is uniform):
   *   - CORRECTNESS (objective; both arms): the artifact's oracle case fraction, gated by `completed`.
   *     There are no implementer merges in the single-agent case, so the merge-up / review factors are
   *     vacuously satisfied — correctness reduces to `(casesPassed/casesTotal) × (completed ? 1 : 0)`.
   *   - TOKEN-ECONOMY (LIVE-ONLY): `null` until a per-agent cost rollup is available (read via optional
   *     chaining against PR B's store surface) — never a silent zero.
   *   - CONTEXT/TOOL-EFFICIENCY (both arms): `null` until a per-agent tool-usage rollup is available.
   */
  readonly scores: WorkerScores;
}

/** The single-agent three-score block (parallels the orchestration `RunScores`). */
export interface WorkerScores {
  /** CORRECTNESS ∈ [0,1] (objective; both arms) — the oracle case fraction gated by completion. */
  readonly correctness: number;
  /** LIVE-ONLY token economy (raw tokens + economy/cache scores); `null` fields with no cost rollup. */
  readonly tokenEconomy: AgentTokenEconomy;
  /** Context/tool efficiency (raw rates + the contextEfficiency score); `null` fields with no rollup. */
  readonly toolEfficiency: AgentToolEfficiency;
}

/**
 * Build the isolated provider spawn spec for a benchmark worker. A thin pass-through to
 * {@link buildHostProofSpawnSpec} (same isolated-home / co-MCP-config / bridge-socket / provider-auth
 * assembly), reused so the benchmark and host-proof share one launch builder (no duplication).
 */
export function buildWorkerSpawnSpec(
  identity: HostedIdentity,
  paths: HostProofLaunchPaths,
): SpawnSpec {
  return buildHostProofSpawnSpec(identity, paths);
}

/**
 * Run the benchmark for one provider against one scenario, returning the graded scorecard. Hosts the
 * agent ONCE, then loops single turns until the done-mail is observed / the pane exits / a turn
 * errors / a budget is hit. The artifact is ALWAYS evaluated after the loop (even when the agent never
 * signalled done), so the scorecard is never a silent hang. The pane is always torn down (`closeAll`).
 */
export async function runWorkerBenchmark(
  provider: 'claude' | 'codex',
  opts: WorkerBenchmarkOptions,
): Promise<WorkerBenchmarkResult> {
  const { projectId, identity, scenario, nonce } = opts;
  const maxTurns = opts.maxTurns ?? envInt(CO_BENCH_MAX_TURNS_ENV, WORKER_BENCH_DEFAULTS.maxTurns);
  const wallClockBudgetMs =
    opts.wallClockBudgetMs ?? envInt(CO_BENCH_WALLCLOCK_MS_ENV, WORKER_BENCH_DEFAULTS.wallClockMs);
  const perTurnTimeoutMs =
    opts.perTurnTimeoutMs ?? envInt(CO_BENCH_PER_TURN_MS_ENV, WORKER_BENCH_DEFAULTS.perTurnMs);
  const sessionTools = opts.sessionTools ?? ((id: HostedIdentity) => toolsForRole(id.role));

  const seams = await resolveHostLiveSeams(provider);
  const engine = new ConductorEngine({
    pty: seams.pty,
    makeTransport: () => seams.makeTransport(opts.socketPath, opts.bridgeLogPath),
    sessionTools,
    now: seams.now,
    quietWindow: seams.quietWindow,
    injectOptions: { retryDelay: seams.injectRetryDelay, allowUnverifiedSubmit: true },
    renderMail: workerBenchRenderer(scenario, nonce, identity.parent),
  });

  const wallStart = Date.now();
  let turnsUsed = 0;
  let completed = false;
  let stopReason: WorkerBenchmarkStopReason | undefined;
  let turnError: string | undefined;
  let paneHasExited = false;
  let unsubExit = noop;
  let unsubData = noop;

  try {
    // Seed the task mail BEFORE hosting (a plain store write; no pane is warm yet, so nothing routes).
    const taskMail = seedTaskMail(projectId, identity, scenario, nonce);

    const hosted = await engine.ensureHosted(identity, opts.spawnSpec);
    unsubExit = hosted.pane.onExit(() => {
      paneHasExited = true;
    });
    if (opts.onPaneData != null) unsubData = hosted.pane.onData(opts.onPaneData);
    if (!hosted.startup.authed) {
      const methods = hosted.startup.loginRequired?.methods.join(', ') || 'unknown methods';
      throw new Error(
        `runWorkerBenchmark: provider '${provider}' is not authenticated; login required before the ` +
          `benchmark can inject a turn (${methods}).`,
      );
    }
    await seams.readySettle();

    const baselineSeq = parentInboxMaxSeq(projectId, identity.parent);
    const deadline = wallStart + wallClockBudgetMs;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (Date.now() >= deadline) {
        stopReason = 'time-budget';
        break;
      }
      const mail =
        turn === 0 ? taskMail : seedNudgeMail(projectId, identity, scenario, nonce, turn);
      let outcome: TurnOutcome;
      try {
        outcome = await withTimeout(engine.runOneTurn(hosted, mail), perTurnTimeoutMs, turn);
      } catch (error) {
        turnError = errorMessage(error);
        stopReason = 'turn-error';
        turnsUsed += 1;
        break;
      }
      turnsUsed += 1;
      if (outcome.errored) {
        turnError = errorMessage(outcome.error);
        stopReason = 'turn-error';
        break;
      }
      if (doneMailObserved(projectId, identity, baselineSeq, nonce)) {
        completed = true;
        stopReason = 'done-mail';
        break;
      }
      if (paneHasExited) {
        stopReason = 'pane-exit';
        break;
      }
    }
    stopReason ??= 'turn-budget';

    // ALWAYS grade the artifact — a correct file with no done-mail still reports artifact.correct.
    const artifact = await scenario.evaluate(identity.cwd);

    // The three comparable scores for the single-agent case. Token/tool rollups are read via OPTIONAL
    // CHAINING against PR B's store surface (declared locally; see {@link WorkerEconStore}) so this
    // compiles on `dev` WITHOUT B — a `null` rollup ⇒ a `null` score (N/A), never a silent zero.
    const { cost, tool } = readWorkerEcon(projectId, identity.agent, seams.fidelity);
    // The throughput diagnostic is DERIVED (not a store field): tool calls per completed task, or null when
    // there is no rollup / the single task did not complete (never a divide-by-zero).
    const toolCallsPerCompletedTask = tool == null || !completed ? null : tool.toolCalls;
    const scores: WorkerScores = {
      correctness: workerCorrectness(artifact, completed),
      tokenEconomy: buildTokenEconomy(cost, budgetTokensForScenario(scenario.id)),
      toolEfficiency: buildToolEfficiency(tool, toolCallsPerCompletedTask),
    };

    return {
      provider,
      scenarioId: scenario.id,
      fidelity: seams.fidelity,
      completed,
      turnsUsed,
      artifact,
      wallClockMs: Date.now() - wallStart,
      stopReason,
      ...(turnError != null ? { turnError } : {}),
      scores,
    };
  } finally {
    unsubData();
    unsubExit();
    await engine.closeAll();
  }
}

/** Render the seeded task mail into the verbatim scenario prompt; everything else via the default renderer. */
export function workerBenchRenderer(
  scenario: BenchmarkScenario,
  nonce: string,
  parent: string,
): MailRenderer {
  const ctx = { nonce, parent };
  const taskSubject = scenario.subject(ctx);
  return (mail) => {
    if (mail.sender === OPERATOR && mail.subject === taskSubject) return scenario.body(ctx);
    return defaultMailRenderer(mail);
  };
}

/** Seed the scenario task mail into the agent's inbox (the turn-0 injection). */
export function seedTaskMail(
  projectId: ProjectId,
  identity: HostedIdentity,
  scenario: BenchmarkScenario,
  nonce: string,
): DeliveredMail {
  const ctx = { nonce, parent: identity.parent };
  const store = openMailStore(projectId);
  try {
    return store.send({
      type: MAIL_CLARIFY_REQUEST,
      to: identity.agent,
      from: OPERATOR,
      subject: scenario.subject(ctx),
      body: scenario.body(ctx),
      idempotencyKey: nonce,
    });
  } finally {
    store.close();
  }
}

/** Seed a small per-turn nudge mail (injected on turns > 0 until the agent signals done). */
export function seedNudgeMail(
  projectId: ProjectId,
  identity: HostedIdentity,
  scenario: BenchmarkScenario,
  nonce: string,
  turn: number,
): DeliveredMail {
  const store = openMailStore(projectId);
  try {
    return store.send({
      type: MAIL_CLARIFY_REQUEST,
      to: identity.agent,
      from: OPERATOR,
      subject: `worker-benchmark continue ${nonce}`,
      body:
        `If ${scenario.artifactPath} is ready and correct, call mcp__co__co_mail_send now to ` +
        `${identity.parent} with type clarify_request, subject "worker done ${nonce}", and a body ` +
        `that includes ${nonce}. Otherwise finish writing ${scenario.artifactPath} first, then send it.`,
      idempotencyKey: `${nonce}:nudge:${turn}`,
    });
  } finally {
    store.close();
  }
}

/** The parent inbox's max seq, captured before the run so a stale item can't false-positive the done check. */
export function parentInboxMaxSeq(projectId: ProjectId, parent: string): number {
  const store = openMailStore(projectId);
  try {
    return Math.max(0, ...store.inbox(parent).map((item) => item.seq));
  } finally {
    store.close();
  }
}

/**
 * True once the hosted agent has routed its done-mail: a NEW (`seq > baselineSeq`) `clarify_request`
 * FROM `identity.agent` TO `identity.parent` carrying the run nonce. Mirrors {@link runHostProof}'s
 * `hasRoutedProofMail` discipline — proves a real reply from THIS agent, not a non-empty queue.
 */
export function doneMailObserved(
  projectId: ProjectId,
  identity: HostedIdentity,
  baselineSeq: number,
  nonce: string,
): boolean {
  const store = openMailStore(projectId);
  try {
    return store
      .inbox(identity.parent)
      .some(
        (item) =>
          item.seq > baselineSeq &&
          item.sender === identity.agent &&
          item.type === MAIL_CLARIFY_REQUEST &&
          (item.subject.includes(nonce) || item.body.includes(nonce)),
      );
  } finally {
    store.close();
  }
}

/**
 * The single-agent CORRECTNESS score: the oracle case fraction, gated by completion. There are no
 * implementer merges in the single-agent case, so the orchestration merge-up / every-merge-reviewed
 * factors are vacuously 1 — correctness reduces to `(casesPassed/casesTotal) × (completed ? 1 : 0)`.
 * `casesTotal === 0` (a scenario with no oracle cases) yields 0 (we cannot claim correctness with no
 * evidence — fail-closed, mirrors the orchestration `correctnessScore`).
 */
export function workerCorrectness(artifact: ArtifactCheck, completed: boolean): number {
  if (artifact.casesTotal <= 0) return 0;
  return clamp01((artifact.casesPassed / artifact.casesTotal) * (completed ? 1 : 0));
}

/**
 * PR B's per-agent read-model surface, declared HERE (not imported from B, and NOT from `@co/core` — those
 * shapes are bench-local + un-exported so B owns the canonical export) so this module compiles on `dev`
 * WITHOUT B. The shapes are STRUCTURAL copies of the bench-local cost/tool-usage contract — read via
 * OPTIONAL CHAINING, so structural compatibility is all that is required. Both methods OPTIONAL: an absent
 * method / `null` return ⇒ a `null` score (N/A), never a silent zero.
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
interface WorkerEconStore {
  readonly getAgentCostRollup?: (agentId: string) => AgentCostRollup | null;
  readonly getAgentToolUsage?: (agentId: string) => AgentToolUsage | null;
}

/**
 * How the driver opens the econ read-model — defaults to the real dispatch store cast to
 * {@link WorkerEconStore}. A SEAM (not a runtime knob): the `sandbox-fake` cost-skip in
 * {@link readWorkerEcon} is enforced regardless of what this returns, so a test can inject a store whose
 * `getAgentCostRollup` returns NON-null token data and still assert the sandbox arm forces `cost=null`.
 */
export type OpenWorkerEcon = (projectId: ProjectId) => WorkerEconStore & { close: () => void };

/** The production econ opener: the real dispatch store, structurally typed as a {@link WorkerEconStore}. */
const openDispatchEcon: OpenWorkerEcon = (projectId) =>
  openDispatchStore(projectId) as ReturnType<typeof openDispatchStore> & WorkerEconStore;

/**
 * Read PR B's per-agent cost + tool-usage rollups via OPTIONAL CHAINING against the dispatch store cast to
 * {@link WorkerEconStore}. On `dev` WITHOUT B the methods are absent ⇒ both reads return `null`. Never
 * throws: a store-open failure or a missing method degrades to `null`.
 *
 * `fidelity` ENFORCES the N/A-in-sandbox rule IN CODE — parity with the orchestration driver's
 * {@link readAgentEcon}: a `sandbox-fake` run spends no real tokens, so the cost read is SKIPPED entirely
 * and `cost` is forced to `null` (token-economy GUARANTEED `null`, not a byproduct of B's store being
 * absent). The tool rollup IS read in both arms (tool calls are observable in the sandbox too).
 *
 * A store-open / read FAILURE is LOGGED, not silently swallowed (Principle 9 — no silent green): a
 * persistent econ-read failure degrades the whole corpus to N/A invisibly otherwise. We still degrade to
 * `null` so the run is graded, but the error is surfaced on stderr.
 */
export function readWorkerEcon(
  projectId: ProjectId,
  agentId: string,
  fidelity: ProofFidelity,
  openEcon: OpenWorkerEcon = openDispatchEcon,
): { cost: AgentCostRollup | null; tool: AgentToolUsage | null } {
  let store: (WorkerEconStore & { close: () => void }) | undefined;
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
      `[co worker-bench] econ read failed for agent '${agentId}' in project '${projectId}': ${errorMessage(error)}`,
    );
    return { cost: null, tool: null };
  } finally {
    store?.close();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, turn: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`runWorkerBenchmark: turn ${turn} exceeded the per-turn timeout (${ms}ms).`),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
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

const noop = (): void => {};
