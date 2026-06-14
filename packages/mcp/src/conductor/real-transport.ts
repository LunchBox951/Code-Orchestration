/**
 * P4 (Stage 10 · AC-S10-4·1) — the real, stream-backed {@link TransportPair} that the engine uses in
 * production to bind the co MCP surface to a live provider pane.
 *
 * The SERVER side is handed to {@link LiveSessionHost.hostSession} (binds the co MCP surface).
 * The CLIENT side is where a live provider's MCP client attaches. In the `[host-live]` run the
 * provider connects here via the `--mcp-config` stdio subprocess; in-sandbox a fake MCP `Client`
 * proves the plumbing deterministically — no real binary needed.
 *
 * This is the non-in-memory counterpart to `InMemoryTransport.createLinkedPair()`. It uses
 * {@link StdioServerTransport} (the MCP SDK's stream-backed line-framing transport) backed by a
 * crossed pair of Node.js `PassThrough` streams, giving both sides a real serialisation/deserialisation
 * path through actual I/O buffers rather than direct in-process hand-off.
 */
import { PassThrough } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { TransportPair } from './engine.js';

/**
 * Create a stream-backed {@link TransportPair} for one MCP bind.
 *
 * Two `PassThrough` pipes cross-link the sides:
 * - `c2s`: client writes → server reads (client→server direction)
 * - `s2c`: server writes → client reads (server→client direction)
 *
 * Both transports are {@link StdioServerTransport} instances backed by these pipes, giving the pair
 * a real JSON-RPC line-framing path. The returned pair is `[clientTransport, serverTransport]`,
 * matching the {@link TransportPair} convention the engine expects.
 *
 * @returns `[clientTransport, serverTransport]` — the engine hands the server side to
 *   `host.hostSession`; a provider's MCP client (or a fake `Client` in-sandbox) attaches to the
 *   client side.
 */
export function createStreamTransportPair(): TransportPair {
  const c2s = new PassThrough();
  const s2c = new PassThrough();

  // serverTransport: reads from the client→server pipe, writes to the server→client pipe.
  const serverTransport = new StdioServerTransport(c2s, s2c);
  // clientTransport: reads from the server→client pipe, writes to the client→server pipe.
  const clientTransport = new StdioServerTransport(s2c, c2s);

  return [clientTransport, serverTransport];
}
