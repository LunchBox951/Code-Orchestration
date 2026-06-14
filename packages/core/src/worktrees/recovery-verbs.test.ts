import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkToolCompleteness } from '../tools/completeness.js';
import { buildCoreRegistry } from '../tools/core-registry.js';
import { BASE_ROLES, toolsForRole } from '../tools/index.js';
import { openWorktreeStore, type WorktreeStore } from './worktree-store.js';
import {
  CleanupGateImpl,
  CleanupGateStub,
  type AgentRouterSeam,
  type CleanupGateDeps,
  type CleanupGate,
} from './cleanup-gate.js';
import { worktreePathFor } from './sling.js';
import type { WorktreeCreated } from './events.js';

// AC-S9-5 — operator recovery/cleanup verbs (operator-only).
//
// These tests prove, over injected git/fs/router seams, that:
//   (1) cleanup proves the branch merged before removing AND is dry-run by default
//   (2) cleanup refuses a non-merged branch (no silent data loss)
//   (3) nuke is gated — no-op without explicit { confirm: true }
//   (4) unstick genuinely re-wakes a stuck agent within the bounded window (MNR-3)
//   (5) none of the recovery verbs is registered as an agent MCP tool
//   (6) CleanupGateStub still fails loud on every verb (Principle 9)

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let stores: WorktreeStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  stores = [];
  const data = mkdtempSync(join(tmpdir(), 'co-recovery-verbs-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const s of stores) s.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  stores = [];
});

function openStore(projectId: string): WorktreeStore {
  const s = openWorktreeStore(projectId);
  stores.push(s);
  return s;
}

const rec = (over: Partial<WorktreeCreated> = {}): WorktreeCreated => ({
  branch: 'co/feature',
  baseRef: 'main',
  baseSha: 'a'.repeat(40),
  path: worktreePathFor('p-recovery', 'co/feature'),
  parent: 'lead-7',
  ...over,
});

/** Build a no-op router spy that records every call. */
function routerSpy(): AgentRouterSeam & {
  calls: Record<keyof AgentRouterSeam, string[]>;
} {
  const calls: Record<keyof AgentRouterSeam, string[]> = {
    revertStuck: [],
    rewake: [],
    pause: [],
    stop: [],
  };
  return {
    calls,
    revertStuck: (id) => {
      calls.revertStuck.push(id);
    },
    rewake: (id) => {
      calls.rewake.push(id);
    },
    pause: (id) => {
      calls.pause.push(id);
    },
    stop: (id) => {
      calls.stop.push(id);
    },
  };
}

/** Build a no-op git spy that records calls. */
function gitSpy(): {
  calls: Array<{ cwd: string; args: readonly string[] }>;
  exec: (cwd: string, args: readonly string[]) => void;
} {
  const calls: Array<{ cwd: string; args: readonly string[] }> = [];
  return {
    calls,
    exec: (cwd, args) => {
      calls.push({ cwd, args });
    },
  };
}

/** Build a no-op FS seam (dir always absent, removeDir is a no-op). */
function nopFs() {
  const removed: string[] = [];
  return {
    removed,
    exists: () => false,
    isSymlink: () => false,
    realpath: (p: string) => p,
    removeDir: (p: string) => {
      removed.push(p);
    },
  };
}

/** Build a CleanupGateImpl with injected seams for headless tests. */
function makeGate(
  projectId: string,
  overrides: Partial<CleanupGateDeps> = {},
): {
  gate: CleanupGateImpl;
  store: WorktreeStore;
  router: ReturnType<typeof routerSpy>;
  git: ReturnType<typeof gitSpy>;
} {
  const store = openStore(projectId);
  const router = routerSpy();
  const git = gitSpy();
  const deps: CleanupGateDeps = {
    store,
    repoCwd: '/fake/repo',
    mergeProbe: () => true,
    repair: (cwd) => {
      git.calls.push({ cwd, args: ['worktree', 'prune'] });
    },
    router,
    gitExec: git.exec,
    fs: nopFs(),
    ...overrides,
  };
  const gate = new CleanupGateImpl(deps);
  return { gate, store, router, git };
}

// ── CleanupGateStub: loud-fail preserved (Principle 9) ───────────────────────────────────────────

describe('CleanupGateStub — loud-fail preserved (Principle 9)', () => {
  it('cleanup throws a typed L8-named error', () => {
    const gate: CleanupGate = new CleanupGateStub();
    expect(() => gate.cleanup('co/x')).toThrow(/cleanup.*not implemented at L3.*L8 plug-point/s);
  });

  it('unstick throws a typed L8-named error', () => {
    const gate: CleanupGate = new CleanupGateStub();
    expect(() => gate.unstick('co/x')).toThrow(/unstick.*not implemented at L3.*L8 plug-point/s);
  });

  it('nuke throws a typed L8-named error', () => {
    const gate: CleanupGate = new CleanupGateStub();
    expect(() => gate.nuke('co/x', { confirm: true })).toThrow(
      /nuke.*not implemented at L3.*L8 plug-point/s,
    );
  });

  it('pause throws a typed L8-named error', () => {
    const gate: CleanupGate = new CleanupGateStub();
    expect(() => gate.pause('agent-1')).toThrow(/pause.*not implemented at L3.*L8 plug-point/s);
  });

  it('stop throws a typed L8-named error', () => {
    const gate: CleanupGate = new CleanupGateStub();
    expect(() => gate.stop('agent-1')).toThrow(/stop.*not implemented at L3.*L8 plug-point/s);
  });
});

// ── cleanup: dry-run by default (AC-S9-5) ────────────────────────────────────────────────────────

describe('cleanup — dry-run by default (AC-S9-5)', () => {
  it('returns a dry-run report and does NOT remove the sandbox when called without opts', () => {
    const { gate, store } = makeGate('p-cleanup-dryrun');
    const branch = 'co/done';
    const path = worktreePathFor('p-cleanup-dryrun', branch);
    store.recordWorktree(rec({ branch, path, parent: 'lead-7' }));

    const report = gate.cleanup(branch);

    expect(report.dryRun).toBe(true);
    expect(report.branch).toBe(branch);
    if (report.dryRun) {
      expect(report.wouldRemovePath).toBe(path);
    }
    // The record must NOT be marked removed — dry-run removes nothing.
    expect(store.getWorktree(branch)?.removed).toBe(false);
  });

  it('dry-run with explicit dryRun: true also removes nothing', () => {
    const { gate, store } = makeGate('p-cleanup-dryrun-explicit');
    const branch = 'co/dry';
    const path = worktreePathFor('p-cleanup-dryrun-explicit', branch);
    store.recordWorktree(rec({ branch, path, parent: 'lead-7' }));

    const report = gate.cleanup(branch, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(store.getWorktree(branch)?.removed).toBe(false);
  });

  it('actually removes when dryRun: false is passed', () => {
    const { gate, store } = makeGate('p-cleanup-execute');
    const branch = 'co/real';
    const path = worktreePathFor('p-cleanup-execute', branch);
    store.recordWorktree(rec({ branch, path, parent: 'lead-7' }));

    const report = gate.cleanup(branch, { dryRun: false });

    expect(report.dryRun).toBe(false);
    expect(report.branch).toBe(branch);
    if (!report.dryRun) {
      expect(report.removed.branch).toBe(branch);
      expect(report.removed.removed).toBe(true);
    }
    expect(store.getWorktree(branch)?.removed).toBe(true);
  });
});

// ── cleanup: proves merged before removing (AC-S9-5) ─────────────────────────────────────────────

describe('cleanup — proves merged before removing, refuses unmerged (AC-S9-5)', () => {
  it('refuses (throws) when the merge probe returns false, touching nothing', () => {
    const { gate, store } = makeGate('p-cleanup-unmerged', {
      mergeProbe: () => false,
    });
    const branch = 'co/open';
    const path = worktreePathFor('p-cleanup-unmerged', branch);
    store.recordWorktree(rec({ branch, path, parent: 'lead-7' }));

    expect(() => gate.cleanup(branch, { dryRun: false })).toThrow(
      /NOT proven merged|no silent data loss/i,
    );
    // The record must still be live — nothing was removed.
    expect(store.getWorktree(branch)?.removed).toBe(false);
  });

  it('refuses even in dry-run mode when not merged (merge-proof gates the report itself)', () => {
    const { gate, store } = makeGate('p-cleanup-unmerged-dry', {
      mergeProbe: () => false,
    });
    const branch = 'co/wip';
    const path = worktreePathFor('p-cleanup-unmerged-dry', branch);
    store.recordWorktree(rec({ branch, path, parent: 'lead-7' }));

    // Even a dry-run must refuse to report "would remove" for an unmerged branch.
    expect(() => gate.cleanup(branch)).toThrow(/NOT proven merged/i);
    expect(store.getWorktree(branch)?.removed).toBe(false);
  });

  it('cleanup passes the branch and targetRef to the merge probe', () => {
    const probeCalls: Array<{ branch: string; targetRef: string }> = [];
    const { gate, store } = makeGate('p-cleanup-probe-args', {
      mergeProbe: (b, t) => {
        probeCalls.push({ branch: b, targetRef: t });
        return true;
      },
    });
    const branch = 'co/probe';
    const path = worktreePathFor('p-cleanup-probe-args', branch);
    store.recordWorktree(rec({ branch, path, parent: 'lead-7' }));

    gate.cleanup(branch, { dryRun: true, targetRef: 'dev' });

    expect(probeCalls).toEqual([{ branch, targetRef: 'dev' }]);
  });

  it('cleanup defaults targetRef to "main" when not specified', () => {
    const probeCalls: Array<{ branch: string; targetRef: string }> = [];
    const { gate, store } = makeGate('p-cleanup-default-target', {
      mergeProbe: (b, t) => {
        probeCalls.push({ branch: b, targetRef: t });
        return true;
      },
    });
    const branch = 'co/default';
    const path = worktreePathFor('p-cleanup-default-target', branch);
    store.recordWorktree(rec({ branch, path, parent: 'lead-7' }));

    gate.cleanup(branch);

    expect(probeCalls[0]?.targetRef).toBe('main');
  });

  it('cleanup fails loud for an unrecorded branch (Principle 9)', () => {
    const { gate } = makeGate('p-cleanup-unrecorded');
    expect(() => gate.cleanup('co/never')).toThrow(/no worktree recorded/i);
  });
});

// ── cleanup: orphan reconciliation ───────────────────────────────────────────────────────────────

describe('cleanup — surfaces orphans alongside the sweep', () => {
  it('dry-run includes orphans found', () => {
    const { gate, store } = makeGate('p-cleanup-orphans-dry');
    const branch = 'co/a';
    const path = worktreePathFor('p-cleanup-orphans-dry', branch);
    store.recordWorktree(rec({ branch, path, parent: 'lead-7' }));
    // Record a second branch whose dir will be absent → dangling-record orphan.
    store.recordWorktree(
      rec({ branch: 'co/dangling', path: '/nonexistent/sandbox', parent: 'lead-7' }),
    );

    const report = gate.cleanup(branch, { dryRun: true });

    expect(report.dryRun).toBe(true);
    if (report.dryRun) {
      expect(report.orphansFound.some((o) => o.kind === 'dangling-record')).toBe(true);
    }
  });
});

// ── nuke: gated — requires explicit confirm (AC-S9-5) ────────────────────────────────────────────

describe('nuke — gated (AC-S9-5)', () => {
  it('force-removes the sandbox when { confirm: true } is given', () => {
    const { gate, store } = makeGate('p-nuke-confirm');
    const branch = 'co/condemned';
    const path = worktreePathFor('p-nuke-confirm', branch);
    store.recordWorktree(rec({ branch, path, parent: 'lead-7' }));

    const removed = gate.nuke(branch, { confirm: true });

    expect(removed.branch).toBe(branch);
    expect(removed.removed).toBe(true);
    expect(store.getWorktree(branch)?.removed).toBe(true);
  });

  it('bypasses the merge probe (no merge check — force removal)', () => {
    const probeCalls: string[] = [];
    const { gate, store } = makeGate('p-nuke-noprobe', {
      mergeProbe: (b) => {
        probeCalls.push(b);
        return false;
      },
    });
    const branch = 'co/force';
    const path = worktreePathFor('p-nuke-noprobe', branch);
    store.recordWorktree(rec({ branch, path, parent: 'lead-7' }));

    gate.nuke(branch, { confirm: true });

    expect(probeCalls).toHaveLength(0);
    expect(store.getWorktree(branch)?.removed).toBe(true);
  });

  it('TypeScript enforces confirm: true at the type level (runtime defence stays green)', () => {
    // The type says `confirm: true` so you cannot pass false at compile time.
    // This test proves the runtime guard is there too (via a cast), so headless callers can't slip.
    const { gate, store } = makeGate('p-nuke-noconfirm');
    const branch = 'co/no-confirm';
    const path = worktreePathFor('p-nuke-noconfirm', branch);
    store.recordWorktree(rec({ branch, path, parent: 'lead-7' }));

    // Cast to bypass the type system — proves the runtime guard works.
    expect(() => gate.nuke(branch, { confirm: false } as unknown as { confirm: true })).toThrow(
      /explicit operator confirmation required/i,
    );
    expect(store.getWorktree(branch)?.removed).toBe(false);
  });
});

// ── unstick: genuinely re-wakes a stuck agent (MNR-3) (AC-S9-5) ──────────────────────────────────

describe('unstick — genuinely re-wakes a stuck agent within the bounded window (MNR-3)', () => {
  it('invokes the router seam revertStuck + rewake keyed by the recorded agentId — NOT the branch (MNR-3 round-trip)', () => {
    // MNR-3: unstick must resolve branch → agentId and pass the agentId to the router seam,
    // never the branch string (which would silently revert the wrong key).
    const branch = 'co/stuck';
    const agentId = 'impl-stuck-agent';
    const { gate, router, store } = makeGate('p-unstick-rewake');
    store.recordWorktree(
      rec({ branch, agent: agentId, path: worktreePathFor('p-unstick-rewake', branch) }),
    );

    const report = gate.unstick(branch);

    // The STUCK flip must be reverted using the agentId, not the branch string.
    expect(router.calls.revertStuck).toEqual([agentId]);
    // The agent must be re-woken using the agentId so the runtime gives it a new turn.
    expect(router.calls.rewake).toEqual([agentId]);
    expect(report.agentRewoken).toBe(true);
    expect(report.repaired).toBe(true);
  });

  it('runs git worktree repair/prune via the seam (git side of unstick)', () => {
    const repairCalls: string[] = [];
    const branch = 'co/stuck';
    const { gate, store } = makeGate('p-unstick-repair', {
      repair: (cwd) => {
        repairCalls.push(cwd);
      },
    });
    store.recordWorktree(
      rec({
        branch,
        agent: 'impl-repair-agent',
        path: worktreePathFor('p-unstick-repair', branch),
      }),
    );

    gate.unstick(branch, { repoCwd: '/main/repo' });

    expect(repairCalls).toEqual(['/main/repo']);
  });

  it('defaults repoCwd to the gate deps repoCwd when not overridden', () => {
    const repairCalls: string[] = [];
    const branch = 'co/stuck';
    const { gate, store } = makeGate('p-unstick-default-cwd', {
      repoCwd: '/default/repo',
      repair: (cwd) => {
        repairCalls.push(cwd);
      },
    });
    store.recordWorktree(
      rec({
        branch,
        agent: 'impl-default-cwd-agent',
        path: worktreePathFor('p-unstick-default-cwd', branch),
      }),
    );

    gate.unstick(branch);

    expect(repairCalls).toEqual(['/default/repo']);
  });

  it('revertStuck and rewake are called IN ORDER (revert before re-wake), keyed by agentId', () => {
    const order: string[] = [];
    const orderedRouter: AgentRouterSeam = {
      revertStuck: (id) => {
        order.push(`revert:${id}`);
      },
      rewake: (id) => {
        order.push(`rewake:${id}`);
      },
      pause: () => {},
      stop: () => {},
    };
    const branch = 'co/agent-1';
    const agentId = 'agent-1';
    const store = openStore('p-unstick-order');
    store.recordWorktree(
      rec({ branch, agent: agentId, path: worktreePathFor('p-unstick-order', branch) }),
    );
    const gate = new CleanupGateImpl({
      store,
      repoCwd: '/repo',
      mergeProbe: () => true,
      repair: () => {},
      router: orderedRouter,
    });

    gate.unstick(branch);

    expect(order).toEqual([`revert:${agentId}`, `rewake:${agentId}`]);
  });

  it('throws loud when no agent is recorded for the branch — refuses to pass a branch as agent id (Principle 9, MNR-3)', () => {
    // P5 previously asserted unstick "does not require a recorded worktree (router side is
    // independent)". That design CAUSED the MNR-3 regression — it is what allowed the branch to
    // be passed as the agent key. unstick now REQUIRES a resolvable recorded agent.
    const { gate, router } = makeGate('p-unstick-no-record');

    // No worktree recorded for 'co/any-agent' → must throw (Principle 9, MNR-3).
    expect(() => gate.unstick('co/any-agent')).toThrow(/MNR-3|no agent recorded/i);
    // revertStuck and rewake must NOT have been called — no partial side effect.
    expect(router.calls.revertStuck).toHaveLength(0);
    expect(router.calls.rewake).toHaveLength(0);
  });
});

// ── pause / stop: agent-lifecycle via router seam ────────────────────────────────────────────────

describe('pause / stop — agent-lifecycle via router seam', () => {
  it('pause delegates to router.pause with the agent id', () => {
    const { gate, router } = makeGate('p-pause');
    gate.pause('agent-abc');
    expect(router.calls.pause).toEqual(['agent-abc']);
  });

  it('stop delegates to router.stop with the agent id', () => {
    const { gate, router } = makeGate('p-stop');
    gate.stop('agent-xyz');
    expect(router.calls.stop).toEqual(['agent-xyz']);
  });

  it('pause and stop are independent (one does not affect the other)', () => {
    const { gate, router } = makeGate('p-pause-stop');
    gate.pause('agent-1');
    gate.stop('agent-2');
    expect(router.calls.pause).toEqual(['agent-1']);
    expect(router.calls.stop).toEqual(['agent-2']);
    expect(router.calls.revertStuck).toHaveLength(0);
    expect(router.calls.rewake).toHaveLength(0);
  });
});

// ── Operator-only: recovery verbs absent from agent MCP registry (AC-S9-5) ───────────────────────

describe('operator-only — recovery verbs NOT registered as agent MCP tools (AC-S9-5)', () => {
  it('the recovery verbs are absent from buildCoreRegistry (completeness gate green by construction)', () => {
    const registry = buildCoreRegistry();
    const names = registry.list().map((s) => s.name);

    // None of the operator recovery verbs may appear in the agent MCP tool surface.
    const operatorOnlyVerbs = ['unstick', 'pause', 'stop', 'cleanup', 'nuke'];
    for (const verb of operatorOnlyVerbs) {
      expect(names.every((n) => !n.includes(verb))).toBe(true);
    }
  });

  it('the completeness gate is GREEN for the real registry (no stubs or partials)', () => {
    const violations = checkToolCompleteness(buildCoreRegistry());
    expect(violations).toEqual([]);
  });

  it('toolsForRole returns no recovery verbs for any role', () => {
    // toolsForRole filters the registry by role — recovery verbs must never appear.
    const operatorVerbs = ['unstick', 'pause', 'stop', 'cleanup', 'nuke'];
    for (const role of BASE_ROLES) {
      const tools = toolsForRole(role);
      for (const tool of tools) {
        expect(operatorVerbs.every((v) => !tool.name.includes(v))).toBe(true);
      }
    }
  });
});
