# `@co/desktop` — the `co` Electron desktop app

The operator-facing **Cockpit** desktop shell. Shell decision: **Electron** (resolved Stage 11;
see [`docs/research/language-and-stack.md`](../../docs/research/language-and-stack.md)).

## What is built (Stage 12)

- **6-view nav shell** — header + 224px left rail + main panel, dark oklch palette.
  Nav views: **Dashboard**, **Agents**, **Mail**, **Review**, **Source**, **Cost**.
- **Dashboard** — live/degraded conductor status, fleet stats, tree, and outstanding actions.
- **Mail** — operator inbox/outbox, actionable approvals/replies, read-state refresh, and
  daemon-routed writes.
- **Agents** — live roster, selected-agent transcript tail/backfill, event-driven transcript
  streaming, and mid-turn steer controls over the daemon-owned IPC path.
- **Cost** — usage headroom popover and cost rollups from the dispatch store.
- **Review** and **Source** remain nav stubs this stage.
- **Main process** (`src/main/`) — Node/Electron context. Imports `@co/core` (static
  reads) and the P1 `OperatorIpcClient` from `@co/mcp` (live conductor IPC). Creates
  the `BrowserWindow` and exposes the typed view-model bridge over `ipcMain`.
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
pnpm --filter @co/mcp exec co-mcp serve <project-id>  # live conductor, separate terminal
CO_PROJECT_ID=<project-id> pnpm --filter @co/desktop start
```

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
in-sandbox (Electron 39 / Node ≥22.5 / `node:sqlite` available). When the
Electron binary is installed, the host proof is:

```sh
ELECTRON_RUN_AS_NODE=1 pnpm --filter @co/desktop exec electron -e "require('node:sqlite'); const { createRequire } = require('node:module'); createRequire(require.resolve('@co/core'))('node-pty'); console.log('native-abi: ok')"
```

It must exit 0 and print `native-abi: ok`.
