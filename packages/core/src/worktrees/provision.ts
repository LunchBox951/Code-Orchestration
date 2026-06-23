import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { assertNever } from '../assert-never.js';
import { openConfigStore } from '../config/config-store.js';

/**
 * Worktree environment provisioning (AC-L3-2) — `docs/architecture/worktrees.md` §"Worktree
 * environment provisioning". A slung worktree (L3-A) has the *tracked* files but none of the
 * **gitignored working essentials** a *runnable* dev environment needs (dependency dirs, `.env`,
 * local config). Provisioning places those essentials into the sandbox by the RIGHT mechanism per
 * item, so the worktree wakes up ready: deps present, env present, a representative test runnable.
 *
 * The mechanisms (the design rule):
 *   - `symlink`        — a pointer for large/stable/read-mostly items (dependency dirs). Cheap, no
 *                        duplication; the sandbox shares the source.
 *   - `copy`           — a fresh copy for small or per-agent-mutable items (`.env`, local config).
 *   - `isolated-copy`  — a fresh PRIVATE copy of a dep dir, for when an agent must MUTATE deps (e.g.
 *                        installs a package): parallel agents never corrupt a shared dependency dir.
 *
 * Pristine SOURCE (Principle 12): provisioning READS from the main repo (`repoCwd`) and WRITES only
 * into the worktree sandbox (`worktreePath`). The source repo is never touched — provable by wrapping
 * a {@link provisionWorktree} call in `assertRepoPristine(repoCwd, …)`. (We do NOT wrap the worktree:
 * it legitimately gains gitignored essentials — that is the whole point — which are not tracked
 * content and not orchestration state.)
 *
 * Fail-loud (Principle 9): an entry whose SOURCE is absent is SKIPPED (a repo may have no `.venv`);
 * a genuinely broken PLACEMENT throws, so a half-provisioned sandbox is never silently accepted.
 */

/**
 * How a provisioning entry's source is placed into the sandbox.
 *   - `symlink`        — a pointer for large/stable/read-mostly items (dependency dirs).
 *   - `copy`           — a fresh copy for small or per-agent-mutable items (`.env`, local config).
 *   - `isolated-copy`  — a fresh PRIVATE copy of a dep dir (an agent may mutate it).
 *   - `workspace-node-modules` — the HYBRID placement for ONE leaf `node_modules` of a pnpm
 *     **workspace**: a REAL, writable directory whose children mirror the source's symlink farm
 *     (each pnpm dep symlink recreated with its original RELATIVE target), except the heavy shared
 *     `.pnpm` store, which is itself symlinked read-only. This keeps the relative `.pnpm` and
 *     `@scope/*` self-links resolving INTO the sandbox (never the source), and keeps the leaf dir
 *     writable so tooling scratch (e.g. vite's `.vite-temp`) stays in-sandbox instead of writing
 *     through a symlink into the pristine source repo (the EROFS class — see {@link expandWorkspaceManifest}).
 *     Not a value a user override sets directly; it is produced by workspace expansion.
 */
export type ProvisionMechanism = 'symlink' | 'copy' | 'isolated-copy' | 'workspace-node-modules';

/** One manifest entry: a repo-relative `path` and the `mechanism` that places it into the sandbox. */
export interface ProvisionEntry {
  /** Repo-relative path of the essential to provision (e.g. `node_modules`, `.env`). */
  readonly path: string;
  /** The placement mechanism for this entry. */
  readonly mechanism: ProvisionMechanism;
}

/** An ordered list of provisioning entries — what {@link provisionWorktree} places, in order. */
export type ProvisioningManifest = readonly ProvisionEntry[];

/**
 * The smart-default manifest: common dependency dirs by **symlink** (large/stable/read-mostly) and
 * common env files by **copy** (small/per-agent-mutable) — deliberately NOT a blanket copy of
 * everything in `.gitignore` (that is mostly junk). Per-project overrides refine this via the config
 * cascade (see {@link resolveProvisioningManifest}).
 *
 * pnpm-workspace (the real `co` monorepo, not just the fixture): a single symlink of the ROOT
 * `node_modules` is correct for a single-package repo, but in a pnpm **workspace** it is broken two
 * ways. (1) The per-package `node_modules` trees (`packages/* /node_modules`, `apps/* /node_modules`)
 * are never provisioned at all, so a bare specifier like `zod` is unresolvable inside a workspace
 * package — `pnpm typecheck`/`build` fail. (2) Writes through a symlinked dep dir (e.g. vite's
 * `.vite-temp`) land in the pristine SOURCE repo → EROFS. So when a `pnpm-workspace.yaml` is present
 * in the repo, {@link expandWorkspaceManifest} automatically REWRITES the `node_modules` symlink
 * entry into a {@link ProvisionMechanism `workspace-node-modules`} entry per leaf (root + every
 * workspace package), each a real writable dir mirroring the source's symlink farm with the heavy
 * `.pnpm` store shared read-only. A single-package repo (no `pnpm-workspace.yaml`) keeps the plain
 * `symlink` behavior unchanged. A per-project override (e.g. `isolated-copy`) still wins over the
 * default and suppresses expansion for that entry.
 */
export const DEFAULT_PROVISION_MANIFEST: ProvisioningManifest = [
  { path: 'node_modules', mechanism: 'symlink' },
  { path: '.venv', mechanism: 'symlink' },
  { path: 'vendor', mechanism: 'symlink' },
  { path: 'target', mechanism: 'symlink' },
  { path: '.env', mechanism: 'copy' },
  { path: '.env.local', mechanism: 'copy' },
];

/** The config-cascade key the per-project provisioning override lives under. */
export const WORKTREE_PROVISION_CONFIG_KEY = 'worktree.provision';

// `workspace-node-modules` is an INTERNAL mechanism produced by workspace expansion, not a value a
// user sets in config — the override schema therefore accepts only the three user-facing mechanisms.
const overrideMechanismSchema = z.enum(['symlink', 'copy', 'isolated-copy']);

/**
 * The shape of a per-project `worktree.provision` override: a map from repo-relative path to either a
 * mechanism (add the entry, or change an existing entry's mechanism — e.g. mark a dep `isolated-copy`)
 * or the literal `'none'` (remove a default entry). Validated fail-loud (Principle 9) so a malformed
 * config surfaces loudly instead of silently degrading provisioning.
 */
const provisionOverrideSchema = z.record(
  z.string().min(1),
  z.union([overrideMechanismSchema, z.literal('none')]),
);
export type ProvisionOverride = z.infer<typeof provisionOverrideSchema>;

/**
 * Merge a per-project override (the raw config value) over a base manifest. `undefined` (no override)
 * yields the base unchanged. An entry whose value is a mechanism is set/added (existing paths keep
 * their position, new paths append in override order); `'none'` removes the path. A malformed override
 * throws (fail-loud). Pure — exposed so the merge is testable without touching the config store.
 */
export function mergeProvisioningManifest(
  base: ProvisioningManifest,
  override: unknown,
): ProvisioningManifest {
  if (override === undefined) return base;
  let parsed: ProvisionOverride;
  try {
    parsed = provisionOverrideSchema.parse(override);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `co worktrees: malformed '${WORKTREE_PROVISION_CONFIG_KEY}' config override: ${detail}`,
      { cause },
    );
  }
  const merged = new Map<string, ProvisionMechanism>();
  for (const entry of base) merged.set(entry.path, entry.mechanism);
  for (const [path, mechanism] of Object.entries(parsed)) {
    if (mechanism === 'none') merged.delete(path);
    else merged.set(path, mechanism);
  }
  return [...merged].map(([path, mechanism]) => ({ path, mechanism }));
}

/**
 * Structured failure raised when a workspace package's `node_modules` could not be made resolvable in
 * the sandbox — so the caller gets a clear "deps not provisioned" diagnostic naming the package and
 * the missing dep, instead of the downstream symptom (a raw EROFS write-through or an unresolvable
 * bare `zod` specifier) surfacing much later from `pnpm typecheck`/`build`. Fail-loud (Principle 9):
 * a half-provisioned workspace sandbox is never silently accepted.
 */
export class WorkspaceDepsNotProvisionedError extends Error {
  /** Repo-relative path of the workspace package whose deps could not be provisioned. */
  readonly packagePath: string;
  constructor(packagePath: string, detail: string, options?: { cause?: unknown }) {
    super(
      `co worktrees: deps not provisioned for workspace package '${packagePath}': ${detail}. ` +
        `The slung worktree cannot run verify (pnpm test/typecheck/build) until its node_modules ` +
        `is resolvable (#129).`,
      options,
    );
    this.name = 'WorkspaceDepsNotProvisionedError';
    this.packagePath = packagePath;
  }
}

/** The pnpm workspace marker; its presence switches the `node_modules` entry to workspace expansion. */
export const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml';

/**
 * Parse the `packages:` globs out of a `pnpm-workspace.yaml`. Intentionally minimal — pnpm's own
 * format is a top-level `packages:` block of `- "<glob>"` list items — so `@co/core` need not take a
 * YAML dependency just to read its own workspace file. Lines outside the `packages:` block, comments,
 * and blank lines are ignored. Globs are returned verbatim (e.g. `packages/*`, `apps/*`).
 */
export function parseWorkspacePackageGlobs(yaml: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/u, '');
    if (/^packages:\s*$/u.test(line)) {
      inPackages = true;
      continue;
    }
    // A new top-level (non-indented, non-list) key ends the packages block.
    if (inPackages && /^\S/u.test(line) && !/^\s*-/u.test(line)) {
      inPackages = false;
    }
    if (!inPackages) continue;
    const m = /^\s*-\s*["']?([^"'#]+?)["']?\s*$/u.exec(line);
    if (m?.[1]) globs.push(m[1].trim());
  }
  return globs;
}

/**
 * Expand a single trailing-`*` glob (the only shape pnpm-workspace globs need here — `packages/*`,
 * `apps/*`, or a literal path) into the matching repo-relative directories under `repoCwd` that look
 * like a package (have a `package.json`). A literal (no `*`) is returned as-is when it exists.
 * Bounded by {@link resolveBounded} so no glob can escape the repo (Principle 12).
 */
function expandPackageGlob(repoCwd: string, glob: string): string[] {
  const trimmed = glob.replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (trimmed.length === 0 || trimmed === '.') return [];
  const star = trimmed.indexOf('*');
  if (star === -1) {
    // A literal package path: include it when it is a real package directory.
    const full = resolveBounded(repoCwd, trimmed, 'workspace package');
    return existsSync(join(full, 'package.json')) ? [trimmed] : [];
  }
  // Support only the common `<dir>/*` shape; deeper globbing is unnecessary for pnpm-workspace here.
  const slash = trimmed.lastIndexOf('/', star);
  const parentRel = slash === -1 ? '' : trimmed.slice(0, slash);
  const parentFull =
    parentRel === '' ? resolve(repoCwd) : resolveBounded(repoCwd, parentRel, 'workspace glob');
  if (!existsSync(parentFull)) return [];
  const out: string[] = [];
  for (const name of readdirSync(parentFull)) {
    if (name.startsWith('.')) continue;
    const rel = parentRel === '' ? name : `${parentRel}/${name}`;
    const full = resolveBounded(repoCwd, rel, 'workspace package');
    if (lstatSync(full).isDirectory() && existsSync(join(full, 'package.json'))) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Detect the workspace package directories of a pnpm workspace rooted at `repoCwd`. Returns `null`
 * when `repoCwd` is NOT a pnpm workspace (no `pnpm-workspace.yaml`) — the caller then keeps the
 * single-package behavior unchanged. Otherwise returns the repo-relative package dirs (deduped,
 * stably ordered) declared by the workspace globs.
 */
export function detectWorkspacePackages(repoCwd: string): string[] | null {
  const file = join(resolve(repoCwd), PNPM_WORKSPACE_FILE);
  if (!existsSync(file)) return null;
  const globs = parseWorkspacePackageGlobs(readFileSync(file, 'utf8'));
  const seen = new Set<string>();
  const packages: string[] = [];
  for (const glob of globs) {
    for (const rel of expandPackageGlob(repoCwd, glob)) {
      if (!seen.has(rel)) {
        seen.add(rel);
        packages.push(rel);
      }
    }
  }
  return packages;
}

/**
 * Workspace-aware expansion of a resolved manifest against the real `repoCwd`. When `repoCwd` is a
 * pnpm workspace, a `node_modules` entry whose mechanism is the default `symlink` is REWRITTEN into
 * one `workspace-node-modules` entry per leaf `node_modules` (the root plus every workspace package
 * that has one) — the hybrid placement that makes a slung worker runnable (#129). An entry the
 * operator has overridden away from `symlink` (e.g. `isolated-copy`) is left untouched (the operator
 * intent wins). A non-workspace repo (no `pnpm-workspace.yaml`) returns the manifest unchanged, so
 * single-package behavior is preserved.
 */
export function expandWorkspaceManifest(
  manifest: ProvisioningManifest,
  repoCwd: string,
): ProvisioningManifest {
  const packages = detectWorkspacePackages(repoCwd);
  if (packages === null) return manifest;
  const out: ProvisionEntry[] = [];
  for (const entry of manifest) {
    if (entry.path === 'node_modules' && entry.mechanism === 'symlink') {
      // Root node_modules → hybrid mirror.
      out.push({ path: 'node_modules', mechanism: 'workspace-node-modules' });
      // Each workspace package's node_modules → hybrid mirror (only those that actually exist in the
      // source; an un-built package may legitimately have none and is skipped by provisionWorktree).
      for (const pkg of packages) {
        out.push({ path: `${pkg}/node_modules`, mechanism: 'workspace-node-modules' });
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

/**
 * The effective manifest for a project: {@link DEFAULT_PROVISION_MANIFEST} ⊕ the per-project
 * `worktree.provision` override read from the config cascade (`global ⊕ project-overrides`, project
 * wins). Opens (and closes) the global config store; reads program-data ONLY.
 */
export function resolveProvisioningManifest(projectId: string): ProvisioningManifest {
  const config = openConfigStore();
  try {
    const override = config.resolveEffective(projectId)[WORKTREE_PROVISION_CONFIG_KEY];
    return mergeProvisioningManifest(DEFAULT_PROVISION_MANIFEST, override);
  } finally {
    config.close();
  }
}

/** Inputs to {@link provisionWorktree}: read from `repoCwd`, write into `worktreePath` by `manifest`. */
export interface ProvisionParams {
  /** The main repo to read the essentials FROM (the source — never written). */
  readonly repoCwd: string;
  /** The sandbox to place the essentials INTO (the only write target). */
  readonly worktreePath: string;
  /** The ordered entries to place. */
  readonly manifest: ProvisioningManifest;
}

/** What {@link provisionWorktree} did: the entries it placed, and the ones it skipped (source absent). */
export interface ProvisionResult {
  /** Entries whose source existed and was placed, in manifest order. */
  readonly provisioned: readonly ProvisionEntry[];
  /** Repo-relative paths whose source was absent and therefore skipped. */
  readonly skipped: readonly string[];
}

/** Resolve `base/rel` and prove it stays within `base` (Principle 12 — nothing escapes the boundary). */
function resolveBounded(base: string, rel: string, label: string): string {
  if (isAbsolute(rel)) {
    throw new Error(
      `co worktrees: provisioning ${label} '${rel}' must be repo-relative, not absolute.`,
    );
  }
  const root = resolve(base);
  const full = resolve(root, rel);
  const within = relative(root, full);
  if (within === '' || within.startsWith('..') || isAbsolute(within)) {
    throw new Error(
      `co worktrees: provisioning ${label} '${rel}' escapes '${base}' (Principle 12).`,
    );
  }
  return full;
}

/** Place a single existing source into the sandbox by `mechanism` (the exhaustive mechanism switch). */
function placeEntry(source: string, dest: string, mechanism: ProvisionMechanism): void {
  mkdirSync(dirname(dest), { recursive: true });
  switch (mechanism) {
    case 'symlink':
      // Pointer for large/stable/read-mostly deps — no duplication; the sandbox shares the source.
      symlinkSync(source, dest);
      return;
    case 'copy':
      // A fresh copy for small or per-agent-mutable items (`.env`, local config).
      cpSync(source, dest, { recursive: true });
      return;
    case 'isolated-copy':
      // A fresh PRIVATE copy of a dep dir: the agent may mutate it without touching the shared
      // source. Mechanically a recursive copy like `copy`, but a DISTINCT intent — it is what a
      // dep dir is overridden to when an agent installs/mutates packages (no cross-agent corruption).
      cpSync(source, dest, { recursive: true });
      return;
    case 'workspace-node-modules':
      // The hybrid for ONE leaf node_modules of a pnpm workspace: a real writable dir mirroring the
      // source's symlink farm, with the heavy `.pnpm` store shared read-only (see mirrorLeafNodeModules).
      mirrorLeafNodeModules(source, dest);
      return;
    default:
      return assertNever(mechanism);
  }
}

/**
 * Names inside a leaf `node_modules` that are SYMLINKED to the source rather than mirrored: the
 * heavy pnpm content-addressed store (`.pnpm`, hundreds of MB) is shared read-only — nothing writes
 * INTO `.pnpm` at verify time, and the per-package relative `../../../node_modules/.pnpm/...` links
 * (and root `.pnpm/...` links) recreated by the mirror resolve THROUGH this shared store.
 */
const LEAF_SHARE_BY_SYMLINK = new Set(['.pnpm']);

/**
 * Mirror ONE leaf `node_modules` directory from `source` into `dest` as a REAL, writable directory.
 * For each direct child:
 *   - the shared `.pnpm` store (and other {@link LEAF_SHARE_BY_SYMLINK} names) → a symlink to the
 *     source (read-only shared; never written at verify time);
 *   - a symlink (a pnpm dep link / `@scope/*` self-link) → recreated with the SAME target string.
 *     Targets are RELATIVE (e.g. `../../../node_modules/.pnpm/zod@…/node_modules/zod`,
 *     `../../../<pkg>` self-links, root `.pnpm/<dep>` links), so they resolve INTO the sandbox: the
 *     `.pnpm` ones into the shared store above, the `@scope/*` self-links into the sandbox's OWN
 *     workspace package sources (which exist — it is a worktree). This is the EROFS fix: writes to
 *     the leaf dir (e.g. vite's `.vite-temp`) stay in-sandbox instead of following a single root
 *     symlink into the pristine source repo.
 *   - a `@scope` directory (holds the package symlinks) → a real dir, mirrored recursively;
 *   - a small metadata file (`.modules.yaml`, …) → copied.
 * Absolute symlink targets (atypical for a pnpm farm) are recreated verbatim — they already point at
 * a stable shared location and never write back into the sandbox tree.
 */
function mirrorLeafNodeModules(source: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(source)) {
    const childSource = join(source, name);
    const childDest = join(dest, name);
    if (LEAF_SHARE_BY_SYMLINK.has(name)) {
      symlinkSync(childSource, childDest);
      continue;
    }
    const stat = lstatSync(childSource);
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(childSource), childDest);
    } else if (stat.isDirectory()) {
      // A `@scope` (or `.bin`) directory: mirror it one level deeper (its children are dep symlinks
      // or small scripts), keeping the dir itself real + writable.
      mirrorLeafNodeModules(childSource, childDest);
    } else {
      cpSync(childSource, childDest);
    }
  }
}

/**
 * Provision the worktree sandbox: for each manifest entry, read its source from `repoCwd` and place
 * it into `worktreePath` by its mechanism. Entries whose source is absent are skipped (Principle 9 —
 * a repo legitimately may have no `.venv`); a genuinely broken placement throws with context (no
 * silent half-provisioned sandbox). Reads the source, writes ONLY the sandbox — the source repo stays
 * pristine (Principle 12).
 */
export function provisionWorktree(params: ProvisionParams): ProvisionResult {
  const { repoCwd, worktreePath } = params;
  // Workspace-aware: in a pnpm workspace, a `node_modules` symlink entry expands into per-leaf
  // hybrid entries (root + every workspace package) so a slung worker is actually runnable (#129).
  // A non-workspace repo leaves the manifest unchanged (single-package behavior preserved).
  const manifest = expandWorkspaceManifest(params.manifest, repoCwd);
  const provisioned: ProvisionEntry[] = [];
  const skipped: string[] = [];

  for (const entry of manifest) {
    const source = resolveBounded(repoCwd, entry.path, 'source');
    const dest = resolveBounded(worktreePath, entry.path, 'destination');
    if (!existsSync(source)) {
      skipped.push(entry.path);
      continue;
    }
    try {
      placeEntry(source, dest, entry.mechanism);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `co worktrees: failed to provision '${entry.path}' (${entry.mechanism}) into ` +
          `'${worktreePath}': ${detail}`,
        { cause },
      );
    }
    if (entry.mechanism === 'workspace-node-modules') {
      assertLeafNodeModulesResolvable(entry.path, source, dest);
    }
    provisioned.push(entry);
  }

  return { provisioned, skipped };
}

/**
 * After mirroring a workspace leaf `node_modules`, prove its deps are actually resolvable in the
 * sandbox: every dep the source declares as a direct child of the leaf must exist (resolve through
 * the mirrored symlink, including the shared `.pnpm` store and `@scope/*` self-links). If any does
 * not, throw the structured {@link WorkspaceDepsNotProvisionedError} (#129) instead of leaving the
 * sandbox to fail much later with a raw EROFS or an unresolvable bare specifier.
 */
function assertLeafNodeModulesResolvable(leafRel: string, source: string, dest: string): void {
  const pkgPath = leafRel === 'node_modules' ? '.' : dirname(leafRel);
  for (const name of readdirSync(source)) {
    if (name.startsWith('.')) continue; // skip `.pnpm`, `.bin`, `.modules.yaml`, …
    const sourceChild = join(source, name);
    const stat = lstatSync(sourceChild);
    // Only verify dependency entries — top-level dep symlinks and `@scope` dirs of symlinks.
    if (stat.isSymbolicLink()) {
      // `existsSync` follows the link → proves it resolves through the sandbox-local mirror.
      if (!existsSync(join(dest, name))) {
        throw new WorkspaceDepsNotProvisionedError(
          pkgPath,
          `dependency '${name}' did not resolve in the provisioned node_modules`,
        );
      }
    } else if (stat.isDirectory() && name.startsWith('@')) {
      for (const inner of readdirSync(sourceChild)) {
        if (!existsSync(join(dest, name, inner))) {
          throw new WorkspaceDepsNotProvisionedError(
            pkgPath,
            `dependency '${name}/${inner}' did not resolve in the provisioned node_modules`,
          );
        }
      }
    }
  }
}

/** What a {@link Provisioner} is handed about the just-created sandbox. */
export interface ProvisionContext {
  /** The main repo the sandbox was cut from (the source — never written). */
  readonly repoCwd: string;
  /** Absolute path of the freshly created worktree sandbox (the write target). */
  readonly worktreePath: string;
  /** The project id, used to resolve the per-project manifest from the config cascade. */
  readonly projectId: string;
}

/**
 * The injectable provisioning seam {@link import('./sling.js').slingWorktree} runs after
 * `git worktree add`. The default applies the project's effective manifest; headless tests inject a
 * no-op/recording one (or pass a manifest directly to {@link provisionWorktree}) so they need not
 * touch config or place real files.
 */
export type Provisioner = (ctx: ProvisionContext) => ProvisionResult | void;

/**
 * The production {@link Provisioner}: resolve the project's effective manifest (defaults ⊕ config
 * overrides) and apply it to the sandbox. This is what runs in the real `co_sling` tool path.
 */
export const defaultProvisioner: Provisioner = ({ repoCwd, worktreePath, projectId }) => {
  const manifest = resolveProvisioningManifest(projectId);
  return provisionWorktree({ repoCwd, worktreePath, manifest });
};
