import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { applyEvent, rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import {
  makeSessionCreatedEvent,
  makeSessionEndedEvent,
  sessionSchemas,
  sessionUpcasters,
} from './events.js';
import { ensureSessionTable, SessionProjector } from './session-projector.js';
import { openSessionStore } from './session-store.js';

// AC-L7-7 (sandbox) — durable session record: make, reject-bad, record, read-back, replace, replay-equal.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-session-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

const CLAUDE_REC = {
  agentId: 'impl-1',
  pane: 'pane-a',
  cwd: '/work/impl-1',
  provider: 'claude' as const,
  resume: { provider: 'claude' as const, sessionId: 'sess-abc' },
};

const CODEX_REC = {
  agentId: 'impl-2',
  pane: 'pane-b',
  cwd: '/work/impl-2',
  provider: 'codex' as const,
  resume: { provider: 'codex' as const, codexHome: '/data/codex-home-2' },
};

function snapshot(db: DatabaseSync): string {
  const rows = db
    .prepare(
      'SELECT agent_id, pane, cwd, provider, resume_kind, resume_value, ts FROM sessions ORDER BY ts, agent_id',
    )
    .all();
  return JSON.stringify(rows);
}

describe('makeSessionCreatedEvent — fail-loud validation', () => {
  it('rejects missing agentId', () => {
    expect(() =>
      makeSessionCreatedEvent('p1', {
        agentId: '',
        pane: 'pane-a',
        cwd: '/work',
        provider: 'claude',
        resume: { provider: 'claude', sessionId: 'sid' },
      }),
    ).toThrow();
  });

  it('rejects missing pane', () => {
    expect(() =>
      makeSessionCreatedEvent('p1', {
        agentId: 'impl-1',
        pane: '',
        cwd: '/work',
        provider: 'claude',
        resume: { provider: 'claude', sessionId: 'sid' },
      }),
    ).toThrow();
  });

  it('rejects missing cwd', () => {
    expect(() =>
      makeSessionCreatedEvent('p1', {
        agentId: 'impl-1',
        pane: 'pane-a',
        cwd: '',
        provider: 'claude',
        resume: { provider: 'claude', sessionId: 'sid' },
      }),
    ).toThrow();
  });

  it('rejects provider/resume mismatch (claude provider + codex resume)', () => {
    expect(() =>
      makeSessionCreatedEvent('p1', {
        agentId: 'impl-1',
        pane: 'pane-a',
        cwd: '/work',
        provider: 'claude',
        resume: { provider: 'codex', codexHome: '/home' },
      }),
    ).toThrow(/resume.provider must match provider/i);
  });

  it('rejects provider/resume mismatch (codex provider + claude resume)', () => {
    expect(() =>
      makeSessionCreatedEvent('p1', {
        agentId: 'impl-1',
        pane: 'pane-a',
        cwd: '/work',
        provider: 'codex',
        resume: { provider: 'claude', sessionId: 'sid' },
      }),
    ).toThrow(/resume.provider must match provider/i);
  });

  it('builds a valid claude event', () => {
    const ev = makeSessionCreatedEvent('p1', CLAUDE_REC);
    expect(ev.type).toBe('session.created');
    expect(ev.scope).toBe('session:impl-1');
    expect(ev.actor).toBe('impl-1');
    expect((ev.payload as typeof CLAUDE_REC).resume).toEqual({
      provider: 'claude',
      sessionId: 'sess-abc',
    });
  });

  it('builds a valid codex event', () => {
    const ev = makeSessionCreatedEvent('p1', CODEX_REC);
    expect(ev.type).toBe('session.created');
    expect((ev.payload as typeof CODEX_REC).resume).toEqual({
      provider: 'codex',
      codexHome: '/data/codex-home-2',
    });
  });
});

describe('makeSessionEndedEvent — fail-loud validation', () => {
  it('rejects missing agentId', () => {
    expect(() =>
      makeSessionEndedEvent('p1', {
        agentId: '',
        pane: 'pane-a',
      }),
    ).toThrow();
  });

  it('rejects missing pane', () => {
    expect(() =>
      makeSessionEndedEvent('p1', {
        agentId: 'impl-1',
        pane: '',
      }),
    ).toThrow();
  });
});

describe('SessionStore — record + read sessions', () => {
  it('ensureSessionTable adds a pane unique index for already-created tables', () => {
    const store = openProjectStore('p-sess-pane-index');
    try {
      store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        db.exec(`
          CREATE TABLE sessions (
            agent_id     TEXT PRIMARY KEY,
            pane         TEXT NOT NULL,
            cwd          TEXT NOT NULL,
            provider     TEXT NOT NULL,
            resume_kind  TEXT NOT NULL,
            resume_value TEXT NOT NULL,
            ts           INTEGER NOT NULL
          );
        `);

        ensureSessionTable(db);

        const indexes = db.prepare("PRAGMA index_list('sessions')").all() as Array<
          Record<string, unknown>
        >;
        expect(indexes.some((row) => row.name === 'sessions_pane_unique')).toBe(true);
      });
    } finally {
      store.close();
    }
  });

  it('recordSession → getSession round-trips for claude provider', () => {
    const store = openSessionStore('p-sess-claude');
    try {
      const rec = store.recordSession(CLAUDE_REC);
      expect(rec.agentId).toBe('impl-1');
      expect(rec.pane).toBe('pane-a');
      expect(rec.cwd).toBe('/work/impl-1');
      expect(rec.provider).toBe('claude');
      expect(rec.resume).toEqual({ provider: 'claude', sessionId: 'sess-abc' });
      expect(rec.createdTs).toBeGreaterThan(0);

      const fetched = store.getSession('impl-1');
      expect(fetched).toEqual(rec);
      expect(store.getSession('absent')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('recordSession → getSession round-trips for codex provider', () => {
    const store = openSessionStore('p-sess-codex');
    try {
      const rec = store.recordSession(CODEX_REC);
      expect(rec.provider).toBe('codex');
      expect(rec.resume).toEqual({ provider: 'codex', codexHome: '/data/codex-home-2' });
    } finally {
      store.close();
    }
  });

  it('second recordSession for same agent fails loud and preserves the original active session', () => {
    const store = openSessionStore('p-sess-replace');
    try {
      const original = store.recordSession(CLAUDE_REC);
      expect(() =>
        store.recordSession({
          agentId: 'impl-1',
          pane: 'pane-new',
          cwd: '/work/impl-1-new',
          provider: 'claude',
          resume: { provider: 'claude', sessionId: 'sess-xyz' },
        }),
      ).toThrow(/already has an active session|duplicate/i);

      // Only one row exists — the original, not a silent replacement.
      expect(store.listSessions()).toHaveLength(1);
      expect(store.getSession('impl-1')).toEqual(original);
    } finally {
      store.close();
    }
  });

  it('second recordSession for same pane but different agent fails loud', () => {
    const store = openSessionStore('p-sess-duplicate-pane');
    try {
      const original = store.recordSession(CLAUDE_REC);
      expect(() =>
        store.recordSession({
          agentId: 'impl-other',
          pane: 'pane-a',
          cwd: '/work/impl-other',
          provider: 'claude',
          resume: { provider: 'claude', sessionId: 'sess-other' },
        }),
      ).toThrow(/pane.*already hosted|duplicate pane/i);

      expect(store.listSessions()).toHaveLength(1);
      expect(store.getSessionByPane('pane-a')).toEqual(original);
    } finally {
      store.close();
    }
  });

  it('endSession closes the active row so a later session for the same agent can be recorded', () => {
    const store = openSessionStore('p-sess-end-rehost');
    try {
      const original = store.recordSession(CLAUDE_REC);
      const ended = store.endSession('impl-1', 'pane-a');
      expect(ended).toEqual(original);
      expect(store.getSession('impl-1')).toBeUndefined();

      const next = store.recordSession({
        agentId: 'impl-1',
        pane: 'pane-new',
        cwd: '/work/impl-1-new',
        provider: 'claude',
        resume: { provider: 'claude', sessionId: 'sess-xyz' },
      });
      expect(next.pane).toBe('pane-new');
      expect(store.listSessions()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('endSession fails loud when the pane does not match the active session', () => {
    const store = openSessionStore('p-sess-end-mismatch');
    try {
      store.recordSession(CLAUDE_REC);
      expect(() => store.endSession('impl-1', 'other-pane')).toThrow(/pane.*does not match/i);
      expect(store.getSession('impl-1')?.pane).toBe('pane-a');
    } finally {
      store.close();
    }
  });

  it('distinct agents coexist; listSessions ordered + complete', () => {
    const store = openSessionStore('p-sess-multi');
    try {
      store.recordSession(CLAUDE_REC);
      store.recordSession(CODEX_REC);

      const sessions = store.listSessions();
      expect(sessions).toHaveLength(2);
      const byId = Object.fromEntries(sessions.map((s) => [s.agentId, s]));
      expect(byId['impl-1']?.provider).toBe('claude');
      expect(byId['impl-2']?.provider).toBe('codex');
    } finally {
      store.close();
    }
  });

  it('persists across store re-open (same project id)', () => {
    const a = openSessionStore('p-sess-persist');
    try {
      a.recordSession(CLAUDE_REC);
    } finally {
      a.close();
    }
    const b = openSessionStore('p-sess-persist');
    try {
      expect(b.getSession('impl-1')?.provider).toBe('claude');
    } finally {
      b.close();
    }
  });
});

describe('AC-L7-7 (sandbox) — replay equality: live fold → rebuildAll → byte-equal', () => {
  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous)', () => {
    const store = openProjectStore('p-sess-replay');
    const projectors = [new SessionProjector()];
    const events = [
      makeSessionCreatedEvent('p-sess-replay', CLAUDE_REC),
      makeSessionCreatedEvent('p-sess-replay', CODEX_REC),
      makeSessionCreatedEvent('p-sess-replay', {
        agentId: 'impl-3',
        pane: 'pane-c',
        cwd: '/work/impl-3',
        provider: 'claude',
        resume: { provider: 'claude', sessionId: 'sess-third' },
      }),
    ];
    try {
      for (const e of events) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, sessionUpcasters, sessionSchemas), projectors);
        });
      }

      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, sessionUpcasters, sessionSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against vacuous pass.
      expect(live).toContain('"impl-1"');
      expect(live).toContain('"claude"');
      expect(live).toContain('"impl-2"');
      expect(live).toContain('"codex"');
    } finally {
      store.close();
    }
  });

  it('duplicate active session events fail loud instead of replaying to a replacement row', () => {
    const store = openProjectStore('p-sess-replay-replace');
    const projectors = [new SessionProjector()];
    const first = makeSessionCreatedEvent('p-sess-replay-replace', CLAUDE_REC);
    const second = makeSessionCreatedEvent('p-sess-replay-replace', {
      agentId: 'impl-1',
      pane: 'pane-updated',
      cwd: '/work/updated',
      provider: 'claude',
      resume: { provider: 'claude', sessionId: 'sess-updated' },
    });
    try {
      store.transaction((tx) => {
        const [s] = tx.append([first]);
        applyEvent(tx, decode(s!, sessionUpcasters, sessionSchemas), projectors);
      });

      expect(() =>
        store.transaction((tx) => {
          const [s] = tx.append([second]);
          applyEvent(tx, decode(s!, sessionUpcasters, sessionSchemas), projectors);
        }),
      ).toThrow(/already has an active session|duplicate/i);

      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));
      expect(live).toContain('"pane-a"');
      expect(live).not.toContain('"pane-updated"');
      const parsed = JSON.parse(live) as unknown[];
      expect(parsed).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('duplicate active pane events fail loud instead of replaying two agents onto one pane', () => {
    const store = openProjectStore('p-sess-replay-duplicate-pane');
    const projectors = [new SessionProjector()];
    const first = makeSessionCreatedEvent('p-sess-replay-duplicate-pane', CLAUDE_REC);
    const second = makeSessionCreatedEvent('p-sess-replay-duplicate-pane', {
      agentId: 'impl-other',
      pane: 'pane-a',
      cwd: '/work/other',
      provider: 'claude',
      resume: { provider: 'claude', sessionId: 'sess-other' },
    });
    try {
      store.transaction((tx) => {
        const [s] = tx.append([first]);
        applyEvent(tx, decode(s!, sessionUpcasters, sessionSchemas), projectors);
      });

      expect(() =>
        store.transaction((tx) => {
          const [s] = tx.append([second]);
          applyEvent(tx, decode(s!, sessionUpcasters, sessionSchemas), projectors);
        }),
      ).toThrow(/pane.*already hosted|duplicate pane/i);

      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));
      expect(live).toContain('"impl-1"');
      expect(live).not.toContain('"impl-other"');
      const parsed = JSON.parse(live) as unknown[];
      expect(parsed).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('ended-then-created lifecycle is replay-equal and leaves the later active session', () => {
    const store = openProjectStore('p-sess-replay-ended');
    const projectors = [new SessionProjector()];
    const first = makeSessionCreatedEvent('p-sess-replay-ended', CLAUDE_REC);
    const ended = makeSessionEndedEvent('p-sess-replay-ended', {
      agentId: 'impl-1',
      pane: 'pane-a',
    });
    const second = makeSessionCreatedEvent('p-sess-replay-ended', {
      agentId: 'impl-1',
      pane: 'pane-updated',
      cwd: '/work/updated',
      provider: 'claude',
      resume: { provider: 'claude', sessionId: 'sess-updated' },
    });
    try {
      for (const e of [first, ended, second]) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, sessionUpcasters, sessionSchemas), projectors);
        });
      }

      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));
      rebuildAll(store, projectors, (e) => decode(e, sessionUpcasters, sessionSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      expect(live).toContain('"pane-updated"');
      expect(live).not.toContain('"pane-a"');
      const parsed = JSON.parse(live) as unknown[];
      expect(parsed).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
