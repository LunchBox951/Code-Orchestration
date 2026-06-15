// SH-2 read-side source-scan guard — Principle 12 — pristine-repo
// Read-side complement to the write-side `assertRepoPristine` in config/pristine.ts.
// v1 criterion SH-2: `co` reads all its own state/specs/plans from its own program-data
// store, never from `.co/` path literals baked into production source at runtime.
//
// This guard is GREEN today because the only `.co/...` strings in packages/*/src live
// inside JSDoc block comments (`/** … */`), not in runtime path literals.  The detector
// strips block comments FIRST so those hits do not trip the guard.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/core/src/tools
const repoRoot = resolve(here, '../../../../'); // tools → src → core → packages → root
const packagesRoot = join(repoRoot, 'packages');
const appsRoot = join(repoRoot, 'apps');

/** Walk a directory recursively, returning every TypeScript-family source path. */
function walkSource(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(c|m)?ts$/u.test(entry.name)) out.push(full);
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
  const literalRe = /\.co[\\/]+(specs|plans|issues)\b/g;
  const coSegmentRe = /['"`]\.co['"`]\s*,\s*['"`](specs|plans|issues)['"`]/g;
  const coVariableSegmentRe = /['"`]\.co['"`]\s*,\s*([A-Za-z_$][\w$]*)/g;
  const staticSectionRe =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`](specs|plans|issues)['"`]/g;
  const concatLiteralRe = /['"`]\.co[\\/]*['"`]\s*\+\s*['"`][\\/]*(specs|plans|issues)['"`]/g;
  const concatVariableRe = /['"`]\.co[\\/]*['"`]\s*\+\s*([A-Za-z_$][\w$]*)/g;
  const templateLiteralRe = /`[^`]*\.co[\\/]*\$\{\s*['"`](specs|plans|issues)['"`]\s*\}[^`]*`/g;
  const templateVariableRe = /`[^`]*\.co[\\/]*\$\{\s*([A-Za-z_$][\w$]*)\s*\}[^`]*`/g;
  const staticSections = new Map<string, string>();
  const hits: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = staticSectionRe.exec(stripped)) !== null) {
    const name = m[1];
    const section = m[2];
    if (name != null && section != null) staticSections.set(name, section);
  }
  while ((m = literalRe.exec(stripped)) !== null) hits.push(m[0]);
  while ((m = coSegmentRe.exec(stripped)) !== null) hits.push(`'.co', '${m[1]}'`);
  while ((m = coVariableSegmentRe.exec(stripped)) !== null) {
    const section = staticSections.get(m[1] ?? '');
    if (section != null) hits.push(`'.co', ${m[1]}`);
  }
  while ((m = concatLiteralRe.exec(stripped)) !== null) hits.push(`'.co/' + '${m[1]}'`);
  while ((m = concatVariableRe.exec(stripped)) !== null) {
    const section = staticSections.get(m[1] ?? '');
    if (section != null) hits.push(`'.co/' + ${m[1]}`);
  }
  while ((m = templateLiteralRe.exec(stripped)) !== null) hits.push(`.co/\${'${m[1]}'}`);
  while ((m = templateVariableRe.exec(stripped)) !== null) {
    const section = staticSections.get(m[1] ?? '');
    if (section != null) hits.push(`.co/\${${m[1]}}`);
  }
  return hits;
}

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const base of [packagesRoot, appsRoot]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const srcDir = join(base, entry.name, 'src');
      if (existsSync(srcDir)) roots.push(srcDir);
    }
  }
  return roots;
}

// ── GREEN over the real production sources ────────────────────────────────────────────

describe('SH-2 — no runtime .co/(specs|plans|issues) reads in production source', () => {
  it('is GREEN over all packages/*/src and apps/*/src production files (non-vacuous)', () => {
    const violations: string[] = [];
    let filesScanned = 0;

    for (const srcDir of sourceRoots()) {
      const files = walkSource(srcDir).filter((f) => !f.endsWith('.test.ts'));
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

  it('flags a string literal referencing a Windows .co\\issues path', () => {
    expect(detectCoPaths("const dir = '.co\\\\issues';")).not.toEqual([]);
  });

  it("flags segmented path construction with join('.co', 'specs')", () => {
    expect(detectCoPaths("const dir = join('.co', 'specs');")).not.toEqual([]);
  });

  it("flags prefixed segmented path construction with join(repoRoot, '.co', 'specs')", () => {
    expect(detectCoPaths("const dir = join(repoRoot, '.co', 'specs');")).not.toEqual([]);
  });

  it("flags prefixed segmented path construction with path.join(repoRoot, '.co', 'plans')", () => {
    expect(detectCoPaths("const dir = path.join(repoRoot, '.co', 'plans');")).not.toEqual([]);
  });

  it("flags prefixed segmented path construction with resolve(cwd, '.co', 'issues')", () => {
    expect(detectCoPaths("const dir = resolve(cwd, '.co', 'issues');")).not.toEqual([]);
  });

  it("flags segmented path construction after a nested call with join(process.cwd(), '.co', 'specs')", () => {
    expect(detectCoPaths("const dir = join(process.cwd(), '.co', 'specs');")).not.toEqual([]);
  });

  it("flags segmented path construction after a nested call with resolve(getRepoRoot(), '.co', 'plans')", () => {
    expect(detectCoPaths("const dir = resolve(getRepoRoot(), '.co', 'plans');")).not.toEqual([]);
  });

  it('flags segmented path construction with a static section variable', () => {
    expect(
      detectCoPaths("const section = 'specs'; const dir = join(repoRoot, '.co', section);"),
    ).not.toEqual([]);
  });

  it('flags string concatenation with a static .co section', () => {
    expect(detectCoPaths("const dir = '.co/' + 'plans';")).not.toEqual([]);
  });

  it('flags template paths with static .co sections', () => {
    expect(detectCoPaths('const dir = `.co/${"issues"}`;')).not.toEqual([]);
  });

  it('does NOT flag a line comment mentioning .co/issues', () => {
    expect(detectCoPaths('// reads .co/issues at runtime')).toEqual([]);
  });

  it('does NOT flag a JSDoc block comment mentioning .co/specs (mirrors the real existing hits)', () => {
    expect(detectCoPaths('/**\n * a path into .co/specs/…locked.md\n */')).toEqual([]);
  });
});
