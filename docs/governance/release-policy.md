# Release policy — branch model DECIDED; release tooling still PARKED

> Branch model resolved 2026-06-01. Release *tooling* and versioning remain open
> (Principle 16 — decisions-deferred).

**Branch model (decided):**

- **`main`** — stable, tagged releases only. Updated **solely by a gated promotion PR from `dev`**
  (the strict gate; review + green required). No direct pushes.
- **`dev`** — the integration line and the **GitHub default branch**. Feature/phase PRs land here
  after review (the looser gate).
- **`nightly`** — a prerelease *channel* cut from `dev` (a release cadence, not a long-lived branch).
- Flow: feature branch → PR → **`dev`** → gated promotion PR → **`main`**. Mirrors `co merge`
  (into `dev`) then `co pr-merge` (promote to `main`); the blocker bar tightens from `dev` to `main`.

**Still open (Principle 16 — decide before wiring `release.yml`):**

- Promotion cadence and who cuts releases.
- Versioning / prerelease scheme (semver tags; `-nightly.N` vs date-stamped).
- Publish tooling: **Changesets** (monorepo-native, explicit changelogs) vs **semantic-release**
  (fully automated, native channels, weaker on monorepos).

Until those resolve, `release.yml` is a documented placeholder and no packages are published
(all `private: true`).
