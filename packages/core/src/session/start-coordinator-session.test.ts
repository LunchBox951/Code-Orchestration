/**
 * Stage 14 · P1 (KEYSTONE) — unit acceptance for the START PRIMITIVE {@link startCoordinatorSession}.
 *
 * Proves, over a real throwaway git repo + program-data stores:
 *   - it PROVISIONS the root's worktree (a live record keyed to the root agent id + a real checkout),
 *   - it REGISTERS the root in the roster as a `coordinator` whose parent is `@operator` (idempotent),
 *   - the kickoff is an ACTIONABLE `clarify_request` from `@operator` to the root (NOT an informational
 *     `operator_message`) carrying the prompt / draft-spec brief,
 *   - it mints NO `session.created` itself (the daemon does that on cold start),
 *   - exactly one of `prompt` / `specBody` is required (both or neither fails loud — Principle 9),
 *   - the root coordinator id is deterministic (derived from the project id; no wall clock / randomness).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATOR, mailKind } from '../mail/events.js';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { openRosterStore, type RosterStore } from '../roles/roster-store.js';
import { openSessionStore } from '../session/session-store.js';
import { openWorktreeStore } from '../worktrees/worktree-store.js';
import { openRegistry } from '../registry/registry.js';
import type { SlingDeps } from '../worktrees/sling.js';
import { rootCoordinatorId, startCoordinatorSession } from './start-coordinator-session.js';

const ORIGINAL_ENV = process.env;
let dirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dirs = [];
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

/** A real repo (no remote → offline), on `main` with one base commit (mirrors sh1-dry-run.makeRepo). */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-start-repo-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), 'base\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync(
    'git',
    ['commit', '-m', 'chore: init', '-m', 'Signed-off-by: Test <t@example.com>'],
    {
      cwd: dir,
      stdio: 'ignore',
    },
  );
  return dir;
}

function makeProject(): { projectId: string; repo: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-start-data-'));
  dirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const repo = makeRepo();
  const registry = openRegistry();
  try {
    return { projectId: registry.register(repo), repo };
  } finally {
    registry.close();
  }
}

// A no-op provisioner + clean baseline so the worktree-provisioning is deterministic (no manifest I/O).
const SLING_DEPS: SlingDeps = {
  provisioner: () => ({ provisioned: [], skipped: [] }),
  probe: () => [],
};

describe('startCoordinatorSession — provisions worktree, registers the root, seeds the actionable kickoff, mints no session', () => {
  it('writes the roster + worktree records and an actionable clarify_request kickoff, with NO session', () => {
    const { projectId, repo } = makeProject();

    const result = startCoordinatorSession(
      { projectId, repoCwd: repo, prompt: 'orchestrate the toy change', base: 'main' },
      { slingDeps: SLING_DEPS },
    );

    // Deterministic root id + branch.
    expect(result.coordinator).toBe(rootCoordinatorId(projectId));
    expect(result.branch).toBe(`co/${result.coordinator}`);

    // (1) WORKTREE: a live record keyed to the root agent id, with a real checkout on the root's branch.
    const wt = openWorktreeStore(projectId);
    try {
      const record = wt.getWorktree(result.branch);
      expect(record?.removed).toBe(false);
      expect(record?.agent).toBe(result.coordinator);
      expect(record?.role).toBe('coordinator');
      expect(record?.parent).toBe(OPERATOR);
      expect(record?.path).toBe(result.worktreePath);
    } finally {
      wt.close();
    }
    expect(existsSync(result.worktreePath)).toBe(true);

    // (2) ROSTER: a coordinator parented to @operator.
    const roster = openRosterStore(projectId);
    try {
      expect(roster.getAgent(result.coordinator)).toMatchObject({
        agentId: result.coordinator,
        role: 'coordinator',
        parent: OPERATOR,
      });
    } finally {
      roster.close();
    }

    // (3) KICKOFF: an ACTIONABLE clarify_request from @operator to the root, carrying the prompt.
    const mail = openMailStore(projectId);
    try {
      const outstanding = mail.outstanding(result.coordinator);
      expect(outstanding).toHaveLength(1);
      const kickoff = outstanding[0]!;
      expect(kickoff.type).toBe('clarify_request');
      expect(mailKind(kickoff.type)).toBe('actionable');
      expect(kickoff.sender).toBe(OPERATOR);
      expect(kickoff.recipient).toBe(result.coordinator);
      expect(kickoff.body).toBe('orchestrate the toy change');
    } finally {
      mail.close();
    }

    // (4) NO SESSION minted by the primitive — the daemon mints it on cold start.
    const sessions = openSessionStore(projectId);
    try {
      expect(sessions.listSessions()).toHaveLength(0);
      expect(sessions.getSession(result.coordinator)).toBeUndefined();
    } finally {
      sessions.close();
    }
  });

  it('starts from a draft spec body (the kickoff carries the brief)', () => {
    const { projectId, repo } = makeProject();
    const result = startCoordinatorSession(
      { projectId, repoCwd: repo, specBody: 'DRAFT SPEC: build the thing', base: 'main' },
      { slingDeps: SLING_DEPS },
    );
    const mail = openMailStore(projectId);
    try {
      const kickoff = mail.outstanding(result.coordinator)[0]!;
      expect(kickoff.type).toBe('clarify_request');
      expect(kickoff.body).toBe('DRAFT SPEC: build the thing');
    } finally {
      mail.close();
    }
  });

  it('roster registration is idempotent (re-asserting the same root is safe)', () => {
    const { projectId, repo } = makeProject();
    const coordinator = rootCoordinatorId(projectId);
    // Pre-register the root exactly as the daemon's hostSession would idempotently re-assert it.
    const roster = openRosterStore(projectId);
    try {
      roster.recordAgent({ agentId: coordinator, role: 'coordinator', parent: OPERATOR });
    } finally {
      roster.close();
    }
    expect(() =>
      startCoordinatorSession(
        { projectId, repoCwd: repo, prompt: 'go', base: 'main' },
        { slingDeps: SLING_DEPS },
      ),
    ).not.toThrow();
  });

  it('cleans up the provisioned root worktree when roster registration fails', () => {
    const { projectId, repo } = makeProject();
    const coordinator = rootCoordinatorId(projectId);
    const branch = `co/${coordinator}`;

    expect(() =>
      startCoordinatorSession(
        { projectId, repoCwd: repo, prompt: 'go', base: 'main' },
        {
          slingDeps: SLING_DEPS,
          openRoster: () =>
            ({
              recordAgent: () => {
                throw new Error('roster failed');
              },
              close: () => {},
            }) as unknown as RosterStore,
        },
      ),
    ).toThrow(/roster failed/i);

    const wt = openWorktreeStore(projectId);
    try {
      expect(wt.getWorktree(branch)?.removed).toBe(true);
    } finally {
      wt.close();
    }
    expect(() =>
      execFileSync('git', ['rev-parse', '--verify', branch], { cwd: repo, stdio: 'ignore' }),
    ).toThrow();
  });

  it('cleans up the provisioned root worktree when kickoff mail fails', () => {
    const { projectId, repo } = makeProject();
    const coordinator = rootCoordinatorId(projectId);
    const branch = `co/${coordinator}`;

    expect(() =>
      startCoordinatorSession(
        { projectId, repoCwd: repo, prompt: 'go', base: 'main' },
        {
          slingDeps: SLING_DEPS,
          openMail: () =>
            ({
              send: () => {
                throw new Error('mail failed');
              },
              close: () => {},
            }) as unknown as MailStore,
        },
      ),
    ).toThrow(/mail failed/i);

    const wt = openWorktreeStore(projectId);
    try {
      expect(wt.getWorktree(branch)?.removed).toBe(true);
    } finally {
      wt.close();
    }
    const mail = openMailStore(projectId);
    try {
      expect(mail.outstanding(coordinator)).toHaveLength(0);
    } finally {
      mail.close();
    }
    expect(() =>
      execFileSync('git', ['rev-parse', '--verify', branch], { cwd: repo, stdio: 'ignore' }),
    ).toThrow();
  });

  it('fails loud when BOTH --prompt and --spec are supplied', () => {
    const { projectId, repo } = makeProject();
    expect(() =>
      startCoordinatorSession(
        { projectId, repoCwd: repo, prompt: 'a', specBody: 'b', base: 'main' },
        { slingDeps: SLING_DEPS },
      ),
    ).toThrow(/exactly one of/i);
  });

  it('fails loud when NEITHER --prompt nor --spec is supplied', () => {
    const { projectId, repo } = makeProject();
    expect(() =>
      startCoordinatorSession(
        { projectId, repoCwd: repo, base: 'main' },
        { slingDeps: SLING_DEPS },
      ),
    ).toThrow(/exactly one of/i);
  });

  it('rootCoordinatorId is deterministic + branch-safe (same project ⇒ same id)', () => {
    expect(rootCoordinatorId('proj-abc')).toBe(rootCoordinatorId('proj-abc'));
    expect(rootCoordinatorId('proj-abc')).toMatch(/^coord-root-[0-9a-f]{8}$/);
    expect(rootCoordinatorId('proj-abc')).not.toBe(rootCoordinatorId('proj-xyz'));
  });
});
