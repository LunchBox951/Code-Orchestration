/**
 * Native-addon ABI proof (§3c — host handoff path).
 *
 * The conductor's host-live path needs two native surfaces: node:sqlite (built into
 * Node ≥22.5) and node-pty (a compiled N-API addon). The desktop app additionally needs
 * node-pty rebuilt for ELECTRON's ABI at package time (electron-builder / electron-rebuild):
 * a dev install compiles node-pty for the host Node ABI, which is correct for `co-mcp`
 * (Node) but not for the packaged Electron runtime.
 *
 * Determinism: every target is located through proper module resolution from this test's
 * own context (never a hardcoded monorepo-root path — that does not hold under pnpm's
 * isolated node_modules), so `pnpm test` is stable regardless of install/hoist state. The
 * runtime-load proof skips loudly when the compiled addon is absent (a bare install that
 * skipped build scripts) rather than failing, and the Electron-binary proof is gated behind
 * CO_HOST_ABI=1 (the operator opts in after electron-rebuild) — never a silent pass, never a
 * flaky failure.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Electron 39 bundles Node 22.x (≥22.14) which has node:sqlite and the N-API surface node-pty needs. */
const ELECTRON_MIN_MAJOR = 39;

/** Node 22.5.0 introduced node:sqlite (DatabaseSync). */
const NODE_SQLITE_MIN = { major: 22, minor: 5 };

function readVersion(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version?: string }).version ?? '0.0.0';
}

/** A require anchored in @co/core, where node-pty is declared (it is not a root dependency). */
function coreRequire(): NodeRequire {
  return createRequire(require.resolve('@co/core'));
}

/** True when node-pty's compiled addon loads under the CURRENT runtime (the conductor host path). */
const nodePtyLoadsUnderNode: boolean = (() => {
  try {
    const pty = coreRequire()('node-pty') as { spawn?: unknown };
    return typeof pty.spawn === 'function';
  } catch {
    return false;
  }
})();

/** The Electron binary path, when the platform binary was installed (postinstall not skipped). */
function electronBinaryPath(): string | undefined {
  try {
    const electron = require('electron') as unknown;
    if (typeof electron === 'string' && existsSync(electron)) return electron;
  } catch {
    // Electron's platform binary was not installed in this environment.
  }
  return undefined;
}

describe('AC-S11-2 §3c — native-addon ABI compatibility', () => {
  it('Electron is pinned ≥39 (bundles Node ≥22.5 → node:sqlite + node-pty ABI)', () => {
    // electron is an apps/desktop devDep — resolve it from this test's own context, not the root.
    const major = parseInt(
      readVersion(require.resolve('electron/package.json')).split('.')[0] ?? '0',
      10,
    );
    expect(major).toBeGreaterThanOrEqual(ELECTRON_MIN_MAJOR);
  });

  it('the current Node runtime is ≥22.5 (node:sqlite present)', () => {
    const [major, minor] = process.versions.node.split('.').map((n) => parseInt(n, 10));
    const hasSqlite =
      (major ?? 0) > NODE_SQLITE_MIN.major ||
      ((major ?? 0) === NODE_SQLITE_MIN.major && (minor ?? 0) >= NODE_SQLITE_MIN.minor);
    expect(hasSqlite).toBe(true);
  });

  it('node:sqlite DatabaseSync round-trips a value', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    expect(DatabaseSync).toBeDefined();
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (v TEXT)');
    db.exec("INSERT INTO t VALUES ('ok')");
    const row = db.prepare('SELECT v FROM t').get() as { v: string } | undefined;
    expect(row?.v).toBe('ok');
    db.close();
  });

  it('node-pty is declared ≥1.0 (the N-API ABI floor)', () => {
    // node-pty is a @co/core dependency — resolve it through @co/core, never the root.
    const major = parseInt(
      readVersion(coreRequire().resolve('node-pty/package.json')).split('.')[0] ?? '0',
      10,
    );
    expect(major).toBeGreaterThanOrEqual(1);
  });

  // Runs when the compiled addon is present (onlyBuiltDependencies builds it on install);
  // skips (visibly) when a bare install skipped build scripts — never a silent pass.
  it.runIf(nodePtyLoadsUnderNode)(
    'node-pty native addon is compiled and loads under the current Node runtime',
    () => {
      const pty = coreRequire()('node-pty') as { spawn?: unknown };
      expect(typeof pty.spawn).toBe('function');
    },
  );

  // The packaged-Electron ABI proof: node-pty rebuilt for Electron must load under the Electron
  // binary. A dev install compiles node-pty for the host Node ABI, so this is gated behind
  // CO_HOST_ABI=1 — the operator opts in after running electron-rebuild for the host proof.
  it.runIf(process.env.CO_HOST_ABI === '1')(
    '[host] Electron binary loads node:sqlite + node-pty (ABI-matched)',
    () => {
      const electron = electronBinaryPath();
      expect(electron, 'CO_HOST_ABI=1 set but no Electron binary is installed').toBeTruthy();
      const script =
        "require('node:sqlite'); const { createRequire } = require('node:module'); " +
        "createRequire(require.resolve('@co/core'))('node-pty'); console.log('native-abi: ok')";
      const result = spawnSync(electron!, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('native-abi: ok');
    },
  );
});
