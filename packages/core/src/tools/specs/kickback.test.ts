import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfigStore, type ConfigStore } from '../../config/config-store.js';
import { MAIL_ESCALATION, MAIL_WORKER_DONE } from '../../mail/events.js';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { REVIEW_ROUND_BUDGET_KEY } from '../../review/strikes.js';
import { openReviewStore, type ReviewStore } from '../../review/review-store.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { openWorktreeStore, type WorktreeStore } from '../../worktrees/worktree-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { toolsForRole } from '../scoping.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

type KickbackOut = {
  kicked_back: boolean;
  action: 'kickback' | 'escalate' | 'noop';
  strike_count: number;
  to: string;
  mail_seq?: number;
  target: string;
  branch: string;
};

// AC-L6a-5 — co_kickback: coordinator/lead kick-back to a direct child, strike tracking,
// escalation at budget, anti-drift checks.

const BRANCH = 'co/feature-x';
const TARGET = 'co/l6a-roles-perms';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let mailStores: MailStore[] = [];
let reviewStores: ReviewStore[] = [];
let rosterStores: RosterStore[] = [];
let worktreeStores: WorktreeStore[] = [];
let configStores: ConfigStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  mailStores = [];
  reviewStores = [];
  rosterStores = [];
  worktreeStores = [];
  configStores = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-kickback-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const m of mailStores) m.close();
  for (const r of reviewStores) r.close();
  for (const r of rosterStores) r.close();
  for (const w of worktreeStores) w.close();
  for (const c of configStores) c.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  mailStores = [];
  reviewStores = [];
  rosterStores = [];
  worktreeStores = [];
  configStores = [];
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────

function openStores(id: string): {
  mail: MailStore;
  reviews: ReviewStore;
  roster: RosterStore;
  worktrees: WorktreeStore;
} {
  const mail = openMailStore(id);
  mailStores.push(mail);
  const reviews = openReviewStore(id);
  reviewStores.push(reviews);
  const roster = openRosterStore(id);
  rosterStores.push(roster);
  const worktrees = openWorktreeStore(id);
  worktreeStores.push(worktrees);
  return { mail, reviews, roster, worktrees };
}

function openCfg(): ConfigStore {
  const cfg = openConfigStore();
  configStores.push(cfg);
  return cfg;
}

/**
 * Build a fake ToolContext with the given agent + stores. Does NOT wire worktrees/dispatch so
 * co_kickback's handler does not reach git (the tool reads the branch from `input.into`).
 */
function makeCtx(
  agentId: string,
  stores: { mail: MailStore; reviews: ReviewStore; roster: RosterStore; worktrees: WorktreeStore },
  cwd = '/fake/cwd',
  opts: {
    seedWorktree?: boolean;
    worker?: string;
    seedWorkerDone?: boolean;
    seedFinish?: boolean;
  } = {},
): ToolContext {
  if (opts.seedWorktree !== false && stores.worktrees.getWorktree(BRANCH) == null) {
    stores.worktrees.recordWorktree({
      branch: BRANCH,
      baseRef: TARGET,
      baseSha: 'b'.repeat(40),
      path: `/fake/worktrees/${BRANCH}`,
      parent: agentId,
    });
  }
  const worker = opts.worker ?? (agentId === 'coord-1' ? 'lead-1' : 'impl-1');
  if (opts.seedFinish !== false && stores.worktrees.getFinish(BRANCH) == null) {
    stores.worktrees.recordFinish({
      branch: BRANCH,
      baseSha: 'b'.repeat(40),
      commitSha: 'c'.repeat(40),
      tests: [],
      agent: worker,
    });
  }
  if (opts.seedWorkerDone !== false) {
    stores.mail.send({
      type: MAIL_WORKER_DONE,
      to: agentId,
      from: worker,
      subject: `worker_done: ${BRANCH}`,
      body: 'done',
    });
  }
  return {
    agent: agentId,
    projectId: 'p-kickback-test',
    cwd,
    mail: stores.mail,
    registry: { resolve: () => 'p-kickback-test' } as never,
    reviews: stores.reviews,
    roster: stores.roster,
    worktrees: stores.worktrees,
  };
}

/**
 * Populate a tree: impl-1 → lead-1 → coord-1 → @operator (structural).
 */
function buildRoster(roster: RosterStore) {
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
  roster.recordAgent({ agentId: 'impl-1', role: 'implementer', parent: 'lead-1' });
}

function recordIssues(
  reviews: ReviewStore,
  reviewId = 'rev-kickback-issues',
  blockerSummaries: readonly string[] = ['tests fail in CI'],
) {
  reviews.recordVerdict({
    reviewId,
    target: TARGET,
    branch: BRANCH,
    reviewer: 'reviewer-1',
    verdict: 'ISSUES',
    blockers: blockerSummaries.map((summary) => ({ summary })),
    suggestions: [],
  });
}

const registry = buildCoreRegistry();

// ── co_kickback — coordinator kicks back its lead ─────────────────────────────────────────────────

describe('co_kickback — coordinator kicks back its lead (AC-L6a-5)', () => {
  it('sends a kickback mail to the lead, increments strike count, NOT rejected', async () => {
    const stores = openStores('p-kb-coord-1');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-coord-kickback', ['tests fail in CI']);
    const ctx = makeCtx('coord-1', stores);

    const result = (await invokeTool(registry, ctx, 'co_kickback', {
      branch: BRANCH,
      worker: 'lead-1',
      blockers: ['tests fail in CI'],
      into: TARGET,
    })) as KickbackOut;

    expect(result.kicked_back).toBe(true);
    expect(result.action).toBe('kickback');
    expect(result.strike_count).toBe(1);
    expect(result.to).toBe('lead-1');
    expect(typeof result.mail_seq).toBe('number');
    expect(result.target).toBe(TARGET);
    expect(result.branch).toBe(BRANCH);

    // Mail routed to the lead
    const lead1Inbox = stores.mail.inbox('lead-1');
    expect(lead1Inbox.some((m) => m.subject === `kickback: ${BRANCH}`)).toBe(true);

    // Strike incremented
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(1);
  });
});

// ── co_kickback — lead kicks back its implementer ────────────────────────────────────────────────

describe('co_kickback — lead kicks back its implementer (AC-L6a-5)', () => {
  it('rejects unadvertised input fields before mail or strike side effects', async () => {
    const stores = openStores('p-kb-strict-input');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-strict-kickback', ['type errors in review']);
    const ctx = makeCtx('lead-1', stores);

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['type errors in review'],
        into: TARGET,
        operator_override: true,
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(stores.mail.inbox('impl-1').filter((m) => m.subject === `kickback: ${BRANCH}`)).toEqual(
      [],
    );
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });

  it('sends a kickback mail to impl-1, increments strike count', async () => {
    const stores = openStores('p-kb-lead-1');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-lead-kickback', ['type errors in review']);
    const ctx = makeCtx('lead-1', stores);

    const result = (await invokeTool(registry, ctx, 'co_kickback', {
      branch: BRANCH,
      worker: 'impl-1',
      blockers: ['type errors in review'],
      suggestions: ['run tsc --noEmit first'],
      into: TARGET,
    })) as KickbackOut;

    expect(result.kicked_back).toBe(true);
    expect(result.action).toBe('kickback');
    expect(result.strike_count).toBe(1);
    expect(result.to).toBe('impl-1');
    expect(typeof result.mail_seq).toBe('number');

    const implInbox = stores.mail.inbox('impl-1');
    expect(implInbox.some((m) => m.subject === `kickback: ${BRANCH}`)).toBe(true);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(1);
  });
});

// ── co_kickback — non-parent caller → loud-fail ───────────────────────────────────────────────────

describe('co_kickback — non-parent caller → loud-fail (AC-L6a-5)', () => {
  it('a kicker that is NOT the worker parent → throws', async () => {
    const stores = openStores('p-kb-nonparent-1');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-nonparent-kickback', ['some issue']);
    // coord-1 is NOT the parent of impl-1 (lead-1 is)
    const ctx = makeCtx('coord-1', stores);

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['some issue'],
        into: TARGET,
      }),
    ).rejects.toThrow(/not the recorded parent/);
  });
});

// ── co_kickback — caller must be owner tier ───────────────────────────────────────────────────────

describe('co_kickback — caller role must be coordinator or lead (AC-L6a-5)', () => {
  it('rejects a direct parent whose role is not coordinator/lead', async () => {
    const stores = openStores('p-kb-role-auth-1');
    buildRoster(stores.roster);
    stores.roster.recordAgent({
      agentId: 'researcher-1',
      role: 'researcher',
      subRole: 'codebase',
      parent: 'impl-1',
    });
    recordIssues(stores.reviews, 'rev-impl-parent-kickback', ['research result is incomplete']);
    const ctx = makeCtx('impl-1', stores);

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'researcher-1',
        blockers: ['research result is incomplete'],
        into: TARGET,
      }),
    ).rejects.toThrow(/Only a coordinator or lead/i);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });

  it('rejects reviewer/researcher children that cannot own code branches', async () => {
    const stores = openStores('p-kb-non-code-worker');
    buildRoster(stores.roster);
    stores.roster.recordAgent({
      agentId: 'researcher-1',
      role: 'researcher',
      subRole: 'codebase',
      parent: 'lead-1',
    });
    recordIssues(stores.reviews, 'rev-researcher-kickback', ['research mail cannot fix code']);
    const ctx = makeCtx('lead-1', stores);

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'researcher-1',
        blockers: ['research mail cannot fix code'],
        into: TARGET,
      }),
    ).rejects.toThrow(/cannot own code branches/i);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });
});

// ── co_kickback — branch ownership ────────────────────────────────────────────────────────────────

describe('co_kickback — branch must belong to caller-owned worktree', () => {
  it('rejects when no worktree record exists for the branch', async () => {
    const stores = openStores('p-kb-no-worktree-record');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-no-worktree-record', ['branch record missing']);
    const ctx = makeCtx('lead-1', stores, '/fake/cwd', { seedWorktree: false });

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['branch record missing'],
        into: TARGET,
      }),
    ).rejects.toThrow(/no worktree record/i);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });

  it('rejects when the branch was spawned by a different parent', async () => {
    const stores = openStores('p-kb-wrong-worktree-parent');
    buildRoster(stores.roster);
    stores.worktrees.recordWorktree({
      branch: BRANCH,
      baseRef: TARGET,
      baseSha: 'b'.repeat(40),
      path: `/fake/worktrees/${BRANCH}`,
      parent: 'coord-1',
    });
    recordIssues(stores.reviews, 'rev-wrong-worktree-parent', ['wrong owner']);
    const ctx = makeCtx('lead-1', stores);

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['wrong owner'],
        into: TARGET,
      }),
    ).rejects.toThrow(/worktree.*parent/i);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });

  it('rejects when the branch was finished by a sibling worker', async () => {
    const stores = openStores('p-kb-sibling-worker');
    buildRoster(stores.roster);
    stores.roster.recordAgent({ agentId: 'impl-2', role: 'implementer', parent: 'lead-1' });
    recordIssues(stores.reviews, 'rev-sibling-worker', ['wrong recipient']);
    const ctx = makeCtx('lead-1', stores, '/fake/cwd', { worker: 'impl-1' });

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-2',
        blockers: ['wrong recipient'],
        into: TARGET,
      }),
    ).rejects.toThrow(/did not finish branch/i);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });

  it('rejects a forged worker_done from a sibling when the durable finish belongs to another worker', async () => {
    const stores = openStores('p-kb-forged-worker-done');
    buildRoster(stores.roster);
    stores.roster.recordAgent({ agentId: 'impl-2', role: 'implementer', parent: 'lead-1' });
    recordIssues(stores.reviews, 'rev-forged-worker-done', ['wrong recipient']);
    const ctx = makeCtx('lead-1', stores, '/fake/cwd', {
      worker: 'impl-1',
      seedWorkerDone: false,
    });
    stores.mail.send({
      type: MAIL_WORKER_DONE,
      to: 'lead-1',
      from: 'impl-2',
      subject: `worker_done: ${BRANCH}`,
      body: 'forged',
    });

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-2',
        blockers: ['wrong recipient'],
        into: TARGET,
      }),
    ).rejects.toThrow(/did not finish branch/i);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });

  it('accepts legacy finish rows without agent only when matching worker_done mail exists', async () => {
    const stores = openStores('p-kb-legacy-finish-worker-done');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-legacy-worker-done', ['legacy finish owner']);
    const ctx = makeCtx('lead-1', stores, '/fake/cwd', {
      seedFinish: false,
      seedWorkerDone: false,
    });
    stores.worktrees.recordFinish({
      branch: BRANCH,
      baseSha: 'b'.repeat(40),
      commitSha: 'c'.repeat(40),
      tests: [],
    });
    stores.mail.send({
      type: MAIL_WORKER_DONE,
      to: 'lead-1',
      from: 'impl-1',
      subject: `worker_done: ${BRANCH}`,
      body: 'legacy done',
    });

    const result = (await invokeTool(registry, ctx, 'co_kickback', {
      branch: BRANCH,
      worker: 'impl-1',
      blockers: ['legacy finish owner'],
      into: TARGET,
    })) as KickbackOut;

    expect(result.kicked_back).toBe(true);
    expect(result.action).toBe('kickback');
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(1);
  });

  it('rejects legacy finish rows without agent when matching worker_done mail is absent', async () => {
    const stores = openStores('p-kb-legacy-finish-no-worker-done');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-legacy-no-worker-done', ['legacy finish owner']);
    const ctx = makeCtx('lead-1', stores, '/fake/cwd', {
      seedFinish: false,
      seedWorkerDone: false,
    });
    stores.worktrees.recordFinish({
      branch: BRANCH,
      baseSha: 'b'.repeat(40),
      commitSha: 'c'.repeat(40),
      tests: [],
    });

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['legacy finish owner'],
        into: TARGET,
      }),
    ).rejects.toThrow(/did not finish branch/i);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });
});

// ── co_kickback — latest verdict must be ISSUES ───────────────────────────────────────────────────

describe('co_kickback — requires a latest ISSUES verdict (AC-L6a-5)', () => {
  it('rejects kickback when no review verdict is recorded', async () => {
    const stores = openStores('p-kb-no-verdict-1');
    buildRoster(stores.roster);
    const ctx = makeCtx('lead-1', stores);

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['claimed blocker'],
        into: TARGET,
      }),
    ).rejects.toThrow(/latest review verdict.*ISSUES/i);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });

  it('rejects kickback when the latest review verdict is PASS', async () => {
    const stores = openStores('p-kb-pass-verdict-1');
    buildRoster(stores.roster);
    stores.reviews.recordVerdict({
      reviewId: 'rev-pass',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'reviewer-1',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
    });
    const ctx = makeCtx('lead-1', stores);

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['claimed blocker'],
        into: TARGET,
      }),
    ).rejects.toThrow(/latest review verdict.*ISSUES/i);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });

  it('rejects when input blockers do not match the latest ISSUES verdict blockers', async () => {
    const stores = openStores('p-kb-blocker-mismatch');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-blocker-mismatch', ['actual blocker']);
    const ctx = makeCtx('lead-1', stores);

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['different blocker'],
        into: TARGET,
      }),
    ).rejects.toThrow(/blockers.*latest review verdict/i);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });
});

// ── co_kickback — notify before strike ────────────────────────────────────────────────────────────

describe('co_kickback — notification failure does not consume a strike', () => {
  it('does not record a strike when kickback mail delivery fails', async () => {
    const stores = openStores('p-kb-mail-failure-1');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-mail-failure', ['tests fail in CI']);
    const ctx = {
      ...makeCtx('lead-1', stores),
      mail: {
        ...stores.mail,
        send: () => {
          throw new Error('delivery failed');
        },
      } as unknown as MailStore,
    };

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['tests fail in CI'],
        into: TARGET,
      }),
    ).rejects.toThrow(/delivery failed/);
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(0);
  });
});

describe('co_kickback — one strike per review verdict', () => {
  it('repeated kickback for the same latest reviewId is an explicit no-op', async () => {
    const stores = openStores('p-kb-repeat-same-review');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-repeat', ['tests fail in CI']);
    const ctx = makeCtx('lead-1', stores);

    const first = (await invokeTool(registry, ctx, 'co_kickback', {
      branch: BRANCH,
      worker: 'impl-1',
      blockers: ['tests fail in CI'],
      into: TARGET,
    })) as KickbackOut;
    const second = (await invokeTool(registry, ctx, 'co_kickback', {
      branch: BRANCH,
      worker: 'impl-1',
      blockers: ['tests fail in CI'],
      into: TARGET,
    })) as KickbackOut;

    expect(first.strike_count).toBe(1);
    expect(first.kicked_back).toBe(true);
    expect(first.action).toBe('kickback');
    expect(typeof first.mail_seq).toBe('number');
    expect(second.kicked_back).toBe(false);
    expect(second.action).toBe('noop');
    expect(second.strike_count).toBe(1);
    expect(second.mail_seq).toBeUndefined();
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(1);
    expect(
      stores.mail.inbox('impl-1').filter((m) => m.subject === `kickback: ${BRANCH}`),
    ).toHaveLength(1);
  });

  it('uses idempotent kickback mail when strike recording fails after notification', async () => {
    const stores = openStores('p-kb-mail-idempotent-after-strike-fail');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-mail-idempotent', ['tests fail in CI']);
    let failRecord = true;
    const ctx = {
      ...makeCtx('lead-1', stores),
      reviews: {
        ...stores.reviews,
        recordStrike: (s) => {
          if (failRecord) {
            failRecord = false;
            throw new Error('strike write failed');
          }
          stores.reviews.recordStrike(s);
        },
      } as ReviewStore,
    };

    await expect(
      invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['tests fail in CI'],
        into: TARGET,
      }),
    ).rejects.toThrow(/strike write failed/);
    const second = (await invokeTool(registry, ctx, 'co_kickback', {
      branch: BRANCH,
      worker: 'impl-1',
      blockers: ['tests fail in CI'],
      into: TARGET,
    })) as KickbackOut;

    expect(second.action).toBe('kickback');
    expect(stores.reviews.getStrikeCount(TARGET, BRANCH)).toBe(1);
    expect(
      stores.mail.inbox('impl-1').filter((m) => m.subject === `kickback: ${BRANCH}`),
    ).toHaveLength(1);
  });
});

// ── co_kickback — budget reached → escalate ──────────────────────────────────────────────────────

describe('co_kickback — budget reached → action=escalate (AC-L6a-5)', () => {
  it('drives to REVIEW_ROUND_BUDGET_DEFAULT (3) → escalate, escalation mail to coord parent', async () => {
    const stores = openStores('p-kb-budget-1');
    buildRoster(stores.roster);
    // Lead kicks back impl-1 repeatedly
    const ctx = makeCtx('lead-1', stores);

    let lastResult: KickbackOut = {} as KickbackOut;
    for (let i = 1; i <= 3; i++) {
      recordIssues(stores.reviews, `rev-budget-${i}`, [`blocker round ${i}`]);
      lastResult = (await invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: [`blocker round ${i}`],
        into: TARGET,
      })) as KickbackOut;
    }

    expect(lastResult.action).toBe('escalate');
    expect(lastResult.kicked_back).toBe(false);
    expect(lastResult.strike_count).toBe(3);

    // Exactly ONE escalation mail fired to the lead's parent (coord-1)
    const coordInbox = stores.mail.inbox('coord-1');
    const escalations = coordInbox.filter((m) => m.type === MAIL_ESCALATION);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.subject).toContain(BRANCH);

    // No kickback mail to impl-1 for the 3rd kick (escalated instead)
    const implInbox = stores.mail.inbox('impl-1');
    const kickbacks = implInbox.filter((m) => m.subject === `kickback: ${BRANCH}`);
    // Exactly 2 kickback mails (rounds 1-2); round 3 escalated
    expect(kickbacks).toHaveLength(2);
  });

  it('6th kick after escalation → still escalate, NO second escalation mail (idempotent)', async () => {
    const stores = openStores('p-kb-budget-2');
    buildRoster(stores.roster);
    const ctx = makeCtx('lead-1', stores);

    for (let i = 1; i <= 6; i++) {
      recordIssues(stores.reviews, `rev-budget-repeat-${i}`, [`blocker ${i}`]);
      (await invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: [`blocker ${i}`],
        into: TARGET,
      })) as KickbackOut;
    }

    // Still exactly one escalation mail
    const coordInbox = stores.mail.inbox('coord-1');
    const escalations = coordInbox.filter((m) => m.type === MAIL_ESCALATION);
    expect(escalations).toHaveLength(1);
  });

  it('uses configured review_round_budget instead of the default', async () => {
    const stores = openStores('p-kb-budget-configured');
    buildRoster(stores.roster);
    const cfg = openCfg();
    cfg.setProjectOverride('p-kickback-test', REVIEW_ROUND_BUDGET_KEY, 2);
    const ctx = makeCtx('lead-1', stores);

    recordIssues(stores.reviews, 'rev-config-budget-1', ['blocker 1']);
    const first = (await invokeTool(registry, ctx, 'co_kickback', {
      branch: BRANCH,
      worker: 'impl-1',
      blockers: ['blocker 1'],
      into: TARGET,
    })) as KickbackOut;
    recordIssues(stores.reviews, 'rev-config-budget-2', ['blocker 2']);
    const second = (await invokeTool(registry, ctx, 'co_kickback', {
      branch: BRANCH,
      worker: 'impl-1',
      blockers: ['blocker 2'],
      into: TARGET,
    })) as KickbackOut;

    expect(first.action).toBe('kickback');
    expect(second.action).toBe('escalate');
    expect(second.strike_count).toBe(2);
    const escalations = stores.mail.inbox('coord-1').filter((m) => m.type === MAIL_ESCALATION);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.subject).toContain('2/2');
  });
});

// ── co_kickback — absent stores → loud-fail ──────────────────────────────────────────────────────

describe('co_kickback — absent stores → loud-fail (Principle 9)', () => {
  it('missing ctx.reviews → throws', async () => {
    const stores = openStores('p-kb-noreviews');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-noreviews', ['x']);
    const ctx = { ...makeCtx('lead-1', stores), reviews: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['x'],
        into: TARGET,
      }),
    ).rejects.toThrow(/ctx.reviews absent/);
  });

  it('missing ctx.roster → throws', async () => {
    const stores = openStores('p-kb-noroster');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-noroster', ['x']);
    const ctx = { ...makeCtx('lead-1', stores), roster: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['x'],
        into: TARGET,
      }),
    ).rejects.toThrow(/ctx.roster absent/);
  });

  it('missing ctx.mail → throws', async () => {
    const stores = openStores('p-kb-nomail');
    buildRoster(stores.roster);
    recordIssues(stores.reviews, 'rev-nomail', ['x']);
    const ctx = { ...makeCtx('lead-1', stores), mail: undefined };
    await expect(
      invokeTool(registry, ctx as unknown as ToolContext, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: ['x'],
        into: TARGET,
      }),
    ).rejects.toThrow(/ctx.mail is absent/);
  });
});

// ── completeness gate (AC-L6a-8) ─────────────────────────────────────────────────────────────────

describe('checkToolCompleteness — co_kickback registered (AC-L6a-8)', () => {
  it('buildCoreRegistry() is green with co_kickback registered', () => {
    const violations = checkToolCompleteness(buildCoreRegistry());
    expect(violations).toHaveLength(0);
  });
});

// ── anti-drift: co_kickback ∈ coordinator + lead, ∉ others (AC-L6a-5) ───────────────────────────

describe('anti-drift — co_kickback offered to exactly coordinator + lead (AC-L6a-5)', () => {
  it('co_kickback ∈ toolsForRole("coordinator")', () => {
    const tools = toolsForRole('coordinator');
    expect(tools.some((t) => t.name === 'co_kickback')).toBe(true);
  });

  it('co_kickback ∈ toolsForRole("lead")', () => {
    const tools = toolsForRole('lead');
    expect(tools.some((t) => t.name === 'co_kickback')).toBe(true);
  });

  it('co_kickback ∉ toolsForRole("implementer")', () => {
    const tools = toolsForRole('implementer');
    expect(tools.some((t) => t.name === 'co_kickback')).toBe(false);
  });

  it('co_kickback ∉ toolsForRole("reviewer")', () => {
    const tools = toolsForRole('reviewer');
    expect(tools.some((t) => t.name === 'co_kickback')).toBe(false);
  });

  it('co_kickback ∉ toolsForRole("researcher")', () => {
    const tools = toolsForRole('researcher');
    expect(tools.some((t) => t.name === 'co_kickback')).toBe(false);
  });
});
