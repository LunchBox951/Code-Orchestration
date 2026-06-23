import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectDataDir } from '@co/core';
import type { HostedIdentity } from '../live-session-host.js';
import {
  codexKickoffHandoffPath,
  codexRoutedHandoffPath,
  removeCodexRoutedHandoff,
  writeCodexKickoffHandoff,
  writeCodexRoutedHandoff,
} from './codex-handoff.js';

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

  it('keeps slash-bearing agent ids in one encoded handoff leaf', () => {
    const root = join(projectDataDir('p-handoff-path'), 'handoffs');
    for (const agent of ['../outside', 'impl/../other']) {
      const target = identity(agent);
      const handoffPath = codexKickoffHandoffPath(target);
      expect(dirname(handoffPath)).toBe(join(root, encodeURIComponent(agent)));

      writeCodexKickoffHandoff(target, `kickoff for ${agent}`);

      expect(readFileSync(handoffPath, 'utf8')).toBe(`kickoff for ${agent}`);
      expect(existsSync(join(root, 'outside', 'kickoff.txt'))).toBe(false);
      expect(existsSync(join(root, 'other', 'kickoff.txt'))).toBe(false);
    }
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

  it('repairs lax existing handoff directory and file modes', () => {
    const target = identity('impl-cx');
    const handoffPath = codexKickoffHandoffPath(target);
    const root = dirname(dirname(handoffPath));
    const agentDir = dirname(handoffPath);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o777);
    chmodSync(agentDir, 0o777);
    writeFileSync(handoffPath, 'old', { encoding: 'utf8', mode: 0o600 });
    chmodSync(handoffPath, 0o666);

    writeCodexKickoffHandoff(target, 'fresh kickoff');

    expect(readFileSync(handoffPath, 'utf8')).toBe('fresh kickoff');
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(agentDir).mode & 0o777).toBe(0o700);
    expect(statSync(handoffPath).mode & 0o777).toBe(0o600);
  });
});

// ── #155 — ROUTED handoff: a SEPARATE file from kickoff.txt, same 0700/0600 + O_NOFOLLOW hardening ──
describe('codex routed handoff', () => {
  it('writes the routed body to a SEPARATE routed.txt (not kickoff.txt) with 0700/0600 modes', () => {
    const target = identity('impl-cx');
    const routedPath = codexRoutedHandoffPath(target);
    const kickoffPath = codexKickoffHandoffPath(target);
    expect(routedPath).not.toBe(kickoffPath);
    expect(dirname(routedPath)).toBe(dirname(kickoffPath));

    const written = writeCodexRoutedHandoff(target, 'x'.repeat(400));

    expect(written).toBe(routedPath);
    expect(readFileSync(routedPath, 'utf8')).toBe('x'.repeat(400));
    expect(statSync(dirname(routedPath)).mode & 0o777).toBe(0o700);
    expect(statSync(routedPath).mode & 0o777).toBe(0o600);
    // The kickoff file is NEVER written for routed mail (#145 stable-path guarantee).
    expect(existsSync(kickoffPath)).toBe(false);
  });

  it('round-trips write then remove (scrub leaves no routed file)', () => {
    const target = identity('impl-cx');
    const routedPath = codexRoutedHandoffPath(target);
    writeCodexRoutedHandoff(target, 'routed body');
    expect(existsSync(routedPath)).toBe(true);
    removeCodexRoutedHandoff(target);
    expect(existsSync(routedPath)).toBe(false);
    // Removing an already-absent routed file is a no-op (idempotent scrub).
    expect(() => removeCodexRoutedHandoff(target)).not.toThrow();
  });

  it('rejects dot-segment agent ids before building a routed path', () => {
    expect(() => codexRoutedHandoffPath(identity('.'))).toThrow(/unsafe agent id/i);
    expect(() => codexRoutedHandoffPath(identity('..'))).toThrow(/unsafe agent id/i);
  });

  it('rejects a symlinked agent handoff directory for the routed file', () => {
    const target = identity('impl-cx');
    const routedPath = codexRoutedHandoffPath(target);
    const handoffRoot = dirname(dirname(routedPath));
    const outside = mkdtempSync(join(tmpdir(), 'co-codex-routed-handoff-outside-'));
    dataDirs.push(outside);
    mkdirSync(handoffRoot, { recursive: true, mode: 0o700 });
    symlinkSync(outside, dirname(routedPath), 'dir');

    expect(() => writeCodexRoutedHandoff(target, 'secret routed')).toThrow(/symlink/i);
    expect(existsSync(join(outside, 'routed.txt'))).toBe(false);
  });

  it('does not follow a symlinked routed file', () => {
    const target = identity('impl-cx');
    const routedPath = codexRoutedHandoffPath(target);
    const outsideFile = join(projectDataDir(target.projectId), 'routed-outside.txt');
    mkdirSync(dirname(routedPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(outsideFile), { recursive: true, mode: 0o700 });
    writeFileSync(outsideFile, 'outside', { encoding: 'utf8', mode: 0o600 });
    symlinkSync(outsideFile, routedPath);

    expect(() => writeCodexRoutedHandoff(target, 'secret routed')).toThrow(
      /symbolic link|symlink|ELOOP|too many/i,
    );
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside');
  });
});
