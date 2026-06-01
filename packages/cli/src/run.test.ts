import { describe, it, expect } from 'vitest';
import { run } from './run.js';

describe('cli run()', () => {
  it('reports which core package it is wired to', () => {
    expect(run()).toBe('co cli → @co/core');
  });
});
