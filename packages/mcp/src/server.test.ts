import { describe, it, expect } from 'vitest';
import { describeServer } from './server.js';

describe('mcp describeServer()', () => {
  it('names the agent surface and the core it serves', () => {
    expect(describeServer()).toEqual({ surface: 'mcp', core: '@co/core' });
  });
});
