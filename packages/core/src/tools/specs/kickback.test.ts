import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIL_ESCALATION } from '../../mail/events.js';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openReviewStore, type ReviewStore } from '../../review/review-store.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { toolsForRole } from '../scoping.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

type KickbackOut = {
  kicked_back: boolean;
  action: 'kickback' | 'escalate';
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

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  mailStores = [];
  reviewStores = [];
  rosterStores = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-kickback-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const m of mailStores) m.close();
  for (const r of reviewStores) r.close();
  for (const r of rosterStores) r.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  mailStores = [];
  reviewStores = [];
  rosterStores = [];
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────

function openStores(id: string): { mail: MailStore; reviews: ReviewStore; roster: RosterStore } {
  const mail = openMailStore(id);
  mailStores.push(mail);
  const reviews = openReviewStore(id);
  reviewStores.push(reviews);
  const roster = openRosterStore(id);
  rosterStores.push(roster);
  return { mail, reviews, roster };
}

/**
 * Build a fake ToolContext with the given agent + stores. Does NOT wire worktrees/dispatch so
 * co_kickback's handler does not reach git (the tool reads the branch from `input.into`).
 */
function makeCtx(
  agentId: string,
  stores: { mail: MailStore; reviews: ReviewStore; roster: RosterStore },
  cwd = '/fake/cwd',
): ToolContext {
  return {
    agent: agentId,
    projectId: 'p-kickback-test',
    cwd,
    mail: stores.mail,
    registry: { resolve: () => 'p-kickback-test' } as never,
    reviews: stores.reviews,
    roster: stores.roster,
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

const registry = buildCoreRegistry();

// ── co_kickback — coordinator kicks back its lead ─────────────────────────────────────────────────

describe('co_kickback — coordinator kicks back its lead (AC-L6a-5)', () => {
  it('sends a kickback mail to the lead, increments strike count, NOT rejected', async () => {
    const stores = openStores('p-kb-coord-1');
    buildRoster(stores.roster);
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
  it('sends a kickback mail to impl-1, increments strike count', async () => {
    const stores = openStores('p-kb-lead-1');
    buildRoster(stores.roster);
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

// ── co_kickback — budget reached → escalate ──────────────────────────────────────────────────────

describe('co_kickback — budget reached → action=escalate (AC-L6a-5)', () => {
  it('drives to REVIEW_ROUND_BUDGET_DEFAULT (5) → escalate, escalation mail to coord parent', async () => {
    const stores = openStores('p-kb-budget-1');
    buildRoster(stores.roster);
    // Lead kicks back impl-1 repeatedly
    const ctx = makeCtx('lead-1', stores);

    let lastResult: KickbackOut = {} as KickbackOut;
    for (let i = 1; i <= 5; i++) {
      lastResult = (await invokeTool(registry, ctx, 'co_kickback', {
        branch: BRANCH,
        worker: 'impl-1',
        blockers: [`blocker round ${i}`],
        into: TARGET,
      })) as KickbackOut;
    }

    expect(lastResult.action).toBe('escalate');
    expect(lastResult.kicked_back).toBe(false);
    expect(lastResult.strike_count).toBe(5);

    // Exactly ONE escalation mail fired to the lead's parent (coord-1)
    const coordInbox = stores.mail.inbox('coord-1');
    const escalations = coordInbox.filter((m) => m.type === MAIL_ESCALATION);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.subject).toContain(BRANCH);

    // No kickback mail to impl-1 for the 5th kick (escalated instead)
    const implInbox = stores.mail.inbox('impl-1');
    const kickbacks = implInbox.filter((m) => m.subject === `kickback: ${BRANCH}`);
    // Exactly 4 kickback mails (rounds 1-4); round 5 escalated
    expect(kickbacks).toHaveLength(4);
  });

  it('6th kick after escalation → still escalate, NO second escalation mail (idempotent)', async () => {
    const stores = openStores('p-kb-budget-2');
    buildRoster(stores.roster);
    const ctx = makeCtx('lead-1', stores);

    for (let i = 1; i <= 6; i++) {
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
});

// ── co_kickback — absent stores → loud-fail ──────────────────────────────────────────────────────

describe('co_kickback — absent stores → loud-fail (Principle 9)', () => {
  it('missing ctx.reviews → throws', async () => {
    const stores = openStores('p-kb-noreviews');
    buildRoster(stores.roster);
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
