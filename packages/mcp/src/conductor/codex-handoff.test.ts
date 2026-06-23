import { describe, expect, it } from 'vitest';
import type { HostedIdentity } from '../live-session-host.js';
import { codexKickoffHandoffPath } from './codex-handoff.js';

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
});
