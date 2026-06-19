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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import type { HostedIdentity } from '../live-session-host.js';
import { assertHostLiveProof, type ProofFidelity, type ProofResult } from './host-proof.js';
import { doneMailObserved, parentInboxMaxSeq, workerBenchRenderer } from './worker-benchmark.js';

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
