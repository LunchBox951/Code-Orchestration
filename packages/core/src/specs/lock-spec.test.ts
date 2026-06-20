import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATOR } from '../mail/events.js';
import { openSpecStore, type SpecStore } from './specs-store.js';
import { lockSpec } from './lock-spec.js';
import type { Criterion } from './criteria-schema.js';

// The shared spec-lock primitive: identity-agnostic (the caller owns the operator gate); refuses a
// missing / non-draft spec and any fuzzy criterion; otherwise records the lock with the given actor.

const ORIGINAL_ENV = process.env;
let dataDir: string;
let stores: SpecStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDir = mkdtempSync(join(tmpdir(), 'co-lock-spec-'));
  process.env.CO_DATA_DIR = dataDir;
  stores = [];
});

afterEach(() => {
  for (const s of stores) s.close();
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

function openSpecs(id: string): SpecStore {
  const specs = openSpecStore(id);
  stores.push(specs);
  return specs;
}

const VALID_CRITERIA: Criterion[] = [
  { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
  { text: 'format check passes', verify: 'pnpm format:check' },
];

function seedDraft(specs: SpecStore, taskId: string, criteria: readonly Criterion[]): void {
  specs.recordDraft({ taskId, title: 'T', goal: 'G', criteria, body: 'body', actor: 'coord-1' });
}

describe('lockSpec — the shared lock primitive', () => {
  it('locks a valid-criteria draft and records the given actor', () => {
    const specs = openSpecs('p-lockspec-ok');
    seedDraft(specs, 'task-1', VALID_CRITERIA);

    const locked = lockSpec(specs, 'task-1', OPERATOR);

    expect(locked.state).toBe('locked');
    expect(locked.lockedBy).toBe(OPERATOR);
    expect(specs.getSpec('task-1')?.state).toBe('locked');
  });

  it('refuses a missing draft', () => {
    const specs = openSpecs('p-lockspec-missing');
    expect(() => lockSpec(specs, 'ghost', OPERATOR)).toThrow(/no spec record for task 'ghost'/i);
  });

  it('refuses a non-draft spec (already locked)', () => {
    const specs = openSpecs('p-lockspec-relock');
    seedDraft(specs, 'task-2', VALID_CRITERIA);
    specs.recordLock('task-2', OPERATOR);
    expect(() => lockSpec(specs, 'task-2', OPERATOR)).toThrow(/is in state 'locked', not 'draft'/i);
  });

  it('refuses fuzzy criteria (no wired command), leaving the spec a draft', () => {
    const specs = openSpecs('p-lockspec-fuzzy');
    seedDraft(specs, 'task-3', [
      { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
      { text: 'auth works' },
    ]);
    expect(() => lockSpec(specs, 'task-3', OPERATOR)).toThrow(
      /refusing to lock 'task-3'.*no wired verification command/is,
    );
    expect(specs.getSpec('task-3')?.state).toBe('draft');
  });
});
