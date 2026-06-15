# `@co/desktop` — the `co` Electron desktop app

The operator-facing **Cockpit** desktop shell. Shell decision: **Electron** (resolved Stage 11;
see [`docs/research/language-and-stack.md`](../../docs/research/language-and-stack.md)).

## What is built (Stage 11 P2)

- **6-view nav shell** — header + 224px left rail + main panel, dark oklch palette.
  Nav views: **Dashboard**, **Agents**, **Mail**, **Review**, **Source**, **Cost**.
  Dashboard, Mail, and Cost receive real data in later stages (P3/P4/P5); Agents,
  Review, and Source are nav stubs this stage.
- **Main process** (`src/main/`) — Node/Electron context. Imports `@co/core` (static
  reads) and the P1 `OperatorIpcClient` from `@co/mcp` (live conductor IPC). Creates
  the `BrowserWindow` and exposes the typed view-model bridge over `ipcMain`.
- **Preload** (`src/preload/preload.ts`) — `contextBridge` exposes `window.coShell`
  (`CoShellBridge`) to the renderer; `contextIsolation: true`, `nodeIntegration: false`.
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
in-sandbox (Electron 36 / Node ≥22.5 / `node:sqlite` available). Full runtime proof
(launching the Electron binary headless, loading `node-pty` + `node:sqlite` under
Electron's ABI) is an operator host-side handoff.
