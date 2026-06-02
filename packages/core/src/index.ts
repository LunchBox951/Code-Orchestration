export { assertNever } from './assert-never.js';

// Part C.1 store contract (LOCKED types) + program-data paths + store openers.
export type { StoredEvent, NewEvent, StoreTx, Store } from './store/types.js';
export { dataRoot, projectDataDir } from './store/paths.js';
export { openProjectStore, openGlobalStore } from './store/sqlite-store.js';

/** Workspace-internal package identity; proves cross-package imports resolve. */
export const CORE_PACKAGE = '@co/core' as const;
