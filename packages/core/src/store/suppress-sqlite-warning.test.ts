import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// Importing the module installs the process.emit shim as a side effect.
import './suppress-sqlite-warning.js';

function warning(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

describe('suppress-sqlite-warning', () => {
  let received: Error[];
  let spy: (w: Error) => void;
  let savedListeners: ReturnType<typeof process.listeners>;

  beforeEach(() => {
    received = [];
    // Detach the default warning printer so delegated warnings don't hit stderr,
    // and install a spy so we can observe what the shim lets through.
    savedListeners = process.listeners('warning');
    process.removeAllListeners('warning');
    spy = (w: Error) => {
      received.push(w);
    };
    process.on('warning', spy);
  });

  afterEach(() => {
    process.removeListener('warning', spy);
    for (const listener of savedListeners) {
      process.on('warning', listener);
    }
  });

  it('swallows the node:sqlite ExperimentalWarning', () => {
    const w = warning('ExperimentalWarning', 'SQLite is an experimental feature and might change');
    const result = process.emit('warning', w);
    expect(result).toBe(false);
    expect(received).toEqual([]);
  });

  it('delegates ExperimentalWarnings that are not about SQLite (no blanket suppression)', () => {
    const w = warning('ExperimentalWarning', 'Type Stripping is an experimental feature');
    process.emit('warning', w);
    expect(received).toEqual([w]);
  });

  it('delegates non-experimental warnings untouched', () => {
    const w = warning('DeprecationWarning', 'some API is deprecated');
    process.emit('warning', w);
    expect(received).toEqual([w]);
  });
});
