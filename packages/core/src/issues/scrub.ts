/**
 * L6b G scrub policy: the mechanical redaction pass run over every outward issue artifact (title
 * and body) BEFORE it is shown for approval and BEFORE it is posted. Working from `co`'s behavior
 * + `co`'s source keeps reports scrubbable by construction (specs-and-issues.md §"Diagnose");
 * this pass removes what still leaks through — local identity (home-directory usernames, email
 * addresses) and credential-shaped tokens. Scrubbing is deliberately conservative pattern
 * matching, not understanding: the per-post human approval is the real backstop.
 *
 * Pure and idempotent: scrubbing already-scrubbed text is a no-op, so the approval preview and
 * the posted body can both be produced by scrubbing without double-redaction artifacts.
 */

const REDACTED_PATH = '[redacted]';
const REDACTED_EMAIL = '[redacted-email]';
const REDACTED_TOKEN = '[redacted-token]';

/** Home-directory username segments: `/home/<user>` (Linux) and `/Users/<user>` (macOS). */
const HOME_PATH_RE = /(\/(?:home|Users)\/)(?!\[redacted\])[^/\s]+/gu;

/** RFC-ish email addresses (conservative; redacts the whole address). */
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;

/**
 * Credential-shaped tokens: GitHub classic/fine-grained PATs, OpenAI-style `sk-` keys, GitLab
 * PATs, Slack tokens, and any Bearer credential. Each pattern requires a distinctive prefix so
 * ordinary prose is never mangled.
 */
const TOKEN_RES: readonly RegExp[] = [
  /\bghp_[A-Za-z0-9]{16,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/gu,
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/gu,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/gu,
  /\bBearer\s+(?!\[redacted-token\])[A-Za-z0-9._~+/=-]+/gu,
];

/**
 * Scrub an outward issue text: redact home-directory usernames, email addresses, and
 * credential-shaped tokens. Returns the scrubbed text; clean text passes through unchanged.
 */
export function scrubIssueText(text: string): string {
  let scrubbed = text.replace(HOME_PATH_RE, `$1${REDACTED_PATH}`);
  scrubbed = scrubbed.replace(EMAIL_RE, REDACTED_EMAIL);
  for (const re of TOKEN_RES) {
    scrubbed = scrubbed.replace(re, (match) =>
      match.startsWith('Bearer') ? `Bearer ${REDACTED_TOKEN}` : REDACTED_TOKEN,
    );
  }
  return scrubbed;
}
