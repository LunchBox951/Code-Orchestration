import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── AC-L2-1 structural proof: cli/mcp are THIN adapters over @co/core ─────────
// The ESLint `no-restricted-imports` override (eslint.config.js) is the enforcement
// that rides `pnpm lint`; this committed test is its always-on structural twin. It
// reads the real adapter sources and asserts (green) that each imports ONLY the
// @co/core public barrel, plus proves the detector itself goes RED on a deep import,
// a core-internals reach, or a raw store import — so "add logic → red, remove → green"
// holds without committing a poisoned file.

const here = dirname(fileURLToPath(import.meta.url)); // packages/core/src/tools
const repoRoot = resolve(here, '../../../../'); // tools → src → core → packages → root

const ADAPTERS = ['cli', 'mcp'] as const;

/** Every `.ts` under an adapter's `src` (recursive), as absolute paths. */
function adapterSources(pkg: string): string[] {
  const root = join(repoRoot, 'packages', pkg, 'src');
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Extract the module specifiers of every static/dynamic import + re-export. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * The layering rule, mirrored in code: a specifier is forbidden for an adapter iff it
 * deep-imports @co/core, reaches into core's source/dist, or opens the store directly.
 * The bare `@co/core` barrel, the MCP SDK, and node builtins are all allowed.
 */
function forbiddenReason(spec: string): string | null {
  if (spec === '@co/core') return null;
  if (spec.startsWith('@co/core/')) {
    return `deep @co/core import (adapters use only the public barrel): '${spec}'`;
  }
  if (/(^|\/)core\/(src|dist)\//.test(spec)) {
    return `reach into core source/dist (that is core logic): '${spec}'`;
  }
  if (spec === 'node:sqlite') {
    return `opens the store directly (core logic, not an adapter's job): '${spec}'`;
  }
  return null;
}

describe('AC-L2-1 — cli/mcp are thin adapters: GREEN over the real sources', () => {
  it.each(ADAPTERS)('packages/%s imports ONLY the @co/core public barrel', (pkg) => {
    const files = adapterSources(pkg);
    expect(files.length).toBeGreaterThan(0); // not a vacuous pass

    const violations: string[] = [];
    let importsBarrel = false;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(source)) {
        if (spec === '@co/core') importsBarrel = true;
        const reason = forbiddenReason(spec);
        if (reason) violations.push(`${file}: ${reason}`);
      }
    }

    expect(violations).toEqual([]);
    // The adapter must genuinely sit over core, not be an empty shell.
    expect(importsBarrel).toBe(true);
  });
});

describe('AC-L2-1 — the detector goes RED on a non-thin import', () => {
  it('flags a deep @co/core import', () => {
    expect(forbiddenReason('@co/core/mail/mail-store.js')).toMatch(/deep @co\/core/);
  });

  it('flags a relative reach into core source', () => {
    expect(forbiddenReason('../../core/src/store/sqlite-store.js')).toMatch(/core source\/dist/);
  });

  it('flags a packages/core/src reach', () => {
    expect(forbiddenReason('../../../packages/core/dist/index.js')).toMatch(/core source\/dist/);
  });

  it('flags opening the store directly', () => {
    expect(forbiddenReason('node:sqlite')).toMatch(/opens the store directly/);
  });

  it('allows the bare @co/core barrel, the MCP SDK, and node builtins', () => {
    expect(forbiddenReason('@co/core')).toBeNull();
    expect(forbiddenReason('@modelcontextprotocol/sdk/server/mcp.js')).toBeNull();
    expect(forbiddenReason('node:path')).toBeNull();
    expect(forbiddenReason('./server.js')).toBeNull();
  });

  it('the specifier extractor catches static, side-effect, dynamic, and re-export forms', () => {
    const src = [
      "import { a } from '@co/core';",
      "import 'node:sqlite';",
      "export { b } from './server.js';",
      "const m = await import('@co/core/internal.js');",
    ].join('\n');
    expect(importSpecifiers(src).sort()).toEqual(
      ['./server.js', '@co/core', '@co/core/internal.js', 'node:sqlite'].sort(),
    );
  });
});
