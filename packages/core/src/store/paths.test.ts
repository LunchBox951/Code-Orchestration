import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataRoot, projectDataDir } from './paths.js';

const ORIGINAL_ENV = process.env;
const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  setPlatform(ORIGINAL_PLATFORM);
});

describe('dataRoot', () => {
  it('CO_DATA_DIR overrides on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      setPlatform(platform);
      process.env.CO_DATA_DIR = '/tmp/co-override';
      expect(dataRoot()).toBe('/tmp/co-override');
    }
  });

  it('ignores an empty CO_DATA_DIR (falls through to platform default)', () => {
    setPlatform('linux');
    process.env.CO_DATA_DIR = '';
    delete process.env.XDG_DATA_HOME;
    expect(dataRoot()).toBe(join(homedir(), '.local', 'share', 'co'));
  });

  it('honors $XDG_DATA_HOME on linux', () => {
    setPlatform('linux');
    delete process.env.CO_DATA_DIR;
    process.env.XDG_DATA_HOME = '/xdg/data';
    expect(dataRoot()).toBe(join('/xdg/data', 'co'));
  });

  it('falls back to ~/.local/share/co on linux without XDG_DATA_HOME', () => {
    setPlatform('linux');
    delete process.env.CO_DATA_DIR;
    delete process.env.XDG_DATA_HOME;
    expect(dataRoot()).toBe(join(homedir(), '.local', 'share', 'co'));
  });

  it('uses ~/Library/Application Support/co on darwin', () => {
    setPlatform('darwin');
    delete process.env.CO_DATA_DIR;
    expect(dataRoot()).toBe(join(homedir(), 'Library', 'Application Support', 'co'));
  });

  it('uses %LOCALAPPDATA%\\co on win32', () => {
    setPlatform('win32');
    delete process.env.CO_DATA_DIR;
    process.env.LOCALAPPDATA = 'C:\\Users\\me\\AppData\\Local';
    expect(dataRoot()).toBe(join('C:\\Users\\me\\AppData\\Local', 'co'));
  });

  it('falls back to %APPDATA%\\co on win32 without LOCALAPPDATA', () => {
    setPlatform('win32');
    delete process.env.CO_DATA_DIR;
    delete process.env.LOCALAPPDATA;
    process.env.APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
    expect(dataRoot()).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'co'));
  });

  it('falls back to ~/AppData/Local/co on win32 without LOCALAPPDATA or APPDATA', () => {
    setPlatform('win32');
    delete process.env.CO_DATA_DIR;
    delete process.env.LOCALAPPDATA;
    delete process.env.APPDATA;
    expect(dataRoot()).toBe(join(homedir(), 'AppData', 'Local', 'co'));
  });
});

describe('projectDataDir', () => {
  it('is `${dataRoot()}/projects/${projectId}`', () => {
    setPlatform('linux');
    process.env.CO_DATA_DIR = '/tmp/co-data';
    expect(projectDataDir('proj-1')).toBe(join('/tmp/co-data', 'projects', 'proj-1'));
  });
});

describe('projectDataDir — path boundary (Principle 12)', () => {
  it.each(['../escape', '../../etc', '/etc/passwd', 'a/b', '..', ''])(
    "throws on hostile projectId '%s'",
    (badId) => {
      process.env.CO_DATA_DIR = '/tmp/co-data';
      expect(() => projectDataDir(badId)).toThrow(/escapes program-data root/);
    },
  );

  it('accepts a normal UUID and returns the expected path', () => {
    process.env.CO_DATA_DIR = '/tmp/co-data';
    const id = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(projectDataDir(id)).toBe(join('/tmp/co-data', 'projects', id));
  });
});
