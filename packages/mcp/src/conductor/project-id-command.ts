/**
 * Stage 14 · P5 — the OPERATOR-ONLY `co-mcp project-id` verb.
 *
 * `co-mcp project-id [repoPath]`  (default repoPath = cwd)
 *
 * Registers the repo path in the project registry (idempotent — returns the existing id if already
 * mapped) and prints ONLY the projectId to stdout, so the operator can use it directly:
 *
 *   co-mcp serve "$(co-mcp project-id)"
 *
 * Uses `register()` rather than read-only `resolve()` because there is no separate explicit
 * operator registration step — this verb IS the registration step (idempotent). Printing the id
 * after a re-registration is safe and returns the same stable id every time.
 *
 * OPERATOR-ONLY — never agent-callable (Principle 4 + D4). Lives in `@co/mcp` (co-mcp bin).
 */
import { resolve as resolvePath } from 'node:path';
import { openRegistry, type ProjectRegistry } from '@co/core';

/** Injectable seams for {@link runProjectIdCommand} (registry + output, for tests). */
export interface RunProjectIdDeps {
  readonly openRegistry?: () => ProjectRegistry;
  readonly cwd?: string;
  readonly print?: (line: string) => void;
}

/**
 * The `co-mcp project-id` entry: resolve the absolute repo path (argv[0] or cwd), register it
 * (idempotent), and print the projectId to stdout. `resolvePath()` guarantees an absolute path
 * before the registry call; `registry.register()` normalizes and validates it internally.
 */
export async function runProjectIdCommand(
  argv: readonly string[],
  deps: RunProjectIdDeps = {},
): Promise<void> {
  const openRegistryFn = deps.openRegistry ?? openRegistry;
  const cwd = deps.cwd ?? process.cwd();
  const print = deps.print ?? ((line: string) => process.stdout.write(line + '\n'));

  if (argv.length > 1) {
    throw new Error(
      `co-mcp project-id: expected at most one repoPath argument, got ${argv.length}. ` +
        'Usage: co-mcp project-id [repoPath]',
    );
  }

  const rawPath = argv[0] ?? cwd;
  const absPath = resolvePath(rawPath);

  const registry = openRegistryFn();
  let projectId: string;
  try {
    projectId = registry.register(absPath);
  } finally {
    registry.close();
  }

  print(projectId);
}
