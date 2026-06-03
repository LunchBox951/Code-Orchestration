import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCoreRegistry, toolsForRole, type Role } from '@co/core';
import { CO_ROLE_ENV, toolsFromEnv } from './context.js';

/** Mirror the CO_DATA_DIR idiom in mail.test.ts: save/restore process.env. */
const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('toolsFromEnv — role-scoped tool-list from launch environment', () => {
  it('returns undefined when CO_ROLE is absent', () => {
    delete process.env[CO_ROLE_ENV];
    const result = toolsFromEnv();
    expect(result).toBeUndefined();
  });

  it('returns undefined when CO_ROLE is empty or whitespace-only', () => {
    process.env[CO_ROLE_ENV] = '';
    expect(toolsFromEnv()).toBeUndefined();

    process.env[CO_ROLE_ENV] = '   ';
    expect(toolsFromEnv()).toBeUndefined();
  });

  it('returns undefined when CO_ROLE is unrecognized (fail-soft)', () => {
    process.env[CO_ROLE_ENV] = 'wizard';
    const result = toolsFromEnv();
    expect(result).toBeUndefined();
  });

  it('returns exactly toolsForRole(role) when CO_ROLE names a valid base role', () => {
    const validRoles: Role[] = ['coordinator', 'lead', 'implementer', 'reviewer', 'researcher'];

    for (const role of validRoles) {
      process.env[CO_ROLE_ENV] = role;
      const result = toolsFromEnv();
      const expected = toolsForRole(role);

      expect(result).toBeDefined();
      expect(result).toEqual(expected);
      // Verify it's a subset and the tool names match (e.g., reviewer excludes co_mail_retract).
      const resultNames = result!.map((t) => t.name).sort();
      const expectedNames = expected.map((t) => t.name).sort();
      expect(resultNames).toEqual(expectedNames);
    }
  });

  it('handles case-insensitive and whitespace-trimmed CO_ROLE', () => {
    process.env[CO_ROLE_ENV] = '  IMPLEMENTER  ';
    const result = toolsFromEnv();
    const expected = toolsForRole('implementer');

    expect(result).toBeDefined();
    expect(result).toEqual(expected);
    expect(result!.map((t) => t.name).sort()).toEqual(expected.map((t) => t.name).sort());
  });

  it('reviewer toolset is scoped (excludes co_mail_retract)', () => {
    process.env[CO_ROLE_ENV] = 'reviewer';
    const result = toolsFromEnv();

    expect(result).toBeDefined();
    const toolNames = result!.map((t) => t.name);
    expect(toolNames).not.toContain('co_mail_retract');
    // Also check that the full registry has more tools.
    const fullRegistry = buildCoreRegistry();
    const allTools = fullRegistry.list();
    expect(allTools.length).toBeGreaterThan(result!.length);
  });
});
