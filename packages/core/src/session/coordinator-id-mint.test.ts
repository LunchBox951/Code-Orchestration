import { describe, expect, it } from 'vitest';
import type { ArchiveStore } from '../archive/archive-store.js';
import type { RosterStore } from '../roles/roster-store.js';
import { mintAvailableCoordinatorId } from './coordinator-id-mint.js';

describe('mintAvailableCoordinatorId', () => {
  it('re-rolls when a candidate collides with the live roster', () => {
    const suffixes = ['aaaaaa', 'bbbbbb'];
    const id = mintAvailableCoordinatorId('proj', 'auth refactor', {
      openArchive: () =>
        ({
          listRecords: () => [],
          close: () => {},
        }) as unknown as ArchiveStore,
      openRoster: () =>
        ({
          getAgent: (agentId: string) =>
            agentId === 'coord-auth-refactor-aaaaaa' ? { agentId } : undefined,
          close: () => {},
        }) as unknown as RosterStore,
      randomHex: () => suffixes.shift() ?? 'cccccc',
    });

    expect(id).toBe('coord-auth-refactor-bbbbbb');
  });

  it('re-rolls when a candidate collides with an archived branch', () => {
    const suffixes = ['aaaaaa', 'bbbbbb'];
    const id = mintAvailableCoordinatorId('proj', 'auth refactor', {
      openArchive: () =>
        ({
          listRecords: () => [
            {
              id: 'co/coord-auth-refactor-aaaaaa',
              name: 'auth refactor',
              branch: 'co/coord-auth-refactor-aaaaaa',
              baseRef: 'main',
              deletedAt: 1,
              expiresAt: 2,
            },
          ],
          close: () => {},
        }) as unknown as ArchiveStore,
      openRoster: () =>
        ({
          getAgent: () => undefined,
          close: () => {},
        }) as unknown as RosterStore,
      randomHex: () => suffixes.shift() ?? 'cccccc',
    });

    expect(id).toBe('coord-auth-refactor-bbbbbb');
  });
});
