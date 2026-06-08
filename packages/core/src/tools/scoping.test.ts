import { describe, it, expect } from 'vitest';
import { buildCoreRegistry } from './core-registry.js';
import { checkToolCompleteness } from './completeness.js';
import { createToolRegistry } from './registry.js';
import { BASE_ROLES, roleToolsets, toolsForRole } from './scoping.js';

// AC-L2-5 — per-role tool-scoping MECHANISM (the seed map + `toolsForRole`). Proves a seed role sees
// only its scoped tools, two roles differ, the offered list is map-driven (not hardcoded), and there
// are no phantom tools (fail-loud — the scoping analogue of the C completeness gate). The
// "self-describing schemas" half of AC-L2-5 is the C gate; cited (not duplicated) at the bottom.

const ALL_TOOLS = [
  'co_mail_send',
  'co_mail_inbox',
  'co_mail_get',
  'co_mail_thread',
  'co_mail_ack',
  'co_mail_retract',
  'co_status',
  'co_worktree_info',
  'co_orient',
  'co_sling',
  'co_finish',
  'co_merge',
  'co_review_finalize',
  'co_push',
  'co_pr_merge',
];

describe('AC-L2-5 — the seed map covers every base role', () => {
  it('declares a seed toolset for all five base roles and nothing else', () => {
    for (const role of BASE_ROLES) expect(roleToolsets.has(role)).toBe(true);
    expect(roleToolsets.size).toBe(BASE_ROLES.length);
  });
});

describe('AC-L2-5 — toolsForRole returns the role’s scoped tools, in registry order', () => {
  it('the offered set for EVERY role IS its roleToolsets entry, in REGISTRY order (map-driven)', () => {
    const registryOrder = buildCoreRegistry()
      .list()
      .map((t) => t.name);
    for (const role of BASE_ROLES) {
      const offered = roleToolsets.get(role)!;
      const got = toolsForRole(role).map((t) => t.name);
      // exactly the mapped names — so changing the map changes the output (not hardcoded)…
      expect([...got].sort()).toEqual([...offered].sort());
      // …emitted in REGISTRY order, never roster order…
      expect(got).toEqual(registryOrder.filter((n) => offered.includes(n)));
      // …and always a subset of the canonical toolset.
      expect(got.length).toBeLessThanOrEqual(ALL_TOOLS.length);
      for (const name of got) expect(ALL_TOOLS).toContain(name);
    }
  });

  it('at least two roles have DIFFERENT toolsets (reviewer ≠ implementer)', () => {
    const reviewer = toolsForRole('reviewer').map((t) => t.name);
    const implementer = toolsForRole('implementer').map((t) => t.name);
    expect(reviewer).not.toEqual(implementer);
    // the documented edge: the leaf reviewer is not offered retract; the implementer is.
    expect(reviewer).not.toContain('co_mail_retract');
    expect(implementer).toContain('co_mail_retract');
    // both subsets of the full toolset; reviewer is strictly fewer than the full set.
    expect(reviewer.length).toBeLessThan(ALL_TOOLS.length);
  });

  it('registry order is preserved (the lead’s offered tools appear in registry order)', () => {
    // co_finish is implementer-scoped (a lead integrates reviewed branches; it does not finish
    // through the gate), so no single role carries the whole registry. The order invariant still
    // holds: the lead's offered tools are its seed filtered IN REGISTRY ORDER.
    const order = buildCoreRegistry()
      .list()
      .map((t) => t.name);
    const leadSeed = roleToolsets.get('lead')!;
    expect(toolsForRole('lead').map((t) => t.name)).toEqual(
      order.filter((n) => leadSeed.includes(n)),
    );
    // co_finish is offered to the implementer, not the lead.
    expect(toolsForRole('lead').map((t) => t.name)).not.toContain('co_finish');
    expect(toolsForRole('implementer').map((t) => t.name)).toContain('co_finish');
  });
});

describe('AC-L2-5 — it is a LIVE mechanism, not a hardcoded list', () => {
  it('extending a role’s toolset entry adds exactly that tool to the offered list', () => {
    const reg = buildCoreRegistry();
    // The selection rule toolsForRole applies: filter the registry to the named set, in registry order.
    const select = (names: readonly string[]): string[] =>
      reg
        .list()
        .filter((s) => names.includes(s.name))
        .map((s) => s.name);

    const researcherSeed = roleToolsets.get('researcher')!;
    expect(researcherSeed).not.toContain('co_worktree_info');
    const extended = [...researcherSeed, 'co_worktree_info'];

    expect(select(extended).length).toBe(select(researcherSeed).length + 1);
    expect(select(extended)).toContain('co_worktree_info');
    // The local selection rule is faithful to the production function on the un-extended seed.
    expect(select(researcherSeed)).toEqual(toolsForRole('researcher').map((s) => s.name));
  });
});

describe('AC-L2-5 — no phantom tools (fail loud, Principle 9)', () => {
  it('every tool named in every roleset exists in the registry; toolsForRole never throws on the seed', () => {
    const reg = buildCoreRegistry();
    for (const [role, names] of roleToolsets) {
      for (const name of names) expect(reg.has(name)).toBe(true);
      expect(() => toolsForRole(role)).not.toThrow();
    }
  });

  it('toolsForRole THROWS when a roleset names a tool absent from the registry (a phantom)', () => {
    const full = buildCoreRegistry();
    // A registry MISSING co_worktree_info — which the reviewer seed names → phantom → loud throw.
    const partial = createToolRegistry();
    for (const spec of full.list()) {
      if (spec.name !== 'co_worktree_info') partial.register(spec);
    }
    expect(() => toolsForRole('reviewer', partial)).toThrow(/phantom|absent|co_worktree_info/i);
  });
});

describe('AC-L2-5 — the self-describing-schemas half is the C completeness gate (cited)', () => {
  it('re-affirms the gate is GREEN over the real registry (RED cases live in completeness.test.ts)', () => {
    // AC-L2-5's "schemas are self-describing" half is enforced by the L2-C gate, not rebuilt here;
    // this single re-affirm is the cited evidence (the gate's RED cases are not duplicated).
    expect(checkToolCompleteness(buildCoreRegistry())).toEqual([]);
  });
});
