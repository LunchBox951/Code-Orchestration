import type { ProjectId, ProjectRegistry } from '@co/core';
import type { AppShell } from './app-shell.js';
import type { DaemonStatus } from './daemon-supervisor.js';

/**
 * P-ON2 — the in-app "Open project" on-ramp.
 *
 * This controller owns the per-project lifecycle the app used to inline in `index.ts`: tear down the
 * live shell + daemon, build a fresh supervisor + shell for the chosen project, start the daemon BEFORE
 * the shell connects, and surface the current project to the renderer. It removes the
 * `CO_PROJECT_ID`-env-only constraint — the window can come up with NO project and let the operator pick
 * a directory (the real on-ramp).
 *
 * Every external effect is an INJECTABLE seam (directory picker / registry / supervisor + shell
 * factories / renderer sinks) so the register → openProject path is testable HEADLESSLY — no real
 * Electron dialog, no real `co-mcp serve`, no real registry write. `index.ts` wires the production
 * defaults (electron `dialog`, `openRegistry`, `createDaemonSupervisor`, `createAppShell`). The whole
 * open path is purely LOCAL (registry write + daemon spawn) so it works offline for any repo (SH-4).
 */

/** The minimal daemon-supervisor surface this controller drives. {@link DaemonSupervisor} satisfies it. */
export interface SupervisorLike {
  /** Spawn + health-wait the daemon for `projectId`; also the idempotent re-arm ("Retry"). */
  start(projectId: ProjectId): Promise<DaemonStatus>;
  /** Stop the daemon and disarm restart. */
  stop(): Promise<void>;
  /** A human-facing reason accompanying `restarting`/`failed`. */
  readonly detail: string | null;
}

/** The operator-visible daemon lifecycle status + detail, pushed to the renderer's header badge. */
export interface DaemonStatusPayload {
  readonly status: DaemonStatus;
  readonly detail: string | null;
}

/** Which project the app currently has open (surfaced in the renderer top bar). `null` = no project open. */
export type CurrentProjectState = {
  readonly projectId: ProjectId;
  readonly path: string | null;
} | null;

/** Injectable seams. Production wires the real electron/registry/supervisor/shell implementations in `index.ts`. */
export interface ProjectControllerDeps {
  /** Build a fresh daemon supervisor for a project. Production: `createDaemonSupervisor`. */
  readonly createSupervisor: (opts: { onStatus: (status: DaemonStatus) => void }) => SupervisorLike;
  /** Build a fresh app shell bound to `projectId`. Production: `createAppShell` with the renderer-push callbacks. */
  readonly createShell: (projectId: ProjectId) => AppShell;
  /** Open the `@co/core` project registry. Production: `openRegistry`. Injectable so tests fake registration. */
  readonly openRegistry: () => ProjectRegistry;
  /** Show the OS directory picker; resolve to the chosen ABSOLUTE dir, or `null` on cancel. Production: electron `dialog`. */
  readonly pickDirectory: () => Promise<string | null>;
  /** Push the daemon lifecycle status to the renderer badge. */
  readonly onDaemonStatus: (payload: DaemonStatusPayload) => void;
  /** Push the current-project state to the renderer top bar (`null` = no project open). */
  readonly onCurrentProject: (state: CurrentProjectState) => void;
  /** Surface a user-visible error (Principle 9 — a register/open failure must never be swallowed). */
  readonly onError: (message: string) => void;
}

export interface ProjectController {
  /** The live app shell (for IPC routing in `index.ts`), or `null` when no project is open. */
  readonly shell: AppShell | null;
  /** The latest daemon status payload (for a renderer-load re-push), or `null` before any project opens. */
  readonly latestDaemonStatus: DaemonStatusPayload | null;
  /** The current-project state (for a renderer-load re-push). */
  readonly currentProject: CurrentProjectState;
  /**
   * Open `projectId`: tear down any current project (daemon then shell), build a fresh supervisor + shell,
   * start the daemon before the shell, and surface the project. `path` is known from the picker; omit it to
   * resolve it from the registry.
   */
  openProject(projectId: ProjectId, path?: string | null): Promise<void>;
  /** Show the directory picker, register the chosen dir, and open it. Cancel = no-op. Failures are visible. */
  pickAndOpenProject(): Promise<void>;
  /** Surface the "no project open" empty state (the on-ramp), optionally with a visible error. */
  showNoProject(error?: string): void;
  /** Re-arm the current daemon — the operator "Retry" path. No-op (visible error) when no project is open. */
  retryDaemon(): Promise<{ ok: boolean; error?: string }>;
  /** Stop the daemon then close the shell (the inverse of the open order) — the app-quit path. */
  shutdown(): Promise<void>;
  /** Best-effort synchronous daemon stop for `before-quit` (fire-and-forget; `shutdown()` does the awaited teardown). */
  requestDaemonStop(): void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createProjectController(deps: ProjectControllerDeps): ProjectController {
  let shell: AppShell | null = null;
  let supervisor: SupervisorLike | null = null;
  let currentProjectId: ProjectId | null = null;
  let currentPath: string | null = null;
  let latestDaemonStatus: DaemonStatusPayload | null = null;
  let currentProject: CurrentProjectState = null;
  let shellStarted = false;

  /**
   * Push the daemon's lifecycle status to the renderer badge (Principle 9 — a start failure / post-max-retries
   * `failed` is VISIBLE + retryable). Once the daemon (re)becomes healthy after the shell is up, nudge the
   * operator-IPC client to reconnect to the freshly-spawned daemon. Mirrors P-ON1's `pushDaemonStatus`.
   */
  function handleDaemonStatus(status: DaemonStatus): void {
    latestDaemonStatus = { status, detail: supervisor?.detail ?? null };
    deps.onDaemonStatus(latestDaemonStatus);
    if (status === 'healthy' && shellStarted) {
      void shell?.connection.refresh().catch((error: unknown) => {
        console.error('Failed to reconnect after the Conductor daemon became healthy:', error);
      });
    }
  }

  function pushCurrentProject(): void {
    currentProject =
      currentProjectId == null ? null : { projectId: currentProjectId, path: currentPath };
    deps.onCurrentProject(currentProject);
  }

  /**
   * Resolve a project's absolute path from the registry — a purely LOCAL read (no network, SH-4 offline-safe).
   * Used on the env-startup path where only the id is known; a lookup failure degrades to `null`, never throws.
   */
  function resolveProjectPath(projectId: ProjectId): string | null {
    try {
      const reg = deps.openRegistry();
      try {
        return reg.pathFor(projectId) ?? null;
      } finally {
        reg.close();
      }
    } catch (e) {
      console.error('Failed to resolve the project path from the registry:', e);
      return null;
    }
  }

  /**
   * Tear down the live shell + daemon. The daemon is stopped FIRST (so no `co-mcp serve` child leaks), then
   * the shell is closed (which closes its per-project mail/dispatch stores + IPC client). Each close is
   * guarded so one failure cannot strand the other.
   */
  async function teardownActive(): Promise<void> {
    shellStarted = false;
    const activeSupervisor = supervisor;
    const activeShell = shell;
    supervisor = null;
    shell = null;
    if (activeSupervisor != null) {
      try {
        await activeSupervisor.stop();
      } catch (e) {
        console.error('Failed to stop the Conductor daemon during project teardown:', e);
      }
    }
    if (activeShell != null) {
      try {
        await activeShell.close();
      } catch (e) {
        console.error('Failed to close the app shell during project teardown:', e);
      }
    }
  }

  async function doOpenProject(projectId: ProjectId, path?: string | null): Promise<void> {
    // 1. Tear down any existing project (daemon then shell) so we never leak a child or double-open stores.
    await teardownActive();

    // 2. Bind the new project + surface it immediately, so the top bar updates while the daemon spins up.
    currentProjectId = projectId;
    currentPath = path !== undefined ? path : resolveProjectPath(projectId);
    pushCurrentProject();

    // 3. Build a fresh supervisor + shell for the new project (createAppShell binds per-project stores at
    //    construction, so a switch genuinely requires a new shell — not a re-point of the old one).
    const newSupervisor = deps.createSupervisor({ onStatus: handleDaemonStatus });
    supervisor = newSupervisor;
    const newShell = deps.createShell(projectId);
    shell = newShell;

    // 4. Start the daemon BEFORE the shell connects (it attaches to a healthy socket). A failed start is
    //    surfaced as a visible status + Retry via handleDaemonStatus; the shell still comes up degraded so
    //    the operator keeps a working window and can retry from inside the app (the P-ON1 invariant).
    await newSupervisor.start(projectId);
    await newShell.start();
    shellStarted = true;
  }

  // Serialize opens through one tail promise so a second open (e.g. the picker fired while the env project
  // is still starting up) never interleaves its teardown with the first open's build — which would start a
  // shell that was already closed, or stop a daemon that was already replaced. Each open fully completes
  // before the next begins. A failed open does not poison the chain (the `.catch` keeps the tail resolvable),
  // but its rejection still propagates to its own caller.
  let openTail: Promise<void> = Promise.resolve();
  function openProject(projectId: ProjectId, path?: string | null): Promise<void> {
    const run = openTail.then(() => doOpenProject(projectId, path));
    openTail = run.catch(() => undefined);
    return run;
  }

  async function pickAndOpenProject(): Promise<void> {
    let absPath: string | null;
    try {
      absPath = await deps.pickDirectory();
    } catch (e) {
      deps.onError(`Could not open the directory picker: ${errorMessage(e)}`);
      return;
    }
    if (absPath == null) return; // operator cancelled — no registration, no switch, no error.

    // Register the chosen dir in the @co/core project registry (idempotent — same path → same id). This is the
    // SAME local path `co-mcp project-id` uses; it touches only the global store, never the network (SH-4). A
    // failure is VISIBLE and the current project stays open (we have not torn anything down yet) — app stays usable.
    let projectId: ProjectId;
    try {
      const reg = deps.openRegistry();
      try {
        projectId = reg.register(absPath);
      } finally {
        reg.close();
      }
    } catch (e) {
      deps.onError(`Could not register "${absPath}": ${errorMessage(e)}`);
      return;
    }

    try {
      await openProject(projectId, absPath);
    } catch (e) {
      deps.onError(`Could not open the project: ${errorMessage(e)}`);
    }
  }

  function showNoProject(error?: string): void {
    currentProjectId = null;
    currentPath = null;
    // No project ⇒ no daemon: report `stopped` so the header badge is accurate (not a perpetual "starting…").
    latestDaemonStatus = { status: 'stopped', detail: null };
    deps.onDaemonStatus(latestDaemonStatus);
    pushCurrentProject();
    if (error != null) deps.onError(error);
  }

  async function retryDaemon(): Promise<{ ok: boolean; error?: string }> {
    const activeSupervisor = supervisor;
    const projectId = currentProjectId;
    if (activeSupervisor == null || projectId == null) {
      return { ok: false, error: 'No project is open — use "Open project" to choose one.' };
    }
    try {
      const status = await activeSupervisor.start(projectId);
      if (status === 'healthy') {
        await shell?.connection.refresh();
        return { ok: true };
      }
      return {
        ok: false,
        error: activeSupervisor.detail ?? 'The Conductor daemon failed to start.',
      };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }

  async function shutdown(): Promise<void> {
    // Tear down through the same tail so a quit during an in-flight open waits for that open to settle first.
    const run = openTail.then(() => teardownActive());
    openTail = run.catch(() => undefined);
    await run;
  }

  function requestDaemonStop(): void {
    void supervisor?.stop();
  }

  return {
    get shell() {
      return shell;
    },
    get latestDaemonStatus() {
      return latestDaemonStatus;
    },
    get currentProject() {
      return currentProject;
    },
    openProject,
    pickAndOpenProject,
    showNoProject,
    retryDaemon,
    shutdown,
    requestDaemonStop,
  };
}
