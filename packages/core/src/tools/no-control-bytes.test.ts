// No-raw-control-byte source-scan guard — hygiene gate (review-387).
//
// A RAW control byte (NUL / ESC / BEL / …) embedded in source is INVISIBLE and unreviewable: an editor
// (and the agent `Read` surface) renders a raw NUL (0x00) as a space, so it survives human review AND
// the full 5-command gate — prettier + eslint do NOT flag a stray control byte inside a string literal.
// One slipped ALL FIVE lane reviews of the Stage-15 conductor work — a raw NUL delimiter in `daemon.ts`'s
// reWarmFailed key — and was caught only by an `LC_ALL=C grep` at the dev-PR push review. THIS guard is
// the systemic fix: it walks every product source file and FAILS LOUD on any control byte, so a raw
// NUL / ESC can never again slip the gate. The cure is always to write the ESCAPE (`\0`, `\u001b`, …),
// which is visible + reviewable.
//
// Mirrors the shape of `sh5-no-raw-path.test.ts`: a pure detector + a non-vacuous GREEN scan over the
// real production sources + RED unit tests proving the detector fires. The RED tests BUILD their control
// bytes via `String.fromCharCode` (never hand-typed), so this guard never embeds the very thing it bans.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/core/src/tools
const repoRoot = resolve(here, '../../../../'); // tools → src → core → packages → root
const packagesRoot = join(repoRoot, 'packages');
const appsRoot = join(repoRoot, 'apps');

/**
 * Detect FORBIDDEN control bytes in `source`: the C0 range plus DEL (0x7f), EXCLUDING the three normal
 * whitespace bytes TAB (0x09), LF (0x0a) and CR (0x0d). A pure char-code scan — NOT a regex, because a
 * control-byte character class would itself trip eslint `no-control-regex`. Returns one
 * `line:col — 0xNN` entry per offending byte so a violation is actionable.
 */
export function detectControlBytes(source: string): string[] {
  const hits: string[] = [];
  let line = 1;
  let col = 0;
  for (let i = 0; i < source.length; i += 1) {
    const c = source.charCodeAt(i);
    if (c === 0x0a) {
      // LF — newline: advance line + reset column (LF itself is allowed whitespace).
      line += 1;
      col = 0;
      continue;
    }
    col += 1;
    // Allowed: TAB (0x09), LF (handled above), CR (0x0d). Everything else at or below 0x1f, plus DEL
    // (0x7f), is a forbidden control byte.
    const forbidden =
      c <= 0x08 || c === 0x0b || c === 0x0c || (c >= 0x0e && c <= 0x1f) || c === 0x7f;
    if (forbidden) {
      hits.push(`line ${line}:${col} — control byte 0x${c.toString(16).padStart(2, '0')}`);
    }
  }
  return hits;
}

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

/** Every product (non-test) source file under the packages and apps `src` trees. */
function productSourceFiles(): string[] {
  const files: string[] = [];
  for (const srcDir of sourceRoots()) {
    for (const file of walkSource(srcDir)) {
      if (!file.endsWith('.test.ts')) files.push(file);
    }
  }
  return files;
}

/** The repo-root-relative path of a file, with forward slashes regardless of host separator. */
function relPosix(file: string): string {
  return relative(repoRoot, file).split(sep).join('/');
}

// ── GREEN over the real production sources ────────────────────────────────────────────────────────

describe('no raw control byte in production source (hygiene — review-387)', () => {
  it('is GREEN: every packages/*/src and apps/*/src product file is free of raw control bytes', () => {
    const violations: string[] = [];
    let filesScanned = 0;
    for (const file of productSourceFiles()) {
      filesScanned += 1;
      for (const hit of detectControlBytes(readFileSync(file, 'utf8'))) {
        violations.push(`${relPosix(file)}: ${hit}`);
      }
    }
    expect(filesScanned).toBeGreaterThan(0); // non-vacuous: we actually scanned source
    expect(violations).toEqual([]); // no raw control byte anywhere in product source
  });
});

// ── RED: the detector fires on raw control bytes (built via String.fromCharCode — never hand-typed) ──

describe('detectControlBytes goes RED on raw control bytes', () => {
  const NUL = String.fromCharCode(0x00);
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const DEL = String.fromCharCode(0x7f);

  it('flags a raw NUL (0x00) — the review-387 bug shape', () => {
    expect(detectControlBytes(`a${NUL}b`)).not.toEqual([]);
  });

  it('flags a raw ESC (0x1b), BEL (0x07), and DEL (0x7f)', () => {
    expect(detectControlBytes(`x${ESC}y`)).not.toEqual([]);
    expect(detectControlBytes(`x${BEL}y`)).not.toEqual([]);
    expect(detectControlBytes(`x${DEL}y`)).not.toEqual([]);
  });

  it('reports the byte as hex + a 1-based line/col', () => {
    const hits = detectControlBytes(`ok\nx${ESC}y`);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('0x1b');
    expect(hits[0]).toContain('line 2');
  });

  it('does NOT flag the normal whitespace bytes TAB / LF / CR', () => {
    expect(detectControlBytes('a\tb\nc\r\nd')).toEqual([]);
  });

  it('does NOT flag ordinary printable ASCII, the `\\0` ESCAPE, or unicode', () => {
    // The `\0` below is the two-char ESCAPE in THIS source (backslash + 0 — visible), not a raw NUL
    // byte: the cure for the bug. Unicode (arrows, CJK, emoji) is also fine — none are control bytes.
    expect(detectControlBytes('const k = `${a}\\0${b}`; // → ✓ 日本語 — 🎉')).toEqual([]);
  });
});
