/**
 * Stage 11 P1 (OP-IPC) — the thin JSON-RPC 2.0 envelope layer shared by the operator-IPC server and
 * client. It builds and classifies {@link JSONRPCMessage}s — the exact line-framed shape the reused
 * {@link import('../conductor/real-transport.js')} socket transports already serialize + validate
 * (`JSONRPCMessageSchema`). We do NOT reinvent framing; this is only the request/response/notification
 * vocabulary over it.
 *
 * The SDK's `JSONRPCMessageSchema` is `.strict()` at the envelope level and `loose` (passthrough) for
 * `params`/`result`, so a message MUST carry exactly the JSON-RPC envelope keys with an OBJECT payload
 * — which is exactly what these builders emit.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** JSON-RPC request id. The client mints monotonic numbers; the server echoes whatever it received. */
export type WireId = number | string;

const JSONRPC_VERSION = '2.0' as const;

/** A loose object — the only payload shape the strict JSON-RPC envelope permits for `params`/`result`. */
export type WirePayload = Record<string, unknown>;

/** Build a JSON-RPC request envelope (`{ jsonrpc, id, method, params }`). */
export function makeRequest(id: WireId, method: string, params: WirePayload): JSONRPCMessage {
  return { jsonrpc: JSONRPC_VERSION, id, method, params } as JSONRPCMessage;
}

/** Build a JSON-RPC success response (`{ jsonrpc, id, result }`); `result` is always an object. */
export function makeResult(id: WireId, result: WirePayload): JSONRPCMessage {
  return { jsonrpc: JSONRPC_VERSION, id, result } as JSONRPCMessage;
}

/** Build a JSON-RPC error response (`{ jsonrpc, id, error: { code, message } }`). */
export function makeError(id: WireId, code: number, message: string): JSONRPCMessage {
  return { jsonrpc: JSONRPC_VERSION, id, error: { code, message } } as JSONRPCMessage;
}

/** Build a JSON-RPC notification (`{ jsonrpc, method, params }`) — no id, no response expected. */
export function makeNotification(method: string, params: WirePayload): JSONRPCMessage {
  return { jsonrpc: JSONRPC_VERSION, method, params } as JSONRPCMessage;
}

/** JSON-RPC error codes used by the operator IPC (a subset of the standard set). */
export const WIRE_ERROR = {
  /** No such method on the server. */
  methodNotFound: -32601,
  /** The handler threw (the daemon-side error, surfaced to the operator). */
  internalError: -32603,
  /** Malformed params for a known method. */
  invalidParams: -32602,
} as const;

/** The structured result of classifying an incoming wire message — a discriminated union. */
export type IncomingMessage =
  | {
      readonly kind: 'request';
      readonly id: WireId;
      readonly method: string;
      readonly params: WirePayload;
    }
  | { readonly kind: 'notification'; readonly method: string; readonly params: WirePayload }
  | { readonly kind: 'result'; readonly id: WireId; readonly result: WirePayload }
  | {
      readonly kind: 'error';
      readonly id: WireId;
      readonly error: { readonly code: number; readonly message: string };
    }
  | { readonly kind: 'unknown' };

function isWireId(value: unknown): value is WireId {
  return typeof value === 'number' || typeof value === 'string';
}

function asPayload(value: unknown): WirePayload {
  return value != null && typeof value === 'object' ? (value as WirePayload) : {};
}

/**
 * Classify a parsed {@link JSONRPCMessage} into the four JSON-RPC shapes (+ `unknown`). The server
 * acts on `request`; the client acts on `result`/`error`/`notification`. The message has already been
 * schema-validated by the socket transport's read buffer, so this only narrows by the present keys.
 */
export function classifyIncoming(message: JSONRPCMessage): IncomingMessage {
  const m = message as Record<string, unknown>;
  const hasId = isWireId(m.id);
  if (typeof m.method === 'string') {
    if (hasId) {
      return { kind: 'request', id: m.id as WireId, method: m.method, params: asPayload(m.params) };
    }
    return { kind: 'notification', method: m.method, params: asPayload(m.params) };
  }
  if (hasId && 'result' in m) {
    return { kind: 'result', id: m.id as WireId, result: asPayload(m.result) };
  }
  if (hasId && m.error != null && typeof m.error === 'object') {
    const error = m.error as Record<string, unknown>;
    return {
      kind: 'error',
      id: m.id as WireId,
      error: {
        code: typeof error.code === 'number' ? error.code : WIRE_ERROR.internalError,
        message: typeof error.message === 'string' ? error.message : 'operator IPC error',
      },
    };
  }
  return { kind: 'unknown' };
}
