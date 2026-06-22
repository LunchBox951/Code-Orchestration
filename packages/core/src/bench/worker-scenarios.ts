/**
 * Live worker-BENCHMARK scenarios (the `CO_LIVE_E2E` worker benchmark — see
 * `packages/mcp/src/conductor/worker-benchmark.ts` for the host-live driver, and
 * `docs/worker-benchmark.md` for the runbook).
 *
 * A {@link BenchmarkScenario} is a pluggable, OBJECTIVELY-graded coding task: the prompt the hosted
 * implementer agent receives (as an injected `clarify_request` mail) PLUS an {@link ArtifactCheck}
 * evaluator that EXECUTES the artifact the agent actually produced and asserts its outputs. There is
 * NO LLM judge and NO subjective pass: a missing / wrong / throwing artifact is a hard `correct:false`
 * with a concrete reason (Principle 9 — fail-loud, no silent green).
 *
 * This lives in `@co/core` (pure — zero host graph), so it is hermetically unit-testable and the
 * `@co/mcp` benchmark driver imports it from the `@co/core` barrel (AC-L2-1 — adapters import only the
 * core barrel). The driver supplies the cwd (a throwaway tmp git worktree, NEVER the CO repo — Principle
 * 12) where the agent writes the artifact; the evaluator reads only that directory.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The objective grade of a produced artifact: did the EXECUTED code satisfy the scenario? Beyond the
 * binary `correct`, the evaluator reports the oracle case tally (`casesPassed`/`casesTotal`) so the
 * three-score CORRECTNESS metric (in {@link ../bench/orchestration-metrics.ts}) can refine the pass into
 * a fraction of oracle cases passed rather than an all-or-nothing 0/1. `correct` stays for back-compat
 * and is exactly `casesPassed === casesTotal` (with `casesTotal > 0`).
 */
export interface ArtifactCheck {
  /** True only when the artifact exists, imports, and passes every assertion (= `casesPassed === casesTotal`). */
  readonly correct: boolean;
  /** A concrete, human-legible reason (the failing case, or a pass summary). */
  readonly detail: string;
  /** Oracle cases that passed (the artifact must exist + import for any case to pass; 0 on a hard miss). */
  readonly casesPassed: number;
  /** Total oracle cases the scenario grades (a fixed scenario property, > 0). */
  readonly casesTotal: number;
}

/** The substitution context for a scenario's prompt text. */
export interface BenchmarkTaskContext {
  /** The per-run nonce the agent must echo in its done-mail (proves THIS run's reply). */
  readonly nonce: string;
  /** The recipient of the done-mail (the hosted agent's parent, normally `@operator`). */
  readonly parent: string;
}

/**
 * A pluggable benchmark task. `subject`/`body` are the verbatim prompt the agent receives; `evaluate`
 * is the objective grader. `artifactPath` is the file (relative to the agent's cwd) the task asks for.
 */
export interface BenchmarkScenario {
  /** Stable id for the scorecard + {@link getScenario} lookup. */
  readonly id: string;
  /** The artifact the task asks the agent to create, relative to its working directory. */
  readonly artifactPath: string;
  /** The seeded task-mail subject (also the renderer's match key). */
  readonly subject: (ctx: BenchmarkTaskContext) => string;
  /** The seeded task-mail body — the verbatim instructions injected into the pane. */
  readonly body: (ctx: BenchmarkTaskContext) => string;
  /** Execute the produced artifact under `worktreeDir` and grade it. NEVER throws — catches into `correct:false`. */
  readonly evaluate: (worktreeDir: string) => Promise<ArtifactCheck>;
}

/**
 * Dynamic-import a freshly-written ES module by absolute path, defeating the ESM module cache so two
 * runs in the same process (e.g. claude then codex) each load their OWN file rather than a cached one.
 */
export function importFreshModule(absPath: string): Promise<Record<string, unknown>> {
  const cacheBust = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const url = `${pathToFileURL(absPath).href}?t=${cacheBust}`;
  return import(url) as Promise<Record<string, unknown>>;
}

const ADD_CASES: ReadonlyArray<readonly [number, number, number]> = [
  [2, 3, 5],
  [0, 0, 0],
  [-1, 1, 0],
  [10, -4, 6],
];

async function evaluateAddModule(
  worktreeDir: string,
  artifactPath: string,
): Promise<ArtifactCheck> {
  const casesTotal = ADD_CASES.length;
  const file = join(worktreeDir, artifactPath);
  if (!existsSync(file)) {
    return miss(`${artifactPath} not found in ${worktreeDir}`, casesTotal);
  }
  let mod: Record<string, unknown>;
  try {
    mod = await importFreshModule(file);
  } catch (error) {
    return miss(`import threw: ${errorMessage(error)}`, casesTotal);
  }
  const add = mod['add'];
  if (typeof add !== 'function') {
    return miss(`${artifactPath} does not export a function 'add'`, casesTotal);
  }
  const addFn = add as (a: number, b: number) => unknown;
  let casesPassed = 0;
  for (const [a, b, want] of ADD_CASES) {
    let got: unknown;
    try {
      got = addFn(a, b);
    } catch (error) {
      return { correct: false, detail: `add(${a}, ${b}) threw: ${errorMessage(error)}`, casesPassed, casesTotal };
    }
    if (got !== want) {
      return { correct: false, detail: `add(${a}, ${b}) = ${String(got)}, want ${want}`, casesPassed, casesTotal };
    }
    casesPassed += 1;
  }
  return { correct: true, detail: `add() correct over ${casesTotal} cases`, casesPassed, casesTotal };
}

/**
 * A hard artifact miss (the file is absent / does not import / does not export the contract): zero oracle
 * cases passed out of `casesTotal`. Factored so the no-silent-zero contract (`casesTotal` is always the
 * scenario's true case count even on a structural miss) is uniform.
 */
function miss(detail: string, casesTotal: number): ArtifactCheck {
  return { correct: false, detail, casesPassed: 0, casesTotal };
}

/**
 * The flagship benchmark scenario: ask the agent to write a one-line pure `add(a, b)` ES module, then
 * signal done. Deliberately trivial so a competent model passes ~always — a failure is a meaningful
 * signal (broken host-live wiring, or the model genuinely failing the task), not benchmark noise.
 *
 * The done-signal is a nonce-bearing `clarify_request` to the parent — NOT `worker_done`, which the
 * `co_mail_send` schema rejects (it is filtered out of the sendable types). The prompt spells out the
 * filename, cwd, export signature, and exact done-mail shape so the task is robust against the
 * provider-to-provider phrasing differences a benchmark must tolerate.
 */
export function addModuleScenario(): BenchmarkScenario {
  const artifactPath = 'solution.mjs';
  return {
    id: 'add-module',
    artifactPath,
    subject: (ctx) => `worker-benchmark task ${ctx.nonce}`,
    body: (ctx) =>
      [
        `Worker-benchmark task ${ctx.nonce}.`,
        '',
        `Create a file named ${artifactPath} in your current working directory (the directory the`,
        'session started in). It must ES-module-export exactly one named function:',
        '',
        '  export function add(a, b) { return a + b; }',
        '',
        'A pure integer addition — no imports, no side effects, no console output. Use your OWN native',
        'file-editing tools (Write/Edit, or a shell heredoc) to create the file. Do NOT use any co_ MCP',
        'tool to write the file.',
        '',
        `When and ONLY when ${artifactPath} exists and is correct, call the mcp__co__co_mail_send MCP`,
        `tool EXACTLY ONCE with: to="${ctx.parent}", type="clarify_request", subject="worker done`,
        `${ctx.nonce}", and a body that includes this exact token: ${ctx.nonce}. (Do NOT use type`,
        'worker_done — it is not a sendable type; use clarify_request.) Do not call co_finish. Do not',
        `call co_mail_send before ${artifactPath} is written.`,
        '',
        `After the tool call returns, print this exact visible line: worker-benchmark complete ${ctx.nonce}`,
      ].join('\n'),
    evaluate: (worktreeDir) => evaluateAddModule(worktreeDir, artifactPath),
  };
}

/** Every registered benchmark scenario (extend this array to add tasks). */
export const WORKER_BENCH_SCENARIOS: readonly BenchmarkScenario[] = [addModuleScenario()];

/** Look up a scenario by id; fail-loud (Principle 9) on an unknown id. */
export function getScenario(id: string): BenchmarkScenario {
  const scenario = WORKER_BENCH_SCENARIOS.find((s) => s.id === id);
  if (scenario == null) {
    const known = WORKER_BENCH_SCENARIOS.map((s) => s.id).join(', ');
    throw new Error(`getScenario: unknown benchmark scenario '${id}' (known: ${known}).`);
  }
  return scenario;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
