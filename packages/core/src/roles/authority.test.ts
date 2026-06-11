import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATOR } from '../mail/events.js';
import { roleParentResolver } from '../mail/escalation.js';
import { openRosterStore, type RosterStore } from './roster-store.js';
import {
  escalationDisposition,
  lowestCompetentResolver,
  type EscalationTopic,
} from './authority.js';

// AC-L6a-4 — production role-based ParentResolver + authority cut + lowestCompetentResolver.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let rosterStores: RosterStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  rosterStores = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-authority-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const r of rosterStores) r.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  rosterStores = [];
});

// ── roleParentResolver ────────────────────────────────────────────────────────────────────────────

describe('roleParentResolver — production resolver (AC-L6a-4)', () => {
  function openStore(id: string): RosterStore {
    const s = openRosterStore(id);
    rosterStores.push(s);
    return s;
  }

  function buildChain(store: RosterStore) {
    // impl → lead → coord → @operator (structural)
    store.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: OPERATOR });
    store.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
    store.recordAgent({ agentId: 'impl-1', role: 'implementer', parent: 'lead-1' });
  }

  it('impl → lead', () => {
    const store = openStore('p-auth-1');
    buildChain(store);
    const resolver = roleParentResolver(store);
    expect(resolver.parentOf('impl-1')).toBe('lead-1');
  });

  it('lead → coord', () => {
    const store = openStore('p-auth-2');
    buildChain(store);
    const resolver = roleParentResolver(store);
    expect(resolver.parentOf('lead-1')).toBe('coord-1');
  });

  it('coord → @operator (STRUCTURAL — always, regardless of stored parent)', () => {
    const store = openStore('p-auth-3');
    buildChain(store);
    const resolver = roleParentResolver(store);
    expect(resolver.parentOf('coord-1')).toBe(OPERATOR);
  });

  it('@operator → throws (top of chain)', () => {
    const store = openStore('p-auth-4');
    const resolver = roleParentResolver(store);
    expect(() => resolver.parentOf(OPERATOR)).toThrow(/top of the escalation chain/);
  });

  it('unknown agent → throws (Principle 9)', () => {
    const store = openStore('p-auth-5');
    const resolver = roleParentResolver(store);
    expect(() => resolver.parentOf('ghost-99')).toThrow(/unknown agent/);
  });

  it('coordinator stored parent is ignored (structural edge, not the stored value)', () => {
    // Even if a legacy/corrupt coordinator row has "some-other-coord", the resolver must return
    // @operator. Use a direct fake roster so the production store can reject that invalid record.
    const resolver = roleParentResolver({
      getAgent: () => ({
        agentId: 'coord-alt',
        role: 'coordinator',
        parent: 'some-other-coord',
        registeredTs: 1,
      }),
    });
    expect(resolver.parentOf('coord-alt')).toBe(OPERATOR);
  });
});

// ── escalationDisposition — authority cut matrix ──────────────────────────────────────────────────

describe('escalationDisposition — authority cut matrix (AC-L6a-4)', () => {
  it('implementer always forwards', () => {
    const topics: EscalationTopic[] = [
      'how-to',
      'integration',
      'approach',
      'worker-rescope',
      'phase-scope',
      'spec-interpretation',
      'known-issue-ack',
      'spec-intent',
    ];
    for (const topic of topics) {
      expect(escalationDisposition('implementer', topic)).toBe('forward');
    }
  });

  it('lead resolves: how-to, integration, approach, worker-rescope', () => {
    expect(escalationDisposition('lead', 'how-to')).toBe('resolve');
    expect(escalationDisposition('lead', 'integration')).toBe('resolve');
    expect(escalationDisposition('lead', 'approach')).toBe('resolve');
    expect(escalationDisposition('lead', 'worker-rescope')).toBe('resolve');
  });

  it('lead forwards: phase-scope, spec-interpretation, known-issue-ack, spec-intent', () => {
    expect(escalationDisposition('lead', 'phase-scope')).toBe('forward');
    expect(escalationDisposition('lead', 'spec-interpretation')).toBe('forward');
    expect(escalationDisposition('lead', 'known-issue-ack')).toBe('forward');
    expect(escalationDisposition('lead', 'spec-intent')).toBe('forward');
  });

  it('coordinator resolves: all topics except spec-intent', () => {
    const coordResolves: EscalationTopic[] = [
      'how-to',
      'integration',
      'approach',
      'worker-rescope',
      'phase-scope',
      'spec-interpretation',
      'known-issue-ack',
    ];
    for (const topic of coordResolves) {
      expect(escalationDisposition('coordinator', topic)).toBe('resolve');
    }
  });

  it('coordinator forwards: spec-intent only', () => {
    expect(escalationDisposition('coordinator', 'spec-intent')).toBe('forward');
  });

  it('reviewer always forwards', () => {
    expect(escalationDisposition('reviewer', 'how-to')).toBe('forward');
    expect(escalationDisposition('reviewer', 'spec-intent')).toBe('forward');
  });

  it('researcher always forwards', () => {
    expect(escalationDisposition('researcher', 'how-to')).toBe('forward');
    expect(escalationDisposition('researcher', 'spec-intent')).toBe('forward');
  });
});

// ── lowestCompetentResolver — three canonical scenarios ──────────────────────────────────────────

describe('lowestCompetentResolver — three canonical scenarios (AC-L6a-4)', () => {
  function openStore(id: string): RosterStore {
    const s = openRosterStore(id);
    rosterStores.push(s);
    return s;
  }

  function buildDeps(store: RosterStore) {
    // impl → lead → coord → @operator (structural)
    store.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: OPERATOR });
    store.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
    store.recordAgent({ agentId: 'impl-1', role: 'implementer', parent: 'lead-1' });
    const resolver = roleParentResolver(store);
    return {
      resolver,
      roleOf: (id: string) => store.getAgent(id)?.role,
    };
  }

  it('topic how-to from implementer → resolves at lead (lead can answer)', () => {
    const store = openStore('p-lcr-1');
    const deps = buildDeps(store);
    expect(lowestCompetentResolver(deps, 'impl-1', 'how-to')).toBe('lead-1');
  });

  it('topic phase-scope from implementer → resolves at coordinator (lead forwards, coord resolves)', () => {
    const store = openStore('p-lcr-2');
    const deps = buildDeps(store);
    expect(lowestCompetentResolver(deps, 'impl-1', 'phase-scope')).toBe('coord-1');
  });

  it('topic spec-intent from implementer → resolves at @operator (everyone forwards)', () => {
    const store = openStore('p-lcr-3');
    const deps = buildDeps(store);
    expect(lowestCompetentResolver(deps, 'impl-1', 'spec-intent')).toBe(OPERATOR);
  });

  it('topic how-to from lead → resolves at lead itself', () => {
    const store = openStore('p-lcr-4');
    const deps = buildDeps(store);
    expect(lowestCompetentResolver(deps, 'lead-1', 'how-to')).toBe('lead-1');
  });

  it('topic spec-intent from coordinator → @operator (coordinator forwards spec-intent)', () => {
    const store = openStore('p-lcr-5');
    const deps = buildDeps(store);
    expect(lowestCompetentResolver(deps, 'coord-1', 'spec-intent')).toBe(OPERATOR);
  });

  it('unknown agent → throws (Principle 9)', () => {
    const store = openStore('p-lcr-6');
    buildDeps(store); // populate roster
    const resolver = roleParentResolver(store);
    const deps = { resolver, roleOf: (id: string) => store.getAgent(id)?.role };
    expect(() => lowestCompetentResolver(deps, 'ghost-99', 'how-to')).toThrow(/unknown agent/);
  });
});
