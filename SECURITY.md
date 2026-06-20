# Security Policy

`co` runs AI agents that **execute code** and hold **subscription/credential access**, so security
reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Instead, use GitHub's private
[Report a vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
flow on this repository.

Please include reproduction steps, affected version/commit, and impact. We aim to acknowledge within
**72 hours** and to provide a remediation timeline after triage.

## Supported versions

While pre-alpha, only the latest `main` is supported. A formal support matrix arrives with the first
tagged release.

## Threat model & network posture

`co` is a **single-operator, local-host** tool. It exposes **no network port**: every server it stands
up is a **Unix-domain socket** under the OS temp dir, in a directory hardened to `0o700` with an
owner-uid check and symlink-rejection on connect (`packages/mcp/src/operator-ipc` /
`real-transport.ts`). Agents reach the core exclusively through the MCP surface over that local socket
(Principle 4); there is no HTTP/WebSocket listener and no remote control plane.

Residual caveat: the socket owner-uid check no-ops on platforms without `process.getuid` (Windows). The
desktop app is Linux/macOS-first today; revisit this if a Windows build ships.

## Dependency advisories (transitive)

Two transitive advisories are tracked and pinned to patched versions via `pnpm.overrides`
(`hono >= 4.12.25`, `undici >= 6.27.0`) as hygiene — neither is reachable in `co`'s threat model:

- **`hono`** (CORS / body-limit / path-traversal advisories) arrives only via
  `@modelcontextprotocol/sdk` → `@hono/node-server`. `co` imports **only** the SDK's stdio / in-memory
  transports, never its `streamableHttp` / `sse` modules — so `hono` is never instantiated and serves
  no request in `co`.
- **`undici`** (WebSocket DoS / header advisories) is pulled in **only by build tooling**
  (`node-gyp` / `@electron/rebuild`), never by product runtime code.

These bumps also clear the `stable-audit` promotion gate. Report any path that would make either
package reachable at runtime through the private advisory flow above.
