/**
 * Stage 14 · P1 (KEYSTONE) — the OPERATOR-ONLY `co-mcp start-session` verb (a thin adapter over the
 * `@co/core` {@link startCoordinatorSession} primitive).
 *
 * `co-mcp start-session <projectId> --name "Name" --prompt "…"`  OR
 * `co-mcp start-session <projectId> --name "Name" --spec <path>`
 *
 * It launches a ROOT coordinator (no warm parent) from a prompt OR a draft-spec file. Exactly one of
 * `--prompt` / `--spec` is required — both or neither FAILS LOUD (Principle 9). Like `co-mcp serve`,
 * this is an operator command the operator runs in a terminal; it is NOT an agent-callable MCP tool
 * (no agent can call it — Principle 4 + D4). It resolves/validates `projectId` against the registry the
 * same way `runServeConductor` does, then calls the core primitive and prints the launched root.
 *
 * All heavy logic (provision worktree → seed the actionable `clarify_request` → register roster
 * kickoff, mint NO session) lives in the core primitive; this verb only parses args, reads the spec
 * file when `--spec` is given, and prints the result. The daemon's cold-start (`daemon.ts`) then hosts
 * the registered-but-unhosted root on a tick and drives its first turn.
 */
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  mintAvailableCoordinatorId,
  openRegistry,
  startCoordinatorSession,
  type ArchiveStore,
  type ProjectRegistry,
  type RosterStore,
} from '@co/core';

/** Parsed `co-mcp start-session` arguments. Exactly one of `prompt` / `specPath` is set (validated). */
export interface StartSessionArgs {
  readonly projectId: string;
  readonly name: string;
  readonly prompt?: string;
  readonly specPath?: string;
}

/**
 * Parse `start-session <projectId> --name "Name" (--prompt "…" | --spec <path>)`. Fails loud (Principle 9) on a
 * missing project id, an unknown flag, a flag missing its value, or unless EXACTLY ONE of
 * `--prompt` / `--spec` is supplied (both or neither is rejected). Pure (no I/O) so it is unit-tested
 * directly.
 */
export function parseStartSessionArgs(argv: readonly string[]): StartSessionArgs {
  const [projectId, ...rest] = argv;
  if (projectId == null || projectId.trim().length === 0 || projectId.startsWith('--')) {
    throw new Error(
      'co-mcp start-session: a project id is required ' +
        '(usage: `co-mcp start-session <projectId> --name "Name" --prompt "…" | --spec <path>`).',
    );
  }
  let name: string | undefined;
  let prompt: string | undefined;
  let specPath: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--name' || flag === '--prompt' || flag === '--spec') {
      const value = rest[i + 1];
      if (value == null) {
        throw new Error(`co-mcp start-session: '${flag}' requires a value.`);
      }
      if (flag === '--name') name = value;
      else if (flag === '--prompt') prompt = value;
      else specPath = value;
      i += 1; // consume the value
    } else {
      throw new Error(
        `co-mcp start-session: unknown argument '${flag}' ` +
          '(expected `--name "Name"` plus `--prompt "…"` or `--spec <path>`).',
      );
    }
  }
  if (name == null || name.trim().length === 0) {
    throw new Error('co-mcp start-session: --name is required for a coordinator session.');
  }
  if ((prompt != null) === (specPath != null)) {
    throw new Error(
      'co-mcp start-session: exactly one of `--prompt` / `--spec` is required ' +
        '(Principle 9 — fail loud; a root coordinator is started from a prompt OR a draft spec).',
    );
  }
  return {
    projectId,
    name: name.trim(),
    ...(prompt != null ? { prompt } : {}),
    ...(specPath != null ? { specPath } : {}),
  };
}

/** Injectable seams for {@link runStartSessionCommand} (registry + spec read + output, for tests). */
export interface RunStartSessionDeps {
  readonly openArchive?: (projectId: string) => ArchiveStore;
  readonly openRegistry?: () => ProjectRegistry;
  readonly openRoster?: (projectId: string) => RosterStore;
  readonly readSpecFile?: (path: string) => string;
  readonly start?: typeof startCoordinatorSession;
  readonly randomHex?: () => string;
  readonly log?: (line: string) => void;
}

/**
 * The `co-mcp start-session` entry: parse args, resolve + validate the project id against the registry
 * (exactly like `runServeConductor`), read the spec file when `--spec` is given, then call the core
 * {@link startCoordinatorSession} primitive and print the launched root. Fails loud on an unknown
 * project id.
 */
export async function runStartSessionCommand(
  argv: readonly string[],
  deps: RunStartSessionDeps = {},
): Promise<void> {
  const { projectId, name, prompt, specPath } = parseStartSessionArgs(argv);
  const openRegistryFn = deps.openRegistry ?? openRegistry;
  const readSpecFile = deps.readSpecFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const start = deps.start ?? startCoordinatorSession;
  const randomHex = deps.randomHex ?? (() => randomBytes(3).toString('hex'));
  const log = deps.log ?? ((line: string) => console.error(line));

  const registry = openRegistryFn();
  let repoCwd: string | undefined;
  try {
    repoCwd = registry.pathFor(projectId) ?? undefined;
  } finally {
    registry.close();
  }
  if (repoCwd == null) {
    throw new Error(
      `co-mcp start-session: unknown project id '${projectId}'. Pass the registered project id for this repo.`,
    );
  }

  const specBody = specPath != null ? readSpecFile(specPath) : undefined;
  const coordinatorId = mintAvailableCoordinatorId(projectId, name, {
    randomHex,
    ...(deps.openArchive != null ? { openArchive: deps.openArchive } : {}),
    ...(deps.openRoster != null ? { openRoster: deps.openRoster } : {}),
  });
  const result = start({
    projectId,
    repoCwd,
    name,
    coordinatorId,
    ...(prompt != null ? { prompt } : {}),
    ...(specBody != null ? { specBody } : {}),
  });

  log(
    `co-mcp start-session: launched root coordinator '${result.coordinator}' ` +
      `on branch '${result.branch}' (worktree: ${result.worktreePath}). ` +
      'The Conductor daemon will cold-start it on its next tick.',
  );
}
