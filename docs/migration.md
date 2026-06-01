# Migration: removing the prototype footprint

The Claude-Orchestrator **prototype** built this repository and left a temporary footprint:
`.co/`, `.claude/`, `.codex/` (see the design spec §3 and the native-memory files). Tracked
parts: `.co/.gitignore`, `.co/specs/`, `.co/plans/`, `.co/issues/`. Everything else is ignored.

A second, smaller residue is the **prototype-era root docs** — `PORTING-CO.md`, `PRINCIPLES.md`,
`.goals/`, `.research/`. Phase 2 _copies_ their content into `docs/` (as `docs/README.md`,
`docs/principles.md`, the `docs/architecture/*` corpus, and `docs/research/*`), but the originals
deliberately stay at the repo root until this teardown so nothing dangles mid-migration.

When `co` can self-host (reads specs/state from its own program-data, no `.co/` dependency),
perform the teardown as **one gated PR** `nightly` → `main`, tracked by the `migration` issue:

1. Confirm `co` no longer depends on `.co/` for any spec/plan/state.
2. Remove the runtime footprint (tracked + on-disk):
   ```bash
   git rm -r --quiet .co
   rm -rf .claude .codex
   ```
3. Remove the migrated prototype-era root docs (their content now lives under `docs/`):
   ```bash
   git rm -r --quiet PORTING-CO.md PRINCIPLES.md .goals .research
   ```
4. Delete the `PROTOTYPE FOOTPRINT` block from `.gitignore`.
5. Drop the now-dangling prototype entries from `.prettierignore` (`.co/`, `.claude/`, `.codex/`,
   `.goals/`, `.research/`, `PORTING-CO.md`, `PRINCIPLES.md`) since those paths no longer exist.
6. Remove the "Prototype footprint (temporary)" section from `AGENTS.md` and `CLAUDE.md`.
7. (Optional) squash/rewrite history if a truly pristine record is wanted — deferred, not required.
8. Archive `docs/v1-acceptance-criteria.md` — retiring the prototype _is_ the v1 bar (`SH-3`), so
   reaching this checklist means §A of that doc is met. Keep it as the historical v1 record (or seed
   a v2 acceptance doc).
9. Open the PR, let it pass the gate, promote to `main`.
