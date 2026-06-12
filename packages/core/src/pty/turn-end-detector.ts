/**
 * L7 C2 — the turn-end detector (PURE). Emits an IDLE / turn-boundary signal — and NOTHING more.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT (AC-L7-4 / must-not-regress): **turn-end ≠ work-end.**
 * This detector marks a turn *idle* — a UI/liveness signal for the E1 watchdog. It must NEVER emit,
 * trigger, or stand in for *completion*. Work-completion stays keyed EXCLUSIVELY to co's MCP verbs
 * (`co_finish` / `worker_done`, owned by `worktrees/finish.ts`). The live probes proved Claude
 * AUTO-BACKGROUNDS long work and ends its *turn* while the work continues, so an "idle ⇒ done"
 * shortcut would silently DROP real work. This detector only CORROBORATES completion; it never races
 * or replaces it. Accordingly this module has NO emission path: it is a pure function returning a
 * plain verdict, importing nothing from the completion/finish layer. `sawCompletionVerb` merely
 * REFLECTS the call-log (observing the verb is completion's business, not ours) — it triggers nothing.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Signals (synthesized from the P3 byte signatures):
 *   - **Byte-quiescence (the NECESSARY gate).** A *working* session is never byte-silent — it renders
 *     a spinner/status continuously (hundreds–thousands of B/s). A quiet window ≥ {@link QUIET_WINDOW_MS}
 *     marks the turn idle. Because "bytes flowing = alive", byte-quiescence is REQUIRED for `idle`;
 *     the other signals only CORROBORATE (they never independently flip a byte-active session to idle).
 *   - **Codex OSC0 idle edge.** Codex's terminal title flips from `⠋ <dirname>` (a braille spinner +
 *     dirname, working) to a plain `<dirname>` (idle) within ~7 ms of byte-quiet — a clean,
 *     render-independent corroborator.
 *   - **Claude OSC0 is NOT a turn-end edge.** Claude's title (`✳ <action>`) keeps the `✳` at idle, so
 *     it is an activity/liveness glyph, NOT an idle edge — we deliberately do NOT treat its presence as
 *     "still working" (that would HANG detection). For Claude, byte-quiescence is the idle signal.
 *   - **MCP-sentinel (Option C).** Tool calls on co's server are the semantic turn-activity signal;
 *     calls having stopped (alongside byte-quiet) corroborates idle.
 */
import { assertNever } from '../assert-never.js';
import type { Provider } from './startup-classifier.js';

/** The byte-quiet window that marks a turn idle (named constant; tunable host-side). */
export const QUIET_WINDOW_MS = 2500;

/** The MCP verbs that mean work is DONE. Observing one is completion's business — see the invariant. */
export const COMPLETION_VERBS: readonly string[] = ['co_finish', 'worker_done'];

/** One timestamped observation in a turn trace. `at` is a monotonic ms timestamp (data, not a clock). */
export type DetectorEvent =
  | { readonly kind: 'bytes'; readonly at: number; readonly bytes?: number }
  | { readonly kind: 'osc0'; readonly at: number; readonly title: string }
  | { readonly kind: 'mcp'; readonly at: number; readonly verb: string }
  | { readonly kind: 'mcp_start'; readonly at: number; readonly verb: string }
  | { readonly kind: 'mcp_end'; readonly at: number; readonly verb: string };

/** Why the detector believes the turn is idle (diagnostics for E1; reporting only — triggers nothing). */
export type IdleSignal = 'byte-quiescence' | 'codex-osc0' | 'mcp-quiescence';

export interface TurnEndConfig {
  /** The pane's provider — gates the OSC0 idle-edge interpretation (codex edge vs claude non-edge). */
  readonly provider?: Provider;
  /** Override the byte-quiet window (default {@link QUIET_WINDOW_MS}). */
  readonly quietWindowMs?: number;
}

/**
 * The detector verdict. `idle` is the UI/watchdog signal. `sawCompletionVerb` merely reflects whether
 * a terminal verb appeared in the call-log (it triggers NOTHING). `idleSignals` is diagnostic.
 * There is deliberately NO completion field — this type cannot express "work done".
 */
export interface TurnEndResult {
  readonly idle: boolean;
  readonly sawCompletionVerb: boolean;
  readonly idleSignals: readonly IdleSignal[];
}

/**
 * Compute the idle verdict for a turn `trace`, observed at `observedAt` (ms). Pure and deterministic:
 * time is DATA (the event `at`s + `observedAt`), never a wall clock, so tests drive it exactly.
 */
export function detectTurnEnd(
  trace: readonly DetectorEvent[],
  observedAt: number,
  config: TurnEndConfig = {},
): TurnEndResult {
  const quietWindow = config.quietWindowMs ?? QUIET_WINDOW_MS;

  let lastByteAt: number | undefined;
  let lastMcpAt: number | undefined;
  let activeMcpCalls = 0;
  let latestOsc0: { at: number; title: string } | undefined;
  let sawCompletionVerb = false;

  for (const ev of trace) {
    switch (ev.kind) {
      case 'bytes':
        if (lastByteAt === undefined || ev.at > lastByteAt) lastByteAt = ev.at;
        break;
      case 'mcp':
        if (lastMcpAt === undefined || ev.at > lastMcpAt) lastMcpAt = ev.at;
        if (COMPLETION_VERBS.includes(ev.verb)) sawCompletionVerb = true;
        break;
      case 'mcp_start':
        activeMcpCalls += 1;
        if (lastMcpAt === undefined || ev.at > lastMcpAt) lastMcpAt = ev.at;
        if (COMPLETION_VERBS.includes(ev.verb)) sawCompletionVerb = true;
        break;
      case 'mcp_end':
        activeMcpCalls = Math.max(0, activeMcpCalls - 1);
        if (lastMcpAt === undefined || ev.at > lastMcpAt) lastMcpAt = ev.at;
        if (COMPLETION_VERBS.includes(ev.verb)) sawCompletionVerb = true;
        break;
      case 'osc0':
        if (latestOsc0 === undefined || ev.at >= latestOsc0.at) {
          latestOsc0 = { at: ev.at, title: ev.title };
        }
        break;
      default:
        return assertNever(ev);
    }
  }

  // Byte-quiescence is the NECESSARY gate (the must-not-misclassify invariant): a session that has
  // rendered bytes and then gone quiet for >= the window is idle; a session still emitting bytes is
  // alive no matter what a stale OSC0/MCP signal says. A session that never rendered any byte is NOT
  // declared idle by absence alone (we have nothing to have gone quiet FROM).
  const byteQuiet = lastByteAt !== undefined && observedAt - lastByteAt >= quietWindow;
  // MCP quiescence: no active calls, and the last point/span edge is older than the window.
  // Corroborates only, but an in-flight call blocks idle even if it started before the quiet window.
  const mcpQuiet =
    activeMcpCalls === 0 && (lastMcpAt === undefined || observedAt - lastMcpAt >= quietWindow);
  // Codex's OSC0 idle edge corroborates (codex only). Claude's `✳`-prefixed title is NOT an edge and
  // is deliberately ignored here, so a persistent `✳` can never hang detection.
  const codexOsc0IdleEdge =
    config.provider === 'codex' && latestOsc0 !== undefined && isCodexIdleTitle(latestOsc0.title);

  const idle = byteQuiet && mcpQuiet;
  const idleSignals: IdleSignal[] = [];
  if (idle) {
    idleSignals.push('byte-quiescence');
    if (codexOsc0IdleEdge) idleSignals.push('codex-osc0');
    idleSignals.push('mcp-quiescence');
  }

  return { idle, sawCompletionVerb, idleSignals };
}

// Braille-pattern block (U+2800–U+28FF): codex renders its working spinner from these glyphs (`⠋⠙⠹…`).
const BRAILLE_FIRST = 0x2800;
const BRAILLE_LAST = 0x28ff;
// `✳` (U+2733) — Claude's persistent activity glyph; an activity marker, never a codex idle title.
const CLAUDE_ACTIVITY = 0x2733;

/**
 * A codex terminal title is an IDLE title when it is a plain `<dirname>` — i.e. it does NOT lead with
 * a braille spinner glyph (working) nor Claude's `✳` activity glyph. Whitespace-trimmed first.
 */
function isCodexIdleTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed === '') return false;
  const first = trimmed.codePointAt(0)!;
  const isSpinner = first >= BRAILLE_FIRST && first <= BRAILLE_LAST;
  return !isSpinner && first !== CLAUDE_ACTIVITY;
}

// OSC 0 terminal-title set: `ESC ] 0 ; <title> (BEL | ESC \)`. Authored with `\u` escapes so the
// SOURCE holds no raw control bytes; the title body excludes the terminators.
const OSC0_PATTERN = '\\u001B\\]0;([^\\u0007\\u001B]*)(?:\\u0007|\\u001B\\\\)';

/**
 * Extract every OSC-0 terminal title set in `chunk`, in order. The integration layer feeds these as
 * `{ kind: 'osc0' }` {@link DetectorEvent}s; exposing the parser keeps OSC0 handling pure + testable.
 */
export function parseOsc0Titles(chunk: string): string[] {
  const re = new RegExp(OSC0_PATTERN, 'g');
  const titles: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) titles.push(m[1] ?? '');
  return titles;
}
