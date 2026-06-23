import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDataDir } from '@co/core';
import type { HostedIdentity } from '../live-session-host.js';

export const CODEX_KICKOFF_HANDOFF_ENV = 'CO_KICKOFF_HANDOFF';

function agentPathSegment(agent: string): string {
  return encodeURIComponent(agent);
}

export function codexKickoffHandoffPath(identity: HostedIdentity): string {
  return join(
    projectDataDir(identity.projectId),
    'handoffs',
    agentPathSegment(identity.agent),
    'kickoff.txt',
  );
}

export function codexKickoffHandoffPointer(): string {
  return `Read $${CODEX_KICKOFF_HANDOFF_ENV} in full and act on it now.`;
}

export function writeCodexKickoffHandoff(identity: HostedIdentity, body: string): string {
  const path = codexKickoffHandoffPath(identity);
  const dir = join(
    projectDataDir(identity.projectId),
    'handoffs',
    agentPathSegment(identity.agent),
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
