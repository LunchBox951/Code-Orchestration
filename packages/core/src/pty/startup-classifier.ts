/**
 * L7 B1 — the startup-interstitial classifier (PURE, provider-aware).
 *
 * A freshly-spawned interactive `claude`/`codex` TUI walks through a short sequence of startup
 * dialogs (trust prompts, an update-available menu, a theme picker) before it settles at a ready
 * composer — OR it stops at a terminal "you must log in" menu. This module answers, from the
 * *current* whitespace-normalized output buffer alone, "what startup state are we in, and (if it is
 * an interstitial) what bytes answer it?". It is pure: no pane, no timers, no I/O — so it is fully
 * exercised in-sandbox over `FakePty` fixtures synthesized from the documented byte signatures.
 *
 * Detection rules honour the L7 prohibitions (AC-L7-1):
 *   - NO TUI-chrome regex / screen-scraping. We match on the documented *prompt text*, anchored on
 *     stable signatures, never on rotating chrome (spinners, the rotating composer placeholder, the
 *     redrawn box-borders). `readyAnchors` is the stable status line `? for shortcuts`, NOT the
 *     placeholder that rotates inside the composer.
 *   - WHITESPACE-NORMALIZED matching ({@link normalizeStartupOutput}): TUIs position text with cursor
 *     moves and pad with runs of spaces, so literal-space / literal-position matching is fragile. We
 *     strip ANSI escape sequences and collapse all whitespace before matching.
 *
 * Provenance of each anchor below: `[documented]` = verbatim from the live-probe-verified P0 byte
 * signatures in the B1 spec; `[synthesized]` = the spec described the dialog but did not embed its
 * exact bytes, so the anchor is a documented-plausible guess that the operator's host-side live-binary
 * E2E (AC-L7-1 `[host-live]`) confirms/corrects. The pure-logic guarantee (drive MY fixtures to the
 * right answer) holds either way; only the real-binary anchor text is host-verified.
 */

// Reuse the canonical project-wide provider enum (`'claude' | 'codex'`) rather than minting a second
// one; it already lives in the dispatch layer and is part of the public barrel. Type-only import, so
// there is no runtime coupling between the pty substrate and the dispatch/usage module.
import type { Provider } from '../dispatch/usage-source.js';
export type { Provider };

/** The startup interstitials we know how to answer. */
export type StartupInterstitialName = 'trust' | 'update' | 'theme';

/**
 * The classified startup state for the current output buffer.
 *   - `starting`        — nothing recognized yet; keep reading (never false-`ready`).
 *   - `interstitial`    — a known dialog is up; `answer` is the bytes to write (≤2 keypresses).
 *   - `ready`           — the ready composer is recognized ⇒ the session is authed.
 *   - `login_required`  — a terminal login menu is up; surface `methods` to the operator, do NOT drive.
 */
export type StartupPhase =
  | { readonly kind: 'starting' }
  | {
      readonly kind: 'interstitial';
      readonly name: StartupInterstitialName;
      readonly answer: string;
    }
  | { readonly kind: 'ready' }
  | { readonly kind: 'login_required'; readonly methods: readonly string[] };

/** One numbered login method: the human-readable `canonical` label, detected by its `match` text. */
interface MethodSig {
  /** The label surfaced to the operator (documented form, with its number). */
  readonly canonical: string;
  /** Lowercased distinctive substring (no number prefix — robust to dot/space rendering). */
  readonly match: string;
}

interface InterstitialSig {
  readonly name: StartupInterstitialName;
  /** Bytes to write to answer this dialog (≤2 keypresses). */
  readonly answer: string;
  /** Lowercased anchors; ALL must be present for this interstitial to match. */
  readonly anchors: readonly string[];
}

interface ProviderSignatures {
  /** Lowercased anchors; ALL present ⇒ ready (authed). The stable status line, never placeholder. */
  readonly readyAnchors: readonly string[];
  /** Lowercased anchors; ALL present ⇒ login_required (terminal). */
  readonly loginAnchors: readonly string[];
  /** Known login methods; those whose `match` is present are captured (surfaced, not answered). */
  readonly methods: readonly MethodSig[];
  /** Interstitials, in startup-flow order (earliest first). */
  readonly interstitials: readonly InterstitialSig[];
}

const SIGNATURES: Readonly<Record<Provider, ProviderSignatures>> = {
  claude: {
    // [documented] welcome box + `❯` composer + `? for shortcuts`; anchor the STABLE status line.
    readyAnchors: ['? for shortcuts'],
    // [documented] `Select login method:` header.
    loginAnchors: ['select login method'],
    methods: [
      // [documented] 1. Claude account with subscription / 2. Anthropic Console account / 3. 3rd-party platform
      {
        canonical: '1. Claude account with subscription',
        match: 'claude account with subscription',
      },
      { canonical: '2. Anthropic Console account', match: 'anthropic console account' },
      { canonical: '3. 3rd-party platform', match: '3rd-party platform' },
    ],
    interstitials: [
      // [documented] `Quick safety check` … `Yes, I trust this folder`; answer Enter.
      { name: 'trust', answer: '\r', anchors: ['quick safety check', 'yes, i trust this folder'] },
      // [synthesized] first-run theme/onboarding picker; answer Enter to advance toward the login menu.
      { name: 'theme', answer: '\r', anchors: ['choose the text style'] },
    ],
  },
  codex: {
    // [synthesized] idle composer footer hints (`send` + `newline` must BOTH be present); stable, NOT
    // the placeholder. Host-side hardening (review #178): if live probes show false-ready positives
    // from these short words, anchor instead on a longer codex-specific token such as the idle
    // composer block element `▌`. Kept as the broader AND-match here because over-narrowing to an
    // unverified glyph risks the worse failure (a false-NEGATIVE ready → the session hangs at startup);
    // the `login_required`-before-`ready` precedence already guards the dangerous logged-out case.
    readyAnchors: ['send', 'newline'],
    // [documented] sign-in menu: anchor on the first + last options (the header is not documented).
    loginAnchors: ['sign in with chatgpt', 'provide your own api key'],
    methods: [
      // [documented] 1. Sign in with ChatGPT / 2. Sign in with Device Code / 3. Provide your own API key
      { canonical: '1. Sign in with ChatGPT', match: 'sign in with chatgpt' },
      { canonical: '2. Sign in with Device Code', match: 'sign in with device code' },
      { canonical: '3. Provide your own API key', match: 'provide your own api key' },
    ],
    interstitials: [
      // [documented] update-available menu `1. Update now` / `2. Skip` / ...; answer the skip number + Enter.
      { name: 'update', answer: '2\r', anchors: ['1. update now', '2. skip'] },
      // [synthesized] directory trust prompt (may be pre-seeded absent by P1); answer Enter.
      { name: 'trust', answer: '\r', anchors: ['trust', 'directory'] },
    ],
  },
};

const EMPTY_ANSWERED: ReadonlySet<StartupInterstitialName> = new Set();

// ANSI/VT control sequences: CSI cursor-moves + SGR colours (ending in a letter / `=><~`) and OSC
// title sets (ending in BEL). Stripped before whitespace-collapse so cursor-positioning noise never
// breaks a prompt-text match. Pattern after the well-proven `ansi-regex`, built via `new RegExp` with
// \u escapes so the SOURCE holds no raw control bytes (the control chars only exist at runtime).
const ANSI_ESCAPE = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  'g',
);

/**
 * Whitespace-normalize raw pty output for prompt-text matching: strip ANSI escape sequences, then
 * collapse every run of whitespace (spaces, tabs, CRs, LFs the TUI uses to position text) to a single
 * space and trim. Case is preserved so captured login-method labels stay human-readable.
 */
export function normalizeStartupOutput(raw: string): string {
  return raw.replace(ANSI_ESCAPE, '').replace(/\s+/g, ' ').trim();
}

/**
 * Classify the CURRENT startup state from the whitespace-normalized output buffer.
 *
 * Precedence is deliberate and fail-loud (Principle 9): `login_required` is checked BEFORE `ready` so
 * a logged-out screen whose footer happens to share a `ready` anchor surfaces the login requirement
 * rather than being mis-reported as an authed session (a silent failure). `answered` lets the driver
 * advance past an already-answered interstitial to the next one in the same flow (e.g. codex
 * update → trust) instead of re-matching the persistent earlier anchor in the accumulated buffer.
 */
export function classifyStartup(
  provider: Provider,
  normalizedOutput: string,
  answered: ReadonlySet<StartupInterstitialName> = EMPTY_ANSWERED,
): StartupPhase {
  const sig = SIGNATURES[provider];
  const hay = normalizedOutput.toLowerCase();
  const has = (needle: string): boolean => hay.includes(needle);
  const allPresent = (anchors: readonly string[]): boolean => anchors.every(has);

  if (allPresent(sig.loginAnchors)) {
    const present = sig.methods.filter((m) => has(m.match)).map((m) => m.canonical);
    const methods = present.length > 0 ? present : sig.methods.map((m) => m.canonical);
    return { kind: 'login_required', methods };
  }
  if (allPresent(sig.readyAnchors)) {
    return { kind: 'ready' };
  }
  for (const it of sig.interstitials) {
    if (answered.has(it.name)) continue;
    if (allPresent(it.anchors)) {
      return { kind: 'interstitial', name: it.name, answer: it.answer };
    }
  }
  return { kind: 'starting' };
}
