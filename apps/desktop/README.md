# `@co/desktop` — the `co` Electron desktop app

The operator-facing **Cockpit** desktop shell. Shell decision: **Electron** (resolved Stage 11;
see [`docs/research/language-and-stack.md`](../../docs/research/language-and-stack.md)).

## What is built (Stage 15)

- **6-view nav shell** — header + 224px left rail + main panel, dark oklch palette.
  Nav views: **Dashboard**, **Agents**, **Mail**, **Review**, **Source**, **Cost**.
- **Project on-ramp** — open a repository/directory from the app; the app registers the project,
  owns the `co-mcp serve` daemon lifecycle, and surfaces daemon health with Retry.
- **Dashboard** — live/degraded conductor status, fleet stats, tree, and outstanding actions.
- **Mail** — operator inbox/outbox, actionable approvals/replies, read-state refresh, and
  daemon-routed writes.
- **Agents** — live roster, selected-agent transcript tail/backfill, event-driven transcript
  streaming, mid-turn steer controls, Stop/Unstick controls, and coordinator launch from the bundled
  demo spec.
- **Cost** — usage headroom popover and cost rollups from the dispatch store.
- **Review** — pending review requests with diff + locked criteria and PASS/ISSUES verdict
  submission through operator IPC.
- **Source** — read-only local branches plus locally-fetched pull-request refs.
- **Main process** (`src/main/`) — Node/Electron context. Imports `@co/core` (static
  reads), supervises the app-owned `co-mcp serve` child, and uses the P1 `OperatorIpcClient` from
  `@co/mcp` (live conductor IPC). Creates the `BrowserWindow` and exposes the typed view-model bridge
  over `ipcMain`.
- **Preload** (`src/preload/preload.cts`) — `contextBridge` exposes `window.coShell`
  (`CoShellBridge`) to the renderer; `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`.
- **Renderer** (`src/renderer/`) — DOM-only; uses `window.coShell` for all data.
- **Shared view-models** (`src/shared/`) — pure TypeScript, no DOM, no Electron.
  `NavVM` and `ConnectionVM` are headless-tested (vitest); pixels are the host smoke-test.

## Development

```sh
# From the repo root
pnpm install
pnpm build                        # compile all packages including @co/desktop
pnpm --filter @co/desktop start   # pick/open a project in the app
```

The app starts/stops `co-mcp serve <project-id>` itself after a project is opened. `CO_PROJECT_ID`
remains useful only for legacy startup/testing paths; ordinary operator flow is the in-app Open
Project button.

## Packaging (Linux)

```sh
pnpm --filter @co/desktop pack    # unpacked dir (fast, no installer)
pnpm --filter @co/desktop dist    # AppImage
```

mac/Win prebuilds require the platform binary — run on the target host.
Config: [`electron-builder.yml`](electron-builder.yml).

## Testing

Headless view-model tests run in the standard monorepo gate:

```sh
pnpm test   # vitest discovers apps/desktop/src/**/*.test.ts
```

The native-addon ABI proof (`native-abi.test.ts`) asserts version compatibility
in-sandbox (Electron 39's bundled Node runtime is ≥22.5 with `node:sqlite`
available; repo setup still uses the root Node version). When the Electron binary
is installed, the host proof is:

```sh
ELECTRON_RUN_AS_NODE=1 pnpm --filter @co/desktop exec electron -e "require('node:sqlite'); const { createRequire } = require('node:module'); createRequire(require.resolve('@co/core'))('node-pty'); console.log('native-abi: ok')"
```

It must exit 0 and print `native-abi: ok`.
