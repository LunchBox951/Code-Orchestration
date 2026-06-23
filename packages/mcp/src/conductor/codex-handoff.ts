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
/**
 * #155 — the env pointer for the ROUTED (non-kickoff) codex handoff. A SEPARATE file from the stable
 * kickoff handoff (#145): over-threshold routed mail must not be persisted to the predictable
 * kickoff.txt path, so it lands in routed.txt and is per-turn scrubbed by the engine.
 */
export const CODEX_ROUTED_HANDOFF_ENV = 'CO_ROUTED_HANDOFF';

const KICKOFF_HANDOFF_FILE = 'kickoff.txt';
const ROUTED_HANDOFF_FILE = 'routed.txt';

function agentPathSegment(agent: string): string {
  const segment = encodeURIComponent(agent);
  if (segment.length === 0 || segment === '.' || segment === '..') {
    throw new Error(`codex handoff: unsafe agent id '${agent}' for handoff path`);
  }
  return segment;
}

function codexHandoffRoot(identity: HostedIdentity): string {
  return resolve(join(projectDataDir(identity.projectId), 'handoffs'));
}

function codexHandoffDir(identity: HostedIdentity): string {
  const root = codexHandoffRoot(identity);
  const dir = resolve(join(root, agentPathSegment(identity.agent)));
  if (dir === root || !dir.startsWith(root + sep)) {
    throw new Error(`codex handoff: unsafe agent id '${identity.agent}' escapes handoff root`);
  }
  return dir;
}

function codexHandoffPath(identity: HostedIdentity, file: string): string {
  return join(codexHandoffDir(identity), file);
}

export function codexKickoffHandoffPath(identity: HostedIdentity): string {
  return codexHandoffPath(identity, KICKOFF_HANDOFF_FILE);
}

export function codexRoutedHandoffPath(identity: HostedIdentity): string {
  return codexHandoffPath(identity, ROUTED_HANDOFF_FILE);
}

export function codexKickoffHandoffPointer(): string {
  return `Read $${CODEX_KICKOFF_HANDOFF_ENV} in full and act on it now.`;
}

export function codexRoutedHandoffPointer(): string {
  return `Read $${CODEX_ROUTED_HANDOFF_ENV} in full and act on it now.`;
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
    throw new Error(`codex handoff: ${label} '${path}' must not be a symlink`);
  }
  if (!entry.isDirectory()) {
    throw new Error(`codex handoff: ${label} '${path}' is not a directory`);
  }
  chmodSync(path, 0o700);
}

function writeCodexHandoffFile(identity: HostedIdentity, file: string, body: string): string {
  const path = codexHandoffPath(identity, file);
  const root = codexHandoffRoot(identity);
  const dir = codexHandoffDir(identity);
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

function removeCodexHandoffFile(identity: HostedIdentity, file: string): void {
  const path = codexHandoffPath(identity, file);
  assertPrivateDirectory(codexHandoffRoot(identity), 'root directory');
  assertPrivateDirectory(codexHandoffDir(identity), 'agent directory');
  try {
    const entry = lstatSync(path);
    if (entry.isDirectory()) {
      throw new Error(`codex handoff: file '${path}' is a directory`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  unlinkSync(path);
}

export function writeCodexKickoffHandoff(identity: HostedIdentity, body: string): string {
  return writeCodexHandoffFile(identity, KICKOFF_HANDOFF_FILE, body);
}

export function removeCodexKickoffHandoff(identity: HostedIdentity): void {
  removeCodexHandoffFile(identity, KICKOFF_HANDOFF_FILE);
}

/**
 * #155 — persist an over-threshold ROUTED (non-kickoff) codex body to a SEPARATE per-agent handoff
 * file (routed.txt), with the same 0700 dir / 0600 file + O_NOFOLLOW hardening as the kickoff handoff.
 * Distinct from {@link writeCodexKickoffHandoff} so sensitive non-kickoff mail is never written to the
 * stable, predictable kickoff.txt path (#145); the engine scrubs routed.txt at turn end.
 */
export function writeCodexRoutedHandoff(identity: HostedIdentity, body: string): string {
  return writeCodexHandoffFile(identity, ROUTED_HANDOFF_FILE, body);
}

export function removeCodexRoutedHandoff(identity: HostedIdentity): void {
  removeCodexHandoffFile(identity, ROUTED_HANDOFF_FILE);
}
