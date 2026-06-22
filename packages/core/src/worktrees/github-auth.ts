import { delimiter, dirname, isAbsolute } from 'node:path';

/**
 * GitHub HTTPS auth provisioning for the daemon's git/gh seams (RC-3 / RC-4).
 *
 * The gated publish (`co_push`/`co_pr_merge`) and remote detection run DAEMON-side via `execFileSync`
 * with no env override ({@link import('./sling.js').defaultGitExec}, `defaultGhExec`, `defaultGitReader`,
 * the repo-mode remote probe), so they inherit the daemon's `process.env`. `gh` reads `GH_TOKEN`
 * directly, but a plain `git push` over HTTPS IGNORES `GH_TOKEN` — it needs a credential helper, and
 * the daemon has no usable `~/.gitconfig` in a sanitized/GUI launch. This builds the env block that
 * authenticates BOTH:
 *
 *   - `GH_TOKEN` / `GITHUB_TOKEN` — for `gh` (and as the password source for the helper below).
 *   - An env-scoped (`GIT_CONFIG_*`) credential helper bound to `https://github.com` that emits the
 *     token as the `x-access-token` password. No `~/.gitconfig`, no HOME, no dependency on `gh` being
 *     on the daemon PATH. Scoped to github.com HTTPS only — SSH origins (operator keys) are untouched.
 *   - `GIT_TERMINAL_PROMPT=0` — a missing/expired token fails LOUD (git exit 128) instead of hanging
 *     the daemon on an interactive username prompt (Principle 9).
 *
 * Pure: it COMPOSES with any inbound `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` in `baseEnv` (appends at
 * the next free index) so it never clobbers env-scoped git config the operator already set. Apply the
 * result onto the daemon `process.env` at `co-mcp serve` boot (see host.ts).
 */

/** The inline credential helper: emit the token as the password for an `x-access-token` user. Reads
 *  `$GH_TOKEN` from the environment at git-credential time, so it carries no secret in the value. */
const GITHUB_CREDENTIAL_HELPER =
  '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

/** Commands to try when resolving `gh` from a GUI launch with a minimal PATH. */
export const GH_AUTH_TOKEN_COMMANDS = [
  'gh',
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/usr/bin/gh',
] as const;

/**
 * Per-candidate cap for `gh auth token`. Four candidates worst-case at 1.5s remains below the
 * desktop daemon health budget (10s), so optional auth discovery cannot make startup look dead.
 */
export const GH_AUTH_TOKEN_TIMEOUT_MS = 1_500;

/**
 * Resolve a GitHub token from an env's EXPLICIT token variables — the single source of truth for the
 * precedence policy (the env-only part; the daemon adds a `gh auth token` fallback on top). Order:
 * `CO_GH_TOKEN` (co-specific override) wins, then `GH_TOKEN` then `GITHUB_TOKEN` — matching `gh`'s own
 * native precedence (`GH_TOKEN` > `GITHUB_TOKEN`) so the daemon picks the same token `gh` would.
 * Whitespace is trimmed; blank/whitespace-only values are treated as absent. Returns `undefined` when
 * no token is set. Pure (reads only `env`).
 */
export function resolveGhTokenFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return [env['CO_GH_TOKEN'], env['GH_TOKEN'], env['GITHUB_TOKEN']]
    .map((v) => v?.trim())
    .find((v) => v != null && v.length > 0);
}

/**
 * Build the env additions that authenticate the daemon's `gh` and `git push https://github.com`.
 * Returns `{}` for a blank token. `baseEnv` is read (never mutated) to compose `GIT_CONFIG_COUNT`.
 */
export function githubHttpsCredentialEnv(
  token: string,
  baseEnv: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const trimmed = token.trim();
  if (trimmed.length === 0) return {};

  const parsedBase = Number.parseInt(baseEnv['GIT_CONFIG_COUNT'] ?? '', 10);
  const start = Number.isInteger(parsedBase) && parsedBase > 0 ? parsedBase : 0;

  return {
    GH_TOKEN: trimmed,
    GITHUB_TOKEN: trimmed,
    GIT_CONFIG_COUNT: String(start + 2),
    [`GIT_CONFIG_KEY_${start}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${start}`]: GITHUB_CREDENTIAL_HELPER,
    [`GIT_CONFIG_KEY_${start + 1}`]: 'credential.https://github.com.useHttpPath',
    [`GIT_CONFIG_VALUE_${start + 1}`]: 'false',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * If `gh` was discovered through an absolute fallback, prepend its directory to PATH so later daemon
 * seams that intentionally call bare `gh` (`gh pr create`, `gh repo view`) use the same binary.
 */
export function ghCommandPathEnv(
  command: string,
  baseEnv: NodeJS.ProcessEnv = {},
): Record<string, string> {
  if (!isAbsolute(command)) return {};
  const dir = dirname(command);
  const current = baseEnv['PATH'] ?? '';
  const entries = current.split(delimiter).filter((entry) => entry.length > 0);
  if (entries.includes(dir)) return {};
  return { PATH: entries.length > 0 ? [dir, ...entries].join(delimiter) : dir };
}
