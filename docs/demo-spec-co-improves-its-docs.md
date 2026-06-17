# co improves its own docs: add a product CLI command reference

## Goal

Write `docs/cli-reference.md` — a concise operator cheat-sheet for the product `co` CLI. The
current docs mention individual commands in passing but offer no single place where an operator can
scan what verbs exist and what each one does. This spec closes that gap with a single small,
self-contained file.

## Context

The product `co` CLI is defined in `packages/cli/src/run.ts` (the `HELP_TEXT` and subcommand
dispatch table are authoritative). The prototype `co` command the harness uses internally is **not**
the product CLI — the reference must document only what an operator of the built product would type.

The existing docs (`docs/alpha-quickstart.md`, `docs/sh1-runbook.md`) reference individual commands
inline; this file is the companion reference, not a replacement.

## Scope

**New file only:** `docs/cli-reference.md`

Do not modify any other file. The CLI reference is additive; nothing else needs to change to satisfy
this spec.

## What the file must contain

1. **One table or list per top-level `co` subcommand** — verb, one-line description, key
   flags/args. Pull the descriptions directly from `run.ts` HELP_TEXT; do not invent or paraphrase
   beyond what the source says.
2. **One table or list for `co-mcp` verbs** (`project-id`, `serve`, `start-session`) with the same
   format.
3. **A short preamble** (2–4 sentences) explaining that this is the product CLI reference and
   pointing to `docs/alpha-quickstart.md` for step-by-step flows.
4. **No terminal-session examples** — the quickstart already covers those. Flags and one-liners are
   enough here.

The file must be accurate to the source; a command that does not appear in `run.ts` must not appear
here.

## Acceptance criteria

- `docs/cli-reference.md` exists and is committed.
- Every verb listed in `co help` / `run.ts` HELP_TEXT appears in the reference; no extra verbs are
  invented.
- Every verb listed in `co-mcp --help` appears in the reference; no extras.
- The preamble links to `docs/alpha-quickstart.md`.
- `pnpm format:check` passes for the tracked product tree. Because `docs/` is currently
  prettier-ignored, the reviewer must also inspect `docs/cli-reference.md` directly for readable
  Markdown formatting.
- Full 5-command gate green (`pnpm test · pnpm lint · pnpm typecheck · pnpm build ·
  pnpm format:check`).

This spec ladders to **MC-3** (`v1-acceptance-criteria.md`): the protocol is self-describing —
`orient` teaches workflow, schemas teach syntax, and this reference teaches the operator surface
(`co` + `co-mcp`) so operators never have to read source to know what commands exist.

## Implementation notes for the coordinator

- Assign one implementer to this task; it is a single-file docs-only change.
- The implementer should read `packages/cli/src/run.ts` to extract the authoritative command list
  before writing; do not guess at command names.
- No phases beyond a single implement → review → merge cycle are needed.
- DCO sign-off required on every commit (`git commit -s`).
- Conventional Commits: `docs: add product CLI command reference`.
