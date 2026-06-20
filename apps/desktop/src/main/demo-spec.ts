import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StartSessionParams } from '@co/core';
import { desktopErrorMessage } from './desktop-errors.js';

/**
 * P-ON3 — "Start from demo spec" (AC-S15-6, the operator MERGE BAR: launch a coordinator from a
 * predesigned spec, no terminal).
 *
 * The predesigned on-ramp spec ships at repo-root `docs/demo-spec-co-improves-its-docs.md` and is
 * bundled into `dist/renderer/demo-spec.md` by `copy-renderer-assets.mjs`. `session:startFromDemoSpec`
 * reads that bundled file and starts a ROOT coordinator from its body via the already-plumbed
 * `startSession({ specBody })` path — the same primitive the free-form session form uses.
 *
 * The spec read is an injectable seam so the launch path is HEADLESS-testable (no real Electron, no
 * real `co-mcp serve`). Every failure is a NAMED, visible result (Principle 9): no project open, an
 * unreadable/missing spec, an empty spec, or a `startSession` rejection — never a blank or a hang.
 */

/** The minimal `startSession` surface this launch needs. `@co/mcp`'s `OperatorIpcClient` satisfies it. */
export interface StartSessionClient {
  startSession(params: StartSessionParams): Promise<unknown>;
}

export interface DemoSpecDeps {
  /** The live shell's operator-IPC client, or `null` when no project is open. Production: `controller.shell?.client`. */
  readonly client: StartSessionClient | null;
  /** Read the bundled demo spec as text. Injectable for tests; production: {@link readBundledDemoSpec}. */
  readonly readDemoSpec: () => string;
}

/** Resolve the bundled demo-spec path from the main bundle dir (`dist/main` → `dist/renderer/demo-spec.md`). */
export function bundledDemoSpecPath(mainDir: string): string {
  return join(mainDir, '../renderer/demo-spec.md');
}

/** Production reader: synchronously read the bundled demo spec as UTF-8. Throws (visibly) if missing/unreadable. */
export function readBundledDemoSpec(mainDir: string): string {
  return readFileSync(bundledDemoSpecPath(mainDir), 'utf8');
}

/**
 * Launch a coordinator from the bundled predesigned demo spec. Returns a visible `{ ok, error? }` for
 * every outcome rather than throwing: no project open, an unreadable spec, an empty spec, or a
 * `startSession` failure each surface a message the renderer can toast (Principle 9). On success the
 * exact spec body read from disk is passed through as `specBody`.
 */
export async function startFromDemoSpec(
  deps: DemoSpecDeps,
): Promise<{ ok: boolean; error?: string }> {
  if (deps.client == null) {
    return { ok: false, error: 'No project is open — use "Open project" to choose one.' };
  }

  let specBody: string;
  try {
    specBody = deps.readDemoSpec();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Could not read the bundled demo spec: ${msg}` };
  }

  if (specBody.trim().length === 0) {
    return { ok: false, error: 'The bundled demo spec is empty.' };
  }

  try {
    await deps.client.startSession({ specBody });
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: desktopErrorMessage(e, 'start from the demo spec') };
  }
}
