import { describe, it, expect } from 'vitest';
import { slugifyCoordinatorName, coordinatorIdFromParts } from './coordinator-id.js';

describe('coordinator-id', () => {
  it('slugifies an operator name to a branch-safe handle', () => {
    expect(slugifyCoordinatorName('Auth Refactor!')).toBe('auth-refactor');
    expect(slugifyCoordinatorName('  spaces   and__under ')).toBe('spaces-and-under');
    expect(slugifyCoordinatorName('---')).toBe('coordinator'); // empty slug → stable fallback
  });
  it('builds a deterministic id from name + injected hex (no entropy of its own)', () => {
    expect(coordinatorIdFromParts('Auth Refactor', '9f3a1c')).toBe('coord-auth-refactor-9f3a1c');
    // pure: same inputs → same output (the uniqueness lives in the caller-supplied hex)
    expect(coordinatorIdFromParts('Auth Refactor', '9f3a1c')).toBe('coord-auth-refactor-9f3a1c');
  });
});
