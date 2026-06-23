import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGithubCredentialStore,
  type CredentialFs,
  type SafeStorageLike,
} from './github-credentials.js';

/**
 * #95/#71 — the Connect-GitHub credential store. Every external effect (safeStorage, the userData dir)
 * is injected, so these run with a FAKE safeStorage + a real temp dir — NO real Electron, NO real
 * keychain. The CRITICAL security invariants: encryption-unavailable refuses (no plaintext on disk),
 * the on-disk bytes are ciphertext (never the plaintext token), the sidecar is 0o600, and the plaintext
 * token never reaches any console/log call.
 */

/** A fake safeStorage: a reversible "encryption" (base64 with a marker) standing in for the OS keychain. */
function fakeSafeStorage(
  available = true,
  backend: ReturnType<SafeStorageLike['getSelectedStorageBackend']> = 'gnome_libsecret',
): SafeStorageLike & { available: boolean } {
  const state = { available };
  const PREFIX = 'enc:';
  return {
    get available() {
      return state.available;
    },
    set available(v: boolean) {
      state.available = v;
    },
    isEncryptionAvailable: () => state.available,
    getSelectedStorageBackend: () => backend,
    encryptString: (plain: string) =>
      Buffer.from(PREFIX + Buffer.from(plain, 'utf8').toString('base64')),
    decryptString: (buf: Buffer) => {
      const s = buf.toString('utf8');
      if (!s.startsWith(PREFIX)) throw new Error('not our ciphertext');
      return Buffer.from(s.slice(PREFIX.length), 'base64').toString('utf8');
    },
  };
}

const TOKEN = 'ghp_SUPERSECRET_test_token_value_0123456789';

let userDataPath: string;
const sidecar = (): string => join(userDataPath, 'github-credentials.enc');

function thrownMessage(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('expected function to throw');
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'co-gh-creds-'));
});

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('github-credentials — encryption-unavailable refuses (Principle 9, no plaintext)', () => {
  it('store() throws a visible error and writes NOTHING when isEncryptionAvailable() is false', () => {
    const safeStorage = fakeSafeStorage(false);
    const store = createGithubCredentialStore({ safeStorage, userDataPath });

    const message = thrownMessage(() => store.storeToken(TOKEN));
    expect(message).toMatch(/unavailable|plaintext|securely/i);
    expect(message).toMatch(/restart.*app|reopen.*project/i);
    expect(existsSync(sidecar())).toBe(false);
  });

  it.each(['basic_text', 'unknown'] as const)(
    'store() refuses the Linux %s backend because it is not protected by a real keyring',
    (backend) => {
      const safeStorage = fakeSafeStorage(true, backend);
      const store = createGithubCredentialStore({ safeStorage, userDataPath });

      const message = thrownMessage(() => store.storeToken(TOKEN));
      expect(message).toMatch(new RegExp(`${backend}|keyring|plaintext`, 'i'));
      expect(message).toMatch(/restart.*app|reopen.*project/i);
      expect(existsSync(sidecar())).toBe(false);
    },
  );
});

describe('github-credentials — stored sidecar read failures fail loud', () => {
  it.each(['basic_text', 'unknown'] as const)(
    'readToken refuses an existing sidecar when the Linux backend downgrades to %s',
    (backend) => {
      const store = createGithubCredentialStore({
        safeStorage: fakeSafeStorage(),
        userDataPath,
      });
      store.storeToken(TOKEN);

      const downgraded = createGithubCredentialStore({
        safeStorage: fakeSafeStorage(true, backend),
        userDataPath,
      });
      expect(() => downgraded.readToken()).toThrow(new RegExp(`${backend}|keyring|plaintext`, 'i'));
      expect(() => downgraded.hasToken()).toThrow(new RegExp(`${backend}|keyring|plaintext`, 'i'));
    },
  );

  it('readToken throws for a non-missing sidecar read failure', () => {
    const readError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const fs: CredentialFs = {
      readFileSync: () => {
        throw readError;
      },
      writeFileSync: () => undefined,
      mkdirSync: () => undefined,
      rmSync: () => undefined,
      chmodSync: () => undefined,
    };
    const store = createGithubCredentialStore({
      safeStorage: fakeSafeStorage(),
      userDataPath,
      fs,
    });

    expect(() => store.readToken()).toThrow(/stored GitHub credential|read|permission/i);
    expect(() => store.hasToken()).toThrow(/stored GitHub credential|read|permission/i);
  });

  it('readToken throws for an empty sidecar instead of treating it as never connected', () => {
    writeFileSync(sidecar(), Buffer.alloc(0));
    const store = createGithubCredentialStore({
      safeStorage: fakeSafeStorage(),
      userDataPath,
    });

    expect(() => store.readToken()).toThrow(/stored GitHub credential|empty|corrupt/i);
  });
});

describe('github-credentials — round-trip + at-rest security', () => {
  it('store → read returns the token, with CIPHERTEXT (not plaintext) on disk at 0o600', () => {
    const safeStorage = fakeSafeStorage();
    const store = createGithubCredentialStore({ safeStorage, userDataPath });

    store.storeToken(TOKEN);

    expect(store.readToken()).toBe(TOKEN);
    expect(store.hasToken()).toBe(true);

    // The on-disk bytes must NOT contain the plaintext token.
    const onDisk = readFileSync(sidecar());
    expect(onDisk.toString('utf8')).not.toContain(TOKEN);
    expect(onDisk.length).toBeGreaterThan(0);

    // Owner-only permissions (0o600). (Mode bits are POSIX; the suite runs on Linux.)
    const mode = statSync(sidecar()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('trims whitespace and rejects a blank token', () => {
    const safeStorage = fakeSafeStorage();
    const store = createGithubCredentialStore({ safeStorage, userDataPath });

    expect(() => store.storeToken('   ')).toThrow(/non-empty/i);
    expect(existsSync(sidecar())).toBe(false);

    store.storeToken(`  ${TOKEN}  `);
    expect(store.readToken()).toBe(TOKEN);
  });

  it('clear() removes the credential (idempotent)', () => {
    const safeStorage = fakeSafeStorage();
    const store = createGithubCredentialStore({ safeStorage, userDataPath });

    store.storeToken(TOKEN);
    expect(store.hasToken()).toBe(true);

    store.clearToken();
    expect(store.hasToken()).toBe(false);
    expect(store.readToken()).toBeNull();
    expect(existsSync(sidecar())).toBe(false);

    // Idempotent — a second clear is a harmless no-op.
    expect(() => store.clearToken()).not.toThrow();
  });

  it('readToken returns null when no sidecar exists', () => {
    const safeStorage = fakeSafeStorage();
    const store = createGithubCredentialStore({ safeStorage, userDataPath });

    expect(store.readToken()).toBeNull(); // nothing stored yet
  });

  it('readToken fails loud when a stored sidecar exists but the keyring can no longer decrypt', () => {
    const safeStorage = fakeSafeStorage();
    const store = createGithubCredentialStore({ safeStorage, userDataPath });

    store.storeToken(TOKEN);
    expect(store.readToken()).toBe(TOKEN);

    // Keyring vanished mid-session: the ciphertext exists but cannot be decrypted — never plaintext.
    safeStorage.available = false;
    expect(() => store.readToken()).toThrow(/stored GitHub credential|decrypt/i);
  });
});

describe('github-credentials — the plaintext token never reaches a log', () => {
  it('no console.* call ever receives the plaintext token across store/read/clear', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const safeStorage = fakeSafeStorage();
    const store = createGithubCredentialStore({ safeStorage, userDataPath });
    store.storeToken(TOKEN);
    store.readToken();
    store.hasToken();
    store.clearToken();

    for (const spy of [logSpy, errSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(TOKEN);
      }
    }
  });
});
