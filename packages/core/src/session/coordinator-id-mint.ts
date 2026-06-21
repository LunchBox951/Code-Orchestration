import { openArchiveStore, type ArchiveStore } from '../archive/archive-store.js';
import { openRosterStore, type RosterStore } from '../roles/roster-store.js';
import type { ProjectId } from '../registry/registry.js';
import { coordinatorIdFromParts } from './coordinator-id.js';

const MAX_COORDINATOR_ID_MINT_ATTEMPTS = 16;

export interface CoordinatorIdMintDeps {
  readonly openArchive?: (projectId: ProjectId) => ArchiveStore;
  readonly openRoster?: (projectId: ProjectId) => RosterStore;
  readonly randomHex: () => string;
}

export function mintAvailableCoordinatorId(
  projectId: ProjectId,
  name: string,
  deps: CoordinatorIdMintDeps,
): string {
  const openArchive = deps.openArchive ?? openArchiveStore;
  const openRoster = deps.openRoster ?? openRosterStore;
  // Each store is opened inside the prior store's try so a throw from the SECOND open still closes
  // the first — opening both before the try would leak the archive handle if openRoster threw.
  const archive = openArchive(projectId);
  try {
    const roster = openRoster(projectId);
    try {
      const archivedBranches = new Set(archive.listRecords().map((rec) => rec.branch));
      for (let attempt = 0; attempt < MAX_COORDINATOR_ID_MINT_ATTEMPTS; attempt += 1) {
        const coordinatorId = coordinatorIdFromParts(name, deps.randomHex());
        if (
          roster.getAgent(coordinatorId) == null &&
          !archivedBranches.has(`co/${coordinatorId}`)
        ) {
          return coordinatorId;
        }
      }
    } finally {
      roster.close();
    }
  } finally {
    archive.close();
  }
  throw new Error(
    `coordinator id mint: exhausted ${MAX_COORDINATOR_ID_MINT_ATTEMPTS} attempts for '${name}'.`,
  );
}
