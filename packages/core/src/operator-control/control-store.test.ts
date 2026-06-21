import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverProjectStore } from '../replay/recovery.js';
import { openAgentControlStore } from './control-store.js';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'co-control-store-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
});

describe('AgentControlStore — durable stopped suppression', () => {
  it('persists stopped state across reopen and recovery until unstop clears it', () => {
    const projectId = 'project-control';
    const control = openAgentControlStore(projectId);
    try {
      expect(control.isStopped('coord-root')).toBe(false);
      control.recordStopped('coord-root');
      expect(control.isStopped('coord-root')).toBe(true);
      expect(control.listStopped()).toEqual(['coord-root']);
    } finally {
      control.close();
    }

    recoverProjectStore(projectId);

    const reopened = openAgentControlStore(projectId);
    try {
      expect(reopened.isStopped('coord-root')).toBe(true);
      reopened.clearStopped('coord-root');
      expect(reopened.isStopped('coord-root')).toBe(false);
      expect(reopened.listStopped()).toEqual([]);
    } finally {
      reopened.close();
    }
  });
});
