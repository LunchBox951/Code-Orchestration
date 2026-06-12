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

  it('leaves clean text untouched', () => {
    const clean = 'co_finish returned success but no worker_done mail was emitted (seq 42).';
    expect(scrubIssueText(clean)).toBe(clean);
  });

  it('is idempotent — scrubbing twice equals scrubbing once', () => {
    const dirty = 'at /home/skyler/x by someone@example.com with ghp_0123456789abcdefghijklmnop';
    expect(scrubIssueText(scrubIssueText(dirty))).toBe(scrubIssueText(dirty));
  });
});
