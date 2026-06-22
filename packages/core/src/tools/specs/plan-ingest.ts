import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { validateCriteria } from '../../plans/criteria.js';
import type { Criterion } from '../../specs/criteria-schema.js';
import type { PhaseNode } from '../../plans/events.js';
import {
  planRecordOutputSchema,
  planRecordToOutput,
  type PlanRecordOutput,
} from './plan-record-output.js';

const criterionInputSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .describe(
        'The concrete, checkable acceptance outcome, e.g. "expired tokens rejected (401)".',
      ),
    verify: z
      .string()
      .optional()
      .describe(
        'The wired verification command that proves this criterion, e.g. "pnpm vitest run packages/core/x". ' +
          'Required at ingestion; fuzzy (unwired) criteria cause ingestion to fail.',
      ),
  })
  .strict();

const phaseInputSchema = z
  .object({
    phase_id: z
      .string()
      .min(1)
      .describe('The unique phase identifier within this plan (DAG node key).'),
    name: z.string().min(1).describe('A human-readable phase name.'),
    owner: z.string().optional().describe('The Lead agent id that owns this phase (optional).'),
    deps: z
      .array(z.string())
      .describe(
        'Phase ids this phase depends on. Every entry must reference a declared phase_id in this plan.',
      ),
    criteria: z
      .array(criterionInputSchema)
      .describe(
        'Per-phase acceptance criteria. Every criterion must carry a wired verification command.',
      ),
  })
  .strict();

const planIngestInput = z
  .object({
    task_id: z
      .string()
      .min(1)
      .describe('The task id this plan is drafted for (the plan stream key).'),
    goal: z.string().min(1).describe('The plan goal statement — what the work must achieve.'),
    task_criteria: z
      .array(criterionInputSchema)
      .describe(
        'Task-level acceptance criteria. Must exactly match the locked spec criteria; every criterion ' +
          'must carry a wired verification command. Fuzzy or drifted criteria cause ingestion to fail.',
      ),
    phases: z
      .array(phaseInputSchema)
      .describe(
        'The non-empty phase DAG nodes. Every phase_id must be unique; every deps entry must reference ' +
          'a declared phase_id (no dangling deps). Fuzzy phase criteria cause ingestion to fail.',
      ),
  })
  .strict();
type PlanIngestInput = z.infer<typeof planIngestInput>;

/** Detect a cycle in the phase DAG using DFS. Returns a cycle description string, or null. */
function detectCycle(
  phases: readonly { phase_id: string; deps: readonly string[] }[],
): string | null {
  const adjList = new Map<string, readonly string[]>();
  for (const p of phases) adjList.set(p.phase_id, p.deps);

  const UNVISITED = 0,
    IN_STACK = 1,
    DONE = 2;
  const state = new Map<string, number>();
  for (const p of phases) state.set(p.phase_id, UNVISITED);

  function dfs(node: string, path: string[]): string | null {
    state.set(node, IN_STACK);
    path.push(node);
    for (const dep of adjList.get(node) ?? []) {
      if (state.get(dep) === IN_STACK) {
        const cycleStart = path.indexOf(dep);
        return [...path.slice(cycleStart), dep].join(' → ');
      }
      if (state.get(dep) === UNVISITED) {
        const result = dfs(dep, path);
        if (result != null) return result;
      }
    }
    path.pop();
    state.set(node, DONE);
    return null;
  }

  for (const p of phases) {
    if (state.get(p.phase_id) === UNVISITED) {
      const cycle = dfs(p.phase_id, []);
      if (cycle != null) return cycle;
    }
  }
  return null;
}

/**
 * `co_plan_ingest` (L6b E1): the coordinator verb that ingests a plan record into the durable
 * plan store (program-data only, Principle 12 — never the repo). The ingestion gate:
 * 1. Requires ctx.plans + ctx.specs + ctx.roster (loud-fail when absent).
 * 2. Coordinator-only (assertToolCallerRole).
 * 3. Requires a locked spec record whose criteria exactly match task_criteria.
 * 4. Structural DAG checks: at least one phase; unique phase_ids; no dangling deps; cycle detection.
 * 5. Validator gate: every criterion in task_criteria AND in each phase must have a wired
 *    `verify` command (the E2 red-on-fuzzy proof — a plan with fuzzy criteria FAILS ingestion).
 * 6. Records the plan via ctx.plans.recordDraft and returns the PlanRecord.
 */
export const planIngestTool: ToolSpec<PlanIngestInput, PlanRecordOutput> = {
  name: 'co_plan_ingest',
  title: 'Ingest a plan',
  description:
    'Ingest a plan record (goal, task-level and per-phase acceptance criteria, phase DAG) under a ' +
    'task id. Refuses unless: a matching locked spec exists, every criterion has a wired verify ' +
    'command, and the DAG is valid. Coordinator-only.',
  inputSchema: planIngestInput,
  outputSchema: planRecordOutputSchema,
  handler: (ctx, input): PlanRecordOutput => {
    if (!ctx.plans) {
      throw new Error('co_plan_ingest: the mount did not inject a plan store (ctx.plans absent).');
    }
    if (!ctx.specs) {
      throw new Error('co_plan_ingest: the mount did not inject a spec store (ctx.specs absent).');
    }
    if (!ctx.roster) {
      throw new Error(
        'co_plan_ingest: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_plan_ingest', ctx.roster, ctx.agent, ['coordinator']);

    const taskCriteriaInput: Criterion[] = input.task_criteria.map((c) =>
      c.verify != null ? { text: c.text, verify: c.verify } : { text: c.text },
    );
    const spec = ctx.specs.getSpec(input.task_id);
    if (spec == null || spec.state !== 'locked') {
      throw new Error(
        `co_plan_ingest: refusing to ingest plan '${input.task_id}' — no locked spec record exists ` +
          'for this task.',
      );
    }
    if (JSON.stringify(taskCriteriaInput) !== JSON.stringify(spec.criteria)) {
      throw new Error(
        `co_plan_ingest: refusing to ingest plan '${input.task_id}' — task_criteria must exactly ` +
          'match the locked spec criteria.',
      );
    }

    // Structural DAG checks (P9 loud-fail).
    if (input.phases.length === 0) {
      throw new Error(
        `co_plan_ingest: refusing to ingest plan '${input.task_id}' — at least one phase is required.`,
      );
    }
    const phaseIds = new Set<string>();
    for (const phase of input.phases) {
      if (phaseIds.has(phase.phase_id)) {
        throw new Error(
          `co_plan_ingest: duplicate phase_id '${phase.phase_id}' in plan '${input.task_id}'`,
        );
      }
      phaseIds.add(phase.phase_id);
    }
    for (const phase of input.phases) {
      for (const dep of phase.deps) {
        if (!phaseIds.has(dep)) {
          throw new Error(
            `co_plan_ingest: dangling dep '${dep}' in phase '${phase.phase_id}' of plan '${input.task_id}' — ` +
              'every dep must reference a declared phase_id',
          );
        }
      }
    }
    const cycle = detectCycle(input.phases);
    if (cycle != null) {
      throw new Error(
        `co_plan_ingest: cycle detected in phase DAG of plan '${input.task_id}': ${cycle}`,
      );
    }

    // Validator gate: run validateCriteria on task_criteria and each phase's criteria.
    const taskViolations = validateCriteria(taskCriteriaInput);

    const phaseViolationParts: string[] = [];
    const phaseViolationsByPhase: Array<{
      phaseId: string;
      violations: ReturnType<typeof validateCriteria>;
    }> = [];
    for (const phase of input.phases) {
      const phaseCriteria: Criterion[] = phase.criteria.map((c) =>
        c.verify != null ? { text: c.text, verify: c.verify } : { text: c.text },
      );
      const phaseViolations = validateCriteria(phaseCriteria);
      if (phaseViolations.length > 0) {
        phaseViolationsByPhase.push({ phaseId: phase.phase_id, violations: phaseViolations });
      }
    }

    if (taskViolations.length > 0 || phaseViolationsByPhase.length > 0) {
      const parts: string[] = [];
      if (taskViolations.length > 0) {
        const enumerated = taskViolations
          .map((v) => `    - criterion ${v.index} ("${v.text}"): ${v.reason}`)
          .join('\n');
        parts.push(`  task_criteria (${taskViolations.length} violation(s)):\n${enumerated}`);
      }
      for (const { phaseId, violations } of phaseViolationsByPhase) {
        const enumerated = violations
          .map((v) => `    - criterion ${v.index} ("${v.text}"): ${v.reason}`)
          .join('\n');
        parts.push(`  phase '${phaseId}' (${violations.length} violation(s)):\n${enumerated}`);
      }
      phaseViolationParts.push(...parts);
      throw new Error(
        `co_plan_ingest: refusing to ingest plan '${input.task_id}' — criterion violations found:\n` +
          phaseViolationParts.join('\n'),
      );
    }

    // Map input to domain types.
    const taskCriteria: Criterion[] = input.task_criteria.map((c) =>
      c.verify != null ? { text: c.text, verify: c.verify } : { text: c.text },
    );
    const phases: PhaseNode[] = input.phases.map((p) => ({
      phaseId: p.phase_id,
      name: p.name,
      ...(p.owner != null ? { owner: p.owner } : {}),
      deps: [...p.deps],
      criteria: p.criteria.map((c) =>
        c.verify != null ? { text: c.text, verify: c.verify } : { text: c.text },
      ),
    }));

    const rec = ctx.plans.recordDraft({
      taskId: input.task_id,
      goal: input.goal,
      taskCriteria,
      phases,
      actor: ctx.agent,
    });
    return planRecordToOutput(rec);
  },
};
