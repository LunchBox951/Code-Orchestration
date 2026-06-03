import { describe, it, expect } from 'vitest';
import { buildCoreRegistry } from '../tools/core-registry.js';
import {
  renderCommitMessage,
  renderMergeMessage,
  renderPrMessage,
  type CommitIntent,
  type MergeIntent,
  type PrIntent,
} from './messages.js';

// AC-L3-3 — the message contract: house-style renderers that are PROVIDER-DETERMINISTIC. Identical
// intent ⇒ byte-identical output, and there is NO provider/voice parameter that could change it.
// The commit/merge renderers match the worktrees.md examples BYTE-FOR-BYTE. Plus the gated-by-default
// invariant: the registry exposes no un-gated co_merge/co_push/co_pr_merge verb (those are L5).

describe('AC-L3-3 — renderCommitMessage matches the worktrees.md example byte-for-byte', () => {
  it('renders type(scope): summary + an adaptive body (the doc example, exactly)', () => {
    const intent: CommitIntent = {
      type: 'fix',
      scope: 'auth',
      summary: 'reject expired tokens instead of passing silently',
      body: [
        'validateToken() returned true past expiry (stale-clock `<=`);',
        'now reads a fresh monotonic clock and adds the boundary test.',
        'Touches login + refresh.',
      ].join('\n'),
    };
    const expected = [
      'fix(auth): reject expired tokens instead of passing silently',
      '',
      'validateToken() returned true past expiry (stale-clock `<=`);',
      'now reads a fresh monotonic clock and adds the boundary test.',
      'Touches login + refresh.',
    ].join('\n');
    expect(renderCommitMessage(intent)).toBe(expected);
  });

  it('renders a trivial change summary-only (the doc trivial example, exactly)', () => {
    expect(
      renderCommitMessage({
        type: 'chore',
        scope: 'ci',
        summary: 'bump node 20 -> 22 in test matrix',
      }),
    ).toBe('chore(ci): bump node 20 -> 22 in test matrix');
  });

  it('omits the scope parens when there is no scope', () => {
    expect(renderCommitMessage({ type: 'docs', summary: 'fix a typo' })).toBe('docs: fix a typo');
    expect(renderCommitMessage({ type: 'docs', scope: '  ', summary: 'fix a typo' })).toBe(
      'docs: fix a typo',
    );
  });

  it('a blank / whitespace-only body is treated as summary-only (no trailing blank line)', () => {
    expect(renderCommitMessage({ type: 'chore', summary: 'x', body: '   \n  ' })).toBe('chore: x');
  });
});

describe('AC-L3-3 — renderMergeMessage matches the worktrees.md example byte-for-byte', () => {
  it('renders the house style + [reviewed: <verdict>] + the N commits · M regressions stat line', () => {
    const intent: MergeIntent = {
      branch: 'co/phase-auth',
      summary: 'harden token validation',
      reviewVerdict: 'PASS',
      body: [
        'Phase "auth-hardening": reject expired tokens, boundary + refresh',
        'tests, stale-clock fix.',
      ].join('\n'),
      commits: 3,
      regressions: 0,
    };
    const expected = [
      'merge(co/phase-auth): harden token validation  [reviewed: PASS]',
      '',
      'Phase "auth-hardening": reject expired tokens, boundary + refresh',
      'tests, stale-clock fix. 3 commits · 0 regressions vs baseline.',
    ].join('\n');
    expect(renderMergeMessage(intent)).toBe(expected);
  });

  it('pluralizes the stat line (1 commit · 1 regression)', () => {
    const intent: MergeIntent = {
      branch: 'co/x',
      summary: 's',
      reviewVerdict: 'PASS',
      body: 'phase body.',
      commits: 1,
      regressions: 1,
    };
    expect(renderMergeMessage(intent)).toContain('1 commit · 1 regression vs baseline.');
  });

  it('omits the stat line when either count is absent (header + body only)', () => {
    expect(renderMergeMessage({ branch: 'co/x', summary: 's', reviewVerdict: 'PASS' })).toBe(
      'merge(co/x): s  [reviewed: PASS]',
    );
    expect(
      renderMergeMessage({ branch: 'co/x', summary: 's', reviewVerdict: 'PASS', body: 'why.' }),
    ).toBe('merge(co/x): s  [reviewed: PASS]\n\nwhy.');
  });
});

describe('AC-L3-3 — renderPrMessage is the Why / What changed / Verification / Conventions pitch', () => {
  it('renders the four sections in order, leading with Why', () => {
    const intent: PrIntent = {
      why: 'Expired tokens were silently accepted.',
      whatChanged: 'validateToken now reads a monotonic clock.',
      verification: 'Added a boundary test; full suite green.',
      conventions: 'Conventional Commits, signed off.',
    };
    const out = renderPrMessage(intent);
    expect(out).toBe(
      [
        '## Why',
        'Expired tokens were silently accepted.',
        '## What changed',
        'validateToken now reads a monotonic clock.',
        '## Verification',
        'Added a boundary test; full suite green.',
        '## Conventions',
        'Conventional Commits, signed off.',
      ].join('\n\n'),
    );
    // Leads with rationale and stakes.
    expect(out.indexOf('## Why')).toBeLessThan(out.indexOf('## What changed'));
    expect(out.startsWith('## Why')).toBe(true);
  });
});

describe('AC-L3-3 — provider-deterministic: identical intent ⇒ byte-identical output, NO voice param', () => {
  it('the same intent from two simulated provider call sites renders byte-identically', () => {
    // A "Claude-voice" agent and a "Codex-voice" agent supply the SAME structured intent — co owns
    // the rendering, so the provider's prose register cannot reach the artifact. Identical intent in
    // ⇒ identical bytes out, every time.
    const claudeVoice: CommitIntent = {
      type: 'fix',
      scope: 'auth',
      summary: 'reject expired tokens',
      body: 'Reads a fresh monotonic clock; adds the boundary test.',
    };
    const codexVoice: CommitIntent = {
      type: 'fix',
      scope: 'auth',
      summary: 'reject expired tokens',
      body: 'Reads a fresh monotonic clock; adds the boundary test.',
    };
    expect(renderCommitMessage(claudeVoice)).toBe(renderCommitMessage(codexVoice));
    // Deterministic across repeated calls (no Date/Math.random/Map-iteration nondeterminism).
    expect(renderCommitMessage(claudeVoice)).toBe(renderCommitMessage(claudeVoice));
  });

  it('the renderers take exactly one argument — there is no provider/voice parameter (freeze #1)', () => {
    // By construction, provider voice cannot be passed in: each renderer is a pure function of its
    // intent alone (arity 1).
    expect(renderCommitMessage.length).toBe(1);
    expect(renderMergeMessage.length).toBe(1);
    expect(renderPrMessage.length).toBe(1);
  });
});

describe('AC-L3-3 — gated-by-default holds at the seam (P7): no un-gated merge/push/PR verb', () => {
  it('the registry exposes no co_merge / co_push / co_pr_merge (those are L5)', () => {
    const names = buildCoreRegistry()
      .list()
      .map((t) => t.name);
    expect(names).not.toContain('co_merge');
    expect(names).not.toContain('co_push');
    expect(names).not.toContain('co_pr_merge');
    // co_finish IS exposed (it commits + records + pings) but does NOT review or merge.
    expect(names).toContain('co_finish');
  });
});
