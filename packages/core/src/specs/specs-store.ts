/**
 * The L6b F1 durable spec record store. Opens the PROJECT store, wires the
 * {@link SpecsProjector}, and exposes a typed {@link SpecStore} facade.
 *
 * L6b note: the production MCP WRITE verbs (draft/lock) are a later task. This layer builds the
 * record + projection + store only. Tests populate via `recordDraft` / `recordLock` / `recordArchive`
 * directly.
 */
import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import type { Criterion } from './criteria-schema.js';
import {
  EVENT_SPEC_ARCHIVED,
  EVENT_SPEC_DRAFTED,
  EVENT_SPEC_LOCKED,
  makeSpecArchivedEvent,
  makeSpecDraftedEvent,
  makeSpecLockedEvent,
  specsSchemas,
  specsUpcasters,
  type SpecRecord,
} from './events.js';
import {
  SpecsProjector,
  ensureSpecsTables,
  selectAllSpecs,
  selectSpec,
  validateSpecTransition,
} from './specs-projector.js';

export interface SpecStore {
  /** Record a spec draft (append `spec.drafted` + fold); returns the read-back record. */
  recordDraft(rec: {
    taskId: string;
    title: string;
    goal: string;
    criteria: readonly Criterion[];
    body: string;
    actor: string;
  }): SpecRecord;
  /** Record a spec lock (append `spec.locked` + fold); returns the read-back record. */
  recordLock(taskId: string, lockedBy: string): SpecRecord;
  /** Record a spec archive (append `spec.archived` + fold); returns the read-back record. */
  recordArchive(taskId: string): SpecRecord;
  /** The spec record for `taskId`, or undefined. */
  getSpec(taskId: string): SpecRecord | undefined;
  /** Every recorded spec, in stable order (by drafted_ts then task_id). */
  listSpecs(): readonly SpecRecord[];
  /** Close the underlying project store. */
  close(): void;
}

/**
 * Open the project spec store: open the PROJECT store, wire the {@link SpecsProjector}, and
 * return the {@link SpecStore} facade. Safe alongside other stores on the same per-project
 * `store.db` — `node:sqlite` is synchronous/single-threaded; the spec store owns distinct scopes
 * (`spec:`) and a distinct read-model table (`specs`).
 */
export function openSpecStore(projectId: string): SpecStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new SpecsProjector()];

  return {
    recordDraft(rec): SpecRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureSpecsTables(db);
        const existing = validateSpecTransition(db, EVENT_SPEC_DRAFTED, {
          taskId: rec.taskId,
          title: rec.title,
          goal: rec.goal,
          criteria: [...rec.criteria],
          body: rec.body,
        });
        if (existing != null) return existing;
        const [stored] = tx.append([
          makeSpecDraftedEvent(
            projectId,
            {
              taskId: rec.taskId,
              title: rec.title,
              goal: rec.goal,
              criteria: [...rec.criteria],
              body: rec.body,
            },
            rec.actor,
          ),
        ]);
        applyEvent(tx, decode(stored!, specsUpcasters, specsSchemas), projectors);
        const row = selectSpec(db, rec.taskId);
        if (!row) {
          throw new Error(
            `openSpecStore.recordDraft: row missing after projection (taskId='${rec.taskId}')`,
          );
        }
        return row;
      });
    },

    recordLock(taskId: string, lockedBy: string): SpecRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureSpecsTables(db);
        const existing = validateSpecTransition(db, EVENT_SPEC_LOCKED, { taskId, lockedBy });
        if (existing != null) return existing;
        const [stored] = tx.append([makeSpecLockedEvent(projectId, { taskId, lockedBy })]);
        applyEvent(tx, decode(stored!, specsUpcasters, specsSchemas), projectors);
        const row = selectSpec(db, taskId);
        if (!row) {
          throw new Error(
            `openSpecStore.recordLock: row missing after projection (taskId='${taskId}')`,
          );
        }
        return row;
      });
    },

    recordArchive(taskId: string): SpecRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureSpecsTables(db);
        const existing = validateSpecTransition(db, EVENT_SPEC_ARCHIVED, { taskId });
        if (existing != null) return existing;
        const [stored] = tx.append([makeSpecArchivedEvent(projectId, { taskId }, 'system')]);
        applyEvent(tx, decode(stored!, specsUpcasters, specsSchemas), projectors);
        const row = selectSpec(db, taskId);
        if (!row) {
          throw new Error(
            `openSpecStore.recordArchive: row missing after projection (taskId='${taskId}')`,
          );
        }
        return row;
      });
    },

    getSpec(taskId: string): SpecRecord | undefined {
      return store.transaction((tx) => selectSpec(tx.raw as DatabaseSync, taskId));
    },

    listSpecs(): readonly SpecRecord[] {
      return store.transaction((tx) => selectAllSpecs(tx.raw as DatabaseSync));
    },

    close(): void {
      store.close();
    },
  };
}
