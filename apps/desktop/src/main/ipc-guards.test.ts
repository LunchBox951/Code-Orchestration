import { describe, expect, it } from 'vitest';
import {
  requireComposerField,
  requireFiniteSeq,
  requireMailTab,
  requireMailType,
  requireNavView,
} from './ipc-guards.js';

describe('main IPC runtime guards', () => {
  it('accepts registered nav views and rejects arbitrary renderer strings', () => {
    expect(requireNavView('mail')).toBe('mail');
    expect(() => requireNavView('settings')).toThrow(/nav view/i);
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
});
