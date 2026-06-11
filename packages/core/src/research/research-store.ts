/**
 * The L6b H durable research record store. Opens the PROJECT store, wires the
 * {@link ResearchProjector}, and exposes a typed {@link ResearchStore} facade.
 *
 * L6b note: this is the STATIC half of the locator — the durable finalize record + the map
 * contract. Research *dispatch* (spawning the researcher into a live session) is L7's Conductor;
 * the production MCP write verb (`co_research_finalize`) lives in `tools/specs/` and calls this
 * facade after its role + contract checks pass.
 */
import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import {
  EVENT_RESEARCH_FINALIZED,
  makeResearchFinalizedEvent,
  researchSchemas,
  researchUpcasters,
  type ResearchFinalized,
  type ResearchRecord,
} from './events.js';
import {
  ResearchProjector,
  ensureResearchTables,
  selectAllResearch,
  selectResearch,
  validateResearchTransition,
} from './research-projector.js';

export interface ResearchStore {
  /** Record a research finalize (append `research.finalized` + fold); returns the record. */
  recordFinalize(rec: ResearchFinalized): ResearchRecord;
  /** The research record for `researchId`, or undefined. */
  getResearch(researchId: string): ResearchRecord | undefined;
  /** Every recorded research result, in stable order (by finalized_ts then research_id). */
  listResearch(): readonly ResearchRecord[];
  /** Close the underlying project store. */
  close(): void;
}

/**
 * Open the project research store: open the PROJECT store, wire the {@link ResearchProjector},
 * and return the {@link ResearchStore} facade. Safe alongside other stores on the same
 * per-project `store.db` — the research store owns distinct scopes (`research:`) and a distinct
 * read-model table (`research_reports`).
 */
export function openResearchStore(projectId: string): ResearchStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new ResearchProjector()];

  return {
    recordFinalize(rec: ResearchFinalized): ResearchRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureResearchTables(db);
        // makeResearchFinalizedEvent re-parses, but validate FIRST so a kind/payload mismatch
        // fails before the idempotency check can mask it.
        const event = makeResearchFinalizedEvent(projectId, rec);
        const existing = validateResearchTransition(db, EVENT_RESEARCH_FINALIZED, rec);
        if (existing != null) return existing;
        const [stored] = tx.append([event]);
        applyEvent(tx, decode(stored!, researchUpcasters, researchSchemas), projectors);
        const row = selectResearch(db, rec.researchId);
        if (!row) {
          throw new Error(
            `openResearchStore.recordFinalize: row missing after projection ` +
              `(researchId='${rec.researchId}')`,
          );
        }
        return row;
      });
    },

    getResearch(researchId: string): ResearchRecord | undefined {
      return store.transaction((tx) => selectResearch(tx.raw as DatabaseSync, researchId));
    },

    listResearch(): readonly ResearchRecord[] {
      return store.transaction((tx) => selectAllResearch(tx.raw as DatabaseSync));
    },

    close(): void {
      store.close();
    },
  };
}
