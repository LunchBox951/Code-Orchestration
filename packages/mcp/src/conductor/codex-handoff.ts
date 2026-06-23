import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { projectDataDir } from '@co/core';
import type { HostedIdentity } from '../live-session-host.js';

export const CODEX_KICKOFF_HANDOFF_ENV = 'CO_KICKOFF_HANDOFF';

function agentPathSegment(agent: string): string {
  const segment = encodeURIComponent(agent);
  if (segment.length === 0 || segment === '.' || segment === '..') {
    throw new Error(`codex kickoff handoff: unsafe agent id '${agent}' for handoff path`);
  }
  return segment;
}

function codexKickoffHandoffRoot(identity: HostedIdentity): string {
  return resolve(join(projectDataDir(identity.projectId), 'handoffs'));
}

function codexKickoffHandoffDir(identity: HostedIdentity): string {
  const root = codexKickoffHandoffRoot(identity);
  const dir = resolve(join(root, agentPathSegment(identity.agent)));
  if (dir === root || !dir.startsWith(root + sep)) {
    throw new Error(
      `codex kickoff handoff: unsafe agent id '${identity.agent}' escapes handoff root`,
    );
  }
  return dir;
}

export function codexKickoffHandoffPath(identity: HostedIdentity): string {
  return join(codexKickoffHandoffDir(identity), 'kickoff.txt');
}

export function codexKickoffHandoffPointer(): string {
  return `Read $${CODEX_KICKOFF_HANDOFF_ENV} in full and act on it now.`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function ensurePrivateDirectory(path: string, label: string, recursive: boolean): void {
  try {
    mkdirSync(path, { recursive, mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
  }
  assertPrivateDirectory(path, label);
}

function assertPrivateDirectory(path: string, label: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    throw new Error(`codex kickoff handoff: ${label} '${path}' must not be a symlink`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`codex kickoff handoff: ${label} '${path}' is not a directory`);
  }
  chmodSync(path, 0o700);
}

export function writeCodexKickoffHandoff(identity: HostedIdentity, body: string): string {
  const path = codexKickoffHandoffPath(identity);
  const root = codexKickoffHandoffRoot(identity);
  const dir = codexKickoffHandoffDir(identity);
  ensurePrivateDirectory(root, 'root directory', true);
  ensurePrivateDirectory(dir, 'agent directory', false);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, body, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
  return path;
}

export function removeCodexKickoffHandoff(identity: HostedIdentity): void {
  const path = codexKickoffHandoffPath(identity);
  assertPrivateDirectory(codexKickoffHandoffRoot(identity), 'root directory');
  assertPrivateDirectory(codexKickoffHandoffDir(identity), 'agent directory');
  try {
    const entry = lstatSync(path);
    if (entry.isDirectory()) {
      throw new Error(`codex kickoff handoff: file '${path}' is a directory`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  unlinkSync(path);
}
