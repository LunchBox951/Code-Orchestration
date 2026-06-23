import { describe, expect, it } from 'vitest';
import {
  requireComposerField,
  requireFiniteSeq,
  requireGithubToken,
  requireMailTab,
  requireMailType,
  requireNavView,
  requireAgentId,
  requireNonEmptyString,
  requireReviewVerdict,
  requireSteer,
  requireInputData,
  requirePositiveDim,
} from './ipc-guards.js';

describe('main IPC runtime guards', () => {
  it('accepts registered nav views and rejects arbitrary renderer strings', () => {
    expect(requireNavView('mail')).toBe('mail');
    expect(requireNavView('settings')).toBe('settings');
    expect(() => requireNavView('bogus-view')).toThrow(/nav view/i);
  });

  it('accepts mail tabs and rejects arbitrary renderer strings', () => {
    expect(requireMailTab('outbox')).toBe('outbox');
    expect(() => requireMailTab('archive')).toThrow(/mail tab/i);
  });

  it('accepts registered mail types and rejects arbitrary renderer strings', () => {
    expect(requireMailType('clarify_response')).toBe('clarify_response');
    expect(() => requireMailType('freeform')).toThrow(/mail type/i);
  });

  it('accepts positive sequence numbers and rejects NaN, fractional, or non-positive values', () => {
    expect(requireFiniteSeq(42, 'seq')).toBe(42);
    expect(() => requireFiniteSeq(Number.NaN, 'seq')).toThrow(/seq/i);
    expect(() => requireFiniteSeq(1.5, 'seq')).toThrow(/seq/i);
    expect(() => requireFiniteSeq(0, 'seq')).toThrow(/seq/i);
    expect(() => requireFiniteSeq(-1, 'seq')).toThrow(/seq/i);
  });

  it('accepts composer fields and rejects arbitrary renderer strings', () => {
    expect(requireComposerField('body')).toBe('body');
    expect(() => requireComposerField('decision')).toThrow(/composer field/i);
  });

  it('accepts non-empty strings and rejects empty or non-string values', () => {
    expect(requireNonEmptyString('@operator', 'mail bus')).toBe('@operator');
    expect(() => requireNonEmptyString('', 'mail bus')).toThrow(/mail bus/i);
    expect(() => requireNonEmptyString(42, 'mail bus')).toThrow(/mail bus/i);
  });

  it('accepts nonblank agent ids and rejects whitespace-only values', () => {
    expect(requireAgentId('impl-x')).toBe('impl-x');
    expect(requireAgentId(' impl-x ')).toBe('impl-x');
    expect(() => requireAgentId('')).toThrow(/agentId/i);
    expect(() => requireAgentId('   ')).toThrow(/agentId/i);
    expect(() => requireAgentId(42)).toThrow(/agentId/i);
  });

  it('github:connect guard accepts a non-blank token (trimmed) and rejects empty/blank/non-string', () => {
    expect(requireGithubToken('ghp_abc123')).toBe('ghp_abc123');
    expect(requireGithubToken('  ghp_trimmed  ')).toBe('ghp_trimmed');
    expect(() => requireGithubToken('')).toThrow(/GitHub token/i);
    expect(() => requireGithubToken('   ')).toThrow(/GitHub token/i);
    expect(() => requireGithubToken(null)).toThrow(/GitHub token/i);
    expect(() => requireGithubToken(42)).toThrow(/GitHub token/i);
  });

  it('github:connect guard never echoes the token value into the error message (no secret leak)', () => {
    // A non-string with a recognizable payload — the message must describe the failure, not the value.
    let message = '';
    try {
      requireGithubToken({ secret: 'ghp_LEAK_ME' });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toMatch(/GitHub token/i);
    expect(message).not.toContain('ghp_LEAK_ME');
  });

  it('accepts PASS/ISSUES verdicts and rejects arbitrary strings', () => {
    expect(requireReviewVerdict('PASS')).toBe('PASS');
    expect(requireReviewVerdict('ISSUES')).toBe('ISSUES');
    expect(() => requireReviewVerdict('pass')).toThrow(/review verdict/i);
    expect(() => requireReviewVerdict('OK')).toThrow(/review verdict/i);
    expect(() => requireReviewVerdict(42)).toThrow(/review verdict/i);
  });

  it('accepts valid steer payloads', () => {
    expect(requireSteer({ kind: 'answer', text: 'use claude' })).toEqual({
      kind: 'answer',
      text: 'use claude',
    });
    expect(requireSteer({ kind: 'redirect', text: 'try the other branch' })).toEqual({
      kind: 'redirect',
      text: 'try the other branch',
    });
    expect(requireSteer({ kind: 'interrupt' })).toEqual({ kind: 'interrupt' });
  });

  it('rejects invalid steer payloads', () => {
    expect(() => requireSteer({ kind: 'answer' })).toThrow(/steer text/i);
    expect(() => requireSteer({ kind: 'redirect', text: '' })).toThrow(/steer text/i);
    expect(() => requireSteer({ kind: 'answer', text: '   ' })).toThrow(/steer text/i);
    expect(() => requireSteer({ kind: 'teleport', text: 'nope' })).toThrow(/steer kind/i);
    expect(() => requireSteer(null)).toThrow(/steer/i);
  });

  it('accepts terminal input strings (including empty) and rejects non-strings / oversized chunks', () => {
    expect(requireInputData('y\r', 'input data')).toBe('y\r');
    expect(requireInputData('', 'input data')).toBe('');
    expect(() => requireInputData(42, 'input data')).toThrow(/input data/i);
    expect(() => requireInputData('x'.repeat(1024 * 1024 + 1), 'input data')).toThrow(
      /input data/i,
    );
  });

  it('accepts positive integer PTY dimensions and rejects NaN, fractional, or non-positive values', () => {
    expect(requirePositiveDim(80, 'cols')).toBe(80);
    expect(() => requirePositiveDim(Number.NaN, 'cols')).toThrow(/cols/i);
    expect(() => requirePositiveDim(24.5, 'rows')).toThrow(/rows/i);
    expect(() => requirePositiveDim(0, 'cols')).toThrow(/cols/i);
    expect(() => requirePositiveDim(-1, 'rows')).toThrow(/rows/i);
    expect(() => requirePositiveDim('80', 'cols')).toThrow(/cols/i);
  });
});
