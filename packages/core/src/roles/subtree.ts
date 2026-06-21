import type { AgentRecord } from './events.js';

/**
 * Post-order (recurse-then-push) traversal over the flat roster's parent pointers,
 * returning descendants leaf-first (children before parents), EXCLUDING the root.
 * Each child bucket is sorted by `registeredTs` then `agentId` for stable order.
 *
 * @param agents - The flat roster of all agents
 * @param rootId - The root agent id whose descendants to traverse
 * @returns Descendants in post-order, excluding the root
 */
export function descendantsLeafFirst(
  agents: readonly AgentRecord[],
  rootId: string,
): AgentRecord[] {
  // Build a parent→children map from the flat roster.
  const childrenOf = new Map<string, AgentRecord[]>();
  for (const agent of agents) {
    if (agent.agentId === rootId) continue; // Skip the root itself
    const parent = agent.parent;
    if (!childrenOf.has(parent)) {
      childrenOf.set(parent, []);
    }
    childrenOf.get(parent)!.push(agent);
  }

  // Sort each child bucket by registeredTs then agentId for stable order.
  for (const children of childrenOf.values()) {
    children.sort((a, b) => {
      const tsDiff = a.registeredTs - b.registeredTs;
      if (tsDiff !== 0) return tsDiff;
      return a.agentId.localeCompare(b.agentId);
    });
  }

  // Post-order traversal: recurse then push.
  const result: AgentRecord[] = [];

  function traverse(parentId: string): void {
    const children = childrenOf.get(parentId);
    if (!children) return;

    for (const child of children) {
      traverse(child.agentId); // Recurse first (visit subtrees)
      result.push(child); // Then push the child itself
    }
  }

  traverse(rootId);
  return result;
}
