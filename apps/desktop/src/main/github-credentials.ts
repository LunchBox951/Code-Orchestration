import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * #95 / #71 — operator-facing "Connect GitHub" credential store for the desktop GUI launch path.
 *
 * A GUI-launched Electron app inherits NO shell exports and `gh` is often off the GUI PATH, so the
 * daemon it spawns has no GitHub token and there is no way for the operator to provide one. This module
 * is the at-rest store behind the Connect-GitHub Settings UI: the operator pastes a token once, we
 * persist it ENCRYPTED, and the supervisor injects it as `CO_GH_TOKEN` into every `co-mcp serve` child
 * (which then provisions every pane app-wide via {@link resolveAndApplyDaemonGithubAuth}).
 *
 * SECURITY (Principle 9 — fail loud, never store plaintext):
 *   - Encryption rides Electron's {@link safeStorage} (OS keychain / DPAPI / libsecret). We GUARD on
 *     `isEncryptionAvailable()` and THROW a visible error if it is not — we NEVER fall back to writing
 *     a plaintext token to disk.
 *   - The ciphertext sidecar is written 0o600 (owner-only) under `app.getPath('userData')`.
 *   - The plaintext token is NEVER logged, NEVER returned in any structured payload other than the
 *     direct {@link readToken} accessor the supervisor calls, and NEVER written to the repo.
 *
 * Every external effect (safeStorage, the userData path, the fs surface) is an INJECTABLE dependency so
 * the store is unit-testable with a fake safeStorage + a temp dir — no real Electron, no real keychain.
 */

/** The minimal Electron `safeStorage` surface this store depends on (a strict subset). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend():
    | 'basic_text'
    | 'gnome_libsecret'
    | 'kwallet'
    | 'kwallet5'
    | 'kwallet6'
    | 'unknown';
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The minimal filesystem surface — defaults to `node:fs`, injectable for tests. */
export interface CredentialFs {
  readFileSync(path: string): Buffer;
  writeFileSync(path: string, data: Buffer, options: { readonly mode: number }): void;
  mkdirSync(path: string, options: { readonly recursive: true }): void;
  rmSync(path: string, options: { readonly force: true }): void;
  chmodSync(path: string, mode: number): void;
}

const realFs: CredentialFs = {
  readFileSync: (path) => readFileSync(path),
  writeFileSync: (path, data, options) => writeFileSync(path, data, options),
  mkdirSync: (path, options) => {
    mkdirSync(path, options);
  },
  rmSync: (path, options) => rmSync(path, options),
  chmodSync: (path, mode) => chmodSync(path, mode),
};

/** Injectable dependencies. Production wires Electron's `safeStorage` + `app.getPath('userData')`. */
export interface GithubCredentialStoreDeps {
  readonly safeStorage: SafeStorageLike;
  /** Absolute path to Electron's per-user data dir (`app.getPath('userData')`). */
  readonly userDataPath: string;
  /** Filesystem seam. Default: real `node:fs`. */
  readonly fs?: CredentialFs;
}

/** Owner-only (0o600) permission for the ciphertext sidecar — never group/world readable. */
const SIDECAR_MODE = 0o600;

/** The sidecar filename under userData. The contents are ciphertext bytes, never plaintext. */
const SIDECAR_NAME = 'github-credentials.enc';

export interface GithubCredentialStore {
  /**
   * Persist `token` ENCRYPTED. Throws a visible error (and writes NOTHING) when OS encryption is
   * unavailable, or when `token` is blank. The plaintext never touches disk or any log.
   */
  storeToken(token: string): void;
  /** The stored token, decrypted, or `null` when none is stored / the sidecar is unreadable. */
  readToken(): string | null;
  /** Remove the stored credential (idempotent — a no-op when none exists). */
  clearToken(): void;
  /** Whether a credential is currently stored (decrypt-verified). */
  hasToken(): boolean;
}

/**
 * Build the credential store over injected dependencies. The store touches ONLY the ciphertext sidecar
 * under `userDataPath`; it never spawns, never logs the token, and never writes plaintext.
 */
export function createGithubCredentialStore(
  deps: GithubCredentialStoreDeps,
): GithubCredentialStore {
  const fs = deps.fs ?? realFs;
  const sidecarPath = join(deps.userDataPath, SIDECAR_NAME);

  function assertEncryptionAvailable(): void {
    if (!deps.safeStorage.isEncryptionAvailable()) {
      // Principle 9 — fail LOUD rather than silently writing a plaintext secret to disk.
      throw new Error(
        'Connect GitHub: OS credential encryption (safeStorage) is unavailable, so the token cannot ' +
          'be stored securely. Refusing to persist a plaintext token. On Linux ensure a keyring ' +
          '(gnome-keyring / kwallet / libsecret) is running, or set CO_GH_TOKEN in the environment ' +
          'instead (or run `gh auth login`).',
      );
    }
    if (process.platform === 'linux') {
      const backend = deps.safeStorage.getSelectedStorageBackend();
      if (backend === 'basic_text' || backend === 'unknown') {
        throw new Error(
          `Connect GitHub: Electron safeStorage selected '${backend}', which does not provide a ` +
            'usable Linux keyring for protecting tokens. Refusing to persist a plaintext-equivalent ' +
            'token. Install or unlock gnome-keyring / kwallet / libsecret, set CO_GH_TOKEN in the ' +
            'environment instead, or run `gh auth login`.',
        );
      }
    }
  }

  return {
    storeToken(token: string): void {
      const trimmed = token.trim();
      if (trimmed.length === 0) {
        throw new Error('Connect GitHub: the token must be a non-empty string.');
      }
      assertEncryptionAvailable();
      const ciphertext = deps.safeStorage.encryptString(trimmed);
      fs.mkdirSync(dirname(sidecarPath), { recursive: true });
      // Pre-create at 0o600 so the bytes never land world-readable even momentarily, then re-assert.
      fs.writeFileSync(sidecarPath, ciphertext, { mode: SIDECAR_MODE });
      fs.chmodSync(sidecarPath, SIDECAR_MODE);
    },

    readToken(): string | null {
      let ciphertext: Buffer;
      try {
        ciphertext = fs.readFileSync(sidecarPath);
      } catch {
        return null; // No sidecar — not connected.
      }
      if (ciphertext.length === 0) return null;
      if (!deps.safeStorage.isEncryptionAvailable()) {
        // The sidecar exists but the OS can no longer decrypt it (keyring gone). Surface the failure
        // without exposing plaintext so the operator sees a repairable credential problem.
        throw new Error(
          'stored GitHub credential exists but cannot be decrypted because OS credential encryption is unavailable.',
        );
      }
      try {
        const token = deps.safeStorage.decryptString(ciphertext).trim();
        return token.length > 0 ? token : null;
      } catch (e) {
        throw new Error(
          `stored GitHub credential exists but cannot be decrypted: ${
            e instanceof Error ? e.message : String(e)
          }`,
          { cause: e },
        );
      }
    },

    clearToken(): void {
      fs.rmSync(sidecarPath, { force: true });
    },

    hasToken(): boolean {
      return this.readToken() != null;
    },
  };
}
