/**
 * Hermetic unit tests for the worker-benchmark driver's PURE pieces (always run under `pnpm test`; no
 * provider, no node-pty, no real clock). They lock the load-bearing invariants the gated live run
 * relies on:
 *   - `doneMailObserved` matches ONLY a NEW `clarify_request` FROM the hosted agent carrying the nonce
 *     (never a stale item, a wrong sender, a wrong type, or a tautological "queue non-empty");
 *   - `workerBenchRenderer` injects the verbatim scenario prompt for the task mail, default otherwise;
 *   - `assertHostLiveProof` refuses a `sandbox-fake`-fidelity scorecard (a fake run can never be banked).
 *
 * The host-live run that drives a real agent is the gated `worker-benchmark.live.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAIL_CHAT,
  MAIL_CLARIFY_REQUEST,
  OPERATOR,
  addModuleScenario,
  defaultMailRenderer,
  openMailStore,
  openRegistry,
  type DeliveredMail,
  type MailStore,
  type ProjectId,
  type ProjectRegistry,
} from '@co/core';
import type { ArtifactCheck } from '@co/core';
import type { HostedIdentity } from '../live-session-host.js';
import { assertHostLiveProof, type ProofFidelity, type ProofResult } from './host-proof.js';
import {
  doneMailObserved,
  parentInboxMaxSeq,
  readWorkerEcon,
  workerBenchRenderer,
  workerCorrectness,
  type WorkerBenchmarkResult,
} from './worker-benchmark.js';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let registries: ProjectRegistry[] = [];
let mailStores: MailStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  registries = [];
  mailStores = [];
});

afterEach(() => {
  for (const closeable of [...mailStores, ...registries]) {
    try {
      closeable.close();
    } catch {
      /* best-effort */
    }
  }
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function makeProject(): ProjectId {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-wb-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const registry = openRegistry();
  registries.push(registry);
  return registry.register(join(dataDir, 'repo'));
}

function openMail(projectId: ProjectId): MailStore {
  const store = openMailStore(projectId);
  mailStores.push(store);
  return store;
}

function identityFor(projectId: ProjectId): HostedIdentity {
  return {
    agent: 'wb-1',
    role: 'implementer',
    parent: OPERATOR,
    pane: 'wb-pane-1',
    projectId,
    cwd: join(tmpdir(), 'wb-cwd'),
    provider: 'claude',
    resume: { provider: 'claude', sessionId: 'wb-session-1' },
  };
}

describe('doneMailObserved (hermetic)', () => {
  const nonce = 'NONCE-XYZ';

  it('is false until the agent routes a NEW nonce clarify_request to its parent', () => {
    const projectId = makeProject();
    const identity = identityFor(projectId);
    const store = openMail(projectId);
    // A pre-existing @operator item (from someone else) sets the baseline.
    store.send({ type: MAIL_CHAT, to: OPERATOR, from: 'coord-1', subject: 'hi', body: 'pre-run' });
    const baseline = parentInboxMaxSeq(projectId, OPERATOR);

    expect(doneMailObserved(projectId, identity, baseline, nonce)).toBe(false);

    // Wrong sender (not the hosted agent) — must NOT count.
    store.send({
      type: MAIL_CLARIFY_REQUEST,
      to: OPERATOR,
      from: 'someone-else',
      subject: `worker done ${nonce}`,
      body: nonce,
    });
    expect(doneMailObserved(projectId, identity, baseline, nonce)).toBe(false);

    // Right sender, wrong type — must NOT count.
    store.send({
      type: MAIL_CHAT,
      to: OPERATOR,
      from: identity.agent,
      subject: `worker done ${nonce}`,
      body: nonce,
    });
    expect(doneMailObserved(projectId, identity, baseline, nonce)).toBe(false);

    // Right sender + type but missing the nonce — must NOT count.
    store.send({
      type: MAIL_CLARIFY_REQUEST,
      to: OPERATOR,
      from: identity.agent,
      subject: 'worker done (no nonce)',
      body: 'all set',
    });
    expect(doneMailObserved(projectId, identity, baseline, nonce)).toBe(false);

    // The real done-mail: NEW clarify_request FROM the agent carrying the nonce.
    store.send({
      type: MAIL_CLARIFY_REQUEST,
      to: OPERATOR,
      from: identity.agent,
      subject: `worker done ${nonce}`,
      body: `finished ${nonce}`,
    });
    expect(doneMailObserved(projectId, identity, baseline, nonce)).toBe(true);
  });

  it('ignores a pre-baseline (stale) done-mail from the agent', () => {
    const projectId = makeProject();
    const identity = identityFor(projectId);
    const store = openMail(projectId);
    // A matching mail that predates the baseline — a leftover from an earlier run — must NOT false-positive.
    store.send({
      type: MAIL_CLARIFY_REQUEST,
      to: OPERATOR,
      from: identity.agent,
      subject: `worker done ${nonce}`,
      body: nonce,
    });
    const baseline = parentInboxMaxSeq(projectId, OPERATOR);
    expect(doneMailObserved(projectId, identity, baseline, nonce)).toBe(false);
  });
});

describe('workerBenchRenderer (hermetic)', () => {
  it('renders the verbatim scenario prompt for the task mail, default otherwise', () => {
    const projectId = makeProject();
    const scenario = addModuleScenario();
    const nonce = 'N1';
    const renderer = workerBenchRenderer(scenario, nonce, OPERATOR);
    const store = openMail(projectId);

    const ctx = { nonce, parent: OPERATOR };
    store.send({
      type: MAIL_CLARIFY_REQUEST,
      to: 'wb-1',
      from: OPERATOR,
      subject: scenario.subject(ctx),
      body: scenario.body(ctx),
    });
    store.send({ type: MAIL_CHAT, to: 'wb-1', from: 'coord-1', subject: 'chatter', body: 'hello' });
    const inbox = store.inbox('wb-1');
    const taskMail = inbox.find((m) => m.subject === scenario.subject(ctx)) as DeliveredMail;
    const otherMail = inbox.find((m) => m.subject === 'chatter') as DeliveredMail;

    const rendered = renderer(taskMail);
    expect(rendered).toContain(nonce);
    expect(rendered).toContain(scenario.artifactPath);
    expect(rendered).toContain('clarify_request');

    expect(renderer(otherMail)).toBe(defaultMailRenderer(otherMail));
  });
});

describe('workerCorrectness — single-agent CORRECTNESS score (hermetic)', () => {
  const artifact = (casesPassed: number, casesTotal: number): ArtifactCheck => ({
    correct: casesPassed === casesTotal && casesTotal > 0,
    detail: `${casesPassed}/${casesTotal}`,
    casesPassed,
    casesTotal,
  });

  it('a correct, completed artifact scores 1 (every case passed, done-mail observed)', () => {
    expect(workerCorrectness(artifact(4, 4), true)).toBe(1);
  });

  it('refines a partial oracle pass into a fraction of cases (2/4), gated by completion', () => {
    expect(workerCorrectness(artifact(2, 4), true)).toBeCloseTo(0.5, 10);
  });

  it('a not-completed run zeroes correctness even with a perfect tally (completion gate)', () => {
    // The exact lazy-agent trap at single-agent scale: the file is correct but the agent never signalled
    // done — correctness must reflect the incomplete run, not just the artifact tally.
    expect(workerCorrectness(artifact(4, 4), false)).toBe(0);
  });

  it('is fail-closed on a zero-case oracle (no evidence ⇒ 0, never 1)', () => {
    expect(workerCorrectness(artifact(0, 0), true)).toBe(0);
  });
});

describe('WorkerBenchmarkResult public type compatibility', () => {
  it('accepts legacy result literals without a scores block', () => {
    const legacy = {
      provider: 'claude',
      scenarioId: 'add-module',
      fidelity: 'host-live',
      completed: true,
      turnsUsed: 1,
      artifact: { correct: true, detail: 'legacy pass' },
      wallClockMs: 10,
      stopReason: 'done-mail',
    } satisfies WorkerBenchmarkResult;

    expect(legacy.completed).toBe(true);
  });
});

describe('assertHostLiveProof refuses a sandbox-fake scorecard (hermetic)', () => {
  const shim = (fidelity: ProofFidelity): ProofResult => ({
    turnRan: true,
    turnIdle: true,
    sessionReconstructed: true,
    mailRouted: true,
    steerCompleted: true,
    steerMidTurn: true,
    recoveredSessions: [],
    fidelity,
  });

  it('throws on sandbox-fake, passes on host-live', () => {
    expect(() => assertHostLiveProof(shim('sandbox-fake'))).toThrow(/host-live/);
    expect(() => assertHostLiveProof(shim('host-live'))).not.toThrow();
  });
});

describe('readWorkerEcon — sandbox cost-skip parity + log-don’t-swallow (hermetic)', () => {
  const ECON_ROLLUP = {
    agentId: 'wb-1',
    inputTokens: 1000,
    outputTokens: 2000,
    cacheReadTokens: 500,
    cacheCreationTokens: 100,
    totalTokens: 3100,
    costUsd: 0.42,
  };
  // An injected econ store that DOES return a non-null cost rollup (present, not PR-B-absent), so the
  // sandbox-fake null below is the fidelity short-circuit at work, not a missing store.
  const openEconWithCost = (): {
    getAgentCostRollup: () => typeof ECON_ROLLUP;
    getAgentToolUsage: () => null;
    close: () => void;
  } => ({
    getAgentCostRollup: () => ECON_ROLLUP,
    getAgentToolUsage: () => null,
    close: () => {},
  });

  it('FORCES cost=null in sandbox-fake even when the store has a non-null rollup, and READS it host-live (non-vacuous)', () => {
    const projectId = makeProject();

    // SANDBOX arm: the cost read is SKIPPED entirely — cost is GUARANTEED null even though the injected
    // store would have returned a rollup. If the sandbox-fake skip is removed, this cost is non-null ⇒ fail.
    const sandbox = readWorkerEcon(projectId, 'wb-1', 'sandbox-fake', openEconWithCost);
    expect(sandbox.cost).toBeNull();

    // HOST-LIVE arm: the SAME injected rollup IS read — proving the short-circuit is the only thing nulling
    // the sandbox arm (parity with the orchestration driver's readAgentEcon).
    const live = readWorkerEcon(projectId, 'wb-1', 'host-live', openEconWithCost);
    expect(live.cost).toEqual(ECON_ROLLUP);
  });

  it('LOGS (does not silently swallow) when the econ store open throws, still degrading to null', () => {
    const projectId = makeProject();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const throwingOpen = (): never => {
        throw new Error('boom: dispatch store unavailable');
      };
      const result = readWorkerEcon(projectId, 'wb-1', 'host-live', throwingOpen);
      // Degrades to null (the run is still graded) AND the failure is surfaced on stderr (Principle 9).
      expect(result).toEqual({ cost: null, tool: null });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toMatch(/econ read failed/u);
    } finally {
      spy.mockRestore();
    }
  });
});
