/**
 * AC-S9-6 — co doctor structural health suite + observability rollup.
 *
 * Proves:
 *   - Each check yields an explicit ok/warn/fail with a human reason (Principle 9).
 *   - program-data-integrity: passes on a healthy store; fails loud on a synthesized divergence.
 *   - project-memory-validity: ok (both files), warn (CLAUDE.md-only or AGENTS.md-only), fail (neither).
 *   - mcp-surface-completeness: ok on the real registry (all tools are complete).
 *   - provider-compatibility: ok (no probe), ok (healthy probe), warn (version skew), fail (absent capability).
 *   - Observability rollup aggregates all four dimensions (roster/phase/review/cost).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openGlobalStore, openProjectStore } from '../store/sqlite-store.js';
import { openConfigStore } from '../config/config-store.js';
import { openRosterStore } from '../roles/roster-store.js';
import { openPlanStore } from '../plans/plans-store.js';
import { openDispatchStore } from '../dispatch/dispatch-store.js';
import { openReviewStore } from '../review/review-store.js';
import { ensureReviewTables } from '../review/review-projector.js';
import {
  defaultProviderProbe,
  defaultGithubAuthProbe,
  runDoctor,
  REQUIRED_CAPABILITIES,
  type ProviderProbeCommand,
  type ProviderProbeSeam,
  type ProviderProbeResult,
} from './doctor.js';
import { queryLiveObservability, queryObservability } from './observability.js';

// ── Test env setup ────────────────────────────────────────────────────────────

const ORIGINAL_ENV = process.env;
let dataDir: string;
let repoDir: string;

const PROJECT_ID = 'test-p6-doctor';

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDir = mkdtempSync(join(tmpdir(), 'co-doctor-data-'));
  repoDir = mkdtempSync(join(tmpdir(), 'co-doctor-repo-'));
  process.env.CO_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeClaudeMd(): void {
  writeFileSync(join(repoDir, 'CLAUDE.md'), '# Project memory\n');
}

function writeAgentsMd(): void {
  writeFileSync(join(repoDir, 'AGENTS.md'), '# Project memory\n');
}

function seedRoster(): void {
  const roster = openRosterStore(PROJECT_ID);
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  roster.recordAgent({ agentId: 'impl-1', role: 'implementer', parent: 'coord-1' });
  roster.close();
}

function seedPlans(): void {
  const plans = openPlanStore(PROJECT_ID);
  plans.recordDraft({
    taskId: 'task-p6',
    goal: 'doctor + observability',
    taskCriteria: [],
    phases: [
      { phaseId: 'p1', name: 'implement', deps: [], criteria: [] },
      { phaseId: 'p2', name: 'verify', deps: ['p1'], criteria: [] },
    ],
    actor: 'coord-1',
  });
  plans.close();
}

function seedCost(): void {
  const dispatch = openDispatchStore(PROJECT_ID);
  dispatch.recordCost({
    provider: 'claude',
    agent: 'impl-1',
    task: 'task-p6',
    turn: 1,
    cost_usd: 0.05,
    input_tokens: 1000,
    output_tokens: 500,
  });
  dispatch.close();
}

function seedReviews(): void {
  const store = openProjectStore(PROJECT_ID);
  store.transaction((tx) => {
    const db = tx.raw as DatabaseSync;
    ensureReviewTables(db);
    db.prepare(
      `INSERT OR IGNORE INTO reviews (target, branch, scope, review_id, requested_by, requested_ts)
       VALUES ('main', 'co/impl-1', 'worker_merge', 'rev-001', 'coord-1', 1)`,
    ).run();
  });
  store.close();
}

// ── program-data-integrity ────────────────────────────────────────────────────

describe('doctor check: program-data-integrity', () => {
  it('returns ok on a healthy (log-consistent) store', () => {
    seedRoster();
    seedPlans();

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'program-data-integrity')!;
    expect(check).toBeDefined();
    expect(check.status).toBe('ok');
  });

  it('returns ok on an empty store (no events)', () => {
    const store = openProjectStore(PROJECT_ID);
    store.close();

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'program-data-integrity')!;
    expect(check.status).toBe('ok');
  });

  it('returns fail when a row was injected into a projection table outside the event log', () => {
    seedRoster();

    // Manually insert a row into the roster table WITHOUT going through the event log.
    // After rebuild the row will be gone (not in the log), causing divergence.
    const store = openProjectStore(PROJECT_ID);
    store.transaction((tx) => {
      const db = tx.raw as DatabaseSync;
      db.prepare(
        `INSERT OR IGNORE INTO roster (agent_id, role, parent, registered_ts)
         VALUES ('ghost-agent', 'implementer', 'coord-1', 9999999)`,
      ).run();
    });
    store.close();

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'program-data-integrity')!;
    expect(check.status).toBe('fail');
    expect(check.reason).toMatch(/divergence/i);
  });

  it('is read-only: a detected divergence is NOT repaired in the live store (#7 §5 #5)', () => {
    seedRoster();
    const store = openProjectStore(PROJECT_ID);
    store.transaction((tx) => {
      (tx.raw as DatabaseSync)
        .prepare(
          `INSERT OR IGNORE INTO roster (agent_id, role, parent, registered_ts)
           VALUES ('ghost-agent', 'implementer', 'coord-1', 9999999)`,
        )
        .run();
    });
    store.close();

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    expect(report.checks.find((c) => c.name === 'program-data-integrity')!.status).toBe('fail');

    // The diagnostic must NOT have rebuilt the live store in place (which would erase the very
    // divergence it detected). The injected ghost row is still present.
    const after = openProjectStore(PROJECT_ID);
    const rows = after.transaction(
      (tx) =>
        (tx.raw as DatabaseSync)
          .prepare(`SELECT agent_id FROM roster WHERE agent_id = 'ghost-agent'`)
          .all() as Array<{ agent_id: string }>,
    );
    after.close();
    expect(rows).toHaveLength(1);
  });
});

// ── global-data-integrity (#7 §5 #7) ──────────────────────────────────────────

describe('doctor check: global-data-integrity', () => {
  it('returns ok on a healthy (log-consistent) global store', () => {
    const cfg = openConfigStore();
    cfg.setGlobal('repo.mode', 'owner');
    cfg.close();

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'global-data-integrity')!;
    expect(check).toBeDefined();
    expect(check.status).toBe('ok');
  });

  it('returns fail when a global projection diverges from the event log', () => {
    const cfg = openConfigStore();
    cfg.setGlobal('repo.mode', 'owner');
    cfg.close();

    // Inject a config row outside the event log → a fresh replay won't reproduce it → divergence.
    const store = openGlobalStore();
    const tables = store.transaction(
      (tx) =>
        (tx.raw as DatabaseSync)
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'config%' ORDER BY name`,
          )
          .all() as Array<{ name: string }>,
    );
    store.close();
    // Guard: the config projection table must exist for this test to be meaningful.
    expect(tables.length).toBeGreaterThan(0);

    const store2 = openGlobalStore();
    store2.transaction((tx) => {
      (tx.raw as DatabaseSync).prepare(`DELETE FROM "${tables[0]!.name}"`).run();
    });
    store2.close();

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'global-data-integrity')!;
    expect(check.status).toBe('fail');
    expect(check.reason).toMatch(/divergence/i);
  });
});

// ── project-memory-validity ───────────────────────────────────────────────────

describe('doctor check: project-memory-validity', () => {
  it('returns ok when both CLAUDE.md and AGENTS.md are present', () => {
    writeClaudeMd();
    writeAgentsMd();

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'project-memory-validity')!;
    expect(check.status).toBe('ok');
  });

  it('returns warn when only CLAUDE.md is present (Codex memory-blind gap)', () => {
    writeClaudeMd();

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'project-memory-validity')!;
    expect(check.status).toBe('warn');
    expect(check.reason).toMatch(/codex/i);
    expect(check.reason).toMatch(/memory-blind/i);
  });

  it('returns warn when only AGENTS.md is present (Claude memory-blind gap)', () => {
    writeAgentsMd();

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'project-memory-validity')!;
    expect(check.status).toBe('warn');
    expect(check.reason).toMatch(/claude/i);
  });

  it('returns fail when neither CLAUDE.md nor AGENTS.md is present', () => {
    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'project-memory-validity')!;
    expect(check.status).toBe('fail');
    expect(check.reason).toMatch(/neither/i);
  });
});

// ── mcp-surface-completeness ──────────────────────────────────────────────────

describe('doctor check: mcp-surface-completeness', () => {
  it('returns ok on the real core registry (all tools are complete, no stubs)', () => {
    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'mcp-surface-completeness')!;
    expect(check.status).toBe('ok');
    expect(check.reason).toMatch(/complete/i);
  });
});

// ── provider-compatibility ────────────────────────────────────────────────────

describe('doctor check: provider-compatibility', () => {
  it('returns ok (skipped) when no probe is provided', () => {
    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'provider-compatibility')!;
    expect(check.status).toBe('ok');
    expect(check.reason).toMatch(/skipped/i);
  });

  it('returns ok when all providers are healthy (not skewed, all capabilities present)', () => {
    const probe: ProviderProbeSeam = (provider) => ({
      version: `${provider}-1.0.0`,
      versionSkewed: false,
      capabilities: [...REQUIRED_CAPABILITIES],
    });

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir, providerProbe: probe });
    const check = report.checks.find((c) => c.name === 'provider-compatibility')!;
    expect(check.status).toBe('ok');
    expect(check.reason).toMatch(/claude-1\.0\.0/);
    expect(check.reason).toMatch(/codex-1\.0\.0/);
  });

  it('returns warn when a provider has version skew but all required capabilities', () => {
    const probe: ProviderProbeSeam = (provider) => ({
      version: provider === 'claude' ? '0.9.0' : '1.0.0',
      versionSkewed: provider === 'claude',
      capabilities: [...REQUIRED_CAPABILITIES],
    });

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir, providerProbe: probe });
    const check = report.checks.find((c) => c.name === 'provider-compatibility')!;
    expect(check.status).toBe('warn');
    expect(check.reason).toMatch(/version skew/i);
    expect(check.reason).toMatch(/proceed.*at-risk/i);
  });

  it('returns fail (hard-stop) when a provider is missing a required capability', () => {
    const probe: ProviderProbeSeam = (provider) => {
      const result: ProviderProbeResult = {
        version: '1.0.0',
        versionSkewed: false,
        // codex is missing 'inference'
        capabilities: provider === 'claude' ? [...REQUIRED_CAPABILITIES] : ['tool-use'],
      };
      return result;
    };

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir, providerProbe: probe });
    const check = report.checks.find((c) => c.name === 'provider-compatibility')!;
    expect(check.status).toBe('fail');
    expect(check.reason).toMatch(/inference/);
    expect(check.reason).toMatch(/hard-stop/i);
  });

  it('version skew alone does NOT hard-stop — warn takes precedence over ok when mixed', () => {
    // claude = skewed, codex = ok → overall warn (not fail)
    const probe: ProviderProbeSeam = (provider) => ({
      version: '1.0.0',
      versionSkewed: provider === 'claude',
      capabilities: [...REQUIRED_CAPABILITIES],
    });

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir, providerProbe: probe });
    const check = report.checks.find((c) => c.name === 'provider-compatibility')!;
    expect(check.status).toBe('warn');
  });
});

// ── github-auth (RC-2 visibility) ──────────────────────────────────────────────

describe('doctor check: github-auth', () => {
  it('skips (ok, not run) when no probe is wired — and never prints the word "skipped"', () => {
    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const check = report.checks.find((c) => c.name === 'github-auth')!;
    expect(check.status).toBe('ok');
    expect(check.reason).not.toMatch(/skipped/i);
  });

  it('ok when authenticated', () => {
    const report = runDoctor({
      projectId: PROJECT_ID,
      repoRoot: repoDir,
      githubAuthProbe: () => ({ authenticated: true }),
    });
    const check = report.checks.find((c) => c.name === 'github-auth')!;
    expect(check.status).toBe('ok');
  });

  it('WARN (not fail) when not authenticated — offline/owner-local still works', () => {
    const report = runDoctor({
      projectId: PROJECT_ID,
      repoRoot: repoDir,
      githubAuthProbe: () => ({
        authenticated: false,
        diagnostic: 'gh auth status: not logged in',
      }),
    });
    const check = report.checks.find((c) => c.name === 'github-auth')!;
    expect(check.status).toBe('warn');
    expect(check.reason).toMatch(/gh auth login/i);
    // A missing remote auth must NOT hard-fail the doctor (offline operators run fine).
    expect(report.checks.find((c) => c.name === 'github-auth')!.status).not.toBe('fail');
  });
});

describe('defaultGithubAuthProbe', () => {
  it('authenticated via an explicit token env without invoking gh', () => {
    let ghCalled = false;
    const probe = defaultGithubAuthProbe({
      env: { CO_GH_TOKEN: 'gho_x' },
      command: () => {
        ghCalled = true;
        return { stdout: '', stderr: '', status: 1 };
      },
    });
    expect(probe().authenticated).toBe(true);
    expect(ghCalled).toBe(false);
  });

  it('authenticated when `gh auth token` returns a token', () => {
    const probe = defaultGithubAuthProbe({
      env: {},
      command: (command, args) =>
        command === 'gh' && args.join(' ') === 'auth token'
          ? { stdout: 'gho_token\n', stderr: '', status: 0 }
          : { stdout: '', stderr: 'no', status: 1 },
    });
    expect(probe().authenticated).toBe(true);
  });

  it('not authenticated when `gh auth status` succeeds but `gh auth token` fails', () => {
    const probe = defaultGithubAuthProbe({
      env: {},
      command: (command, args) => {
        if (command === 'gh' && args.join(' ') === 'auth status') {
          return { stdout: 'Logged in', stderr: '', status: 0 };
        }
        if (command === 'gh' && args.join(' ') === 'auth token') {
          return { stdout: '', stderr: 'no token available', status: 1 };
        }
        return { stdout: '', stderr: 'not found', status: 127 };
      },
    });
    const result = probe();
    expect(result.authenticated).toBe(false);
    expect(result.diagnostic).toMatch(/gh auth token/i);
  });

  it('not authenticated when no env token and `gh auth token` fails', () => {
    const probe = defaultGithubAuthProbe({
      env: {},
      command: () => ({
        stdout: '',
        stderr: 'You are not logged into any GitHub hosts',
        status: 1,
      }),
    });
    const result = probe();
    expect(result.authenticated).toBe(false);
    expect(result.diagnostic).toMatch(/gh auth token/i);
  });
});

// ── default provider probe ([host-live] metadata-only binary checks) ───────────

describe('defaultProviderProbe', () => {
  it('runs only provider metadata commands and returns observed versions + capabilities', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const command: ProviderProbeCommand = (cmd, args) => {
      calls.push({ command: cmd, args: [...args] });
      if (cmd === 'claude' && args.join(' ') === '--version') {
        return { stdout: '2.1.158 (Claude Code)\n', stderr: '', status: 0 };
      }
      if (cmd === 'claude' && args.join(' ') === 'auth status --json') {
        return { stdout: '{"logged_in":true}\n', stderr: '', status: 0 };
      }
      if (cmd === 'codex' && args.join(' ') === '--version') {
        return { stdout: 'codex-cli 0.139.0\n', stderr: '', status: 0 };
      }
      if (cmd === 'codex' && args.join(' ') === 'doctor --json') {
        return { stdout: '{"authenticated":true,"status":"warning"}\n', stderr: '', status: 0 };
      }
      return { stdout: '', stderr: 'unexpected command', status: 127 };
    };
    const probe = defaultProviderProbe({ command });

    expect(probe('claude')).toEqual({
      version: '2.1.158 (Claude Code)',
      versionSkewed: false,
      capabilities: [...REQUIRED_CAPABILITIES],
    });
    expect(probe('codex')).toEqual({
      version: 'codex-cli 0.139.0',
      versionSkewed: false,
      capabilities: [...REQUIRED_CAPABILITIES],
    });
    expect(calls).toEqual([
      { command: 'claude', args: ['--version'] },
      { command: 'claude', args: ['auth', 'status', '--json'] },
      { command: 'codex', args: ['--version'] },
      { command: 'codex', args: ['doctor', '--json'] },
    ]);
    for (const call of calls) {
      expect(
        call.args.some((arg) => /exec|prompt|complete|completion|--message|query|-p/i.test(arg)),
      ).toBe(false);
    }
  });

  it('fails closed with no capabilities when a provider binary is unreachable', () => {
    const command: ProviderProbeCommand = () => ({
      stdout: '',
      stderr: '',
      status: null,
      error: new Error('ENOENT'),
    });
    const probe = defaultProviderProbe({ command });

    const result = probe('claude');
    expect(result.version).toBeUndefined();
    expect(result.versionSkewed).toBe(true);
    expect(result.capabilities).toEqual([]);
    expect(result.diagnostic).toMatch(/ENOENT/);
  });

  it('fails closed when codex doctor reports an overall failure payload', () => {
    const command: ProviderProbeCommand = (cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === '--version') {
        return { stdout: 'codex-cli 0.139.0\n', stderr: '', status: 0 };
      }
      if (cmd === 'codex' && args.join(' ') === 'doctor --json') {
        return {
          stdout: '{"authenticated":true,"overallStatus":"fail"}\n',
          stderr: '',
          status: 1,
        };
      }
      return { stdout: '', stderr: 'unexpected command', status: 127 };
    };
    const probe = defaultProviderProbe({ command });

    const result = probe('codex');
    expect(result.version).toBe('codex-cli 0.139.0');
    expect(result.versionSkewed).toBe(false);
    expect(result.capabilities).toEqual([]);
    expect(result.diagnostic).toMatch(/codex doctor --json failed/i);
  });

  it('fails closed when claude auth status returns malformed JSON', () => {
    const command: ProviderProbeCommand = (cmd, args) => {
      if (cmd === 'claude' && args.join(' ') === '--version') {
        return { stdout: '2.1.158 (Claude Code)\n', stderr: '', status: 0 };
      }
      if (cmd === 'claude' && args.join(' ') === 'auth status --json') {
        return { stdout: '{not json', stderr: '', status: 0 };
      }
      return { stdout: '', stderr: 'unexpected command', status: 127 };
    };
    const probe = defaultProviderProbe({ command });

    const result = probe('claude');
    expect(result.version).toBe('2.1.158 (Claude Code)');
    expect(result.capabilities).toEqual([]);
    expect(result.diagnostic).toMatch(/invalid json/i);
  });

  it('fails closed when codex doctor returns malformed JSON', () => {
    const command: ProviderProbeCommand = (cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === '--version') {
        return { stdout: 'codex-cli 0.139.0\n', stderr: '', status: 0 };
      }
      if (cmd === 'codex' && args.join(' ') === 'doctor --json') {
        return { stdout: '{not json', stderr: '', status: 0 };
      }
      return { stdout: '', stderr: 'unexpected command', status: 127 };
    };
    const probe = defaultProviderProbe({ command });

    const result = probe('codex');
    expect(result.version).toBe('codex-cli 0.139.0');
    expect(result.capabilities).toEqual([]);
    expect(result.diagnostic).toMatch(/invalid json/i);
  });

  it('fails closed when codex doctor exits nonzero even with healthy-looking stdout', () => {
    const command: ProviderProbeCommand = (cmd, args) => {
      if (cmd === 'codex' && args.join(' ') === '--version') {
        return { stdout: 'codex-cli 0.139.0\n', stderr: '', status: 0 };
      }
      if (cmd === 'codex' && args.join(' ') === 'doctor --json') {
        return { stdout: '{"authenticated":true,"status":"ok"}\n', stderr: '', status: 1 };
      }
      return { stdout: '', stderr: 'unexpected command', status: 127 };
    };
    const probe = defaultProviderProbe({ command });

    const result = probe('codex');
    expect(result.version).toBe('codex-cli 0.139.0');
    expect(result.capabilities).toEqual([]);
    expect(result.diagnostic).toMatch(/codex doctor --json failed/i);
  });
});

// ── runDoctor integration ─────────────────────────────────────────────────────

describe('runDoctor integration', () => {
  it('emits exactly six checks', () => {
    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    expect(report.checks).toHaveLength(6);
    const names = report.checks.map((c) => c.name);
    expect(names).toContain('program-data-integrity');
    expect(names).toContain('global-data-integrity');
    expect(names).toContain('project-memory-validity');
    expect(names).toContain('mcp-surface-completeness');
    expect(names).toContain('provider-compatibility');
    expect(names).toContain('github-auth');
  });

  it('every check has a non-empty reason (no silent failures)', () => {
    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    for (const check of report.checks) {
      expect(check.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('healthy is false when any check fails', () => {
    // project-memory-validity will fail (no memory files → fail)
    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir });
    const memCheck = report.checks.find((c) => c.name === 'project-memory-validity')!;
    expect(memCheck.status).toBe('fail');
    expect(report.healthy).toBe(false);
  });

  it('healthy is false when any check is warn', () => {
    writeClaudeMd(); // no AGENTS.md → warn
    const probe: ProviderProbeSeam = () => ({
      version: '1.0.0',
      versionSkewed: false,
      capabilities: [...REQUIRED_CAPABILITIES],
    });

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir, providerProbe: probe });
    const memCheck = report.checks.find((c) => c.name === 'project-memory-validity')!;
    expect(memCheck.status).toBe('warn');
    expect(report.healthy).toBe(false);
  });

  it('healthy is true only when all checks are ok', () => {
    writeClaudeMd();
    writeAgentsMd();
    seedRoster();

    const probe: ProviderProbeSeam = () => ({
      version: '1.0.0',
      versionSkewed: false,
      capabilities: [...REQUIRED_CAPABILITIES],
    });

    const report = runDoctor({ projectId: PROJECT_ID, repoRoot: repoDir, providerProbe: probe });
    for (const check of report.checks) {
      expect(check.status).toBe('ok');
    }
    expect(report.healthy).toBe(true);
  });
});

// ── Observability ─────────────────────────────────────────────────────────────

describe('queryObservability', () => {
  it('returns empty snapshot for an empty store', () => {
    const store = openProjectStore(PROJECT_ID);
    store.close();

    const snap = queryObservability(PROJECT_ID);
    expect(snap.agents).toHaveLength(0);
    expect(snap.plans).toHaveLength(0);
    expect(snap.reviews).toHaveLength(0);
    expect(snap.costRollups).toHaveLength(0);
  });

  it('aggregates all four dimensions from a seeded store', () => {
    seedRoster();
    seedPlans();
    seedCost();
    seedReviews();

    const snap = queryObservability(PROJECT_ID);

    // roster
    expect(snap.agents).toHaveLength(2);
    expect(snap.agents.map((a) => a.agentId).sort()).toEqual(['coord-1', 'impl-1']);

    // plans (one plan with two phases)
    expect(snap.plans).toHaveLength(1);
    expect(snap.plans[0]?.taskId).toBe('task-p6');
    expect(snap.plans[0]?.phases).toHaveLength(2);

    // reviews
    expect(snap.reviews).toHaveLength(1);
    expect(snap.reviews[0]?.target).toBe('main');
    expect(snap.reviews[0]?.branch).toBe('co/impl-1');
    expect(snap.reviews[0]?.verdict).toBeUndefined(); // no verdict yet

    // cost rollups (agent + task rollup for impl-1 / task-p6)
    expect(snap.costRollups.length).toBeGreaterThanOrEqual(2);
    const agentRollup = snap.costRollups.find((r) => r.kind === 'agent' && r.id === 'impl-1');
    const taskRollup = snap.costRollups.find((r) => r.kind === 'task' && r.id === 'task-p6');
    expect(agentRollup).toBeDefined();
    expect(taskRollup).toBeDefined();
    expect(agentRollup?.totalCostUsd).toBeCloseTo(0.05);
  });

  it('carries operator-provided agent names into the live view', () => {
    const roster = openRosterStore(PROJECT_ID);
    try {
      roster.recordAgent({
        agentId: 'coord-auth-9f3a1c',
        role: 'coordinator',
        parent: '@operator',
        name: 'Auth refactor',
      });
    } finally {
      roster.close();
    }

    const snap = queryLiveObservability(PROJECT_ID, {
      liveStates: (agentIds) =>
        agentIds.map((agentId) => ({
          agentId,
          hosted: false,
          outstandingMail: 0,
          paused: false,
          stuck: false,
          stopped: false,
        })),
    });

    expect(snap.agents[0]).toMatchObject({
      agentId: 'coord-auth-9f3a1c',
      name: 'Auth refactor',
    });
  });

  it('phase status is accessible from the plans dimension', () => {
    seedRoster();
    seedPlans();

    const snap = queryObservability(PROJECT_ID);
    const plan = snap.plans[0]!;
    for (const phase of plan.phases) {
      expect(phase.status).toBe('planned'); // initial status
    }
  });

  it('review verdict is visible once set', () => {
    seedRoster();
    const review = openReviewStore(PROJECT_ID);
    review.recordReviewRequested({
      reviewId: 'rev-002',
      target: 'main',
      branch: 'co/feature',
      scope: 'worker_merge',
      requestedBy: 'coord-1',
    });
    review.recordVerdict({
      reviewId: 'rev-002',
      target: 'main',
      branch: 'co/feature',
      scope: 'worker_merge',
      reviewer: 'rev-agent',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
    });
    review.close();

    const snap = queryObservability(PROJECT_ID);
    const r = snap.reviews.find((x) => x.branch === 'co/feature');
    expect(r).toBeDefined();
    expect(r?.verdict).toBe('PASS');
  });
});
