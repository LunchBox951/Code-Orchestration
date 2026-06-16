import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent } from '../replay/projector.js';
import { projectDataDir } from '../store/paths.js';
import { openGlobalStore } from '../store/sqlite-store.js';
import {
  makeRegisteredEvent,
  makeRelinkedEvent,
  registrySchemas,
  registryUpcasters,
} from './events.js';
import { ProjectsProjector, ensureProjectsTable } from './projects-projector.js';

/** Opaque, path-independent project identity (a UUID; freeze #1). */
export type ProjectId = string;

/**
 * Path-based project registry living entirely in the GLOBAL program-data store
 * (freeze #4). Maps an absolute repo path → a stable opaque id → a per-project
 * data dir, with a headless relink that survives a move (same id + full history).
 */
export interface ProjectRegistry {
  /** Mint a NEW opaque id for `absPath`; idempotent — returns the existing id if already mapped. */
  register(absPath: string): ProjectId;
  /** Headless move: same id, history intact, append-only index update. */
  relink(projectId: ProjectId, newAbsPath: string): void;
  /** Path → id, or undefined if unmapped. */
  resolve(absPath: string): ProjectId | undefined;
  /** Id → current path, or undefined if the project id is unknown. */
  pathFor(projectId: ProjectId): string | undefined;
  /** Per-project data dir for an id (pure path; never created here). */
  dataDirFor(projectId: ProjectId): string;
  /** Close the underlying global store (lifecycle helper; not part of the C.3 contract). */
  close(): void;
}

/**
 * Require absolute + normalize identically across register/relink/resolve so the
 * same logical path always keys the same row. We do NOT realpath / follow symlinks:
 * a moved directory's *logical* path is what we key on, not its on-disk target.
 */
function normalizePath(absPath: string): string {
  if (!isAbsolute(absPath)) {
    throw new Error(`ProjectRegistry: path must be absolute, got '${absPath}'`);
  }
  return resolvePath(absPath);
}

function selectIdByPath(db: DatabaseSync, path: string): ProjectId | undefined {
  const row = db.prepare('SELECT project_id FROM projects WHERE current_path = ?').get(path);
  return row ? String(row.project_id) : undefined;
}

function selectPathById(db: DatabaseSync, projectId: ProjectId): string | undefined {
  const row = db.prepare('SELECT current_path FROM projects WHERE project_id = ?').get(projectId);
  return row ? String(row.current_path) : undefined;
}

export function openRegistry(): ProjectRegistry {
  // The global store holds the registry log + the `projects` read-model. The
  // projection persists across opens (same db file) and is maintained incrementally
  // and atomically in each register/relink tx — we deliberately do NOT rebuild on open.
  const store = openGlobalStore();
  const projectors = [new ProjectsProjector()];

  return {
    register(absPath: string): ProjectId {
      const path = normalizePath(absPath);
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureProjectsTable(db);
        // Check the projection before appending: a known path is idempotent and
        // mints NO new event — same path → same id (freeze #1).
        const existing = selectIdByPath(db, path);
        if (existing !== undefined) {
          return existing;
        }
        // Mint ONCE here, on the live path — never derived/hashed from the path.
        const projectId = randomUUID();
        const [stored] = tx.append([makeRegisteredEvent(projectId, path)]);
        applyEvent(tx, decode(stored!, registryUpcasters, registrySchemas), projectors);
        return projectId;
      });
    },

    relink(projectId: ProjectId, newAbsPath: string): void {
      const newPath = normalizePath(newAbsPath);
      store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureProjectsTable(db);
        const currentPath = selectPathById(db, projectId);
        if (currentPath === undefined) {
          throw new Error(`relink: unknown project id '${projectId}'`); // fail loud (Principle 9)
        }
        if (currentPath === newPath) {
          return; // already at this path — no-op, append nothing
        }
        const owner = selectIdByPath(db, newPath);
        if (owner !== undefined && owner !== projectId) {
          throw new Error(`relink: path '${newPath}' is already registered to '${owner}'`);
        }
        // Append-only index update (freeze #5): the per-project store at
        // projectDataDir(projectId) is NEVER touched, so the id + full event
        // history survive the move.
        const [stored] = tx.append([makeRelinkedEvent(projectId, currentPath, newPath)]);
        applyEvent(tx, decode(stored!, registryUpcasters, registrySchemas), projectors);
      });
    },

    resolve(absPath: string): ProjectId | undefined {
      const path = normalizePath(absPath);
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureProjectsTable(db);
        return selectIdByPath(db, path);
      });
    },

    pathFor(projectId: ProjectId): string | undefined {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureProjectsTable(db);
        return selectPathById(db, projectId);
      });
    },

    dataDirFor(projectId: ProjectId): string {
      // Pure path computation; does not create the dir and never touches it (freeze #5).
      return projectDataDir(projectId);
    },

    close(): void {
      store.close();
    },
  };
}
