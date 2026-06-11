import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { applyEvent, rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import {
  makeResearchFinalizedEvent,
  researchSchemas,
  researchUpcasters,
  type ResearchFinalized,
} from './events.js';
import { ResearchProjector } from './research-projector.js';
import { openResearchStore } from './research-store.js';
import type { LocatorMap } from './map-contract.js';

// L6b H — the research-finalize record: a cited map/answer durably stored as replay-safe
// program-data (AC-L6b-H1). The live "agent reads a stranger repo and produces the map" is
// L7-coupled and NOT here.

const ORIGINAL_ENV = process.env;
let dataDir = '';

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDir = mkdtempSync(join(tmpdir(), 'co-research-'));
  process.env.CO_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

const MAP: LocatorMap = {
  question: 'where is the review gate?',
  entries: [
    {
      path: 'packages/core/src/review/merge.ts',
      why: 'the gated merge',
      symbols: ['CoReviewGate'],
    },
  ],
  readOrder: ['packages/core/src/review/merge.ts'],
};

const MAP_FINALIZE: ResearchFinalized = {
  researchId: 'res-1',
  question: 'where is the review gate?',
  requestedBy: 'impl-3',
  researcher: 'res-codebase-1',
  kind: 'map',
  map: MAP,
};

const ANSWER_FINALIZE: ResearchFinalized = {
  researchId: 'res-2',
  question: 'is delivery pluggable?',
  requestedBy: 'lead-1',
  researcher: 'res-decision-1',
  kind: 'answer',
  answer: {
    text: 'yes — the Delivery seam is injectable',
    citations: [{ source: 'packages/core/src/mail/delivery.ts' }],
  },
};

describe('ResearchStore — finalize + read-back', () => {
  it('records a map finalize and reads it back', () => {
    const store = openResearchStore('p-research-map');
    try {
      const rec = store.recordFinalize(MAP_FINALIZE);
      expect(rec.researchId).toBe('res-1');
      expect(rec.kind).toBe('map');
      expect(rec.map).toEqual(MAP);
      expect(rec.answer).toBeUndefined();
      expect(rec.requestedBy).toBe('impl-3');
      expect(rec.researcher).toBe('res-codebase-1');
      expect(rec.finalizedTs).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('records an answer finalize and reads it back', () => {
    const store = openResearchStore('p-research-answer');
    try {
      const rec = store.recordFinalize(ANSWER_FINALIZE);
      expect(rec.kind).toBe('answer');
      expect(rec.answer?.citations).toHaveLength(1);
      expect(rec.map).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('getResearch returns undefined for absent; listResearch is in finalized order', () => {
    const store = openResearchStore('p-research-list');
    try {
      expect(store.getResearch('ghost')).toBeUndefined();
      store.recordFinalize(MAP_FINALIZE);
      store.recordFinalize(ANSWER_FINALIZE);
      const list = store.listResearch();
      expect(list.map((r) => r.researchId)).toEqual(['res-1', 'res-2']);
    } finally {
      store.close();
    }
  });

  it('idempotent re-finalize returns existing; conflicting re-finalize throws', () => {
    const store = openResearchStore('p-research-idem');
    try {
      const first = store.recordFinalize(MAP_FINALIZE);
      const second = store.recordFinalize(MAP_FINALIZE);
      expect(second.finalizedTs).toBe(first.finalizedTs);
      expect(store.listResearch()).toHaveLength(1);
      expect(() =>
        store.recordFinalize({ ...MAP_FINALIZE, question: 'a different question' }),
      ).toThrow(/conflicting re-finalize/i);
    } finally {
      store.close();
    }
  });

  it('a kind/payload mismatch fails validation loud (map kind with no map)', () => {
    const store = openResearchStore('p-research-mismatch');
    try {
      expect(() =>
        store.recordFinalize({ ...MAP_FINALIZE, map: undefined } as ResearchFinalized),
      ).toThrow();
      expect(() =>
        store.recordFinalize({ ...ANSWER_FINALIZE, map: MAP } as ResearchFinalized),
      ).toThrow();
    } finally {
      store.close();
    }
  });
});

describe('ResearchStore — replay-equal', () => {
  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous)', () => {
    const store = openProjectStore('p-research-replay');
    const projectors = [new ResearchProjector()];
    const snapshot = (db: DatabaseSync): string =>
      JSON.stringify(
        db
          .prepare(
            'SELECT research_id, kind, finalized_ts FROM research_reports ORDER BY finalized_ts, research_id',
          )
          .all(),
      );
    try {
      for (const rec of [MAP_FINALIZE, ANSWER_FINALIZE]) {
        store.transaction((tx) => {
          const [s] = tx.append([makeResearchFinalizedEvent('p-research-replay', rec)]);
          applyEvent(tx, decode(s!, researchUpcasters, researchSchemas), projectors);
        });
      }
      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));
      rebuildAll(store, projectors, (e) => decode(e, researchUpcasters, researchSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));
      expect(replayed).toBe(live);
      expect(live).toContain('"res-1"');
      expect(live).toContain('"map"');
    } finally {
      store.close();
    }
  });
});
