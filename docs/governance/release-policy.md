# Release Policy

> Branch model resolved 2026-06-01. Linux AppImage release automation is wired;
> macOS/Windows installers, signing, package publishing, and semver versioning remain deferred
> (Principle 16 — decisions-deferred).

## Branches And Channels

- **`dev`** — the integration line, GitHub default branch, and source for the nightly channel.
  Feature/phase PRs land here after review. Experimental work may live here while it proves out.
- **`release/*`** — selective stabilization branches cut from current `main`. Maintainers
  cherry-pick the tested `dev` changes intended for stable release, leaving unrelated or early work
  behind.
- **`main`** — stable, tagged releases only. Updated solely by a gated promotion PR from
  same-repository `release/*`; no direct pushes.
- **`nightly`** — a moving GitHub prerelease built from `dev` at 05:00 UTC.
- **`stable`** — GitHub releases built from `main` after CI passes. Each stable release gets a
  unique `stable-YYYYMMDD-<sha>` tag, and the moving `stable` tag points at the newest stable commit.

## Promotion Flow

1. Feature branch → PR → `dev`.
2. Nightly AppImage publishes from `dev`, giving integration changes time to run in public.
3. Cut `release/YYYY-MM-DD` from current `main`.
4. Cherry-pick only the tested changes selected for stable from `dev` into the release branch.
5. Open `release/*` → `main`.
6. The main gate requires green CI, `pnpm audit --audit-level high`, current `main` ancestry,
   patch-equivalence to `dev`, and a 24-hour soak on the release branch head commit.
7. Merge to `main`; the stable release workflow publishes the Linux AppImage for that exact commit.

This keeps the nightly channel fast while avoiding all-or-nothing promotion from `dev` to `main`.
The blocker bar tightens toward production (Principle 7 — `gated-by-default`; `RG-2`).

## Download Surface

- Nightly users download the latest prerelease asset: `co-nightly-linux-x64.AppImage`.
- Stable users download the latest stable asset: `co-stable-linux-x64.AppImage`.
- Linux AppImage is the only automated installer artifact for now. Cross-platform packaging and code
  signing are future work, not hidden requirements of the current gate.

## Required GitHub Settings

Repository settings must enforce what YAML cannot fully guarantee:

- `dev`: require pull requests, require `CI / quality-gate`, block force pushes.
- `main`: require pull requests, require `CI / quality-gate`, `CI / stable-audit`, and all
  `Main merge policy` jobs; block force pushes and direct pushes.
- Tags `nightly` and `stable` must allow `GITHUB_TOKEN` updates from the release workflow, or the
  release workflow needs an equivalent repo-scoped token.

## Critical Security Soak Bypass

The 24-hour soak can be skipped only for critical security promotions by applying the
`security:critical` PR label. That label does **not** skip CI, audit, same-repository `release/*`
source validation, current-`main` ancestry, or the `dev` patch-equivalence check.

Use the label only when delaying stable release would expose users to an active critical security
risk. Remove it after the emergency release PR is closed or merged if it was applied only for that
promotion.
