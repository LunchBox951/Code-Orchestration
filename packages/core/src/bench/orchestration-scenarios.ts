/**
 * Multi-level ORCHESTRATION-benchmark scenarios — the centerpiece v1 proof.
 *
 * Where {@link ./worker-scenarios.ts} grades ONE implementer writing ONE module, an
 * {@link OrchestrationScenario} grades the whole spawn chain: a COORDINATOR is given a general task,
 * decomposes it, dispatches a LEAD, the lead dispatches IMPLEMENTERS who each own a module, and the
 * reviewed branches are MERGED UP into one integration branch. The grade EXECUTES the merged artifact
 * against a hidden oracle — so a green grade is end-to-end proof that all three levels ran AND the
 * merge-up landed every module (a no-op, a missing module, or an un-merged barrel is a hard
 * `correct:false`; Principle 9 — no silent green, no LLM judge).
 *
 * This lives in `@co/core` (pure — zero host graph), so it is hermetically unit-testable and the
 * `@co/mcp` driver imports it from the core barrel. The scenario carries BOTH halves of the switchable
 * benchmark: the verbatim prompts a REAL model self-drives from (live mode), and per-module reference
 * sources the scripted-MCP sandbox harness writes (sandbox mode) so the same oracle grades both. The
 * driver supplies the integration worktree (a throwaway tmp clone, NEVER the CO repo — Principle 12).
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type ArtifactCheck, importFreshModule } from './worker-scenarios.js';

export type { ArtifactCheck } from './worker-scenarios.js';

/** The substitution context for a scenario's prompts. */
export interface OrchestrationTaskContext {
  /** The per-run nonce the chain must echo in its completion mail (proves THIS run). */
  readonly nonce: string;
  /** The recipient of the coordinator's escalations/clarifications (normally `@operator`). */
  readonly operator: string;
}

/**
 * One implementer-owned module in the decomposition. The `goal` text feeds the prompt; `referenceModule`
 * is what the scripted sandbox implementer writes (a real model writes its own equivalent from the prompt
 * in live mode). The oracle never reads `referenceModule` — it only ever executes the merged result.
 */
export interface ImplementerSubtask {
  /** Stable id (also the sandbox worktree/branch suffix), e.g. `ops`. */
  readonly id: string;
  /** The module this implementer owns, relative to the repo root, e.g. `calc-lib/ops.mjs`. */
  readonly modulePath: string;
  /** Human description of the module's contract (woven into the prompt). */
  readonly goal: string;
  /** Reference ES-module source the SANDBOX implementer writes; the live model authors its own. */
  readonly referenceModule: string;
}

/** The lead's integrating module (the barrel that re-exports the implementers' modules and merges up). */
export interface LeadIntegration {
  readonly modulePath: string;
  readonly goal: string;
  readonly referenceModule: string;
}

/** A pluggable multi-level benchmark task. */
export interface OrchestrationScenario {
  /** Stable id for the scorecard + {@link getOrchestrationScenario} lookup. */
  readonly id: string;
  /** The merged artifact the oracle executes, relative to the integration worktree root. */
  readonly artifactPath: string;
  /** The general task the coordinator receives (subject + body) — it decomposes and dispatches from this. */
  readonly rootSubject: (ctx: OrchestrationTaskContext) => string;
  readonly rootBody: (ctx: OrchestrationTaskContext) => string;
  /** The intended decomposition: the implementer subtasks the lead fans out to. */
  readonly implementers: readonly ImplementerSubtask[];
  /** The lead's barrel module that re-exports the implementers' work and is merged up to the coordinator. */
  readonly lead: LeadIntegration;
  /** Execute the merged artifact under `integrationDir` and grade it. NEVER throws — catches to `correct:false`. */
  readonly evaluate: (integrationDir: string) => Promise<ArtifactCheck>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── The flagship scenario: a small calculator library ────────────────────────────────────────────────

const CALC_DIR = 'calc-lib';

const OPS_MODULE = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  'export function sub(a, b) {',
  '  return a - b;',
  '}',
  'export function mul(a, b) {',
  '  return a * b;',
  '}',
  '',
].join('\n');

const TOKENIZE_MODULE = [
  'export function tokenize(expr) {',
  '  const matched = String(expr).match(/\\d+|[+\\-*/()]/g);',
  '  return matched ?? [];',
  '}',
  '',
].join('\n');

const CALC_BARREL = [
  "export { add, sub, mul } from './ops.mjs';",
  "export { tokenize } from './tokenize.mjs';",
  '',
].join('\n');

const ADD_CASES: ReadonlyArray<readonly [number, number, number]> = [
  [2, 3, 5],
  [0, 0, 0],
  [-4, 10, 6],
];
const SUB_CASES: ReadonlyArray<readonly [number, number, number]> = [
  [5, 3, 2],
  [0, 7, -7],
  [-2, -2, 0],
];
const MUL_CASES: ReadonlyArray<readonly [number, number, number]> = [
  [3, 4, 12],
  [-2, 5, -10],
  [0, 9, 0],
];
const TOKENIZE_CASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['12+3*4', ['12', '+', '3', '*', '4']],
  ['1 - 2', ['1', '-', '2']],
  ['(7+8)', ['(', '7', '+', '8', ')']],
  ['42', ['42']],
];

/** The total oracle cases the calc-lib scenario grades (add+sub+mul numeric ⊕ tokenize). */
const CALC_CASES_TOTAL =
  ADD_CASES.length + SUB_CASES.length + MUL_CASES.length + TOKENIZE_CASES.length;

/** A numeric-op grade: how many of `cases` passed, plus the first failure reason (or null on a clean run). */
interface OpGrade {
  readonly passed: number;
  readonly failure: string | null;
}

function checkNumericOp(
  fn: unknown,
  name: string,
  cases: ReadonlyArray<readonly [number, number, number]>,
): OpGrade {
  if (typeof fn !== 'function') {
    return { passed: 0, failure: `calc.mjs does not export a function '${name}'` };
  }
  const op = fn as (a: number, b: number) => unknown;
  let passed = 0;
  let firstFailure: string | null = null;
  for (const [a, b, want] of cases) {
    let got: unknown;
    try {
      got = op(a, b);
    } catch (error) {
      firstFailure ??= `${name}(${a}, ${b}) threw: ${errorMessage(error)}`;
      continue;
    }
    if (got !== want) {
      firstFailure ??= `${name}(${a}, ${b}) = ${String(got)}, want ${want}`;
      continue;
    }
    passed += 1;
  }
  return { passed, failure: firstFailure };
}

/** A hard structural miss (calc.mjs absent / un-importable): zero cases passed out of the scenario total. */
function calcMiss(detail: string): ArtifactCheck {
  return { correct: false, detail, casesPassed: 0, casesTotal: CALC_CASES_TOTAL };
}

async function evaluateCalcLib(integrationDir: string): Promise<ArtifactCheck> {
  const file = join(integrationDir, CALC_DIR, 'calc.mjs');
  if (!existsSync(file)) {
    return calcMiss(
      `${CALC_DIR}/calc.mjs not found in the merged integration branch at ${integrationDir} ` +
        '(the lead barrel never merged up, or the chain did not complete)',
    );
  }
  let mod: Record<string, unknown>;
  try {
    mod = await importFreshModule(file);
  } catch (error) {
    // A re-export barrel that imports missing implementer modules throws here — i.e. a module did
    // not merge up. That is exactly the merge-up failure the oracle must catch.
    return calcMiss(`import of calc.mjs threw: ${errorMessage(error)}`);
  }

  // Accumulate the oracle case tally across every op + tokenize so CORRECTNESS can refine the pass into
  // a fraction of cases passed. Keep the first failure as the diagnostic, but continue through independent
  // cases so `casesPassed` is the total passed count, not just the prefix before the first failure.
  let casesPassed = 0;
  let firstFailure: string | null = null;
  for (const [fn, name, cases] of [
    [mod['add'], 'add', ADD_CASES],
    [mod['sub'], 'sub', SUB_CASES],
    [mod['mul'], 'mul', MUL_CASES],
  ] as const) {
    const grade = checkNumericOp(fn, name, cases);
    casesPassed += grade.passed;
    firstFailure ??= grade.failure;
  }

  const tokenize = mod['tokenize'];
  if (typeof tokenize !== 'function') {
    return {
      correct: false,
      detail: firstFailure ?? "calc.mjs does not export a function 'tokenize'",
      casesPassed,
      casesTotal: CALC_CASES_TOTAL,
    };
  }
  const tokenizeFn = tokenize as (expr: string) => unknown;
  for (const [expr, want] of TOKENIZE_CASES) {
    let got: unknown;
    try {
      got = tokenizeFn(expr);
    } catch (error) {
      firstFailure ??= `tokenize(${JSON.stringify(expr)}) threw: ${errorMessage(error)}`;
      continue;
    }
    if (!Array.isArray(got) || got.length !== want.length || want.some((t, i) => got[i] !== t)) {
      firstFailure ??= `tokenize(${JSON.stringify(expr)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
      continue;
    }
    casesPassed += 1;
  }

  if (firstFailure != null) {
    return {
      correct: false,
      detail: firstFailure,
      casesPassed,
      casesTotal: CALC_CASES_TOTAL,
    };
  }

  return {
    correct: true,
    detail: `calc.mjs correct: add/sub/mul over ${ADD_CASES.length + SUB_CASES.length + MUL_CASES.length} cases + tokenize over ${TOKENIZE_CASES.length} cases`,
    casesPassed,
    casesTotal: CALC_CASES_TOTAL,
  };
}

/**
 * The flagship orchestration scenario (`calc-lib`): the coordinator builds a small calculator library,
 * naturally split across a lead and two implementers, integrated via a barrel module merged up the chain.
 * The oracle passes ONLY if both implementer modules (`ops.mjs`, `tokenize.mjs`) AND the lead's `calc.mjs`
 * barrel all landed in the integration branch and compute correctly — so a green grade proves the
 * three-level spawn + merge-up end to end, not just that one agent wrote one file.
 */
export function calcLibScenario(): OrchestrationScenario {
  const implementers: readonly ImplementerSubtask[] = [
    {
      id: 'ops',
      modulePath: `${CALC_DIR}/ops.mjs`,
      goal: `${CALC_DIR}/ops.mjs — ES-module-export pure functions add(a,b), sub(a,b), mul(a,b).`,
      referenceModule: OPS_MODULE,
    },
    {
      id: 'tokenize',
      modulePath: `${CALC_DIR}/tokenize.mjs`,
      goal:
        `${CALC_DIR}/tokenize.mjs — ES-module-export tokenize(expr): split an arithmetic string into an ` +
        'array of number and operator tokens (e.g. "12+3*4" → ["12","+","3","*","4"]).',
      referenceModule: TOKENIZE_MODULE,
    },
  ];
  const lead: LeadIntegration = {
    modulePath: `${CALC_DIR}/calc.mjs`,
    goal:
      `${CALC_DIR}/calc.mjs — a barrel that re-exports add, sub, mul from ./ops.mjs and tokenize from ` +
      './tokenize.mjs, after merging the two implementer branches up.',
    referenceModule: CALC_BARREL,
  };
  return {
    id: 'calc-lib',
    artifactPath: `${CALC_DIR}/calc.mjs`,
    implementers,
    lead,
    rootSubject: (ctx) => `orchestration-benchmark: build the calc-lib library (${ctx.nonce})`,
    rootBody: (ctx) =>
      [
        `Orchestration-benchmark task ${ctx.nonce}. You are the root COORDINATOR.`,
        '',
        `Goal: build a small ES-module calculator library under ${CALC_DIR}/ in this repository that,`,
        `via ${CALC_DIR}/calc.mjs, exports add(a,b), sub(a,b), mul(a,b), and tokenize(expr).`,
        '',
        'Decompose this into a plan and dispatch the work down the chain — do NOT write the modules',
        'yourself. The natural decomposition is one phase with a LEAD who fans out two IMPLEMENTERS:',
        `  - implementer "ops": ${implementers[0]!.goal}`,
        `  - implementer "tokenize": ${implementers[1]!.goal}`,
        `  - the LEAD writes ${lead.goal}`,
        '',
        'Each implementer works in its own isolated worktree and signals done to the lead; the lead',
        'reviews and MERGES UP both implementer branches, then integrates the calc.mjs barrel and',
        'finishes the phase up to you; you merge the lead branch into the integration branch and',
        'complete the task. Use ONLY the co_ MCP tools to plan, sling, review, and merge — never a raw',
        'publish command or PR-merge outside the gated co_ path (the review gate must hold).',
        '',
        `When the task is complete and the integration branch contains a working ${CALC_DIR}/calc.mjs,`,
        `ensure the completion is recorded and the nonce ${ctx.nonce} is echoed to ${ctx.operator}.`,
      ].join('\n'),
    evaluate: evaluateCalcLib,
  };
}

/** Every registered orchestration scenario (extend this array to add tasks). */
export const ORCHESTRATION_SCENARIOS: readonly OrchestrationScenario[] = [calcLibScenario()];

/** Look up an orchestration scenario by id; fail-loud (Principle 9) on an unknown id. */
export function getOrchestrationScenario(id: string): OrchestrationScenario {
  const scenario = ORCHESTRATION_SCENARIOS.find((s) => s.id === id);
  if (scenario == null) {
    const known = ORCHESTRATION_SCENARIOS.map((s) => s.id).join(', ');
    throw new Error(`getOrchestrationScenario: unknown scenario '${id}' (known: ${known}).`);
  }
  return scenario;
}
