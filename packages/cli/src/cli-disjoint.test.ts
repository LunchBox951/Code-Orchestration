/**
 * AC-S9-8 — CLI⊥MCP disjointness invariant (pinned invariant D1).
 *
 * This guard asserts that the CLI operator surface and the agent MCP surface are
 * PERMANENTLY DISJOINT. It goes RED if anyone registers an operator-only verb as
 * an agent tool or removes the shell-invocation block that prevents agents from
 * reaching the CLI.
 *
 * Three assertions:
 *   1. No operator-only verb appears in the core MCP registry or any role's toolset.
 *   2. Agents cannot reach the CLI — `matchBlock('co <verb>')` fires the co-in-shell rule.
 *   3. The CLI dispatches each operator verb (run() does NOT return "unknown command").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCoreRegistry, toolsForRole, BASE_ROLES, matchBlock, openRegistry } from '@co/core';
import { run } from './run.js';

// ── The operator-only verb set (AC-S9-8 ✦D1) ─────────────────────────────────
// These MUST NEVER appear as agent MCP tools. The invariant is pinned here as a
// compile-time constant so any change to this list is a reviewed diff.

const OPERATOR_ONLY_VERBS = [
  'status',
  'doctor',
  'cleanup',
  'unstick',
  'nuke',
  'pause',
  'stop',
] as const;

// Mail/spec/plan views may also be CLI-only, but they are observability reads —
// the invariant is specifically that the RECOVERY/OBSERVABILITY operator verbs
// never become agent tools. We assert all of them here for completeness.

const OPERATOR_OBSERVABILITY_VERBS = ['status', 'doctor', 'spec', 'plan', 'phase'] as const;

const ALL_OPERATOR_VERBS = [...OPERATOR_ONLY_VERBS, 'mail', 'spec', 'plan', 'phase'] as const;

// ── Test fixtures ─────────────────────────────────────────────────────────────

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  const dir = mkdtempSync(join(tmpdir(), 'co-disjoint-data-'));
  tmpDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
});

function makeUnregisteredDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-disjoint-unreg-'));
  tmpDirs.push(dir);
  return dir;
}

function makeRegisteredDir(): { dir: string; projectId: string } {
  const dir = mkdtempSync(join(tmpdir(), 'co-disjoint-repo-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  const registry = openRegistry();
  const projectId = registry.register(dir);
  registry.close();
  return { dir, projectId };
}

// ── 1. No operator-only verb is an agent MCP tool ─────────────────────────────

describe('AC-S9-8 D1 — operator-only verbs are NOT in the MCP registry', () => {
  const registry = buildCoreRegistry();
  const allToolNames = registry.list().map((t) => t.name);

  it.each(OPERATOR_ONLY_VERBS)('operator verb "%s" is absent from buildCoreRegistry()', (verb) => {
    expect(allToolNames).not.toContain(verb);
  });

  it.each(OPERATOR_OBSERVABILITY_VERBS)(
    'observability verb "%s" is absent from buildCoreRegistry()',
    (verb) => {
      expect(allToolNames).not.toContain(verb);
    },
  );

  it('the MCP registry is non-empty (vacuity check)', () => {
    expect(allToolNames.length).toBeGreaterThan(0);
  });
});

describe('AC-S9-8 D1 — operator-only verbs are NOT in any role toolset', () => {
  it.each(BASE_ROLES)('role "%s" does not include any operator-only verb', (role) => {
    const toolNames = toolsForRole(role).map((t) => t.name);
    for (const verb of OPERATOR_ONLY_VERBS) {
      expect(toolNames).not.toContain(verb);
    }
    for (const verb of OPERATOR_OBSERVABILITY_VERBS) {
      expect(toolNames).not.toContain(verb);
    }
  });

  it('every base role has tools (vacuity check)', () => {
    for (const role of BASE_ROLES) {
      expect(toolsForRole(role).length).toBeGreaterThan(0);
    }
  });
});

// ── 2. Agents cannot reach the CLI (co-in-shell block holds) ─────────────────

describe('AC-S9-8 D1 — agents cannot reach the CLI via shell (co-in-shell block)', () => {
  it('matchBlock("co status") fires the co-in-shell rule', () => {
    const blocked = matchBlock('co status');
    expect(blocked).not.toBeNull();
    expect(blocked!.id).toBe('co-in-shell');
  });

  it.each(ALL_OPERATOR_VERBS)('matchBlock("co %s ...") fires the co-in-shell rule', (verb) => {
    const blocked = matchBlock(`co ${verb} some-arg`);
    expect(blocked).not.toBeNull();
    expect(blocked!.id).toBe('co-in-shell');
  });

  it('the co-in-shell rule description names the MCP surface as the correct path', () => {
    const blocked = matchBlock('co doctor');
    expect(blocked).not.toBeNull();
    expect(blocked!.description).toMatch(/MCP|co_\*/i);
  });
});

// ── 3. The CLI dispatches each operator verb ──────────────────────────────────

describe('AC-S9-8 D1 — the CLI dispatches each operator verb (not "unknown command")', () => {
  // With an unregistered cwd, every command that needs a project will fail with
  // "not a registered project" — which is NOT "unknown command". This proves the
  // verb is dispatched (known to the CLI) without requiring a full end-to-end setup.

  it.each(ALL_OPERATOR_VERBS)(
    'run(["%s"], unregistered) does NOT say "unknown command"',
    async (verb) => {
      const dir = makeUnregisteredDir();
      const result = await run([verb], dir);
      expect(result.output).not.toMatch(/unknown command/i);
      expect(result.exitCode).toBe(1);
    },
  );

  it('run(["mail", "read"], unregistered) does NOT say "unknown command"', async () => {
    const dir = makeUnregisteredDir();
    const result = await run(['mail', 'read'], dir);
    expect(result.output).not.toMatch(/unknown command/i);
    expect(result.exitCode).toBe(1);
  });

  it('run(["mail", "send"], unregistered) does NOT say "unknown command"', async () => {
    const dir = makeUnregisteredDir();
    const result = await run(['mail', 'send'], dir);
    expect(result.output).not.toMatch(/unknown command/i);
    expect(result.exitCode).toBe(1);
  });
});

// ── 4. CLI-side functional assertions ─────────────────────────────────────────

describe('AC-S9-8 — co status dispatches to queryObservability', () => {
  it('returns roster/plans/reviews/cost snapshot for a registered project', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['status'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/roster/i);
    expect(result.output).toMatch(/plans/i);
    expect(result.output).toMatch(/reviews/i);
    expect(result.output).toMatch(/cost/i);
  });

  it('returns exit code 1 for unknown option', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['status', '--bogus'], dir);
    expect(result.exitCode).toBe(1);
  });
});

describe('AC-S9-8 — co doctor dispatches to runDoctor', () => {
  it('returns a health report for a registered project', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['doctor'], dir);
    // doctor returns 0 (healthy) or 1 (unhealthy) — both are valid non-unknown-command
    expect(result.output).toMatch(/co doctor/i);
    expect(result.output).toMatch(/\[(ok|warn|fail)\]/);
  });

  it('returns exit code 1 for unknown option', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['doctor', '--bogus'], dir);
    expect(result.exitCode).toBe(1);
  });
});

describe('AC-S9-8 — co spec dispatches to openSpecStore', () => {
  it('lists zero specs for a fresh project', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['spec'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/none|specs/i);
  });

  it('returns exit code 1 for an unknown taskId', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['spec', 'task-nonexistent'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/not found/i);
  });
});

describe('AC-S9-8 — co plan dispatches to openPlanStore', () => {
  it('lists zero plans for a fresh project', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['plan'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/none|plans/i);
  });

  it('returns exit code 1 for an unknown taskId', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['plan', 'task-nonexistent'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/not found/i);
  });
});

describe('AC-S9-8 — co phase dispatches to openPlanStore', () => {
  it('returns exit code 1 when missing taskId', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['phase'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/missing.*taskId|taskId/i);
  });

  it('returns exit code 1 for an unknown taskId', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['phase', 'task-nonexistent'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/not found/i);
  });
});

describe('AC-S9-8 — co mail read dispatches to openMailStore', () => {
  it('shows empty inbox for a fresh project', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['mail', 'read'], dir);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/inbox|empty/i);
  });
});

describe('AC-S9-8 — co mail send dispatches to openMailStore', () => {
  it('returns exit code 1 for missing --to', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(
      ['mail', 'send', '--type', 'operator_message', '--subject', 'hi'],
      dir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/--to/i);
  });

  it('returns exit code 1 for invalid type', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(
      ['mail', 'send', '--to', 'agent-123', '--type', 'bad_type', '--subject', 'hi'],
      dir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/unknown mail type|bad_type/i);
  });

  it('sends a valid operator_message mail', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(
      ['mail', 'send', '--to', 'agent-123', '--type', 'operator_message', '--subject', 'hello'],
      dir,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/sent/i);
    expect(result.output).toMatch(/operator_message/);
  });

  it('rejects worker_done because co_finish owns that durable signal', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(
      [
        'mail',
        'send',
        '--to',
        'lead-1',
        '--type',
        'worker_done',
        '--subject',
        'worker_done: co/feature',
        '--body',
        'done',
      ],
      dir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/worker_done|not CLI-sendable|co_finish/i);
  });

  it('keeps the SH-1 runbook aligned with rejected CLI review_response sends', async () => {
    const runbook = readFileSync(join(process.cwd(), 'docs', 'sh1-runbook.md'), 'utf8');
    expect(runbook).toContain('`co mail send --type review_response …` is rejected');
    expect(runbook).not.toContain('stores a mail but does not record');

    const { dir } = makeRegisteredDir();
    const result = await run(
      [
        'mail',
        'send',
        '--to',
        'lead-1',
        '--type',
        'review_response',
        '--subject',
        'review verdict',
        '--body',
        'PASS',
      ],
      dir,
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/not CLI-sendable|review_response|Review view/i);
  });
});

describe('AC-S9-8 — co cleanup dispatches to CleanupGateImpl', () => {
  it('returns exit code 1 when missing branch argument', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['cleanup'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/missing.*branch|branch/i);
  });

  it('returns exit code 1 when branch not recorded (no worktree)', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['cleanup', 'co/some-branch'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/cleanup/i);
  });
});

describe('AC-S9-8 — co nuke dispatches to CleanupGateImpl (gated)', () => {
  it('returns exit code 1 without --confirm', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['nuke', 'co/some-branch'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/confirm/i);
  });

  it('returns exit code 1 when branch not recorded even with --confirm', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['nuke', 'co/some-branch', '--confirm'], dir);
    expect(result.exitCode).toBe(1);
  });
});

describe('AC-S9-8 — co unstick dispatches to CleanupGateImpl ([host-live])', () => {
  it('returns exit code 1 when missing branch argument', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['unstick'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/missing.*branch|branch/i);
  });

  it('returns exit code 1 with [host-live] message when branch exists', async () => {
    const { dir } = makeRegisteredDir();
    // Without a real git worktree, the repair seam throws (or the router does)
    const result = await run(['unstick', 'co/some-branch'], dir);
    expect(result.exitCode).toBe(1);
    // The error is either from the repair seam or the [host-live] router
    expect(result.output).toMatch(/unstick|host-live|git/i);
  });
});

describe('AC-S9-8 — co pause dispatches to CleanupGateImpl ([host-live])', () => {
  it('returns exit code 1 when missing agentId argument', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['pause'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/missing.*agentId|agentId/i);
  });

  it('returns exit code 1 with [host-live] message', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['pause', 'agent-123'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/host-live|router/i);
  });
});

describe('AC-S9-8 — co stop dispatches to CleanupGateImpl ([host-live])', () => {
  it('returns exit code 1 when missing agentId argument', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['stop'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/missing.*agentId|agentId/i);
  });

  it('returns exit code 1 with [host-live] message', async () => {
    const { dir } = makeRegisteredDir();
    const result = await run(['stop', 'agent-123'], dir);
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/host-live|router/i);
  });
});
