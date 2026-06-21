import { describe, expect, it } from 'vitest';
import type { StartSessionParams } from './contract.js';

describe('operator IPC startSession contract', () => {
  it('requires a coordinator name at the type boundary', () => {
    const valid: StartSessionParams = { name: 'Docs', prompt: 'start' };
    expect(valid.name).toBe('Docs');

    // @ts-expect-error name is required by the public operator IPC contract.
    const missingName: StartSessionParams = { prompt: 'start' };
    expect(missingName.prompt).toBe('start');
  });
});
