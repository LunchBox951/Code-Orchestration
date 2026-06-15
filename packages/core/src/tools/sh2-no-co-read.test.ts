// SH-2 read-side source-scan guard — Principle 12 — pristine-repo
// Read-side complement to the write-side `assertRepoPristine` in config/pristine.ts.
// v1 criterion SH-2: `co` reads all its own state/specs/plans from its own program-data
// store, never from `.co/` path literals baked into production source at runtime.
//
// This guard is GREEN today because the only `.co/...` strings in packages/*/src live
// inside JSDoc block comments (`/** … */`), not in runtime path literals.  The detector
// strips block comments FIRST so those hits do not trip the guard.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/core/src/tools
const repoRoot = resolve(here, '../../../../'); // tools → src → core → packages → root
const packagesRoot = join(repoRoot, 'packages');

/** Walk a directory recursively, returning every `.ts` path. */
function walkTs(root: string): string[] {
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

/**
 * Detect `.co/(specs|plans|issues)` path occurrences in source that survive comment
 * stripping — i.e. runtime path literals.  Returns one entry per match.
 *
 * Strip order: block comments first (removes JSDoc hits), then line comments.
 */
export function detectCoPaths(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (/** … */ and /* … */)
    .replace(/\/\/[^\n]*/g, ''); // line comments
  const re = /\.co\/(specs|plans|issues)\b/g;
  const hits: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) hits.push(m[0]);
  return hits;
}

// ── GREEN over the real production sources ────────────────────────────────────────────

describe('SH-2 — no runtime .co/(specs|plans|issues) reads in production source', () => {
  it('is GREEN over all packages/*/src production files (non-vacuous)', () => {
    const pkgs = readdirSync(packagesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    const violations: string[] = [];
    let filesScanned = 0;

    for (const pkg of pkgs) {
      const srcDir = join(packagesRoot, pkg, 'src');
      const files = walkTs(srcDir).filter((f) => !f.endsWith('.test.ts'));
      filesScanned += files.length;
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const hit of detectCoPaths(source)) {
          violations.push(`${file}: ${hit}`);
        }
      }
    }

    // Non-vacuous: we must have actually scanned source files.
    expect(filesScanned).toBeGreaterThan(0);
    // The guard: no runtime path literals survive.
    expect(violations).toEqual([]);
  });

  it('scanned at least one file known to contain a JSDoc .co/specs hit (comment-stripping proof)', () => {
    // spec-ref.ts is the canonical file with JSDoc `.co/specs` mentions.
    // If the detector returns [] for it, comment-stripping is working correctly.
    const specRefPath = join(packagesRoot, 'core', 'src', 'review', 'spec-ref.ts');
    const source = readFileSync(specRefPath, 'utf8');
    expect(source).toMatch(/\.co\/specs/); // file DOES contain the string…
    expect(detectCoPaths(source)).toEqual([]); // …but the detector correctly ignores it
  });
});

// ── RED: the detector catches runtime literals ────────────────────────────────────────

describe('SH-2 — detectCoPaths goes RED on runtime path literals', () => {
  it('flags a readFileSync with .co/specs', () => {
    expect(detectCoPaths("const p = readFileSync('.co/specs/x.locked.md');")).not.toEqual([]);
  });

  it('flags a string literal referencing .co/plans', () => {
    expect(detectCoPaths("const dir = '.co/plans';")).not.toEqual([]);
  });

  it('does NOT flag a line comment mentioning .co/issues', () => {
    expect(detectCoPaths('// reads .co/issues at runtime')).toEqual([]);
  });

  it('does NOT flag a JSDoc block comment mentioning .co/specs (mirrors the real existing hits)', () => {
    expect(detectCoPaths('/**\n * a path into .co/specs/…locked.md\n */')).toEqual([]);
  });
});
