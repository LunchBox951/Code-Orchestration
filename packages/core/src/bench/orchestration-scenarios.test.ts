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
    // A clean pass = every oracle case passed; `correct` is exactly `casesPassed === casesTotal`.
    expect(result.casesTotal).toBe(13); // add(3)+sub(3)+mul(3)+tokenize(4)
    expect(result.casesPassed).toBe(result.casesTotal);
  });

  it('fails when the lead barrel never merged up (calc.mjs missing)', async () => {
    const files = referenceFiles();
    delete files['calc-lib/calc.mjs'];
    writeFiles(files);
    const result = await calcLibScenario().evaluate(dir);
    expect(result.correct).toBe(false);
    expect(result.detail).toMatch(/calc\.mjs not found/);
    // A hard structural miss reports zero of the full case total — never a silent partial.
    expect(result.casesPassed).toBe(0);
    expect(result.casesTotal).toBe(13);
  });

  it('fails when an implementer module did not merge up (barrel imports a missing module)', async () => {
    const files = referenceFiles();
    delete files['calc-lib/ops.mjs']; // calc.mjs re-exports ./ops.mjs → import throws
    writeFiles(files);
    const result = await calcLibScenario().evaluate(dir);
    expect(result.correct).toBe(false);
    expect(result.detail).toMatch(/import of calc\.mjs threw/);
    expect(result.casesPassed).toBe(0);
    expect(result.casesTotal).toBe(13);
  });

  it('fails when a numeric op is wrong and still counts later passing oracle cases', async () => {
    const files = referenceFiles();
    files['calc-lib/ops.mjs'] = [
      'export function add(a, b) {',
      '  if (a === 2 && b === 3) return -1;', // wrong on the FIRST add case only
      '  return a + b;',
      '}',
      'export function sub(a, b) { return a - b; }',
      'export function mul(a, b) { return a * b; }',
      '',
    ].join('\n');
    writeFiles(files);
    const result = await calcLibScenario().evaluate(dir);
    expect(result.correct).toBe(false);
    expect(result.detail).toMatch(/add\(2, 3\) = -1, want 5/);
    // The first add case fails, but the other 12 oracle cases pass. casesPassed is the total passed count,
    // not a prefix-before-first-failure count.
    expect(result.casesPassed).toBe(12);
    expect(result.casesTotal).toBe(13);
  });

  it('reports a PARTIAL case tally when later cases fail (add+sub pass, mul wrong)', async () => {
    const files = referenceFiles();
    files['calc-lib/ops.mjs'] = [
      'export function add(a, b) { return a + b; }', // 3 add cases pass
      'export function sub(a, b) { return a - b; }', // 3 sub cases pass
      'export function mul(a, b) { return a + b; }', // mul wrong → fails its first case
      '',
    ].join('\n');
    writeFiles(files);
    const result = await calcLibScenario().evaluate(dir);
    expect(result.correct).toBe(false);
    // 3 add + 3 sub + 4 tokenize cases pass; all 3 mul cases fail. The tally is total passed cases, not
    // cases before the first mul failure.
    expect(result.casesPassed).toBe(10);
    expect(result.casesTotal).toBe(13);
  });

  it('fails when tokenize is wrong', async () => {
    const files = referenceFiles();
    files['calc-lib/tokenize.mjs'] = ['export function tokenize() { return []; }', ''].join('\n');
    writeFiles(files);
    const result = await calcLibScenario().evaluate(dir);
    expect(result.correct).toBe(false);
    expect(result.detail).toMatch(/tokenize\(.*\).*want/);
  });

  it('counts later passing tokenize cases after the first tokenize failure', async () => {
    const files = referenceFiles();
    files['calc-lib/tokenize.mjs'] = [
      'export function tokenize(expr) {',
      '  if (expr === "12+3*4") return [];',
      '  const matched = String(expr).match(/\\d+|[+\\-*/()]/g);',
      '  return matched ?? [];',
      '}',
      '',
    ].join('\n');
    writeFiles(files);
    const result = await calcLibScenario().evaluate(dir);
    expect(result.correct).toBe(false);
    expect(result.detail).toMatch(/tokenize\("12\+3\*4"\)/);
    expect(result.casesPassed).toBe(12);
    expect(result.casesTotal).toBe(13);
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
