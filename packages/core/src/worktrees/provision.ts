import { cpSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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

/** How a provisioning entry's source is placed into the sandbox. */
export type ProvisionMechanism = 'symlink' | 'copy' | 'isolated-copy';

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
 * pnpm-workspace caveat (so the design stays honest for the real `co` monorepo, not just the
 * fixture): a single symlink of the ROOT `node_modules` is correct for a single-package repo, but in
 * a pnpm **workspace** the `node_modules/@co/*` self-links resolve relative to the symlink target —
 * i.e. into the SOURCE repo's packages, not the worktree's. A workspace repo should therefore
 * OVERRIDE the `node_modules` entry — e.g. to `isolated-copy` (a private, self-contained tree whose
 * internal relative links stay valid), or rely on a `pnpm install --offline` step against the warm
 * store. The hard guarantee here is the single-package case (and the fixture); the override knob is
 * how a workspace layout is made runnable.
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

const provisionMechanismSchema = z.enum(['symlink', 'copy', 'isolated-copy']);

/**
 * The shape of a per-project `worktree.provision` override: a map from repo-relative path to either a
 * mechanism (add the entry, or change an existing entry's mechanism — e.g. mark a dep `isolated-copy`)
 * or the literal `'none'` (remove a default entry). Validated fail-loud (Principle 9) so a malformed
 * config surfaces loudly instead of silently degrading provisioning.
 */
const provisionOverrideSchema = z.record(
  z.string().min(1),
  z.union([provisionMechanismSchema, z.literal('none')]),
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
    default:
      return assertNever(mechanism);
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
  const { repoCwd, worktreePath, manifest } = params;
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
    provisioned.push(entry);
  }

  return { provisioned, skipped };
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
