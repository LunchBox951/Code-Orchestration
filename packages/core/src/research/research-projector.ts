import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_RESEARCH_FINALIZED,
  type ResearchFinalized,
  type ResearchKind,
  type ResearchRecord,
} from './events.js';
import type { CitedAnswer, LocatorMap } from './map-contract.js';

const CREATE_RESEARCH_TABLE = `
  CREATE TABLE IF NOT EXISTS research_reports (
    research_id  TEXT PRIMARY KEY,
    question     TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    researcher   TEXT NOT NULL,
    kind         TEXT NOT NULL,
    map          TEXT,
    answer       TEXT,
    finalized_ts INTEGER NOT NULL
  );
`;

/** Defensive create of the research read-model table — called on reset/apply AND every read path. */
export function ensureResearchTables(db: DatabaseSync): void {
  db.exec(CREATE_RESEARCH_TABLE);
}

const RESEARCH_COLUMNS =
  'research_id, question, requested_by, researcher, kind, map, answer, finalized_ts';

/** Map a raw `research_reports` row to a {@link ResearchRecord}. */
export function rowToResearchRecord(row: Record<string, unknown>): ResearchRecord {
  return {
    researchId: String(row.research_id),
    question: String(row.question),
    requestedBy: String(row.requested_by),
    researcher: String(row.researcher),
    kind: String(row.kind) as ResearchKind,
    ...(row.map != null ? { map: JSON.parse(String(row.map)) as LocatorMap } : {}),
    ...(row.answer != null ? { answer: JSON.parse(String(row.answer)) as CitedAnswer } : {}),
    finalizedTs: Number(row.finalized_ts),
  };
}

/** The research record for `researchId`, or undefined. */
export function selectResearch(db: DatabaseSync, researchId: string): ResearchRecord | undefined {
  ensureResearchTables(db);
  const row = db
    .prepare(`SELECT ${RESEARCH_COLUMNS} FROM research_reports WHERE research_id = ?`)
    .get(researchId);
  return row ? rowToResearchRecord(row as Record<string, unknown>) : undefined;
}

/** All research records, in stable order: by `finalized_ts` then `research_id` for tie-breaks. */
export function selectAllResearch(db: DatabaseSync): ResearchRecord[] {
  ensureResearchTables(db);
  const rows = db
    .prepare(`SELECT ${RESEARCH_COLUMNS} FROM research_reports ORDER BY finalized_ts, research_id`)
    .all();
  return rows.map((r) => rowToResearchRecord(r as Record<string, unknown>));
}

function sameFinalize(existing: ResearchRecord, rec: ResearchFinalized): boolean {
  return (
    existing.question === rec.question &&
    existing.requestedBy === rec.requestedBy &&
    existing.researcher === rec.researcher &&
    existing.kind === rec.kind &&
    JSON.stringify(existing.map ?? null) === JSON.stringify(rec.map ?? null) &&
    JSON.stringify(existing.answer ?? null) === JSON.stringify(rec.answer ?? null)
  );
}

/**
 * Validate a finalize against the already-folded read model. A research record is write-once:
 * an identical re-finalize is idempotent (returns the existing record); a different one throws
 * (Principle 9 — loud-fail). Follow-ups are NEW research ids, not amended records.
 */
export function validateResearchTransition(
  db: DatabaseSync,
  type: string,
  payload: ResearchFinalized,
): ResearchRecord | undefined {
  if (type !== EVENT_RESEARCH_FINALIZED) {
    throw new Error(`research: unknown event type '${type}'`);
  }
  const existing = selectResearch(db, payload.researchId);
  if (existing == null) return undefined;
  if (sameFinalize(existing, payload)) return existing;
  throw new Error(
    `research: research '${payload.researchId}' is already finalized with different content — ` +
      'refusing conflicting re-finalize (follow-ups are new research ids)',
  );
}

interface ResearchFinalizedEvent extends StoredEvent {
  readonly type: typeof EVENT_RESEARCH_FINALIZED;
  readonly payload: ResearchFinalized;
}

/**
 * Folds `research.finalized` events into the `research_reports` read-model. Write-once with
 * idempotent re-assert; `event.ts` is used for the timestamp (never wall-clock — freeze #6).
 */
export class ResearchProjector implements Projector {
  readonly name = 'research';

  handles(type: string): boolean {
    return type === EVENT_RESEARCH_FINALIZED;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureResearchTables(db);
    db.exec('DELETE FROM research_reports');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureResearchTables(db);
    const researchEvent = event as ResearchFinalizedEvent;
    const type = researchEvent.type;
    switch (type) {
      case EVENT_RESEARCH_FINALIZED: {
        const { researchId, question, requestedBy, researcher, kind, map, answer } =
          researchEvent.payload;
        const existing = validateResearchTransition(db, type, researchEvent.payload);
        if (existing != null) return;
        db.prepare(
          `INSERT INTO research_reports
             (research_id, question, requested_by, researcher, kind, map, answer, finalized_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          researchId,
          question,
          requestedBy,
          researcher,
          kind,
          map != null ? JSON.stringify(map) : null,
          answer != null ? JSON.stringify(answer) : null,
          event.ts,
        );
        return;
      }
      default:
        return assertNever(type);
    }
  }
}
