/**
 * Shared, PURE benchmark economy/efficiency types — the per-agent raw token + tool-usage signals the
 * three-score scorecard derives its TOKEN-ECONOMY (live-only) and CONTEXT/TOOL-EFFICIENCY scores from
 * (see {@link ./orchestration-metrics.ts}).
 *
 * These two interfaces are the READ-MODEL CONTRACT the `@co/mcp` driver fetches PER AGENT — the cost
 * rollup (tokens spent) and the tool-usage rollup (tool calls / errors / redundant reads / permission
 * asks). They are declared HERE, in `@co/core` (pure — no host graph), so:
 *   - the scorecard math is hermetically unit-testable with injected fakes (no store, no provider);
 *   - the `@co/mcp` adapter reads the provider-side store via OPTIONAL CHAINING against an extended store
 *     type (`store.getAgentCostRollup?.(id) ?? null`), so the driver compiles whether or not the store
 *     surface that produces this data has landed yet — a `null` rollup ⇒ the corresponding score is `null`
 *     (N/A), never a silent zero (the silent-zero trap that already afflicts live `turnsUsed`).
 *
 * The fields mirror the L4 cost read-model (`packages/core/src/dispatch/cost-projector.ts`) plus the
 * cache-token split a live provider reports; whoever produces this rollup populates these from the
 * durable cost/tool observations, never a model's self-report (Principle 9 — no LLM judge, no silent green).
 */

/**
 * The raw per-agent TOKEN cost rollup — the LIVE-ONLY economy signal. Every field is a non-negative
 * count of tokens the agent actually spent over the run (summed across its turns), plus the reported
 * dollar cost. In a SANDBOX run no real tokens are spent, so the driver hands `null` (not a zeroed
 * rollup) and the token-economy score is `null` (N/A), per the no-silent-zero rule.
 *
 * STRUCTURAL CONTRACT: the canonical `@co/core` barrel exports this shape for adapter compatibility,
 * while the `@co/mcp` driver reads the optional store surface through a structurally compatible seam.
 */
export interface AgentCostRollup {
  /** Which agent this rollup belongs to (matches the roster agent id). */
  readonly agentId: string;
  /** Input (prompt) tokens billed to the agent across all its turns. */
  readonly inputTokens: number;
  /** Output (completion) tokens the agent produced across all its turns. */
  readonly outputTokens: number;
  /** Tokens served from the provider's prompt cache (cheap reads). */
  readonly cacheReadTokens: number;
  /** Tokens written INTO the provider's prompt cache (the one-time cache-creation cost). */
  readonly cacheCreationTokens: number;
  /** Total tokens billed (input + output + cache, as the provider rolls them up). */
  readonly totalTokens: number;
  /** Reported dollar cost, or `null` where the provider does not report a cost (no silent zero). */
  readonly costUsd: number | null;
}

/**
 * The raw per-agent TOOL-USAGE rollup — the CONTEXT/TOOL-EFFICIENCY signal (available in BOTH arms, since
 * tool calls are observable in the sandbox too). `toolErrors` is the count of tool calls that returned an
 * error; `redundantReads` is the count of reads of a path the agent already read this run (a context
 * inefficiency); `permissionAsks` is the count of permission prompts the agent triggered. The one un-scored
 * diagnostic the STORE produces (`turnsToFirstProductiveCoCall`) is reported raw; `toolCallsPerCompletedTask`
 * is NOT a store field — it is DERIVED by the benchmark driver from `toolCalls / completed-task-count`.
 *
 * STRUCTURAL CONTRACT: the canonical `@co/core` barrel exports this shape for adapter compatibility,
 * while the `@co/mcp` driver reads the optional store surface through a structurally compatible seam.
 */
export interface AgentToolUsage {
  /** Which agent this rollup belongs to (matches the roster agent id). */
  readonly agentId: string;
  /** Total tool calls the agent issued across the run. */
  readonly toolCalls: number;
  /** Of those, how many returned an error (failed tool calls). */
  readonly toolErrors: number;
  /** Reads of a path the agent had already read this run (redundant context re-fetches). */
  readonly redundantReads: number;
  /** Permission prompts the agent triggered (a friction signal — fewer is better). */
  readonly permissionAsks: number;
  /** DIAGNOSTIC (un-scored): turns before the agent's first productive `co_` tool call, or `null` if it never made one. */
  readonly turnsToFirstProductiveCoCall: number | null;
}
