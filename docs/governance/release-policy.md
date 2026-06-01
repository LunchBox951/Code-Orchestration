# Release policy — PARKED

> Status: open (Principle 16 — decisions-deferred). Structure exists; policy does not.

Decided so far: a **two-track** model — `main` (stable, tagged) and `nightly` (integration,
auto-prerelease), with gated promotion `nightly` → `main`.

Still open (decide before wiring `release.yml`):

- Branch name: `nightly` vs `dev`/`develop`.
- Which branch is the GitHub default (affects PR-base ergonomics).
- Promotion cadence and who cuts releases.
- Versioning / prerelease scheme (semver tags; `-nightly.N` vs date-stamped).
- Publish tooling: **Changesets** (monorepo-native, explicit changelogs) vs **semantic-release**
  (fully automated, native `main`/`next` channels, weaker on monorepos).

Until resolved, `release.yml` is a documented placeholder and no packages are published
(all `private: true`).
