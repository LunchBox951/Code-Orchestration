import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  calcLibScenario,
  getOrchestrationScenario,
  ORCHESTRATION_SCENARIOS,
} from './orchestration-scenarios.js';

// The objective oracle must grade the EXECUTED merged artifact — green ONLY when both implementer
// modules and the lead barrel landed and compute correctly; a missing / un-merged / wrong module is a
// hard correct:false with a concrete reason (no LLM judge, no silent green — Principle 9).

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'co-orch-scn-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a set of `relativePath → contents` files under the integration dir. */
function writeFiles(files: Record<string, string>): void {
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, contents);
  }
}

/** The reference modules the scenario carries, keyed by their merged path. */
function referenceFiles(): Record<string, string> {
  const scenario = calcLibScenario();
  const files: Record<string, string> = {
    [scenario.lead.modulePath]: scenario.lead.referenceModule,
  };
  for (const impl of scenario.implementers) files[impl.modulePath] = impl.referenceModule;
  return files;
}

describe('calc-lib orchestration scenario — the objective merge-up oracle', () => {
  it('grades a correctly merged artifact (all modules present) as correct:true', async () => {
    writeFiles(referenceFiles());
    const result = await calcLibScenario().evaluate(dir);
    expect(result.correct).toBe(true);
    expect(result.detail).toMatch(/calc\.mjs correct/);
  });

  it('fails when the lead barrel never merged up (calc.mjs missing)', async () => {
    const files = referenceFiles();
    delete files['calc-lib/calc.mjs'];
    writeFiles(files);
    const result = await calcLibScenario().evaluate(dir);
    expect(result.correct).toBe(false);
    expect(result.detail).toMatch(/calc\.mjs not found/);
  });

  it('fails when an implementer module did not merge up (barrel imports a missing module)', async () => {
    const files = referenceFiles();
    delete files['calc-lib/ops.mjs']; // calc.mjs re-exports ./ops.mjs → import throws
    writeFiles(files);
    const result = await calcLibScenario().evaluate(dir);
    expect(result.correct).toBe(false);
    expect(result.detail).toMatch(/import of calc\.mjs threw/);
  });

  it('fails when a numeric op is wrong (executes the artifact, names the failing case)', async () => {
    const files = referenceFiles();
    files['calc-lib/ops.mjs'] = [
      'export function add(a, b) { return a - b; }', // wrong
      'export function sub(a, b) { return a - b; }',
      'export function mul(a, b) { return a * b; }',
      '',
    ].join('\n');
    writeFiles(files);
    const result = await calcLibScenario().evaluate(dir);
    expect(result.correct).toBe(false);
    expect(result.detail).toMatch(/add\(2, 3\) = -1, want 5/);
  });

  it('fails when tokenize is wrong', async () => {
    const files = referenceFiles();
    files['calc-lib/tokenize.mjs'] = ['export function tokenize() { return []; }', ''].join('\n');
    writeFiles(files);
    const result = await calcLibScenario().evaluate(dir);
    expect(result.correct).toBe(false);
    expect(result.detail).toMatch(/tokenize\(.*\).*want/);
  });
});

describe('orchestration scenario registry', () => {
  it('registers calc-lib and resolves it by id', () => {
    expect(ORCHESTRATION_SCENARIOS.map((s) => s.id)).toContain('calc-lib');
    expect(getOrchestrationScenario('calc-lib').id).toBe('calc-lib');
  });

  it('fail-loud on an unknown scenario id', () => {
    expect(() => getOrchestrationScenario('nope')).toThrow(/unknown scenario 'nope'/);
  });

  it('the root prompt instructs decomposition and names the modules (does not ask the coordinator to write code)', () => {
    const body = calcLibScenario().rootBody({ nonce: 'n1', operator: '@operator' });
    expect(body).toMatch(/do NOT write the modules/i);
    expect(body).toMatch(/ops\.mjs/);
    expect(body).toMatch(/tokenize\.mjs/);
    expect(body).toMatch(/n1/);
  });
});
