/**
 * The GATED LIVE multi-level ORCHESTRATION benchmark (the v1 centerpiece of the `CO_LIVE_E2E` live suite;
 * see `docs/orchestration-benchmark.md`). When the opt-in {@link CO_LIVE_E2E_ENV}=1 is set AND a real
 * provider binary is installed/authenticated AND node-pty is built, it provisions a root COORDINATOR over
 * a real node-pty, composes the REAL {@link serveConductor} daemon with the real host-live seams (real
 * pty + socket-bridge transport + real timers), and lets a REAL provider self-drive the full
 * coordinator → lead → 2-implementers → merge-up chain for the calc-lib scenario — automating only the
 * HUMAN operator gates (spec-lock + review-PASS) between ticks. It then grades the merged integration
 * branch by EXECUTING it against the scenario's hidden oracle and hard-asserts the scorecard.
 *
 * Otherwise (the sandbox / CI case) every live case SKIPS LOUDLY with the missing prerequisite named in
 * its title — it never fails and never mock-passes (Principle 9). The always-on guard below proves the
 * gate is OFF without the opt-in, and the deterministic sandbox regression lives in
 * `orchestration-benchmark.test.ts` (which runs under `pnpm test`).
 *
 * Because the LIVE automation resolves the host-live seam bundle lazily, collecting this file under a
 * default `pnpm test` pulls in NO node-pty / host-only graph: the node-pty probe runs only when the
 * opt-in is present (short-circuited otherwise), and all real I/O lives inside the gated cases.
 *
 * COST: a live run spends real Anthropic + OpenAI tokens (it drives MANY real model turns across the
 * whole chain). It is gated OFF by default and run only via `pnpm test:live` on an authenticated host.
 *
 * ── HONESTY NOTE (Principle 9) ────────────────────────────────────────────────────────────────────────
 * The host-live DRIVE of the full multi-level chain by a real binary is UNPROVEN — no real provider has
 * yet self-driven coordinator → lead → 2-implementers → merge-up end to end. This test is the harness an
 * operator runs to GENERATE that evidence; a green run is evidence the operator reviews (SH-1/RL-1/RL-3/
 * RL-4 ladder), not an auto-checkbox. The skip-gate + the derived-fidelity stamp guarantee it can never
 * mock-pass: a fake host can never be `host-live`, and the chain must actually complete + the oracle must
 * execute the merged artifact for `pass` to be true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CO_LIVE_E2E_ENV,
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  NodePtyHost,
  OPERATOR,
  buildCoreRegistry,
  calcLibScenario,
  defaultGitExec,
  defaultGitRawReader,
  invokeTool,
  isLiveE2EEnabled,
  openConfigStore,
  openDispatchStore,
  openMailStore,
  openPlanStore,
  openRegistry,
  openReviewStore,
  openRosterStore,
  openSpecStore,
  openWorktreeStore,
  renderScorecard,
  reviewRequestEnvelope,
  reviewReviewerKey,
  startCoordinatorSession,
  toJsonl,
  type DeliveredMail,
  type OrchestrationScenario,
  type ProjectId,
  type ProviderMode,
  type ReviewContext,
  type ReviewContextResolved,
} from '@co/core';
import { openContextStores } from '../context.js';
import { defaultServeCoMcpPaths, serveConductor, type IntervalScheduler } from './host.js';
import { resolveHostLiveSeams } from './host-live-seams.js';
import { resolveReviewContext } from './review-context.js';
import { OperatorIpcServer } from '../operator-ipc/server.js';
import { OperatorIpcClient } from '../operator-ipc/client.js';
import type { ConductorControlSurface } from './host.js';
import type { DaemonBackedAgentRouter } from './agent-router.js';
import {
  ORCH_BENCH_DEFAULTS,
  ORCH_BENCH_TASK_ID,
  runOrchestrationBenchmark,
  type AgentTurnSample,
  type AutomationDriveResult,
  type OrchestrationAutomation,
} from './orchestration-benchmark.js';

// The CO monorepo root — for the Principle-12 pristine guard (the run must not touch the repo tree).
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function optInSkipReason(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return isLiveE2EEnabled(env)
    ? undefined
    : `set ${CO_LIVE_E2E_ENV}=1 to run the live orchestration benchmark`;
}

function commandSkipReason(command: string): string | undefined {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.error !== undefined ? `command '${command}' is not available on PATH` : undefined;
}

async function probeNodePty(): Promise<string | undefined> {
  try {
    await NodePtyHost.create();
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `node-pty native addon is not built/available: ${message}`;
  }
}

const suffix = (reason: string | undefined): string =>
  reason === undefined ? '' : ` [skipped: ${reason}]`;

const optInSkip = optInSkipReason();
// Only probe node-pty (loads the native addon) when actually opted in — keeps default `pnpm test` free
// of the host-only graph (the `??` short-circuits before `await probeNodePty()` runs).
const nodePtySkip = optInSkip ?? (await probeNodePty());
const claudeSkip = optInSkip ?? commandSkipReason('claude') ?? nodePtySkip;
const codexSkip = optInSkip ?? commandSkipReason('codex') ?? nodePtySkip;

describe('orchestration benchmark — skip gate (hermetic, always runs)', () => {
  it(`is OFF without ${CO_LIVE_E2E_ENV} — the live benchmark below SKIPS`, () => {
    expect(isLiveE2EEnabled({})).toBe(false);
    expect(isLiveE2EEnabled({ [CO_LIVE_E2E_ENV]: '1' })).toBe(true);
  });

  it('names the missing opt-in as the skip reason instead of failing', () => {
    expect(optInSkipReason({})).toMatch(CO_LIVE_E2E_ENV);
    expect(optInSkipReason({ [CO_LIVE_E2E_ENV]: '1' })).toBeUndefined();
  });
});

// ── Live setup ───────────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  // CO_BENCH_KEEP=1 preserves the throwaway dirs (and prints them) for post-mortem debugging.
  if (process.env['CO_BENCH_KEEP'] === '1') {
    if (dataDirs.length > 0 || repoDirs.length > 0) {
      console.error(
        `[orchestration-benchmark] kept dirs: data=${dataDirs.join(',')} repo=${repoDirs.join(',')}`,
      );
    }
    return;
  }
  for (const dir of [...dataDirs, ...repoDirs]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── Non-vacuous hermetic regression for maybePassReviews (always runs; no node-pty, no provider) ───────
//
// Proves the live arm's `maybePassReviews` WIRING actually drives a pending review to a recorded PASS via
// the REAL operator-IPC reviewContext + reply path — the exact gate a live chain hangs on if this is the
// no-op stub it used to be (`void ipc; void projectId`). It builds a real throwaway git repo + worktree so
// `resolveReviewContext` yields a `patch` diff (the server requires it), locks a spec so the request has
// criteria, seeds one `review_request`, stands up a real OperatorIpcServer (its `reviewContext` is the
// production resolver), then calls `maybePassReviews` and asserts the review store recorded a PASS verdict.
// WITHOUT the implementation (the old no-op) NO verdict is recorded and the assertion fails — non-vacuous.
describe('maybePassReviews — drives a pending review to PASS over the real operator-IPC path (hermetic)', () => {
  it('records a PASS verdict for the pending review_request (fails if maybePassReviews is a no-op)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'co-ob-mpr-data-'));
    dataDirs.push(dataDir);
    process.env.CO_DATA_DIR = dataDir;

    // A real git repo: target `main` + a divergent `feat` branch + a checked-out worktree for `feat`, so
    // `git diff main...feat` is a real patch (the server's evidence-ready gate requires diff.kind==='patch').
    const repo = mkdtempSync(join(tmpdir(), 'co-ob-mpr-repo-'));
    repoDirs.push(repo);
    const target = 'main';
    const branch = 'feat';
    defaultGitExec(repo, ['init', '-b', target]);
    defaultGitExec(repo, ['config', 'user.email', 'mpr@example.com']);
    defaultGitExec(repo, ['config', 'user.name', 'MPR']);
    defaultGitExec(repo, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repo, 'README.md'), 'base\n');
    defaultGitExec(repo, ['add', '.']);
    defaultGitExec(repo, [
      'commit',
      '-m',
      'chore: base',
      '-m',
      'Signed-off-by: MPR <mpr@example.com>',
    ]);
    defaultGitExec(repo, ['branch', branch]);
    const wtPath = join(repo, 'wt-feat');
    defaultGitExec(repo, ['worktree', 'add', wtPath, branch]);
    writeFileSync(join(wtPath, 'change.txt'), 'changed\n');
    defaultGitExec(wtPath, ['add', '.']);
    defaultGitExec(wtPath, [
      'commit',
      '-m',
      'feat: change',
      '-m',
      'Signed-off-by: MPR <mpr@example.com>',
    ]);

    const registry = openRegistry();
    let projectId: ProjectId;
    try {
      projectId = registry.register(repo);
    } finally {
      registry.close();
    }

    const taskId = 'mpr-task';
    const reviewId = 'rev-mpr-1';
    const specRef = `spec:${taskId}#locked`;

    // Lock a spec so the review request carries criteria the resolver + server validate.
    const specs = openSpecStore(projectId);
    try {
      specs.recordDraft({
        taskId,
        title: 'maybePassReviews regression',
        goal: 'maybePassReviews regression',
        criteria: [{ text: 'the change is correct', verify: 'pnpm test' }],
        body: 'A hermetic fixture spec for the maybePassReviews PASS-path regression.',
        actor: 'lead-mpr',
      });
      specs.recordLock(taskId, OPERATOR);
    } finally {
      specs.close();
    }

    // Record the reviewed branch's worktree so `resolveReviewContext` finds the diff sandbox. The baseSha
    // is read with the raw git READER (defaultGitExec returns void — it is a side-effecting GitExec).
    const baseSha = (defaultGitRawReader(repo, ['rev-parse', target]) ?? '').trim();
    const worktrees = openWorktreeStore(projectId);
    try {
      worktrees.recordWorktree({
        branch,
        baseRef: target,
        baseSha,
        path: wtPath,
        parent: 'lead-mpr',
        agent: 'impl-mpr',
        role: 'implementer',
      });
    } finally {
      worktrees.close();
    }

    // Seed ONE pending review_request to @operator (the gate maybePassReviews must PASS), recording the
    // durable review.requested with a criteria spec-ref (so the server's criteria check passes).
    const mailStore = openMailStore(projectId);
    try {
      mailStore.requestHumanReview(
        reviewRequestEnvelope({
          from: 'lead-mpr',
          subject: `review requested: '${branch}' into '${target}'`,
          body: `review ${reviewId}`,
          idempotencyKey: `review-request:${reviewId}`,
        }),
        {
          reviewId,
          target,
          branch,
          scope: 'worker_merge',
          reviewerKind: 'human',
          requestedBy: 'lead-mpr',
          specRefKind: 'criteria',
          specRefRef: specRef,
        },
      );
    } finally {
      mailStore.close();
    }

    // Stand up the REAL operator-IPC server whose reviewContext is the production resolver (verbatim from
    // the sandbox operatorPassViaIpc control surface), plus a client the helper drives.
    const sockDir = mkdtempSync(join(tmpdir(), 'co-ob-mpr-sock-'));
    dataDirs.push(sockDir);
    const socketPath = join(sockDir, 'control.sock');
    const control: ConductorControlSurface = {
      router: {} as DaemonBackedAgentRouter,
      observe: () => {
        throw new Error('mpr: observe is not used by the review path');
      },
      transcriptTail: (agentId) => ({ agentId, offset: 0, tail: '' }),
      onTranscript: () => () => {},
      reviewContext: (rid) =>
        resolveReviewContext(
          {
            openReviews: () => openReviewStore(projectId),
            openSpecs: () => openSpecStore(projectId),
            openWorktrees: () => openWorktreeStore(projectId),
            gitReader: defaultGitRawReader,
          },
          rid,
        ),
      deleteAgent: () => Promise.reject(new Error('mpr: deleteAgent is not used here')),
      listArchive: () => Promise.resolve([]),
      restoreArchive: () => Promise.reject(new Error('mpr: restoreArchive is not used here')),
      purgeArchive: () => Promise.reject(new Error('mpr: purgeArchive is not used here')),
    };
    const server = new OperatorIpcServer({ control, projectId, socketPath });
    await server.start();
    const ipc = new OperatorIpcClient({ projectId, socketPath });
    try {
      // PRE: no verdict recorded yet (the gate is open).
      const before = openReviewStore(projectId);
      try {
        expect(before.getVerdict(target, branch)?.verdict).toBeUndefined();
      } finally {
        before.close();
      }

      // THE WIRING UNDER TEST: drive the pending review to PASS.
      await maybePassReviews(ipc, projectId);

      // POST: the review store now carries a PASS verdict for (target, branch) — the gate held + passed.
      const after = openReviewStore(projectId);
      try {
        expect(after.getVerdict(target, branch)?.verdict).toBe('PASS');
      } finally {
        after.close();
      }

      // And the request mail is now resolved (so a re-run is idempotent — it PASSes nothing new).
      const inboxAfter = openMailStore(projectId);
      try {
        const req = inboxAfter
          .inbox(OPERATOR)
          .find((m) => m.idempotencyKey === `review-request:${reviewId}`);
        expect(req?.resolved).toBe(true);
      } finally {
        inboxAfter.close();
      }
    } finally {
      await ipc.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});

// ── Always-on hermetic test for the maybePassReviews failStreak / wedge-logging (no node-pty, no IPC) ───
//
// Proves the per-reviewId CONSECUTIVE-failure accounting + the wedge log (Principle 9 — log, don't swallow):
// a PASS attempt that keeps failing tick after tick is a WEDGED gate, and after {@link REVIEW_PASS_FAIL_LOG_AFTER}
// failures running it MUST be logged so the operator sees the stall instead of an invisibly-hung chain. A
// later successful PASS CLEARS the streak. Uses a STUB ipc (the real wire is exercised by the PASS-path test
// above) so the failure branch is reachable hermetically: `reviewContext` throws in fail-mode, resolves in
// pass-mode. WITHOUT the streak accounting (a bare swallow) NO console.error fires and the streak never
// clears — the assertions below fail, so the test is non-vacuous.
describe('maybePassReviews — per-reviewId failStreak + wedge-logging (hermetic, always runs)', () => {
  // A controllable stub typed as an OperatorIpcClient: fail-mode throws from reviewContext (so the PASS
  // attempt fails + the streak climbs); pass-mode resolves a context + a no-op reply (so the streak clears).
  function makeStubIpc(): {
    ipc: OperatorIpcClient;
    setMode: (mode: 'fail' | 'pass') => void;
    replyCount: () => number;
  } {
    let mode: 'fail' | 'pass' = 'fail';
    let replies = 0;
    const resolved = (reviewId: string): ReviewContextResolved => ({
      kind: 'resolved',
      reviewId,
      evidenceFingerprint: `sha256:${reviewId}`,
      branch: 'feat',
      target: 'main',
      scope: 'worker_merge',
      diff: { kind: 'patch', patch: 'diff --git a/x b/x\n' },
      criteria: { kind: 'no-locked-spec' },
    });
    const ipc = {
      reviewContext: (reviewId: string): Promise<ReviewContext> => {
        if (mode === 'fail') {
          return Promise.reject(new Error(`stub: reviewContext '${reviewId}' is wedged`));
        }
        return Promise.resolve(resolved(reviewId));
      },
      reply: (): Promise<DeliveredMail> => {
        replies += 1;
        return Promise.resolve({} as DeliveredMail);
      },
    } as unknown as OperatorIpcClient;
    return { ipc, setMode: (m) => (mode = m), replyCount: () => replies };
  }

  // Seed ONE pending review_request to @operator (the gate maybePassReviews tries to PASS each tick) without
  // any git/diff/spec scaffolding — the stub ipc never reaches the resolver, so only the mail need exist.
  function seedPendingReview(projectId: ProjectId, reviewId: string): void {
    const mailStore = openMailStore(projectId);
    try {
      mailStore.requestHumanReview(
        reviewRequestEnvelope({
          from: 'lead-wedge',
          subject: `review requested: 'feat' into 'main'`,
          body: `review ${reviewId}`,
          idempotencyKey: `review-request:${reviewId}`,
        }),
        {
          reviewId,
          target: 'main',
          branch: 'feat',
          scope: 'worker_merge',
          reviewerKind: 'human',
          requestedBy: 'lead-wedge',
          specRefKind: 'criteria',
          specRefRef: `spec:wedge#locked`,
        },
      );
    } finally {
      mailStore.close();
    }
  }

  it('increments the per-reviewId streak across ticks, LOGS once the streak hits the threshold, and a PASS clears it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'co-ob-wedge-data-'));
    dataDirs.push(dataDir);
    process.env.CO_DATA_DIR = dataDir;

    const registry = openRegistry();
    let projectId: ProjectId;
    try {
      projectId = registry.register(join(dataDir, 'repo'));
    } finally {
      registry.close();
    }

    const reviewId = 'rev-wedge-1';
    seedPendingReview(projectId, reviewId);

    const { ipc, setMode, replyCount } = makeStubIpc();
    const failStreak = new Map<string, number>();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // FAIL-MODE: the gate keeps failing its PASS attempt. The streak climbs one per tick, and the wedge
      // log stays SILENT until the streak reaches REVIEW_PASS_FAIL_LOG_AFTER (5) — never before.
      for (let tick = 1; tick <= REVIEW_PASS_FAIL_LOG_AFTER; tick++) {
        await maybePassReviews(ipc, projectId, failStreak);
        expect(failStreak.get(reviewId)).toBe(tick);
        // Below the threshold: no wedge log yet (a transient miss must not spam the operator).
        if (tick < REVIEW_PASS_FAIL_LOG_AFTER) expect(errorSpy).not.toHaveBeenCalled();
      }
      // At the threshold: the wedge is logged EXACTLY once, naming the wedged reviewId.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(reviewId);
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/wedged/u);
      // No PASS reply was ever submitted while the gate was wedged.
      expect(replyCount()).toBe(0);

      // PASS-MODE: the gate now resolves + the reply lands. The streak is CLEARED (deleted), and the reply
      // was submitted — the chain un-wedges.
      setMode('pass');
      await maybePassReviews(ipc, projectId, failStreak);
      expect(failStreak.has(reviewId)).toBe(false);
      expect(replyCount()).toBe(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does NOT log a transient single failure (streak below threshold) — only a PERSISTENT wedge', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'co-ob-wedge2-data-'));
    dataDirs.push(dataDir);
    process.env.CO_DATA_DIR = dataDir;

    const registry = openRegistry();
    let projectId: ProjectId;
    try {
      projectId = registry.register(join(dataDir, 'repo'));
    } finally {
      registry.close();
    }
    const reviewId = 'rev-transient-1';
    seedPendingReview(projectId, reviewId);

    const { ipc } = makeStubIpc(); // stays in fail-mode
    const failStreak = new Map<string, number>();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A single failed tick is a transient miss (it retries next tick) — it must NOT log.
      await maybePassReviews(ipc, projectId, failStreak);
      expect(failStreak.get(reviewId)).toBe(1);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

interface LiveRun {
  readonly projectId: ProjectId;
  readonly repo: string;
  readonly integrationBranch: string;
}

/**
 * A throwaway project: a SEPARATE git repo (never the CO tree) parked on a detached HEAD so the
 * integration branch is checked out in no worktree (the coordinator's slung worktree can `git checkout`
 * it for the gated lead→integration merge), plus a throwaway CO_DATA_DIR (Principle 12).
 */
function setupLiveRun(): LiveRun {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-ob-data-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;

  const repo = mkdtempSync(join(tmpdir(), 'co-ob-repo-'));
  repoDirs.push(repo);
  const integrationBranch = 'main';
  defaultGitExec(repo, ['init', '-b', integrationBranch]);
  defaultGitExec(repo, ['config', 'user.email', 'orch-bench@example.com']);
  defaultGitExec(repo, ['config', 'user.name', 'Orch Bench']);
  defaultGitExec(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  defaultGitExec(repo, ['add', '.']);
  defaultGitExec(repo, [
    'commit',
    '-m',
    'chore: init orch-bench repo',
    '-m',
    'Signed-off-by: Orch Bench <orch-bench@example.com>',
  ]);
  defaultGitExec(repo, ['checkout', '--detach']);

  const registry = openRegistry();
  let projectId: ProjectId;
  try {
    projectId = registry.register(repo);
  } finally {
    registry.close();
  }
  return { projectId, repo, integrationBranch };
}

/**
 * Build the LIVE {@link OrchestrationAutomation}: provision the root coordinator, compose the REAL
 * {@link serveConductor} daemon over the host-live seams (real node-pty + socket-bridge transport + real
 * timers) with a MANUAL scheduler so this test steps ticks deterministically, then drive ticks until the
 * chain completes (`task.completed`) or a budget is hit — automating ONLY the human operator gates
 * (spec-lock + review-PASS) between ticks via the operator tool path / operator-IPC, exactly as the
 * desktop operator would. Fidelity is DERIVED from the resolved pty host (a fake can never be host-live).
 */
async function makeLiveAutomation(
  provider: 'claude' | 'codex',
  run: LiveRun,
  scenario: OrchestrationScenario,
): Promise<OrchestrationAutomation> {
  // Resolve the shared host-live seam bundle (real node-pty + socket bridge transport + real timers). The
  // pty it returns is what the driver derives fidelity from — a non-NodePtyHost would fail loud upstream.
  const seams = await resolveHostLiveSeams(provider);

  // A manual scheduler captures the runner's tick callback so this test steps it one tick at a time.
  let tickCb: (() => void) | null = null;
  const manual: IntervalScheduler = {
    setInterval: (cb) => {
      tickCb = cb;
      return {};
    },
    clearInterval: () => {
      tickCb = null;
    },
  };

  // A throwaway operator-IPC socket so the human review-PASS gate can be played over the production wire.
  const sockDir = mkdtempSync(join(tmpdir(), 'co-ob-sock-'));
  dataDirs.push(sockDir);
  const socketPath = join(sockDir, 'control.sock');

  const runner = await serveConductor({
    projectId: run.projectId,
    coMcpPaths: defaultServeCoMcpPaths(),
    pty: seams.pty,
    now: seams.now,
    quietWindow: seams.quietWindow,
    scheduler: manual,
    operatorIpc: { socketPath },
    // Large interval (we step manually); autoStart arms the cadence + runs recover().
    intervalMs: 3_600_000,
  });

  return {
    pty: seams.pty,
    teardown: async () => {
      await runner.stop();
    },
    drive: async (input): Promise<AutomationDriveResult> => {
      const reg = buildCoreRegistry();
      // Pin the gated merges to a HUMAN review so this test plays the operator PASS via operator-IPC.
      const cfg = openConfigStore();
      try {
        cfg.setProjectOverride(input.projectId, reviewReviewerKey('worker_merge'), 'human');
        cfg.setProjectOverride(input.projectId, reviewReviewerKey('phase_merge'), 'human');
      } finally {
        cfg.close();
      }

      // Provision + register the root coordinator + seed its kickoff (the daemon cold-starts it tick-0).
      startCoordinatorSession({
        projectId: input.projectId,
        repoCwd: input.repoCwd,
        prompt: scenario.rootBody({ nonce: input.nonce, operator: OPERATOR }),
        base: input.integrationBranch,
      });

      const ipc = new OperatorIpcClient({ projectId: input.projectId, socketPath });

      const deadline = seams.now() + input.wallClockBudgetMs;
      // Per-agent wall-clock: the real time between when an agent first appears in the roster (it has been
      // provisioned + is taking turns) and the end of the drive. The daemon owns the turns themselves, so
      // turn COUNTS are read from the durable cost read-model below (one cost.recorded per turn) rather
      // than guessed — both are real measurements, not the `agentTurns:{}` silent zero this replaces.
      const firstSeenMs = new Map<string, number>();
      // Per-reviewId consecutive PASS-attempt failure counter, owned by the drive loop and threaded into
      // maybePassReviews each tick. A transient miss is fine (it retries next tick); a PERSISTENT failure
      // (the same gate failing tick after tick) is LOGGED so the operator sees a wedged review instead of a
      // silently-stalled chain (Principle 9 — no silent green).
      const reviewFailStreak = new Map<string, number>();
      let completed = false;
      let ticks = 0;
      try {
        for (; ticks < input.maxTicks; ticks++) {
          if (seams.now() >= deadline) break;
          // Step one daemon tick (the runner's captured callback fires `beat()`), then settle.
          tickCb?.();
          await settle();

          // Record the first wall time each non-operator agent is observed in the roster (its session
          // is live). Cheap + monotonic — the earliest tick an agent exists bounds its active window.
          for (const agentId of rosterAgentIds(input.projectId)) {
            if (!firstSeenMs.has(agentId)) firstSeenMs.set(agentId, seams.now());
          }

          // Between ticks, play the human operator gates: lock the spec once drafted, and PASS any
          // pending review_request. These are the ONLY hand-driven inputs — all coding/merging is the
          // live agents' own work through the co tools.
          await maybeLockSpec(reg, input.projectId, input.repoCwd);
          await maybePassReviews(ipc, input.projectId, reviewFailStreak);

          completed = planCompleted(input.projectId);
          if (completed) break;
        }
      } finally {
        await ipc.close().catch(() => undefined);
      }

      const driveEndMs = seams.now();
      return {
        stopReason: completed
          ? 'task-complete'
          : driveEndMs >= deadline
            ? 'wall-budget'
            : 'turn-budget',
        // REAL per-agent samples: turns from the durable cost rollup (one observation per turn), wall from
        // the observed active window. Replaces the `agentTurns:{}` silent zero — an agent that took turns
        // now reports a non-zero turn count and a measured wall-clock.
        agentTurns: measureAgentTurns(input.projectId, firstSeenMs, driveEndMs),
        integrationBranch: input.integrationBranch,
      };
    },
  };
}

/** Settle the event loop briefly so an in-flight async tick can complete before the next step. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** Lock the spec once the coordinator has drafted it (the operator's spec-lock gate). Idempotent. */
async function maybeLockSpec(
  reg: ReturnType<typeof buildCoreRegistry>,
  projectId: ProjectId,
  repoCwd: string,
): Promise<void> {
  const ctx = openContextStores({ agent: OPERATOR, projectId, cwd: repoCwd });
  try {
    await invokeTool(reg, ctx.ctx, 'co_spec_lock', { task_id: ORCH_BENCH_TASK_ID });
  } catch {
    // Not yet draftable / already locked — both are expected on most ticks. Fail-soft (the gate retries).
  } finally {
    ctx.close();
  }
}

/**
 * PASS every pending `review_request` via the REAL operator-IPC path (the desktop Review-view flow), so a
 * real chain does not hang at the first review gate. Ports the sandbox `operatorPassViaIpc` (in
 * `orchestration-benchmark.test.ts`) onto the live arm's already-running `serveConductor` IPC surface:
 * for each UNRESOLVED `review_request` in @operator's inbox, parse its `reviewId` from the durable
 * `review-request:<reviewId>` idempotency key, fetch the review context over the production wire (diff +
 * criteria + the evidence fingerprint the verdict must echo), and submit a `review_response` PASS reply
 * carrying that fingerprint. Idempotent: a resolved item is skipped, so re-running this each tick PASSes
 * only newly-arrived gates. Fail-soft on a single review (a transient `reviewContext` miss / fingerprint
 * race is retried next tick) — the chain must never wedge because one PASS attempt raced the gate.
 *
 * `failStreak` (optional; threaded by the drive loop) counts CONSECUTIVE PASS-attempt failures per
 * reviewId: a transient miss is fine (it retries), but a PERSISTENT failure (the same gate failing for
 * {@link REVIEW_PASS_FAIL_LOG_AFTER} ticks running) is LOGGED so the operator sees the wedge instead of a
 * silently-stalled chain (Principle 9 — log, don't swallow). A successful PASS clears the streak.
 */
async function maybePassReviews(
  ipc: OperatorIpcClient,
  projectId: ProjectId,
  failStreak?: Map<string, number>,
): Promise<void> {
  for (const req of pendingReviewRequests(projectId)) {
    const reviewId = reviewIdFromMail(req);
    if (reviewId == null) continue;
    try {
      const context = await ipc.reviewContext(reviewId);
      if (context.kind !== 'resolved') continue; // not yet resolvable — retry next tick
      await ipc.reply(
        { seq: req.seq, recipient: OPERATOR },
        {
          type: MAIL_REVIEW_RESPONSE,
          reviewVerdict: 'PASS',
          reviewContextFingerprint: context.evidenceFingerprint,
          subject: `PASS: review ${reviewId}`,
          body: 'Reviewed the diff + locked acceptance criteria. PASS.',
        },
      );
      failStreak?.delete(reviewId); // a PASS landed — reset the per-gate failure streak.
    } catch (error) {
      // A transient reviewContext/reply race (e.g. the request landed mid-tick) is retried next tick. But
      // count it: a gate that fails the PASS attempt for many ticks running is WEDGED — log it loudly so an
      // operator sees a stalled review instead of an invisibly-hung chain (Principle 9 — never silently
      // dropped). The chain still does not throw here; the gate simply re-surfaces next tick.
      const streak = (failStreak?.get(reviewId) ?? 0) + 1;
      failStreak?.set(reviewId, streak);
      if (failStreak != null && streak >= REVIEW_PASS_FAIL_LOG_AFTER) {
        console.error(
          `[co orch-bench] review '${reviewId}' has failed its operator PASS attempt ${streak} ticks ` +
            `running — the gate may be wedged: ${errorMessage(error)}`,
        );
      }
    }
  }
}

/** Log a persistent review PASS-attempt failure after this many CONSECUTIVE failed ticks (a wedge signal). */
const REVIEW_PASS_FAIL_LOG_AFTER = 5;

/** Normalize an unknown thrown value to a string message for logging. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The UNRESOLVED `review_request` mails in @operator's inbox — the gates awaiting an operator verdict. A
 * resolved item (already PASSed/ISSUES'd) is excluded so {@link maybePassReviews} is idempotent per tick.
 */
function pendingReviewRequests(projectId: ProjectId): readonly DeliveredMail[] {
  const mail = openMailStore(projectId);
  try {
    return mail
      .inbox(OPERATOR)
      .filter((m) => m.type === MAIL_REVIEW_REQUEST && m.resolved !== true && m.retracted !== true);
  } finally {
    mail.close();
  }
}

/** Parse the `reviewId` from a `review_request` mail's durable `review-request:<reviewId>` idempotency key. */
function reviewIdFromMail(mail: DeliveredMail): string | null {
  const key = mail.idempotencyKey;
  if (key == null || !key.startsWith('review-request:')) return null;
  const reviewId = key.slice('review-request:'.length);
  return reviewId.length > 0 ? reviewId : null;
}

function planCompleted(projectId: ProjectId): boolean {
  const store = openPlanStore(projectId);
  try {
    return store.getPlan(ORCH_BENCH_TASK_ID)?.completedTs != null;
  } finally {
    store.close();
  }
}

/** Every non-operator agent currently registered in the roster (the live agent set this tick). */
function rosterAgentIds(projectId: ProjectId): readonly string[] {
  const roster = openRosterStore(projectId);
  try {
    return roster
      .listAgents()
      .map((a) => a.agentId)
      .filter((id) => id !== OPERATOR);
  } finally {
    roster.close();
  }
}

/**
 * Measure REAL per-agent turn/wall samples for the live arm (replacing the `agentTurns:{}` silent zero):
 *   - turns: the agent's count of durable `cost.recorded` observations (the daemon files one per turn), so
 *     an agent that actually took turns reports a non-zero count straight from the objective cost log.
 *   - wall: the active window `driveEndMs − firstSeenMs[agent]` (when the agent first appeared in the
 *     roster until the drive ended) — a real measurement, not a guess.
 * An agent with no recorded cost yet still appears with `turnsUsed: 0` + its measured wall (it was seen).
 */
function measureAgentTurns(
  projectId: ProjectId,
  firstSeenMs: ReadonlyMap<string, number>,
  driveEndMs: number,
): Record<string, AgentTurnSample> {
  const dispatch = openDispatchStore(projectId);
  try {
    const samples: Record<string, AgentTurnSample> = {};
    for (const [agentId, seenMs] of firstSeenMs) {
      const rollup = dispatch.getRollup('agent', agentId);
      samples[agentId] = {
        turnsUsed: rollup?.observations ?? 0,
        wallClockMs: Math.max(0, driveEndMs - seenMs),
      };
    }
    return samples;
  } finally {
    dispatch.close();
  }
}

// Read the SAME budgets the driver uses (shared defaults, so an operator override of CO_BENCH_* keeps the
// test's outer timeout in sync with what the run actually does).
function benchEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw == null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
const benchWallClockMs = benchEnvInt('CO_BENCH_WALLCLOCK_MS', ORCH_BENCH_DEFAULTS.wallClockMs);
const benchPerStepMs = benchEnvInt('CO_BENCH_PER_STEP_MS', ORCH_BENCH_DEFAULTS.perStepMs);
// The per-test (per-provider) timeout must exceed the in-driver wall-clock budget plus slack for one
// over-running final step.
const LIVE_TIMEOUT_MS = benchWallClockMs + benchPerStepMs + 180_000;

// Provider-pinning mode → the roster a run pins. claude-only / codex-only run the WHOLE chain on one
// provider (the deterministic, reproducible per-provider corpus); `mixed` is an operator opt-in.
const PROVIDER_MODES: ReadonlyArray<{ provider: 'claude' | 'codex'; mode: ProviderMode }> = [
  { provider: 'claude', mode: 'claude-only' },
  { provider: 'codex', mode: 'codex-only' },
];

// Optional single-provider selector for targeted operator runs / debugging, e.g.
// `CO_BENCH_ONLY=codex CO_HOST_PROOF_TRACE=1 pnpm test:live`.
const onlyProvider = process.env['CO_BENCH_ONLY'];
// Opt-in: persist the per-run JSONL corpus to this dir (else a throwaway tmp dir, discarded after).
const corpusDir = process.env['CO_BENCH_CORPUS_DIR'];

describe(`LIVE orchestration benchmark [local only; skips loudly unless ${CO_LIVE_E2E_ENV}=1 + provider installed + node-pty built]`, () => {
  for (const { provider, mode } of PROVIDER_MODES) {
    const selectorSkip =
      onlyProvider != null && onlyProvider !== provider
        ? `CO_BENCH_ONLY=${onlyProvider} selected`
        : undefined;
    const skip = selectorSkip ?? (provider === 'claude' ? claudeSkip : codexSkip);
    it.skipIf(skip !== undefined)(
      `drives the FULL coordinator → lead → 2-implementers → merge-up chain on a real ${provider} (${mode}) and grades the merged artifact${suffix(skip)}`,
      async () => {
        const run = setupLiveRun();

        // Principle 12: the agent's cwd and all program-data are throwaway tmp dirs, NEVER the CO repo.
        expect(run.repo.startsWith(REPO_ROOT)).toBe(false);
        expect((process.env['CO_DATA_DIR'] ?? '').startsWith(REPO_ROOT)).toBe(false);

        const scenario = calcLibScenario();
        const nonce = `ob-${provider}-${randomUUID()}`;
        const automation = await makeLiveAutomation(provider, run, scenario);

        const scorecard = await runOrchestrationBenchmark({
          projectId: run.projectId,
          scenario,
          nonce,
          providerMode: mode,
          repoCwd: run.repo,
          integrationBranch: run.integrationBranch,
          automation,
        });

        // Print the per-provider scorecard (the operator reviews this, not an auto-checkbox).
        console.error(renderScorecard(scorecard));

        // Persist the JSONL corpus (opt-in dir, else a throwaway).
        const outDir = corpusDir ?? mkdtempSync(join(tmpdir(), 'co-ob-corpus-'));
        if (corpusDir == null) dataDirs.push(outDir);
        writeFileSync(join(outDir, `${scorecard.runId}.jsonl`), toJsonl(scorecard));

        // PLUMBING (hard): a real node-pty host ⇒ host-live fidelity (Principle 2; never the flag).
        expect(scorecard.fidelity).toBe('host-live');

        // The whole chain landed and the MERGED artifact, EXECUTED, is correct (the objective oracle).
        expect(scorecard.completed).toBe(true);
        expect(scorecard.artifact.correct).toBe(true);
        expect(scorecard.pass).toBe(true);

        // BOTH implementer branches merged up (RL-4 / SH-1 — the multi-level merge-up landed).
        expect(scorecard.implementerBranchesMergedUp).toBeGreaterThanOrEqual(2);

        // Principle 12 — the CO repo tree is untouched (the run lives entirely in throwaway dirs).
        expect(existsSync(join(REPO_ROOT, '.co', 'orchestration-benchmark-task'))).toBe(false);
        // The throwaway repo carries the merged artifact; the CO repo carries nothing from this run.
        expect(run.repo.startsWith(REPO_ROOT)).toBe(false);
      },
      LIVE_TIMEOUT_MS,
    );
  }
});
