import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Pristine-repo guard (freeze #7). Runs `fn`, asserting the repo at `repoPath` is
 * byte-identical before and after — across the working tree AND `.git` (so it
 * catches a stray write to the index, a ref, an object, anything). Returns fn's
 * result on success; throws a descriptive error (naming what changed) otherwise.
 *
 * The repo check is UNCONDITIONAL: even when `fn` throws, the repo is re-verified
 * before the error propagates, so a partial write made BEFORE an exception is
 * still caught (otherwise a throwing op could mutate the repo undetected). If both
 * happen — fn wrote AND threw — the pristine violation is surfaced, with fn's
 * original error preserved as the thrown error's `cause`.
 *
 * Implementation note: we build the manifest by hashing the filesystem directly
 * rather than shelling out to git, so the guard itself never perturbs `.git`
 * (a `git status` can write `.git/index`). Every L0 op writes ONLY under
 * `dataRoot()`/`CO_DATA_DIR` — a separate dir from any repo — so wrapping an op
 * in this guard against a fixture repo must NOT throw (AC-L0-5).
 */
export function assertRepoPristine<T>(repoPath: string, fn: () => T): T {
  const before = buildManifest(repoPath);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: fn() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  // Re-check regardless of how `fn` exited — the no-repo-write guarantee holds
  // even on the throwing path.
  const changes = diffManifests(before, buildManifest(repoPath));
  if (changes.length > 0) {
    const detail = `assertRepoPristine: ${repoPath} was modified by the wrapped operation:\n  ${changes.join('\n  ')}`;
    throw outcome.ok
      ? new Error(detail)
      : new Error(`${detail}\n  (the wrapped operation then threw; see cause)`, {
          cause: outcome.error,
        });
  }
  if (!outcome.ok) {
    throw outcome.error; // repo untouched — propagate fn's own error unchanged
  }
  return outcome.value;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministic manifest of every path under `root` (INCLUDING `.git`), as a map
 * from repo-relative path to a `type:mode:hash` signature:
 *   - file:    sha256 of its contents
 *   - symlink: sha256 of its link target (we do NOT follow it — avoids cycles /
 *              escaping the tree, and a retarget is still a change)
 *   - dir:     recorded (no hash) so an added/removed dir is caught
 *   - other:   sockets/fifos/devices — type + mode only
 * `mode` includes the type+permission bits, so a chmod or a file↔dir↔symlink
 * type swap registers as a change too. A missing root yields an empty manifest
 * (so a fn that creates the repo shows up as additions).
 */
function buildManifest(root: string): Map<string, string> {
  const manifest = new Map<string, string>();
  if (!existsSync(root)) return manifest;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      const stat = lstatSync(full);
      const mode = stat.mode;
      if (stat.isSymbolicLink()) {
        manifest.set(rel, `symlink:${mode}:${sha256(readlinkSync(full))}`);
      } else if (stat.isDirectory()) {
        manifest.set(rel, `dir:${mode}:`);
        walk(full);
      } else if (stat.isFile()) {
        manifest.set(rel, `file:${mode}:${sha256(readFileSync(full))}`);
      } else {
        manifest.set(rel, `other:${mode}:`);
      }
    }
  };
  walk(root);
  return manifest;
}

/** Sorted human-readable diff of two manifests: added / removed / modified paths. */
function diffManifests(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [path, sig] of before) {
    const next = after.get(path);
    if (next === undefined) changes.push(`removed: ${path}`);
    else if (next !== sig) changes.push(`modified: ${path}`);
  }
  for (const path of after.keys()) {
    if (!before.has(path)) changes.push(`added: ${path}`);
  }
  changes.sort();
  return changes;
}
