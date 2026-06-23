import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectDataDir } from '@co/core';
import type { HostedIdentity } from '../live-session-host.js';
import { codexKickoffHandoffPath, writeCodexKickoffHandoff } from './codex-handoff.js';

const ORIGINAL_ENV = process.env;
const dataDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  const dir = mkdtempSync(join(tmpdir(), 'co-codex-handoff-'));
  process.env.CO_DATA_DIR = dir;
  dataDirs.push(dir);
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function identity(agent: string): HostedIdentity {
  return {
    agent,
    role: 'implementer',
    parent: 'lead-1',
    pane: `pane-${agent}`,
    projectId: 'p-handoff-path',
    cwd: '/worktree',
    provider: 'codex',
    resume: { provider: 'codex', codexHome: '/codex-home' },
  };
}

describe('codex kickoff handoff path', () => {
  it('rejects dot-segment agent ids before building a program-data path', () => {
    expect(() => codexKickoffHandoffPath(identity('.'))).toThrow(/unsafe agent id/i);
    expect(() => codexKickoffHandoffPath(identity('..'))).toThrow(/unsafe agent id/i);
  });

  it('rejects a symlinked agent handoff directory', () => {
    const target = identity('impl-cx');
    const handoffPath = codexKickoffHandoffPath(target);
    const handoffRoot = dirname(dirname(handoffPath));
    const outside = mkdtempSync(join(tmpdir(), 'co-codex-handoff-outside-'));
    dataDirs.push(outside);
    mkdirSync(handoffRoot, { recursive: true, mode: 0o700 });
    symlinkSync(outside, dirname(handoffPath), 'dir');

    expect(() => writeCodexKickoffHandoff(target, 'secret kickoff')).toThrow(/symlink/i);
    expect(existsSync(join(outside, 'kickoff.txt'))).toBe(false);
  });

  it('does not follow a symlinked kickoff file', () => {
    const target = identity('impl-cx');
    const handoffPath = codexKickoffHandoffPath(target);
    const outsideFile = join(projectDataDir(target.projectId), 'outside.txt');
    mkdirSync(dirname(handoffPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(outsideFile), { recursive: true, mode: 0o700 });
    writeFileSync(outsideFile, 'outside', { encoding: 'utf8', mode: 0o600 });
    symlinkSync(outsideFile, handoffPath);

    expect(() => writeCodexKickoffHandoff(target, 'secret kickoff')).toThrow(
      /symbolic link|symlink|ELOOP|too many/i,
    );
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside');
  });
});
