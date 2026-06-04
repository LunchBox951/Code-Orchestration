/**
 * L4 Phase 6 — the GATED LOCAL LIVE E2E (spec §5 Phase 6; AC7). This is the one test that, when creds
 * are present AND the explicit opt-in {@link CO_LIVE_E2E_ENV}=1 is set, runs the REAL adapters against
 * the REAL host and asserts it retrieves REAL usage/limits for BOTH Claude (Max) and Codex (pro) —
 * NON-MOCKED. Otherwise (the sandbox case, and GitHub CI) it SKIPS LOUDLY: it never fails and never
 * mock-passes. The host-side run is escalated by the Lead to the coordinator; it is NOT executed here.
 *
 * It stays out of the default hermetic suite by construction: `describe.skipIf` gates the live block on
 * the opt-in, and the live `read()` calls (the only I/O) live INSIDE those blocks — so collecting this
 * file under default `pnpm test` does zero network / process / disk work. The always-on guard below
 * asserts the gate is OFF without the opt-in (the "verify it SKIPS" proof).
 */

import { describe, it, expect } from 'vitest';
import { createProviderUsageSource, isLiveE2EEnabled, CO_LIVE_E2E_ENV } from './provider-source.js';

const live = isLiveE2EEnabled();

describe('gated live E2E — skip gate (hermetic, always runs)', () => {
  it(`is OFF without ${CO_LIVE_E2E_ENV} — the live suite below SKIPS (set ${CO_LIVE_E2E_ENV}=1 + creds to run)`, () => {
    // In the sandbox / CI the opt-in is absent, so the real-host suite is skipped, never failed/mocked.
    expect(isLiveE2EEnabled({})).toBe(false);
    expect(isLiveE2EEnabled({ [CO_LIVE_E2E_ENV]: '1' })).toBe(true);
  });
});

describe.skipIf(!live)(
  `LIVE E2E [skipped unless ${CO_LIVE_E2E_ENV}=1 + creds]: REAL Claude (Max) + Codex (pro) usage, non-mocked`,
  () => {
    it('retrieves REAL Claude (Max) usage/limits via the real OAuth usage adapter', async () => {
      const source = createProviderUsageSource('claude', {
        enableIdleUsageRead: true,
        readStatusLine: () => Promise.resolve({}),
      });
      const snap = await source.read('claude');
      expect(snap.provider).toBe('claude');
      expect(snap.available).toBe(true);
      expect(snap.source).toBe('oauth-usage');
      expect(snap.windows.length).toBeGreaterThan(0);
      for (const window of snap.windows) {
        expect(typeof window.used_pct).toBe('number');
        expect(Number.isNaN(Date.parse(window.reset_at))).toBe(false);
      }
    }, 30_000);

    it('retrieves REAL Codex (pro) usage/limits via the real sqlite adapter', async () => {
      const source = createProviderUsageSource('codex'); // real seams — NO fixtures
      const snap = await source.read('codex');
      expect(snap.provider).toBe('codex');
      expect(snap.available).toBe(true);
      expect(snap.windows.length).toBeGreaterThan(0);
      for (const window of snap.windows) {
        expect(typeof window.used_pct).toBe('number');
        expect(Number.isNaN(Date.parse(window.reset_at))).toBe(false);
      }
    }, 30_000);
  },
);
