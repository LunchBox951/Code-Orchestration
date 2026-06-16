/**
 * SH-1 DRY-RUN HARNESS (Stage 13 · Stream H) — a deterministic sandbox rehearsal of the orchestration
 * loop driving a toy multi-phase change end to end: spec-lock → worktree → finish → review-gate →
 * gated-merge, over `FakePty` with a deterministic injected clock and scripted MCP-client "agents".
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * CRITICAL — THIS TEST PROVES THE LOOP **PLUMBING** ONLY.
 *
 * Over `FakePty` the agents' "work" is **scripted bytes / scripted MCP tool-calls**, not a real provider
 * doing real work (`hostLiveTransportRequired` in `host.ts` throws by design for the real transport).
 * It is **NOT** the `SH-1` acceptance bar — `SH-1` (a real agent making a real change to the `co` repo)
 * stays a **host-live operator proof** (`docs/sh1-runbook.md`). The value here is a deterministic
 * regression guard for the orchestration transitions + a rehearsal of the runbook flow.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IS DRIVEN, AND WHERE THE BOUNDARIES ARE (Principle 9 — no silent papering-over):
 *   - The motor is the REAL {@link ConductorDaemon} + {@link ConductorEngine}, composed over `FakePty`
 *     exactly like `host-proof.test.ts` / `daemon.test.ts`: an injected counter clock (DATA, never a wall
 *     clock), a controllable byte-quiet window, and `InMemoryTransport` for the MCP bind.
 *   - The conductor-driven AGENT transitions go through the REAL co tools, called by a scripted MCP client
 *     connected to a hosted pane's transport (the generalization of `runHostProof`'s `awaitMailRouted`
 *     fake client): the worker's `co_finish` runs INSIDE a `daemon.tick()`-driven turn, and the lead's
 *     gated `co_merge` runs over its hosted pane. We assert the transitions via the program-data stores +
 *     the tmp repo's git log — NEVER by trusting the scripted agent's own claims.
 *   - The OPERATOR gates (lock the spec; submit the human verdict) are the HUMAN operator's inputs, driven
 *     through the real operator tool/core with an operator-identity context — NOT a conductor-driven pane
 *     (the operator is not an agent the loop hosts; in SH-1 the operator is host-live). This mirrors the
 *     runbook, where the human locks the spec and replies with a `review_response` PASS.
 *   - The L4 dispatch-PLACEMENT shell around `co_sling` (provider/usage selection) is intentionally NOT
 *     driven here: it reads the wall clock + a live usage source, which would make this loop test flaky.
 *     We provision the worktree through `slingWorktree` — the exact core `co_sling` wraps — so the
 *     worktree-provisioning plumbing transition is exercised deterministically. Placement is covered by
 *     `packages/core/src/tools/specs/sling.test.ts`; the live reviewer SPAWN gate (P2) is covered by
 *     `host-proof.test.ts` + `merge.test.ts`.
 *
 * DETERMINISM: no wall clock (`Date.now()`/`new Date()`), no `Math.random()` in this harness — the engine
 * + daemon read the injected counter clock; ids/branches/review-ids are fixed literals. The full flow is
 * run TWICE on fresh tmp repos to confirm it is not timing-flaky (identical transition + tick fingerprints).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  OPERATOR,
  QUIET_WINDOW_MS,
  ReconcileLoop,
  buildCoreRegistry,
  defaultMailRenderer,
  invokeTool,
  openConfigStore,
  openMailStore,
  openRegistry,
  openReviewStore,
  openRosterStore,
  openSpecStore,
  openWorktreeStore,
  recordHumanVerdict,
  reviewRequestEnvelope,
  reviewReviewerKey,
  slingWorktree,
  worktreePathFor,
  type DeliveredMail,
  type MailStore,
  type ProjectId,
  type ProjectRegistry,
  type ReviewStore,
  type RosterStore,
  type SpecStore,
  type WorktreeStore,
} from '@co/core';
import { ConductorDaemon, type DaemonTickOutcome } from './daemon.js';
import { ConductorEngine, type HostedPane } from './engine.js';
import type { HostedIdentity } from '../live-session-host.js';
import { openContextStores } from '../context.js';

// ── Scripted startup fixture. ESC authored via fromCharCode so the SOURCE holds no raw control byte. ──
const ESC = String.fromCharCode(0x1b);
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// ── Fixed identities / ids (deterministic — no randomness in the harness) ──────────────────────────
const TASK_ID = '2026-06-15-sh1-dry-run-toy';
const TOY_BRANCH = 'co/sh1-dry-run-toy';
const INTEGRATION = 'main';
const LEAD = 'lead-sh1-toy';
const WORKER = 'impl-sh1-toy';
const COORD = 'coord-sh1-toy';
const REVIEW_ID = 'rev-sh1-toy-1';

// ── Cleanup state (mirrors host-proof.test.ts / daemon.test.ts) ────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];
let engines: ConductorEngine[] = [];
let clients: Client[] = [];
let registries: ProjectRegistry[] = [];
let mailStores: MailStore[] = [];
let reviewStores: ReviewStore[] = [];
let worktreeStores: WorktreeStore[] = [];
let specStores: SpecStore[] = [];
let rosterStores: RosterStore[] = [];
let contextHandles: Array<{ close: () => void }> = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  engines = [];
  clients = [];
  registries = [];
  mailStores = [];
  reviewStores = [];
  worktreeStores = [];
  specStores = [];
  rosterStores = [];
  contextHandles = [];
});

afterEach(async () => {
  for (const client of clients) {
    try {
      await client.close();
    } catch {
      /* best-effort */
    }
  }
  for (const engine of engines) {
    try {
      await engine.closeAll();
    } catch {
      /* best-effort */
    }
  }
  for (const closeable of [
    ...mailStores,
    ...reviewStores,
    ...worktreeStores,
    ...specStores,
    ...rosterStores,
    ...contextHandles,
    ...registries,
  ]) {
    try {
      closeable.close();
    } catch {
      /* best-effort */
    }
  }
  process.env = ORIGINAL_ENV;
  for (const dir of [...dataDirs, ...repoDirs]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── Deterministic seams (counter clock + controllable quiet window — never a wall clock) ───────────
function makeClock(): { now: () => number; set: (t: number) => void } {
  let t = 0;
  return { now: () => t, set: (next) => void (t = next) };
}

function makeQuietWindow(): {
  quietWindow: (signal: AbortSignal) => Promise<void>;
  settle: () => void;
} {
  const waiters = new Set<() => void>();
  return {
    quietWindow: (signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          waiters.delete(finish);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        signal.addEventListener('abort', finish, { once: true });
        waiters.add(finish);
      }),
    settle: () => {
      for (const w of [...waiters]) w();
    },
  };
}

/** Drain microtasks + a macrotask (mirrors the engine/daemon test harnesses). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ── Real throwaway git repo in a tmp dir (mirrors merge.test.ts makeRepo) ──────────────────────────
function git(cwd: string, ...args: string[]): string {
  // stderr ignored so git's "Switched to branch …" chatter does not pollute test output.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/** A real repo (NO remote → resolves to offline mode), on the integration branch with one base commit. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-sh1-dry-run-repo-'));
  repoDirs.push(dir);
  execFileSync('git', ['init', '-b', INTEGRATION, dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'chore: init', '-m', 'Signed-off-by: Test <t@example.com>');
  return dir;
}

function makeProject(): { projectId: ProjectId; repo: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-sh1-dry-run-data-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const repo = makeRepo();
  const registry = openRegistry();
  registries.push(registry);
  return { projectId: registry.register(repo), repo };
}

// ── Tracked store openers (all share one per-project node:sqlite DB) ───────────────────────────────
function mail(projectId: ProjectId): MailStore {
  const store = openMailStore(projectId);
  mailStores.push(store);
  return store;
}
function reviews(projectId: ProjectId): ReviewStore {
  const store = openReviewStore(projectId);
  reviewStores.push(store);
  return store;
}
function worktrees(projectId: ProjectId): WorktreeStore {
  const store = openWorktreeStore(projectId);
  worktreeStores.push(store);
  return store;
}
function specs(projectId: ProjectId): SpecStore {
  const store = openSpecStore(projectId);
  specStores.push(store);
  return store;
}
function roster(projectId: ProjectId): RosterStore {
  const store = openRosterStore(projectId);
  rosterStores.push(store);
  return store;
}

// ── Engine / daemon composition (mirrors daemon.test.ts) ───────────────────────────────────────────
function makeEngine(
  pty: FakePty,
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
): ConductorEngine {
  const engine = new ConductorEngine({
    pty,
    makeTransport: () => InMemoryTransport.createLinkedPair(),
    now: clock.now,
    quietWindow: qw.quietWindow,
    // A never-resolving retryDelay so injectMail waits for the scripted echo and never times out.
    injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
  });
  engines.push(engine);
  return engine;
}

/** An inert reconcile loop (empty running set) — the watchdog sweep is daemon.test's concern, not this. */
function makeReconcile(clock: ReturnType<typeof makeClock>): ReconcileLoop {
  return new ReconcileLoop({
    runningAgents: () => [],
    livenessInputFor: () => undefined,
    now: clock.now,
    onBreak: () => {},
    markStuck: () => {},
  });
}

/** Spawn + drive a FakePty pane to ready (the P2-spawn stand-in: writes the session + roster records). */
async function hostPane(
  engine: ConductorEngine,
  pty: FakePty,
  identity: HostedIdentity,
): Promise<{ hosted: HostedPane; pane: FakePty['panes'][number] }> {
  const ensureP = engine.ensureHosted(identity);
  const pane = pty.panes[pty.panes.length - 1]!;
  pane.emit(CLAUDE_READY);
  const hosted = await ensureP;
  return { hosted, pane };
}

async function connectScriptedAgent(transport: HostedPane['clientTransport']): Promise<Client> {
  const client = new Client({ name: 'sh1-dry-run-scripted-agent', version: '0.0.0' });
  clients.push(client);
  await client.connect(transport);
  return client;
}

/** Call a co tool over the scripted agent's MCP client; throw loud if the tool reported an error. */
async function callToolOrThrow(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (res.isError === true) {
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    throw new Error(`sh1-dry-run: co tool '${name}' returned an error: ${text}`);
  }
}

/** Drive a hosted pane through ONE idle turn: echo the injected item, emit turn bytes, settle quiet. */
async function driveTurnToIdle(
  pane: FakePty['panes'][number],
  item: DeliveredMail,
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
): Promise<void> {
  await tick(); // injectMail has written the payload and is awaiting the echo
  pane.emit(defaultMailRenderer(item)); // composer echoes the injected text → exactly one Enter
  await tick(); // injectMail submits; observeTurnEnd arms the first quiet window
  clock.set(1000);
  pane.emit('⠋ working…\r\n'); // the turn produces bytes, then goes quiet
  await tick(); // the new bytes re-arm the quiet window
  clock.set(1000 + QUIET_WINDOW_MS + 1);
  qw.settle(); // the window elapses with no further output ⇒ idle
}

function seedActionableMail(projectId: ProjectId, to: string, from: string): DeliveredMail {
  return mail(projectId).send({
    type: 'clarify_request',
    to,
    from,
    subject: 'implement the toy change',
    body: 'sling a worktree, make the toy edit, and finish.',
  });
}

// ── The structured outcome of one dry-run (mirrors HostProofResult's shape) ────────────────────────
interface Sh1DryRunResult {
  readonly specLocked: boolean;
  readonly worktreeProvisioned: boolean;
  readonly worktreePath: string;
  readonly finishRecorded: boolean;
  readonly finishCommitSha: string;
  readonly workerDonePersisted: boolean;
  readonly reviewRequested: boolean;
  readonly passVerdictRecorded: boolean;
  readonly merged: boolean;
  readonly mergeCommitSha: string;
  readonly mergedFileOnIntegration: boolean;
  readonly workerTick: DaemonTickOutcome;
  readonly finalTick: DaemonTickOutcome;
}

/**
 * Drive the full toy change through the loop. Returns the structured transition facts (read from the
 * program-data stores + the tmp repo's git log) so the test asserts the PLUMBING, not the scripted
 * agent's claims.
 */
async function driveSh1DryRun(projectId: ProjectId, repo: string): Promise<Sh1DryRunResult> {
  const reg = buildCoreRegistry();

  // ── Phase 0 — OPERATOR locks the toy spec (human input; co_spec_lock is operator-only). ──────────
  // Drafting is the author's setup; the LOCK is the asserted operator transition (driven via the real
  // co_spec_lock tool with the operator's own tool context, exactly as the operator's MCP mount builds it).
  specs(projectId).recordDraft({
    taskId: TASK_ID,
    title: 'SH-1 dry-run toy change',
    goal: 'Exercise the orchestration loop plumbing end to end.',
    criteria: [
      {
        text: 'the toy change merges cleanly into the integration branch',
        verify: 'pnpm vitest run packages/mcp/src/conductor/sh1-dry-run.test.ts',
      },
    ],
    body: 'A minimal toy change used to rehearse the SH-1 runbook flow in-sandbox.',
    actor: OPERATOR,
  });
  const operatorCtx = openContextStores({ agent: OPERATOR, projectId, cwd: repo });
  contextHandles.push(operatorCtx);
  await invokeTool(reg, operatorCtx.ctx, 'co_spec_lock', { task_id: TASK_ID });
  const specLocked = specs(projectId).getSpec(TASK_ID)?.state === 'locked';

  // ── Phase 1 — provision the worker's sandbox (worktree-provisioning transition, slingWorktree core). ──
  // The lead provisions the sandbox the worker will finish in. The L4 dispatch placement around co_sling
  // is intentionally not driven (it reads the wall clock + a live usage source — see the file docstring).
  const slung = slingWorktree(
    worktrees(projectId),
    {
      parent: LEAD,
      agent: WORKER,
      role: 'implementer',
      branch: TOY_BRANCH,
      base: INTEGRATION,
      repoCwd: repo,
      projectId,
    },
    {
      // No-op provisioner + a clean recorded baseline so honest-verify is deterministic and clean.
      provisioner: () => ({ provisioned: [], skipped: [] }),
      probe: () => [{ name: 'toy-suite', passed: true }],
    },
  );
  const worktreeProvisioned =
    worktrees(projectId).getWorktree(TOY_BRANCH)?.removed === false &&
    existsSync(slung.worktreePath) &&
    git(slung.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD') === TOY_BRANCH;

  // Seed the parent chain a real spawn would have recorded, parent-before-child (the roster refuses a
  // child whose parent is unregistered). The lead's later hostSession idempotently re-asserts LEAD.
  const rosterStore = roster(projectId);
  rosterStore.recordAgent({ agentId: COORD, role: 'coordinator', parent: OPERATOR });
  rosterStore.recordAgent({ agentId: LEAD, role: 'lead', parent: COORD });

  // ── Compose the REAL daemon + engine over FakePty + the injected counter clock. ──────────────────
  const clock = makeClock();
  const qw = makeQuietWindow();
  const pty = new FakePty();
  const engine = makeEngine(pty, clock, qw);
  const daemon = new ConductorDaemon({
    engine,
    reconcile: makeReconcile(clock),
    projectId,
    now: clock.now,
    reconcileEvery: 1,
  });

  // ── Phase 2 — host the worker pane; the worker makes the toy edit + finishes inside a driven turn. ──
  const workerIdentity: HostedIdentity = {
    agent: WORKER,
    role: 'implementer',
    parent: LEAD,
    pane: `pane-${WORKER}`,
    provider: 'claude',
    resume: { provider: 'claude', sessionId: `session-${WORKER}` },
    projectId,
    cwd: slung.worktreePath,
  };
  const { hosted: workerHosted, pane: workerPane } = await hostPane(engine, pty, workerIdentity);
  const workerClient = await connectScriptedAgent(workerHosted.clientTransport);

  // The worker "produces the change in its worktree" — a minimal edit the scripted co_finish will commit.
  writeFileSync(join(slung.worktreePath, 'toy.txt'), 'the toy change\n');

  // The daemon reconstructs the live set, SELECTS the worker (warm, MNR-5 reuse), injects its outstanding
  // item, and drives EXACTLY ONE turn. DURING that turn the scripted worker calls the REAL co_finish.
  const kickoff = seedActionableMail(projectId, WORKER, LEAD);
  const workerTickP = daemon.tick();
  await callToolOrThrow(workerClient, 'co_finish', {
    intent: { type: 'feat', scope: 'toy', summary: 'add the toy change' },
    tests: [{ name: 'toy-suite', passed: true }],
    notes: 'sh1 dry-run',
  });
  await driveTurnToIdle(workerPane, kickoff, clock, qw);
  const workerTick = await workerTickP;

  const finishRecord = worktrees(projectId).getFinish(TOY_BRANCH);
  const finishCommitSha = finishRecord?.commitSha ?? '';
  const finishRecorded =
    finishRecord != null && finishCommitSha === git(repo, 'rev-parse', TOY_BRANCH);
  // worker_done landed in the lead's inbox (the mail bus delivered the finish notification).
  const workerDonePersisted = mail(projectId)
    .inbox(LEAD)
    .some((m) => m.type === 'worker_done' && m.sender === WORKER);

  // The worker is done — release its warm pane (ends its session; it leaves the live set).
  await engine.release(projectId, WORKER);

  // ── Phase 3 — OPERATOR review (human): request the review, then submit the PASS verdict. ─────────
  // This is what CoReviewGate records for a human review (the runbook's operator path). The review
  // request + the verdict re-entry use the real cores (requestHumanReview / recordHumanVerdict).
  const cfg = openConfigStore();
  try {
    cfg.setProjectOverride(projectId, reviewReviewerKey('worker_merge'), 'human');
  } finally {
    cfg.close();
  }
  mail(projectId).requestHumanReview(
    reviewRequestEnvelope({
      from: LEAD,
      subject: `review requested: '${TOY_BRANCH}' into '${INTEGRATION}'`,
      body:
        'A human review has been requested for the toy change. Open the Reviews view to inspect ' +
        'the diff and submit PASS.',
      idempotencyKey: `review-request:${REVIEW_ID}`,
    }),
    {
      reviewId: REVIEW_ID,
      target: INTEGRATION,
      branch: TOY_BRANCH,
      scope: 'worker_merge',
      reviewerKind: 'human',
      requestedBy: LEAD,
      specRefKind: 'no-locked-spec',
    },
  );
  const reviewRequested =
    reviews(projectId).getReviewRequest(INTEGRATION, TOY_BRANCH)?.reviewId === REVIEW_ID;

  recordHumanVerdict(reviews(projectId), {
    reviewId: REVIEW_ID,
    target: INTEGRATION,
    branch: TOY_BRANCH,
    verdict: 'PASS',
  });
  const passVerdictRecorded =
    reviews(projectId).getVerdict(INTEGRATION, TOY_BRANCH)?.verdict === 'PASS';

  // ── Phase 4 — host the lead pane; the lead drives the gated co_merge over the live MCP surface. ──
  const leadIdentity: HostedIdentity = {
    agent: LEAD,
    role: 'lead',
    parent: COORD,
    pane: `pane-${LEAD}`,
    provider: 'claude',
    resume: { provider: 'claude', sessionId: `session-${LEAD}` },
    projectId,
    cwd: repo,
  };
  const { hosted: leadHosted } = await hostPane(engine, pty, leadIdentity);
  const leadClient = await connectScriptedAgent(leadHosted.clientTransport);
  const integrationHeadBefore = git(repo, 'rev-parse', INTEGRATION);
  await callToolOrThrow(leadClient, 'co_merge', {
    branch: TOY_BRANCH,
    into: INTEGRATION,
    intent: { summary: 'land the SH-1 dry-run toy change' },
  });

  // Assert the gated merge landed on the integration branch via git — not the scripted agent's claim.
  const mergeCommitSha = git(repo, 'rev-parse', INTEGRATION);
  const merged = mergeCommitSha !== integrationHeadBefore;
  const mergedFileOnIntegration = git(repo, 'cat-file', '-t', `${INTEGRATION}:toy.txt`) === 'blob';

  // ── Phase 5 — a final tick proves the daemon deterministically reconstructs the post-merge live set. ──
  const finalTick = await daemon.tick();

  return {
    specLocked,
    worktreeProvisioned,
    worktreePath: slung.worktreePath,
    finishRecorded,
    finishCommitSha,
    workerDonePersisted,
    reviewRequested,
    passVerdictRecorded,
    merged,
    mergeCommitSha,
    mergedFileOnIntegration,
    workerTick,
    finalTick,
  };
}

/** A replay-stable fingerprint of one run (excludes per-run git SHAs, which differ by commit time). */
function determinismFingerprint(r: Sh1DryRunResult): Record<string, unknown> {
  return {
    specLocked: r.specLocked,
    worktreeProvisioned: r.worktreeProvisioned,
    finishRecorded: r.finishRecorded,
    workerDonePersisted: r.workerDonePersisted,
    reviewRequested: r.reviewRequested,
    passVerdictRecorded: r.passVerdictRecorded,
    merged: r.merged,
    mergedFileOnIntegration: r.mergedFileOnIntegration,
    workerObservedAt: r.workerTick.observedAt,
    workerSelected: r.workerTick.selected,
    workerCandidateCount: r.workerTick.candidateCount,
    workerIdle: r.workerTick.cycle?.turn.turnEnd?.idle ?? null,
    workerErrored: r.workerTick.cycle?.turn.errored ?? null,
    workerSawCompletionVerb: r.workerTick.cycle?.turn.turnEnd?.sawCompletionVerb ?? null,
    finalTickNum: r.finalTick.tick,
    finalObservedAt: r.finalTick.observedAt,
    finalSelected: r.finalTick.selected,
    finalCandidateCount: r.finalTick.candidateCount,
  };
}

describe('SH-1 dry-run harness — PROVES LOOP PLUMBING ONLY (scripted bytes/MCP-calls over FakePty), NOT the SH-1 acceptance bar (which stays a host-live operator proof: docs/sh1-runbook.md)', () => {
  it('drives a toy change spec-lock → worktree → finish → review-gate → gated-merge and asserts every transition via the stores + git log', async () => {
    const { projectId, repo } = makeProject();
    const result = await driveSh1DryRun(projectId, repo);

    // (1) spec-lock: a LOCKED spec record exists.
    expect(result.specLocked).toBe(true);

    // (2) worktree: a live worktree was provisioned (real git worktree on the toy branch).
    expect(result.worktreeProvisioned).toBe(true);
    expect(result.worktreePath).toBe(worktreePathFor(projectId, TOY_BRANCH));

    // The daemon selected + drove the worker through EXACTLY ONE idle turn (the scripted co_finish ran
    // during it). Turn-end is a liveness signal ONLY — NOT "done" (completion stays verb-keyed).
    expect(result.workerTick.selected).toBe(WORKER);
    expect(result.workerTick.candidateCount).toBe(1);
    expect(result.workerTick.cycle?.turn.errored).toBe(false);
    expect(result.workerTick.cycle?.turn.turnEnd?.idle).toBe(true);
    expect(result.workerTick.cycle?.turn.turnEnd?.sawCompletionVerb).toBe(false);

    // (3) finish: a finish record exists and its commit sha matches the branch head (the merge's
    //     reviewed-ref check depends on this), and worker_done reached the lead's inbox.
    expect(result.finishRecorded).toBe(true);
    expect(result.finishCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.workerDonePersisted).toBe(true);

    // (4) review-gate: a review was requested and a PASS verdict was recorded.
    expect(result.reviewRequested).toBe(true);
    expect(result.passVerdictRecorded).toBe(true);

    // (5) gated-merge: the merge landed on the integration branch, and the toy file is present on it.
    expect(result.merged).toBe(true);
    expect(result.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.mergedFileOnIntegration).toBe(true);
    // The merge commit really sits on the integration branch (no orchestration file left in the tree).
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(result.mergeCommitSha);
    expect(existsSync(join(repo, '.co'))).toBe(false);

    // The final tick deterministically reconstructs the post-merge live set: the worker was released, so
    // only the lead remains, and it has no outstanding actionable work (no spurious turn driven).
    expect(result.finalTick.tick).toBe(2);
    expect(result.finalTick.candidateCount).toBe(1);
    expect(result.finalTick.selected).toBeNull();
    // observedAt is injected DATA, never a wall clock.
    expect(Number.isFinite(result.workerTick.observedAt)).toBe(true);
    expect(Number.isFinite(result.finalTick.observedAt)).toBe(true);
  });

  it('is deterministic: two runs on fresh tmp repos produce identical transition + tick fingerprints (not timing-flaky)', async () => {
    const first = makeProject();
    const run1 = await driveSh1DryRun(first.projectId, first.repo);

    const second = makeProject();
    const run2 = await driveSh1DryRun(second.projectId, second.repo);

    // Same scripted bytes + same injected counter-clock sequence ⇒ identical plumbing outcome. Per-run
    // git SHAs differ (commit time), so the fingerprint excludes them and compares the transitions + ticks.
    expect(determinismFingerprint(run1)).toEqual(determinismFingerprint(run2));
    // Both runs fully landed the gated merge.
    expect(run1.merged).toBe(true);
    expect(run2.merged).toBe(true);
  });
});
