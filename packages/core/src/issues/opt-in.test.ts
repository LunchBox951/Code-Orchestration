import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfigStore } from '../config/config-store.js';
import {
  ISSUE_CAPTURE_KEY,
  ISSUE_PUBLISH_KEY,
  ISSUE_SELF_ASSIGN_KEY,
  layerIssueOptIns,
  resolveIssueOptIns,
} from './opt-in.js';

// L6b G — layered opt-in (specs-and-issues.md §"Layered opt-in"): capture (local) → publish
// (GitHub) → self-assign. Each more invasive, each its own switch, ALL OFF BY DEFAULT, and a
// later layer has effect only when every earlier layer is on (AC-L6b-G1).

const ORIGINAL_ENV = process.env;
let dataDir = '';

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDir = mkdtempSync(join(tmpdir(), 'co-issue-optin-'));
  process.env.CO_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('layerIssueOptIns — pure layering rule', () => {
  it('everything is OFF by default', () => {
    expect(layerIssueOptIns({})).toEqual({ capture: false, publish: false, selfAssign: false });
  });

  it('each layer enables independently when its predecessors are on', () => {
    expect(layerIssueOptIns({ capture: true })).toEqual({
      capture: true,
      publish: false,
      selfAssign: false,
    });
    expect(layerIssueOptIns({ capture: true, publish: true })).toEqual({
      capture: true,
      publish: true,
      selfAssign: false,
    });
    expect(layerIssueOptIns({ capture: true, publish: true, selfAssign: true })).toEqual({
      capture: true,
      publish: true,
      selfAssign: true,
    });
  });

  it('a later layer WITHOUT its predecessor has no effect (publish needs capture, etc.)', () => {
    expect(layerIssueOptIns({ publish: true })).toEqual({
      capture: false,
      publish: false,
      selfAssign: false,
    });
    expect(layerIssueOptIns({ capture: true, selfAssign: true })).toEqual({
      capture: true,
      publish: false,
      selfAssign: false,
    });
  });

  it('only the boolean true enables — truthy non-booleans stay OFF (a stranger repo never auto-files)', () => {
    expect(layerIssueOptIns({ capture: 'yes', publish: 1, selfAssign: 'true' })).toEqual({
      capture: false,
      publish: false,
      selfAssign: false,
    });
  });
});

describe('resolveIssueOptIns — config-cascade resolution', () => {
  it('returns all-off for a project with no opt-in config', () => {
    expect(resolveIssueOptIns('p-optin-defaults')).toEqual({
      capture: false,
      publish: false,
      selfAssign: false,
    });
  });

  it('reads the layered switches from the cascade (project override wins)', () => {
    const config = openConfigStore();
    try {
      config.setGlobal(ISSUE_CAPTURE_KEY, true);
      config.setProjectOverride('p-optin-cascade', ISSUE_PUBLISH_KEY, true);
      expect(resolveIssueOptIns('p-optin-cascade', config)).toEqual({
        capture: true,
        publish: true,
        selfAssign: false,
      });
      config.setProjectOverride('p-optin-cascade', ISSUE_SELF_ASSIGN_KEY, true);
      expect(resolveIssueOptIns('p-optin-cascade', config)).toEqual({
        capture: true,
        publish: true,
        selfAssign: true,
      });
    } finally {
      config.close();
    }
  });

  it('a project override can switch a globally-enabled layer back OFF', () => {
    const config = openConfigStore();
    try {
      config.setGlobal(ISSUE_CAPTURE_KEY, true);
      config.setGlobal(ISSUE_PUBLISH_KEY, true);
      config.setProjectOverride('p-optin-off', ISSUE_PUBLISH_KEY, false);
      expect(resolveIssueOptIns('p-optin-off', config)).toEqual({
        capture: true,
        publish: false,
        selfAssign: false,
      });
    } finally {
      config.close();
    }
  });
});
