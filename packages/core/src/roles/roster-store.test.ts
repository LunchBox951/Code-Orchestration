import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { applyEvent, rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import { assertRepoPristine } from '../config/pristine.js';
import { makeAgentRegisteredEvent, rolesSchemas, rolesUpcasters } from './events.js';
import { RosterProjector } from './roster-projector.js';
import { openRosterStore } from './roster-store.js';

// AC-L6a-1 + AC-L6a-10 — durable agent→role→parent projection: record, read-back, replay-equal,
// and pristine-repo round-trip.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-roster-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of [...dataDirs, ...repoDirs]) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-roster-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

function snapshot(db: DatabaseSync): string {
  const rows = db
    .prepare(
      'SELECT agent_id, role, sub_role, parent, registered_ts FROM roster ORDER BY registered_ts, agent_id',
    )
    .all();
  return JSON.stringify(rows);
}

function appendRosterEvents(
  store: ReturnType<typeof openProjectStore>,
  events: readonly ReturnType<typeof makeAgentRegisteredEvent>[],
): void {
  store.append(events);
}

function rebuildRoster(store: ReturnType<typeof openProjectStore>): void {
  rebuildAll(store, [new RosterProjector()], (e) => decode(e, rolesUpcasters, rolesSchemas));
}

describe('RosterStore — record + read agents', () => {
  it('records three agents and reads each back correctly', () => {
    const store = openRosterStore('p-roster-1');
    try {
      const coord = store.recordAgent({
        agentId: 'coord-1',
        role: 'coordinator',
        parent: '@operator',
      });
      const lead = store.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
      const impl = store.recordAgent({ agentId: 'impl-1', role: 'implementer', parent: 'lead-1' });

      expect(coord.agentId).toBe('coord-1');
      expect(coord.role).toBe('coordinator');
      expect(coord.parent).toBe('@operator');
      expect(coord.registeredTs).toBeGreaterThan(0);

      expect(store.getAgent('coord-1')).toEqual(coord);
      expect(store.getAgent('lead-1')).toEqual(lead);
      expect(store.getAgent('impl-1')).toEqual(impl);
      expect(store.getAgent('absent')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('listAgents returns all agents — each with correct role + parent', () => {
    const store = openRosterStore('p-roster-list');
    try {
      store.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
      store.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
      store.recordAgent({ agentId: 'impl-1', role: 'implementer', parent: 'lead-1' });

      const agents = store.listAgents();
      expect(agents).toHaveLength(3);
      const byId = Object.fromEntries(agents.map((a) => [a.agentId, a]));
      expect(byId['coord-1']?.role).toBe('coordinator');
      expect(byId['coord-1']?.parent).toBe('@operator');
      expect(byId['lead-1']?.role).toBe('lead');
      expect(byId['lead-1']?.parent).toBe('coord-1');
      expect(byId['impl-1']?.role).toBe('implementer');
      expect(byId['impl-1']?.parent).toBe('lead-1');
    } finally {
      store.close();
    }
  });

  it('records and reads back a sub-role', () => {
    const store = openRosterStore('p-roster-subrole');
    try {
      store.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
      store.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
      const rec = store.recordAgent({
        agentId: 'impl-test-1',
        role: 'implementer',
        subRole: 'test',
        parent: 'lead-1',
      });
      expect(rec.subRole).toBe('test');
      expect(store.getAgent('impl-test-1')?.subRole).toBe('test');
    } finally {
      store.close();
    }
  });

  it('rejects a sub-role that is not shipped for the base role', () => {
    const store = openRosterStore('p-roster-bad-subrole');
    try {
      store.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
      store.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });

      expect(() =>
        store.recordAgent({
          agentId: 'researcher-1',
          role: 'researcher',
          subRole: 'test',
          parent: 'lead-1',
        }),
      ).toThrow(/unknown sub-role/i);
    } finally {
      store.close();
    }
  });

  it('rejects a coordinator whose parent is not @operator', () => {
    const store = openRosterStore('p-roster-bad-coord-parent');
    try {
      expect(() =>
        store.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: 'coord-parent' }),
      ).toThrow(/coordinator.*@operator/i);
    } finally {
      store.close();
    }
  });

  it('rejects @operator as a registrable agent id', () => {
    const store = openRosterStore('p-roster-operator-agent');
    try {
      store.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

      expect(() =>
        store.recordAgent({ agentId: '@operator', role: 'lead', parent: 'coord-1' }),
      ).toThrow(/reserved.*@operator/i);
    } finally {
      store.close();
    }
  });

  it('rejects non-coordinator agents with a missing parent record', () => {
    const store = openRosterStore('p-roster-ghost-parent');
    try {
      expect(() =>
        store.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-missing' }),
      ).toThrow(/parent.*coord-missing.*not registered/i);
    } finally {
      store.close();
    }
  });

  it('rejects parent-child edges that violate spawn rules', () => {
    const store = openRosterStore('p-roster-bad-spawn-edge');
    try {
      store.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
      store.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });

      expect(() =>
        store.recordAgent({ agentId: 'lead-2', role: 'lead', parent: 'lead-1' }),
      ).toThrow(/lead never spawns a lead/i);
    } finally {
      store.close();
    }
  });

  it('rejects conflicting re-registration for the same agent id', () => {
    const store = openRosterStore('p-roster-conflicting-reregister');
    try {
      store.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
      store.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
      store.recordAgent({ agentId: 'worker-1', role: 'implementer', parent: 'lead-1' });

      expect(() =>
        store.recordAgent({ agentId: 'worker-1', role: 'researcher', parent: 'lead-1' }),
      ).toThrow(/already registered/i);
      expect(store.getAgent('worker-1')?.role).toBe('implementer');
    } finally {
      store.close();
    }
  });

  it('persists across store re-open (same project id)', () => {
    const a = openRosterStore('p-roster-persist');
    try {
      a.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    } finally {
      a.close();
    }
    const b = openRosterStore('p-roster-persist');
    try {
      expect(b.getAgent('coord-1')?.role).toBe('coordinator');
    } finally {
      b.close();
    }
  });
});

describe('AC-L6a-1 — replay equality: live fold → rebuildAll → byte-equal', () => {
  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous)', () => {
    const store = openProjectStore('p-roster-replay');
    const projectors = [new RosterProjector()];
    const events = [
      makeAgentRegisteredEvent('p-roster-replay', {
        agentId: 'coord-1',
        role: 'coordinator',
        parent: '@operator',
      }),
      makeAgentRegisteredEvent('p-roster-replay', {
        agentId: 'lead-1',
        role: 'lead',
        parent: 'coord-1',
      }),
      makeAgentRegisteredEvent('p-roster-replay', {
        agentId: 'impl-1',
        role: 'implementer',
        subRole: 'code',
        parent: 'lead-1',
      }),
    ];
    try {
      for (const e of events) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, rolesUpcasters, rolesSchemas), projectors);
        });
      }

      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, rolesUpcasters, rolesSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against a vacuous pass (two empty snapshots are also "equal").
      expect(live).toContain('"coord-1"');
      expect(live).toContain('"coordinator"');
      expect(live).toContain('"@operator"');
      expect(live).toContain('"code"');
    } finally {
      store.close();
    }
  });

  it('replay fails loud on conflicting agent re-registration', () => {
    const store = openProjectStore('p-roster-replay-conflict');
    const events = [
      makeAgentRegisteredEvent('p-roster-replay-conflict', {
        agentId: 'coord-1',
        role: 'coordinator',
        parent: '@operator',
      }),
      makeAgentRegisteredEvent('p-roster-replay-conflict', {
        agentId: 'lead-1',
        role: 'lead',
        parent: 'coord-1',
      }),
      makeAgentRegisteredEvent('p-roster-replay-conflict', {
        agentId: 'worker-1',
        role: 'implementer',
        parent: 'lead-1',
      }),
      makeAgentRegisteredEvent('p-roster-replay-conflict', {
        agentId: 'worker-1',
        role: 'researcher',
        parent: 'lead-1',
      }),
    ];
    try {
      appendRosterEvents(store, events);

      expect(() => rebuildRoster(store)).toThrow(/already registered/i);
    } finally {
      store.close();
    }
  });

  it('replay fails loud when @operator is registered as an agent id', () => {
    const store = openProjectStore('p-roster-replay-operator');
    const event = makeAgentRegisteredEvent('p-roster-replay-operator', {
      agentId: '@operator',
      role: 'coordinator',
      parent: '@operator',
    });
    try {
      appendRosterEvents(store, [event]);

      expect(() => rebuildRoster(store)).toThrow(/reserved.*@operator/i);
    } finally {
      store.close();
    }
  });

  it('replay fails loud when committed history contains a missing parent', () => {
    const store = openProjectStore('p-roster-replay-missing-parent');
    try {
      appendRosterEvents(store, [
        makeAgentRegisteredEvent('p-roster-replay-missing-parent', {
          agentId: 'lead-1',
          role: 'lead',
          parent: 'coord-missing',
        }),
      ]);

      expect(() => rebuildRoster(store)).toThrow(/parent.*coord-missing.*not registered/i);
    } finally {
      store.close();
    }
  });

  it('replay fails loud when committed history contains an illegal spawn edge', () => {
    const store = openProjectStore('p-roster-replay-bad-spawn-edge');
    try {
      appendRosterEvents(store, [
        makeAgentRegisteredEvent('p-roster-replay-bad-spawn-edge', {
          agentId: 'coord-1',
          role: 'coordinator',
          parent: '@operator',
        }),
        makeAgentRegisteredEvent('p-roster-replay-bad-spawn-edge', {
          agentId: 'lead-1',
          role: 'lead',
          parent: 'coord-1',
        }),
        makeAgentRegisteredEvent('p-roster-replay-bad-spawn-edge', {
          agentId: 'lead-2',
          role: 'lead',
          parent: 'lead-1',
        }),
      ]);

      expect(() => rebuildRoster(store)).toThrow(/lead never spawns a lead/i);
    } finally {
      store.close();
    }
  });

  it('replay fails loud when committed history contains an invalid sub-role', () => {
    const store = openProjectStore('p-roster-replay-bad-subrole');
    try {
      appendRosterEvents(store, [
        makeAgentRegisteredEvent('p-roster-replay-bad-subrole', {
          agentId: 'coord-1',
          role: 'coordinator',
          parent: '@operator',
        }),
        makeAgentRegisteredEvent('p-roster-replay-bad-subrole', {
          agentId: 'lead-1',
          role: 'lead',
          parent: 'coord-1',
        }),
        makeAgentRegisteredEvent('p-roster-replay-bad-subrole', {
          agentId: 'researcher-1',
          role: 'researcher',
          subRole: 'test',
          parent: 'lead-1',
        }),
      ]);

      expect(() => rebuildRoster(store)).toThrow(/unknown sub-role/i);
    } finally {
      store.close();
    }
  });
});

describe('AC-L6a-10 — assertRepoPristine round-trip', () => {
  it('a full record + read round-trip leaves the repo byte-identical', () => {
    const repoDir = makeRepo();
    assertRepoPristine(repoDir, () => {
      const store = openRosterStore('p-roster-pristine');
      try {
        store.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
        store.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
        expect(store.getAgent('coord-1')).not.toBeUndefined();
        expect(store.listAgents()).toHaveLength(2);
      } finally {
        store.close();
      }
    });
  });
});
