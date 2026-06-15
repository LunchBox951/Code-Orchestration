/**
 * Native-addon ABI proof (§3c — [host] handoff path).
 *
 * The Electron binary cannot execute in this CI sandbox (postinstall binary
 * download was skipped via --ignore-scripts). Full runtime proof (launching
 * electron headless, loading node-pty + node:sqlite under Electron's ABI) is
 * a [host] handoff to the operator.
 *
 * This in-sandbox test asserts the VERSION COMPATIBILITY invariant that makes
 * the host proof meaningful: Electron 36–39 bundles Node 22.14+ (≥22.5), which
 * includes node:sqlite built-in (added in Node 22.5) and ships compatible
 * node-pty prebuilds.
 *
 * Issue logged: electron-sandbox-exec (see co issue list).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);

// ── Electron version probe ────────────────────────────────────────────────────

function getElectronVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        require.resolve('electron/package.json', {
          paths: [join(here, '../../../../')],
        }),
        'utf8',
      ),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Electron 36+ bundles Node 22.x (≥22.14.0) which has node:sqlite. */
const ELECTRON_MIN_MAJOR = 36;

/** Node 22.5.0 introduced node:sqlite (DatabaseSync). */
const NODE_SQLITE_MIN = { major: 22, minor: 5 };

const HOST_HANDOFF_COMMAND =
  "pnpm --filter @co/desktop exec electron -e \"const path = require('node:path'); " +
  "require('node:sqlite'); " +
  "require(require.resolve('node-pty', { paths: [process.cwd(), path.resolve(process.cwd(), '../..')] })); " +
  "console.log('native-abi: ok')\"";

describe('AC-S11-2 §3c — native-addon ABI version compatibility', () => {
  it('Electron version is ≥36 (bundles Node 22.x which has node:sqlite)', () => {
    const version = getElectronVersion();
    const major = parseInt(version.split('.')[0] ?? '0', 10);
    expect(major).toBeGreaterThanOrEqual(ELECTRON_MIN_MAJOR);
  });

  it('current Node runtime has node:sqlite (DatabaseSync)', () => {
    // This Node process (v25.x) definitely has node:sqlite; confirms the test
    // infrastructure assumption. The assertion below validates that the version
    // is ≥22.5 (the minimum where node:sqlite exists).
    const [major, minor] = process.versions.node.split('.').map((n) => parseInt(n, 10));
    const hasSqlite =
      (major ?? 0) > NODE_SQLITE_MIN.major ||
      ((major ?? 0) === NODE_SQLITE_MIN.major && (minor ?? 0) >= NODE_SQLITE_MIN.minor);
    expect(hasSqlite).toBe(true);
  });

  it('node:sqlite DatabaseSync is importable in the current Node runtime', async () => {
    // Confirms node:sqlite is live in this runtime — the Electron main process
    // will have the same built-in (it uses Node 22.14+).
    const { DatabaseSync } = await import('node:sqlite');
    expect(DatabaseSync).toBeDefined();
    // Smoke: open an in-memory DB and round-trip a value.
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (v TEXT)');
    db.exec("INSERT INTO t VALUES ('ok')");
    const row = db.prepare('SELECT v FROM t').get() as { v: string } | undefined;
    expect(row?.v).toBe('ok');
    db.close();
  });

  it('node-pty version is ≥1.0 (supports Electron 36 / Node 22.x ABI via napi 9+)', () => {
    // node-pty v1.x ships N-API 9 prebuilds that cover Electron 30–39 / Node 22.x.
    // v0.x only targeted older Electron/Node pairs and lacks these prebuilds.
    // This assertion mirrors the node:sqlite check above — if the version drifts
    // below the ABI floor, the host proof will fail before anyone catches it.
    try {
      const pkg = JSON.parse(
        readFileSync(
          require.resolve('node-pty/package.json', {
            paths: [join(here, '../../../../')],
          }),
          'utf8',
        ),
      ) as { version?: string };
      const version = pkg.version ?? '0.0.0';
      const major = parseInt(version.split('.')[0] ?? '0', 10);
      expect(major).toBeGreaterThanOrEqual(1);
    } catch {
      // node-pty is in packages/core, not apps/desktop — resolve from monorepo root
      const pkg = JSON.parse(
        readFileSync(join(here, '../../../../node_modules/node-pty/package.json'), 'utf8'),
      ) as { version?: string };
      const version = pkg.version ?? '0.0.0';
      const major = parseInt(version.split('.')[0] ?? '0', 10);
      expect(major).toBeGreaterThanOrEqual(1);
    }
  });

  // Operator TODO: run
  // HOST_HANDOFF_COMMAND
  // and confirm exit 0 with the sentinel "native-abi: ok".
  it.todo('[host handoff] electron binary execution is not tested in this sandbox');

  it('documents a host handoff command that resolves node-pty from the workspace root', () => {
    expect(HOST_HANDOFF_COMMAND).toContain("require.resolve('node-pty'");
    expect(HOST_HANDOFF_COMMAND).toContain("path.resolve(process.cwd(), '../..')");
  });
});
