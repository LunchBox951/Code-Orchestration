import { describe, expect, it } from 'vitest';
import { ConductorUnavailableError } from '@co/mcp';
import { desktopErrorMessage } from './desktop-errors.js';

describe('desktopErrorMessage', () => {
  it('maps ConductorUnavailableError to app-owned daemon guidance', () => {
    const message = desktopErrorMessage(
      new ConductorUnavailableError('Conductor unavailable; run `co-mcp serve test-project`.'),
      'start a session',
    );

    expect(message).toContain('the app manages the daemon');
    expect(message).toContain('to start a session');
    expect(message).not.toContain('co-mcp serve');
  });

  it('passes through ordinary Error messages', () => {
    expect(desktopErrorMessage(new Error('bad input'), 'start a session')).toBe('bad input');
  });
});
