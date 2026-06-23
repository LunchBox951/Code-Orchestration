import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
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

function codexKickoffHandoffDir(identity: HostedIdentity): string {
  const root = resolve(join(projectDataDir(identity.projectId), 'handoffs'));
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

export function writeCodexKickoffHandoff(identity: HostedIdentity, body: string): string {
  const path = codexKickoffHandoffPath(identity);
  const dir = codexKickoffHandoffDir(identity);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
