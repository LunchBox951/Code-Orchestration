// SH-5 no-raw-path source-scan guard — Principle 7 — gated-by-default.
//
// v1 criterion SH-5: no raw `git push` / `gh pr create` / `gh pr merge` path exists; only the gated
// `co_merge` / `co_push` / `co_pr_merge` tools reach `master` / the remote / a PR. The RUNTIME
// block-list (`packages/core/src/permissions/block-list.ts`) blocks such a command if a hosted agent
// types it; THIS guard is the STATIC complement — a "no fallback exists" proof. It walks product
// command-construction surfaces and fails loud on any raw publish-command CONSTRUCTION outside the
// sanctioned chokepoints, so a new un-gated `git push` / `gh pr create|merge` cannot be planted in
// `cli` / `mcp` / a tool / the conductor / the app / package scripts / workflows without turning
// this test red.
//
// Sanctioned (allow-listed) sites — the ONLY product files permitted to construct these commands:
//   - worktrees/repo-mode.ts          — `CoRepoModeGate.enactPush` / `enactPrMerge` / `enactPublish`,
//                                        the single enactment chokepoint behind the gated
//                                        `co_push` / `co_pr_merge` / `co_merge` tools.
//   - permissions/block-list.ts        — the runtime block-list RULES, which name these commands as
//                                        DATA in order to detect + refuse them.
//   - permissions/pane-launch-config.ts — the hosted-pane permission DENY patterns
//                                        (`Bash(git push*)`, `Bash(gh pr merge*)`, …) — the
//                                        block-list's deny config.
//   - .github/workflows/release.yml      — release-tag publishing by the repository's release
//                                        workflow, outside the self-hosted agent gate.
//
// Mirrors the shape of `sh2-no-co-read.test.ts`: a pure comment-stripped detector + a non-vacuous
// GREEN scan + RED unit tests proving the detector fires on real invocation shapes.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/core/src/tools
const repoRoot = resolve(here, '../../../../'); // tools → src → core → packages → root
const packagesRoot = join(repoRoot, 'packages');
const appsRoot = join(repoRoot, 'apps');
const githubWorkflowsRoot = join(repoRoot, '.github', 'workflows');

/**
 * The ONLY product source files allowed to construct a raw `git push` / `gh pr create|merge`
 * command — the sanctioned gated chokepoint plus the runtime block-list rules that name these
 * commands as data. Repo-root-relative, with forward slashes (normalized below for the host sep).
 */
const SANCTIONED: readonly string[] = [
  'packages/core/src/worktrees/repo-mode.ts',
  'packages/core/src/permissions/block-list.ts',
  'packages/core/src/permissions/pane-launch-config.ts',
  '.github/workflows/release.yml',
];

const COMMAND_SURFACE_FILE_RE = /\.(?:[cm]?ts|[cm]?js|json|ya?ml)$/u;

/** Walk a directory recursively, returning every file whose basename passes `include`. */
function walkFiles(root: string, include: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (include(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Detect raw publish-command CONSTRUCTION that survives comment stripping. Matches both the
 * arg-array form an exec seam is handed (`['push', …]`, `['pr', 'create'|'merge', …]`, including
 * leading global args like `['-C', repo, 'push']` / `['--repo', repo, 'pr', 'create']`) and the
 * shell-string form (`git push …`, `gh pr create|merge …`). Strip order: block comments first
 * (removes JSDoc mentions), then line comments — so a doc comment that merely *mentions*
 * `gh pr create` is never a violation.
 */
export function detectRawPublish(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (/** … */ and /* … */)
    .replace(/\/\/[^\n]*/g, ''); // line comments
  const hits: string[] = [];
  // Raw `git push`: a push-subcommand arg-array, or a `git push` / `git-push` command string.
  const gitPushArrayRe = /\[[^\]]*['"`]push['"`][^\]]*\]/g;
  const gitPushStringRe = /\bgit[\s-]+push\b/g;
  // Raw `gh pr create|merge`: a ['pr', 'create'|'merge', …] arg-array (newline tolerant via \s*), or
  // a `gh pr create|merge` command string.
  const ghPrArrayRe = /\[[^\]]*['"`]pr['"`][^\]]*['"`](create|merge)['"`][^\]]*\]/g;
  const ghPrStringRe = /\bgh\s+pr\s+(create|merge)\b/g;
  let m: RegExpExecArray | null;
  while ((m = gitPushArrayRe.exec(stripped)) !== null) hits.push(`git push (arg-array): ${m[0]}`);
  while ((m = gitPushStringRe.exec(stripped)) !== null) hits.push(`git push (command): ${m[0]}`);
  while ((m = ghPrArrayRe.exec(stripped)) !== null) hits.push(`gh pr ${m[1]} (arg-array)`);
  while ((m = ghPrStringRe.exec(stripped)) !== null) hits.push(`gh pr ${m[1]} (command)`);
  return hits;
}

/** The repo-root-relative path of a file, with forward slashes regardless of host separator. */
function relPosix(file: string): string {
  return relative(repoRoot, file).split(sep).join('/');
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

/** Every product command-construction surface SH-5 must statically guard. */
function productCommandSurfaceFiles(): string[] {
  const files: string[] = [];
  for (const srcDir of sourceRoots()) {
    for (const file of walkFiles(srcDir, (name) => COMMAND_SURFACE_FILE_RE.test(name))) {
      if (!/\.test\.[cm]?ts$/u.test(file) && !/\.test\.[cm]?js$/u.test(file)) files.push(file);
    }
  }
  for (const base of [repoRoot, packagesRoot, appsRoot]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        /^(package\.json|pnpm-workspace\.yaml|eslint\.config\.js)$/u.test(entry.name)
      ) {
        files.push(join(base, entry.name));
      }
      if (!entry.isDirectory()) continue;
      const packageJson = join(base, entry.name, 'package.json');
      if (existsSync(packageJson)) files.push(packageJson);
      const scriptsDir = join(base, entry.name, 'scripts');
      if (existsSync(scriptsDir)) {
        files.push(...walkFiles(scriptsDir, (name) => COMMAND_SURFACE_FILE_RE.test(name)));
      }
    }
  }
  if (existsSync(githubWorkflowsRoot)) {
    for (const file of walkFiles(githubWorkflowsRoot, (name) => /\.ya?ml$/u.test(name))) {
      files.push(file);
    }
  }
  return [...new Set(files)].sort();
}

// ── GREEN over the real production sources ────────────────────────────────────────────────────────

describe('SH-5 — no un-gated raw git push / gh pr create|merge path in production source', () => {
  it('is GREEN over product command surfaces except sanctioned chokepoints', () => {
    const violations: string[] = [];
    let filesScanned = 0;

    for (const file of productCommandSurfaceFiles()) {
      filesScanned += 1;
      if (SANCTIONED.includes(relPosix(file))) continue; // sanctioned gate / block-list rules
      const source = readFileSync(file, 'utf8');
      for (const hit of detectRawPublish(source)) {
        violations.push(`${relPosix(file)}: ${hit}`);
      }
    }

    // Non-vacuous: we must have actually scanned source files.
    expect(filesScanned).toBeGreaterThan(0);
    // The guard: no raw publish path exists outside the sanctioned chokepoint.
    expect(violations).toEqual([]);
  });

  it('guards scripts, manifests, and workflows, not just TypeScript source', () => {
    const rels = productCommandSurfaceFiles().map(relPosix);

    expect(rels).toContain('package.json');
    expect(rels).toContain('apps/desktop/package.json');
    expect(rels).toContain('apps/desktop/scripts/copy-renderer-assets.mjs');
    expect(rels).toContain('.github/workflows/release.yml');
  });

  it('keeps the allow-list load-bearing: every sanctioned file exists AND still constructs a raw publish command', () => {
    // If a sanctioned file no longer contains a raw publish construction, the allow-list entry is
    // stale and must be removed — otherwise it silently over-permits future raw calls in that file.
    for (const rel of SANCTIONED) {
      const path = join(repoRoot, rel);
      expect(existsSync(path), `sanctioned file missing: ${rel}`).toBe(true);
      const hits = detectRawPublish(readFileSync(path, 'utf8'));
      expect(
        hits.length,
        `sanctioned file no longer constructs a raw publish command: ${rel}`,
      ).toBeGreaterThan(0);
    }
  });

  it('proves the gated chokepoint really houses the raw push + PR construction (detector is not blind)', () => {
    const repoMode = readFileSync(
      join(repoRoot, 'packages/core/src/worktrees/repo-mode.ts'),
      'utf8',
    );
    const hits = detectRawPublish(repoMode);
    expect(hits.some((h) => h.startsWith('git push'))).toBe(true); // enactPush
    expect(hits.some((h) => h.startsWith('gh pr create'))).toBe(true); // enactPrMerge
  });
});

// ── RED: the detector catches raw publish constructions ─────────────────────────────────────────────

describe('SH-5 — detectRawPublish goes RED on raw publish constructions', () => {
  it('flags a git push arg-array', () => {
    expect(detectRawPublish("execFileSync('git', ['push', 'origin', branch]);")).not.toEqual([]);
  });

  it('flags a git push arg-array with leading global args', () => {
    expect(
      detectRawPublish("execFileSync('git', ['-C', repo, 'push', 'origin', branch]);"),
    ).not.toEqual([]);
  });

  it('flags a force git push command string', () => {
    expect(detectRawPublish('await sh(`git push --force origin ${b}`);')).not.toEqual([]);
  });

  it('flags a `git-push` executable invocation', () => {
    expect(detectRawPublish("execFileSync('git-push', [remote, ref]);")).not.toEqual([]);
  });

  it('flags a gh pr create arg-array', () => {
    expect(detectRawPublish("ghExec(cwd, ['pr', 'create', '--base', into]);")).not.toEqual([]);
  });

  it('flags a gh pr create arg-array with leading global args', () => {
    expect(
      detectRawPublish("ghExec(cwd, ['--repo', repo, 'pr', 'create', '--base', into]);"),
    ).not.toEqual([]);
  });

  it('flags a gh pr merge arg-array', () => {
    expect(detectRawPublish("ghExec(cwd, ['pr', 'merge', String(num)]);")).not.toEqual([]);
  });

  it('flags a gh pr merge arg-array with leading global args', () => {
    expect(detectRawPublish("ghExec(cwd, ['-R', repo, 'pr', 'merge', String(num)]);")).not.toEqual(
      [],
    );
  });

  it('flags a multi-line gh pr create arg-array (newline between elements)', () => {
    expect(detectRawPublish("ghExec(cwd, [\n  'pr',\n  'create',\n  '--base',\n]);")).not.toEqual(
      [],
    );
  });

  it('flags a `gh pr merge` command string', () => {
    expect(detectRawPublish('exec(`gh pr merge ${pr} --squash`);')).not.toEqual([]);
  });

  it('does NOT flag a JSDoc block comment mentioning `gh pr create`', () => {
    expect(
      detectRawPublish('/**\n * contributor + owner create a PR via `gh pr create`.\n */'),
    ).toEqual([]);
  });

  it('does NOT flag a line comment mentioning git push', () => {
    expect(detectRawPublish('// raw git push is blocked — use co_push')).toEqual([]);
  });

  it('does NOT flag the gated tool names co_push / co_pr_merge / co_merge', () => {
    expect(detectRawPublish("await invokeTool(reg, ctx, 'co_push', { branch });")).toEqual([]);
    expect(detectRawPublish("await invokeTool(reg, ctx, 'co_pr_merge', { branch });")).toEqual([]);
  });

  it('does NOT flag an unrelated `gh issue create` arg-array', () => {
    expect(detectRawPublish("ghExec(cwd, ['issue', 'create', '--title', t]);")).toEqual([]);
  });

  it('does NOT flag an Array#push method call', () => {
    expect(detectRawPublish('hits.push(`violation`); files.push(full);')).toEqual([]);
  });
});
