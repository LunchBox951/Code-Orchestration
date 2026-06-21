import { describe, it, expect } from 'vitest';
import type { AgentRecord } from './events.js';
import { descendantsLeafFirst } from './subtree.js';

describe('descendantsLeafFirst', () => {
  it('returns descendants leaf-first (children before parents), excluding the root', () => {
    const agents: readonly AgentRecord[] = [
      { agentId: 'c', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'lead', role: 'lead', parent: 'c', registeredTs: 2 },
      { agentId: 'impl', role: 'implementer', parent: 'lead', registeredTs: 3 },
      { agentId: 'other', role: 'coordinator', parent: '@operator', registeredTs: 4 },
    ];
    expect(descendantsLeafFirst(agents, 'c').map((a) => a.agentId)).toEqual(['impl', 'lead']);
    expect(descendantsLeafFirst(agents, 'impl')).toEqual([]); // leaf has none
  });

  it('handles multi-level subtrees with stable ordering', () => {
    const agents: readonly AgentRecord[] = [
      { agentId: 'c', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'lead1', role: 'lead', parent: 'c', registeredTs: 2 },
      { agentId: 'lead2', role: 'lead', parent: 'c', registeredTs: 3 },
      { agentId: 'impl1', role: 'implementer', parent: 'lead1', registeredTs: 4 },
      { agentId: 'impl2', role: 'implementer', parent: 'lead1', registeredTs: 5 },
      { agentId: 'impl3', role: 'implementer', parent: 'lead2', registeredTs: 6 },
    ];
    const result = descendantsLeafFirst(agents, 'c').map((a) => a.agentId);
    // leaf-first: implementations before their leads, then leads
    expect(result).toEqual(['impl1', 'impl2', 'lead1', 'impl3', 'lead2']);
  });

  it('sorts each child bucket by registeredTs then agentId for stable order', () => {
    const agents: readonly AgentRecord[] = [
      { agentId: 'c', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      // Two children with same registeredTs but different ids
      { agentId: 'z', role: 'lead', parent: 'c', registeredTs: 2 },
      { agentId: 'a', role: 'lead', parent: 'c', registeredTs: 2 },
    ];
    const result = descendantsLeafFirst(agents, 'c').map((a) => a.agentId);
    // Should sort by agentId when registeredTs is same
    expect(result).toEqual(['a', 'z']);
  });

  it('throws a clear cycle error on a corrupt roster with a parent cycle (fail-loud, not stack-overflow)', () => {
    // A corrupt roster with conflicting parent edges: r → a, a → b, b → a (a appears as both b's
    // parent and b's child). Without the visited-set guard this would recurse forever and overflow.
    const agents: readonly AgentRecord[] = [
      { agentId: 'a', role: 'lead', parent: 'r', registeredTs: 1 },
      { agentId: 'b', role: 'implementer', parent: 'a', registeredTs: 2 },
      { agentId: 'a', role: 'lead', parent: 'b', registeredTs: 3 },
    ];
    expect(() => descendantsLeafFirst(agents, 'r')).toThrow(/roster cycle detected at 'a'/);
  });
});
