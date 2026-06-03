/**
 * The live-session-hosting seam (L7 plug-point) — the L2 analogue of L1's `LiveDeliveryStub`.
 * In production the Conductor hosts the REAL interactive claude/codex in a pty (Principle 2 —
 * authentic-terminal; never headless `-p`/`exec`) and serves the co MCP tools to that live
 * session, injecting the session's agent identity into each {@link ToolContext} (never trusting
 * client-supplied identity) and waking/routing the session on inbound mail. L2 ships the
 * transport-agnostic server (stdio) + this typed stub; it does NOT host live sessions, and the
 * stdio server works WITHOUT it (that is what "transport-agnostic" means).
 */
export interface LiveSessionHost {
  /**
   * Host a live pty session for `agent` and serve the co MCP surface to it. Returns `never`: the
   * exact parameters and lifecycle are L7's to finalize; this signature only marks the seam.
   */
  hostSession(agent: string): never;
}

/**
 * The L7 STUB host. Fails loud (Principle 9) until the Conductor owns live session-hosting — never
 * a silent no-op (a silent stub is exactly the fallback that hid the prototype's gaps).
 */
export class LiveSessionHostStub implements LiveSessionHost {
  // L7 PLUG-POINT (Conductor → runtime substrate). The production host must:
  //  (1) spawn + host the real interactive claude/codex in a pty (Principle 2; never headless -p/exec);
  //  (2) inject the session's agent identity into each tool call's ToolContext (never trust client input);
  //  (3) wake/route the session on inbound mail (turn lifecycle is L6/L7).
  // Until then this stub fails loud (Principle 9). The signature omits the params the interface
  // declares (TS allows a method to ignore trailing parameters) — it always throws regardless.
  hostSession(): never {
    throw new Error(
      'LiveSessionHostStub.hostSession: live pty session-hosting is not implemented at L2. ' +
        'This is the L7 plug-point: host the real claude/codex in a pty, inject per-session identity ' +
        'into the ToolContext, and wake/route on mail. Use the stdio server for headless flows.',
    );
  }
}
