/**
 * Hermetic unit tests for the worker-benchmark scenario evaluator (always run under `pnpm test`; zero
 * network / process / provider I/O). They prove the OBJECTIVE grader is real and fail-loud: a correct
 * artifact passes, a wrong/missing/throwing one fails with a concrete reason, and `getScenario` rejects
 * an unknown id. The host-live run that actually produces the artifact is the gated
 * `worker-benchmark.live.test.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WORKER_BENCH_SCENARIOS, addModuleScenario, getScenario } from './worker-scenarios.js';

describe('addModuleScenario — objective evaluator (hermetic)', () => {
  let dir: string;
  const scenario = addModuleScenario();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-wb-scenario-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes a correct solution.mjs (executed, not inspected)', async () => {
    writeFileSync(
      join(dir, scenario.artifactPath),
      'export function add(a, b) { return a + b; }\n',
    );
    const check = await scenario.evaluate(dir);
    expect(check.correct).toBe(true);
    expect(check.detail).toMatch(/correct over/);
    // A clean pass = every oracle case passed; `correct` is exactly `casesPassed === casesTotal`.
    expect(check.casesTotal).toBe(4);
    expect(check.casesPassed).toBe(4);
  });

  it('fails a wrong solution.mjs with a concrete reason', async () => {
    writeFileSync(
      join(dir, scenario.artifactPath),
      'export function add(a, b) { return a - b; }\n',
    );
    const check = await scenario.evaluate(dir);
    expect(check.correct).toBe(false);
    expect(check.detail).toMatch(/add\(/);
    // add(2,3) is the FIRST case and is wrong ⇒ zero cases passed before the bail (a real partial count).
    expect(check.casesPassed).toBe(0);
    expect(check.casesTotal).toBe(4);
  });

  it('fails when the artifact is missing', async () => {
    const check = await scenario.evaluate(dir);
    expect(check.correct).toBe(false);
    expect(check.detail).toMatch(/not found/);
    // A hard miss reports zero of the full case total — never a silent partial.
    expect(check.casesPassed).toBe(0);
    expect(check.casesTotal).toBe(4);
  });

  it('fails when the export is not a function', async () => {
    writeFileSync(join(dir, scenario.artifactPath), 'export const add = 42;\n');
    const check = await scenario.evaluate(dir);
    expect(check.correct).toBe(false);
    expect(check.detail).toMatch(/does not export a function/);
  });

  it('fails (does not throw) when the module is syntactically broken', async () => {
    writeFileSync(join(dir, scenario.artifactPath), 'export function add(a, b) { return a + ; }\n');
    const check = await scenario.evaluate(dir);
    expect(check.correct).toBe(false);
    expect(check.detail).toMatch(/import threw/);
  });
});

describe('getScenario / WORKER_BENCH_SCENARIOS (hermetic)', () => {
  it('resolves the registered add-module scenario', () => {
    expect(getScenario('add-module').id).toBe('add-module');
    expect(WORKER_BENCH_SCENARIOS.some((s) => s.id === 'add-module')).toBe(true);
  });

  it('fails loud on an unknown scenario id', () => {
    expect(() => getScenario('does-not-exist')).toThrow(/unknown benchmark scenario/);
  });

  it('renders prompt + subject with the run nonce and parent', () => {
    const scenario = addModuleScenario();
    const ctx = { nonce: 'NONCE-123', parent: '@operator' };
    expect(scenario.subject(ctx)).toContain('NONCE-123');
    const body = scenario.body(ctx);
    expect(body).toContain('NONCE-123');
    expect(body).toContain('@operator');
    expect(body).toContain(scenario.artifactPath);
    expect(body).toContain('clarify_request');
    // Guards the load-bearing fact: worker_done is NOT a sendable co_mail_send type.
    expect(body).toMatch(/NOT use type\s+worker_done/);
  });
});
