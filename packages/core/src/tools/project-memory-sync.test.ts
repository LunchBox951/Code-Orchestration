import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../');

describe('project memory files - CLAUDE.md / AGENTS.md native-memory guard', () => {
  it('keeps Claude and Codex project memory present and provider-specific', () => {
    const claude = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
    const agents = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');

    expect(claude).toContain('# Project notes for CO agents');
    expect(claude).toContain('pnpm format:check');
    expect(agents).toContain('# Code Orchestration Agent Map');
    expect(agents).toContain('Claude/Codex terminal sessions');
    expect(claude).not.toBe(agents);
  });
});
