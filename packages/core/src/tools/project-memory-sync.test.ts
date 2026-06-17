import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../');

describe('project memory files — CLAUDE.md / AGENTS.md sync guard', () => {
  it('keeps Claude and Codex project memory byte-identical until prototype teardown', () => {
    const claude = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
    const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');

    expect(claude).toBe(agents);
  });
});
