import { describe, expect, it } from 'vitest';
import { BLOCK_LIST } from './block-list.js';
import { checkBlockListDrift, CODEX_MCP_PRE_GRANT_VIOLATION_ID } from './drift.js';

const ALL_IDS = BLOCK_LIST.map((r) => r.id);

describe('checkBlockListDrift', () => {
  it('returns [] when enforced ids exactly match the registry (AC-L6a-6)', () => {
    const result = checkBlockListDrift(BLOCK_LIST, { blockedIds: ALL_IDS });
    expect(result).toEqual([]);
  });

  it('returns declared-not-enforced when a registry rule is missing from enforced config', () => {
    const missingId = 'git-force-push';
    const enforced = { blockedIds: ALL_IDS.filter((id) => id !== missingId) };
    const violations = checkBlockListDrift(BLOCK_LIST, enforced);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: missingId, kind: 'declared-not-enforced' });
  });

  it('returns enforced-not-declared when an enforced id is absent from the registry', () => {
    const bogusId = 'not-a-real-rule';
    const enforced = { blockedIds: [...ALL_IDS, bogusId] };
    const violations = checkBlockListDrift(BLOCK_LIST, enforced);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: bogusId, kind: 'enforced-not-declared' });
  });

  it('reports both kinds simultaneously when ids diverge in both directions', () => {
    const missing = 'sudo';
    const bogus = 'phantom-rule';
    const enforced = {
      blockedIds: [...ALL_IDS.filter((id) => id !== missing), bogus],
    };
    const violations = checkBlockListDrift(BLOCK_LIST, enforced);
    expect(violations).toHaveLength(2);
    expect(violations.find((v) => v.kind === 'declared-not-enforced')?.id).toBe(missing);
    expect(violations.find((v) => v.kind === 'enforced-not-declared')?.id).toBe(bogus);
  });

  it('#78: a missing codex MCP pre-grant raises a DISTINCT kind, NOT block-list drift', () => {
    // The block list is FULLY enforced (ids exactly match) but the codex MCP pre-grant regressed. The
    // missing pre-grant must surface as its OWN violation kind — never as declared-not-enforced for
    // every rule (the misleading signal #78 round-2 kills).
    const enforced = { blockedIds: ALL_IDS, codexMcpPreGrantMissing: true };
    const violations = checkBlockListDrift(BLOCK_LIST, enforced);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      id: CODEX_MCP_PRE_GRANT_VIOLATION_ID,
      kind: 'codex-mcp-pre-grant-missing',
    });
    // The (intact) block list contributes NO declared-not-enforced violations.
    expect(violations.some((v) => v.kind === 'declared-not-enforced')).toBe(false);
  });

  it('#78: the pre-grant violation is ADDITIVE — real block-list drift still reports alongside it', () => {
    // A pre-grant regression and a genuine dropped rule are independent signals: both must surface, each
    // with its own kind, so the operator sees the FULL picture (not one masking the other).
    const missing = 'sudo';
    const enforced = {
      blockedIds: ALL_IDS.filter((id) => id !== missing),
      codexMcpPreGrantMissing: true,
    };
    const violations = checkBlockListDrift(BLOCK_LIST, enforced);
    expect(violations).toHaveLength(2);
    expect(violations.find((v) => v.kind === 'declared-not-enforced')?.id).toBe(missing);
    expect(violations.find((v) => v.kind === 'codex-mcp-pre-grant-missing')?.id).toBe(
      CODEX_MCP_PRE_GRANT_VIOLATION_ID,
    );
  });
});

// readEnforcedConfig is tested via the drift-clean roundtrip in pane-launch-config.test.ts
// (L7 Phase P1). The stub that previously threw is replaced by the real reader.
