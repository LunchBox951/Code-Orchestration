import { assertNever } from '../assert-never.js';
import type { Provider } from './usage-source.js';

/** Default Claude account label when provider metadata does not refine it. */
export const CLAUDE_DEFAULT_ACCOUNT = 'claude:max';

/** Default Codex account label when provider metadata does not refine it. */
export const CODEX_DEFAULT_ACCOUNT = 'codex:pro';

/** The `source` tag the startup seed writes, distinguishable from a real provider read. */
export const ACCOUNT_STATUS_SEED_SOURCE = 'seed' as const;

/** The default per-account label a provider maps to (per-account tracking, Principle 13). */
export function accountForProvider(provider: Provider): string {
  switch (provider) {
    case 'claude':
      return CLAUDE_DEFAULT_ACCOUNT;
    case 'codex':
      return CODEX_DEFAULT_ACCOUNT;
    default:
      return assertNever(provider);
  }
}
