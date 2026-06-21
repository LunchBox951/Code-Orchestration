import { describe, it, expect } from 'vitest';
import { scrubIssueText } from './scrub.js';

// L6b G — the scrub policy: an outward issue body never leaks local identity (home paths,
// emails) or credentials. Scrubbing is the mechanical pass; the per-post human approval is the
// real backstop (specs-and-issues.md §"File — with per-post approval").

describe('scrubIssueText — redactions', () => {
  it('redacts home-directory usernames (linux and macOS)', () => {
    expect(scrubIssueText('failed at /home/skyler/dev/co/src/x.ts')).toBe(
      'failed at /home/[redacted]/dev/co/src/x.ts',
    );
    expect(scrubIssueText('see /Users/skyler.clemens/repo')).toBe('see /Users/[redacted]/repo');
  });

  it('redacts email addresses', () => {
    expect(scrubIssueText('author was someone@example.com here')).toBe(
      'author was [redacted-email] here',
    );
  });

  it('redacts credential-shaped tokens', () => {
    expect(scrubIssueText('used ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe(
      'used [redacted-token]',
    );
    expect(scrubIssueText('key sk-proj-AbCdEf0123456789AbCdEf01')).toBe('key [redacted-token]');
    expect(scrubIssueText('header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y')).toBe(
      'header Authorization: Bearer [redacted-token]',
    );
    expect(scrubIssueText('pat github_pat_11ABCDEFG0_abcdefghij')).toBe('pat [redacted-token]');
  });

  it('redacts additional fixed-shape secrets (AWS, GCP, npm, PEM)', () => {
    expect(scrubIssueText('env AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE rest')).toBe(
      'env AWS_ACCESS_KEY_ID=[redacted-token] rest',
    );
    expect(scrubIssueText('key AIzaSyA_1234567890abcdefghijklmnopqrstu done')).toBe(
      'key [redacted-token] done',
    );
    expect(scrubIssueText('token npm_abcdefghijklmnopqrstuvwxyz0123456789 ok')).toBe(
      'token [redacted-token] ok',
    );
    expect(
      scrubIssueText(
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      ),
    ).toBe('[redacted-token]');
  });

  it('redacts bearer credentials case-insensitively and Authorization: Basic', () => {
    expect(scrubIssueText('authorization: bearer eyJhbGciOi.abc.def')).toBe(
      'authorization: bearer [redacted-token]',
    );
    expect(scrubIssueText('AUTH: BEARER eyJhbGciOi.abc.def')).toBe('AUTH: BEARER [redacted-token]');
    expect(scrubIssueText('header Authorization: Basic dXNlcjpwYXNzd29yZA== end')).toBe(
      'header Authorization: Basic [redacted-token] end',
    );
  });

  it('does not mangle ordinary prose containing "Basic"', () => {
    const prose = 'A Basic understanding of the dispatch policy is required.';
    expect(scrubIssueText(prose)).toBe(prose);
  });

  it('leaves clean text untouched', () => {
    const clean = 'co_finish returned success but no worker_done mail was emitted (seq 42).';
    expect(scrubIssueText(clean)).toBe(clean);
  });

  it('is idempotent — scrubbing twice equals scrubbing once', () => {
    const dirty = 'at /home/skyler/x by someone@example.com with ghp_0123456789abcdefghijklmnop';
    expect(scrubIssueText(scrubIssueText(dirty))).toBe(scrubIssueText(dirty));
  });
});
