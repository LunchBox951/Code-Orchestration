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
 * Credential-shaped tokens. Each pattern requires a distinctive prefix or fixed shape so ordinary
 * prose is never mangled; the per-post human approval remains the real backstop. Covers GitHub
 * classic/fine-grained PATs, OpenAI-style `sk-` keys, GitLab PATs, Slack tokens, AWS access-key
 * ids, Google API keys, npm tokens, PEM private-key blocks, and Bearer / HTTP-Basic credentials.
 */
const TOKEN_RES: readonly RegExp[] = [
  /\bghp_[A-Za-z0-9]{16,}\b/gu, // GitHub classic PAT
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/gu, // GitHub fine-grained PAT
  /\bsk-[A-Za-z0-9_-]{16,}\b/gu, // OpenAI-style secret key
  /\bglpat-[A-Za-z0-9_-]{16,}\b/gu, // GitLab PAT
  /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/gu, // Slack token
  /\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/gu, // AWS access key id
  /\bAIza[A-Za-z0-9_-]{35}\b/gu, // Google API key
  /\bnpm_[A-Za-z0-9]{36}\b/gu, // npm access/automation token
  // PEM private-key block of any key type (multiline) — a leaked private key is the worst case.
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/gu,
  // Bearer credential — case-insensitive keyword; log/header dumps frequently lowercase it.
  /\bbearer\s+(?!\[redacted-token\])[A-Za-z0-9._~+/=-]+/giu,
  // HTTP Basic auth, anchored on the Authorization header so ordinary "Basic …" prose is untouched.
  /\bAuthorization:\s*Basic\s+(?!\[redacted-token\])[A-Za-z0-9+/=._-]+/giu,
];

/**
 * Replace one credential match. Keyword-prefixed credentials (Bearer, Authorization: Basic) keep
 * their label so the surrounding line stays readable and the negative lookahead keeps redaction
 * idempotent; every other shape is replaced wholesale.
 */
function redactTokenMatch(match: string): string {
  const bearer = /^bearer\b/iu.exec(match);
  if (bearer != null) return `${match.slice(0, bearer[0].length)} ${REDACTED_TOKEN}`;
  const basic = /^Authorization:\s*Basic\b/iu.exec(match);
  if (basic != null) return `${match.slice(0, basic[0].length)} ${REDACTED_TOKEN}`;
  return REDACTED_TOKEN;
}

/**
 * Scrub an outward issue text: redact home-directory usernames, email addresses, and
 * credential-shaped tokens. Returns the scrubbed text; clean text passes through unchanged.
 */
export function scrubIssueText(text: string): string {
  let scrubbed = text.replace(HOME_PATH_RE, `$1${REDACTED_PATH}`);
  scrubbed = scrubbed.replace(EMAIL_RE, REDACTED_EMAIL);
  for (const re of TOKEN_RES) {
    scrubbed = scrubbed.replace(re, redactTokenMatch);
  }
  return scrubbed;
}
