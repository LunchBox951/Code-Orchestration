/**
 * Shared provider startup-byte fixtures (the B1 byte signatures). Each value is RAW pty bytes — ANSI
 * cursor-moves / colours / OSC title sets around the documented prompt text — so a consumer exercises
 * the real path: normalize (strip ANSI, collapse whitespace) → classify.
 *
 * These were declared inline in `startup-classifier.test.ts`; they are lifted here so BOTH the
 * classifier tests AND the Conductor host-proof harness (`packages/mcp`) drive ONE source of truth
 * instead of re-declaring divergent copies.
 *
 * PROVENANCE TAGS carry host-verify-later semantics — DO NOT drop or relabel them:
 *   - `[documented]`  — live-probe-verified bytes (a real probe captured this signature).
 *   - `[synthesized]` — a documented-plausible guess the host-live E2E is expected to confirm.
 *   - `[host-live]`   — bytes captured from a real provider build on the operator's host.
 *
 * ESC/BEL are authored from their code points (`String.fromCharCode`) so this SOURCE holds NO raw
 * control bytes (a leaked raw ESC breaks tooling — see the C2 pristine-repo rule). Grep-verify the
 * file is clean of raw 0x1b / 0x07.
 */

const ESC = String.fromCharCode(0x1b); // 0x1B authored as a code point so this SOURCE holds no raw control byte
const BEL = String.fromCharCode(0x07); // 0x07 authored as a code point so this SOURCE holds no raw control byte

// ── claude ───────────────────────────────────────────────────────────────────
// [documented] trust prompt: "Quick safety check" … "Yes, I trust this folder".
export const CLAUDE_TRUST =
  ESC +
  '[2J' +
  ESC +
  '[H' +
  '╭───────────────────────────╮\r\n' +
  '│  Quick safety check       │\r\n' +
  '│                           │\r\n' +
  ESC +
  '[1;36m' +
  '❯ 1. Yes, I trust this folder' +
  ESC +
  '[0m' +
  '\r\n  2. No, ask me later\r\n';

// [documented] ready: welcome box + ❯ composer + "? for shortcuts" (stable status line).
export const CLAUDE_READY =
  ESC +
  ']0;claude' +
  BEL +
  ESC +
  '[2J' +
  '╭─ Welcome to Claude Code ─╮\r\n' +
  '❯ ' +
  ESC +
  '[2mTry "fix the build"' +
  ESC +
  '[0m\r\n' +
  '  ? for shortcuts\r\n';

// [host-live] Claude Code 2.1.158 paints the ready footer with cursor-positioning between words,
// not literal spaces: `?` at col 3, `for` at col 5, `shortcuts` at col 9.
export const CLAUDE_READY_CURSOR_POSITIONED =
  ESC +
  ']0;✳ Claude Code' +
  BEL +
  '❯ ' +
  ESC +
  '[7m ' +
  ESC +
  '[27m\r\n' +
  ESC +
  '[3G?' +
  ESC +
  '[5Gfor' +
  ESC +
  '[9Gshortcuts' +
  ESC +
  '[19G·' +
  ESC +
  '[21G←' +
  ESC +
  '[23Gfor' +
  ESC +
  '[27Gagents\r\n';

// [host-live] Claude Code 2.1.158 no longer shows `? for shortcuts`; the stable ready footer is the
// permission-mode/status strip with `shift+tab to cycle`, `for agents`, and a token count.
export const CLAUDE_READY_STATUS_STRIP =
  ESC +
  ']0;✳ Claude Code' +
  BEL +
  '▐▛███▜▌ Claude Code v2.1.158\r\n' +
  '❯ Try "how do I log an error?"\r\n' +
  "⏵⏵ don't ask on (shift+tab to cycle) · ← for agents                 0 tokens\r\n";

// [host-live] Claude Code 2.1.181 launched with `--permission-mode bypassPermissions`: the status strip
// reads "bypass permissions on" in place of the don't-ask/token-count region, so the ready footer is
// detected on `shift+tab` + `agents` alone (NOT a token count). Without this the conductor never
// classifies a bypass-mode coordinator as ready and times out at startup.
export const CLAUDE_READY_BYPASS_STRIP =
  ESC +
  ']0;✳ Claude Code' +
  BEL +
  '▐▛███▜▌ Claude Code v2.1.181\r\n' +
  '❯ Try "how do I log an error?"\r\n' +
  '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\r\n';

// [synthesized] first-run theme/onboarding picker: "Choose the text style…".
export const CLAUDE_THEME =
  ESC +
  '[2J' +
  'Choose the text style that looks best with your terminal:\r\n' +
  '❯ 1. Dark mode\r\n  2. Light mode\r\n';

// [documented] login menu: header + the three numbered methods.
export const CLAUDE_LOGIN =
  ESC +
  '[2J' +
  'Select login method:\r\n' +
  ESC +
  '[1m' +
  '❯ 1. Claude account with subscription' +
  ESC +
  '[0m\r\n' +
  '  2. Anthropic Console account\r\n' +
  '  3. 3rd-party platform\r\n';

// [host-live] Claude Code 2.1.158 can jump directly into the browser OAuth code prompt when an
// isolated config needs an auth scope refresh for MCP. This is terminal login-required, not ready.
export const CLAUDE_OAUTH_LOGIN =
  ESC +
  '[2J' +
  'Opening browser to sign in…\r\n' +
  "Browser didn't open? Use the url below to sign in (c to copy)\r\n" +
  'https://claude.com/cai/oauth/authorize?code=true&scope=user%3Amcp_servers\r\n' +
  'Paste code here if prompted >\r\n';

// ── codex ────────────────────────────────────────────────────────────────────
// [documented] update-available menu.
export const CODEX_UPDATE =
  ESC +
  '[2J' +
  'Update available!\r\n' +
  '❯ 1. Update now\r\n' +
  '  2. Skip\r\n' +
  '  3. Skip until next version\r\n';

// [synthesized] directory trust prompt.
export const CODEX_TRUST =
  ESC +
  '[2J' +
  'Do you trust the files in this directory?\r\n' +
  '❯ 1. Yes, allow Codex to work here\r\n' +
  '  2. No\r\n';

// [host-live] Codex 0.139.0 hook trust prompt for an isolated generated PreToolUse hook.
export const CODEX_HOOKS_REVIEW =
  ESC +
  '[2J' +
  'Hooks need review\r\n' +
  '1 hook is new or changed.\r\n' +
  'Hooks can run outside the sandbox after you trust them.\r\n' +
  '› 1. Review hooks\r\n' +
  '2. Trust all and continue\r\n' +
  "3. Continue without trusting (hooks won't run)\r\n";

// [synthesized] idle composer/status line ("send" + "newline" footer hints).
export const CODEX_READY =
  ESC +
  ']0;codex' +
  BEL +
  '▌ ' +
  ESC +
  '[2mAsk Codex…' +
  ESC +
  '[0m\r\n' +
  '⏎ send   ⌃J newline   ⌃C quit\r\n';

// [host-live] Codex 0.139.0 idle composer: prompt glyph + skills hint + model/cwd footer.
export const CODEX_READY_CURRENT =
  ESC +
  ']0;Code-Orchestration' +
  BEL +
  ESC +
  '[11;1H' +
  '›' +
  ESC +
  '[11;3H' +
  ESC +
  '[2mUse /skills to list available skills' +
  ESC +
  '[13;3H' +
  'gpt-5.5 xhigh' +
  ESC +
  '[2m · ' +
  '~/Documents/Code-Orchestration\r\n';

// [host-live] Codex 0.139.0 MCP startup screen: the idle footer is present but servers are still
// starting, so this must NOT classify as ready.
export const CODEX_MCP_STARTING =
  ESC +
  '[2J' +
  '• Starting MCP servers (0/2): co, codex_apps (0s • esc to interrupt)\r\n' +
  '› Use /skills to list available skills\r\n' +
  'gpt-5.5 default · ~/Documents/Code-Orchestration\r\n';

// [documented] sign-in menu.
export const CODEX_SIGNIN =
  ESC +
  '[2J' +
  '❯ 1. Sign in with ChatGPT\r\n' +
  '  2. Sign in with Device Code\r\n' +
  '  3. Provide your own API key\r\n';
