import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import {
  IDENTITY_PERSONA_ALLOWLIST_KEY,
  IDENTITY_PERSONA_KEY,
  checkPublishIdentities,
  checkSignedOffCommits,
  defaultCommitIdentityReader,
  resolvePersonaAllowlist,
  resolvePersona,
  type CommitIdentity,
} from './identity-guard.js';

// AC-L6a-7 — identity guard: pure guard, config resolvers, normalization.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let configs: ConfigStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  configs = [];
  const data = mkdtempSync(join(tmpdir(), 'co-idguard-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const c of configs) c.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  configs = [];
});

function openCfg(): ConfigStore {
  const c = openConfigStore();
  configs.push(c);
  return c;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-idguard-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 'persona@noreply.github.com');
  git(dir, 'config', 'user.name', 'Persona');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'chore: init');
  return dir;
}

// ---------------------------------------------------------------------------
// Pure guard — checkPublishIdentities
// ---------------------------------------------------------------------------

const PERSONA = 'maintainer <1+maintainer@users.noreply.github.com>';
const ALLOWLIST = [PERSONA];

const cleanCommit: CommitIdentity = {
  sha: 'a'.repeat(40),
  author: PERSONA,
  committer: PERSONA,
  signoffs: [PERSONA],
};

describe('checkPublishIdentities — pure guard', () => {
  it('all-persona commits → no violations', () => {
    expect(checkPublishIdentities([cleanCommit], ALLOWLIST)).toEqual([]);
  });

  it('off-persona author → one violation naming sha+field+identity', () => {
    const commit: CommitIdentity = {
      ...cleanCommit,
      author: 'maintainer <off@example.com>',
    };
    const violations = checkPublishIdentities([commit], ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.field).toBe('author');
    expect(violations[0]!.sha).toBe(commit.sha);
    expect(violations[0]!.identity).toBe('maintainer <off@example.com>');
  });

  it('off-persona committer → one violation', () => {
    const commit: CommitIdentity = {
      ...cleanCommit,
      committer: 'Bad Actor <bad@example.com>',
    };
    const violations = checkPublishIdentities([commit], ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.field).toBe('committer');
  });

  it('off-persona Signed-off-by trailer → one violation', () => {
    const commit: CommitIdentity = {
      ...cleanCommit,
      signoffs: ['maintainer <off@example.com>'],
    };
    const violations = checkPublishIdentities([commit], ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.field).toBe('signed-off-by');
    expect(violations[0]!.identity).toBe('maintainer <off@example.com>');
  });

  it('missing Signed-off-by trailer → violation even when author and committer are allowlisted', () => {
    const commit: CommitIdentity = {
      ...cleanCommit,
      signoffs: [],
    };
    const violations = checkPublishIdentities([commit], ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.field).toBe('signed-off-by');
    expect(violations[0]!.reason).toMatch(/missing/i);
  });

  it('multiple violations across fields on one commit', () => {
    const commit: CommitIdentity = {
      sha: 'b'.repeat(40),
      author: 'Bad <bad@example.com>',
      committer: 'Also Bad <also@example.com>',
      signoffs: ['Signed Bad <sign@example.com>'],
    };
    const violations = checkPublishIdentities([commit], ALLOWLIST);
    expect(violations).toHaveLength(3);
    expect(violations.map((v) => v.field).sort()).toEqual(
      ['author', 'committer', 'signed-off-by'].sort(),
    );
  });

  it('violations across multiple commits', () => {
    const bad1: CommitIdentity = {
      sha: 'a'.repeat(40),
      author: 'Bad <b@x.com>',
      committer: PERSONA,
      signoffs: [],
    };
    const bad2: CommitIdentity = {
      sha: 'b'.repeat(40),
      author: PERSONA,
      committer: 'Bad2 <c@x.com>',
      signoffs: [],
    };
    const violations = checkPublishIdentities([bad1, bad2], ALLOWLIST);
    expect(violations).toHaveLength(4);
    expect(violations[0]!.sha).toBe(bad1.sha);
    expect(violations[2]!.sha).toBe(bad2.sha);
  });

  it('email-case normalization: uppercase email in commit matches lowercase allowlist', () => {
    const id = 'maintainer <persona@noreply.github.com>';
    const idUpper = 'maintainer <PERSONA@NOREPLY.GITHUB.COM>';
    const allowlist = [idUpper];
    const commit: CommitIdentity = {
      sha: 'e'.repeat(40),
      author: id,
      committer: id,
      signoffs: [id],
    };
    // Both normalize to lowercase email → no violation.
    expect(checkPublishIdentities([commit], allowlist)).toEqual([]);
  });

  it('bare-email allowlist entry matches any identity with that email', () => {
    const commit: CommitIdentity = {
      sha: 'e'.repeat(40),
      author: 'Persona <persona@noreply.github.com>',
      committer: 'Different Name <persona@noreply.github.com>',
      signoffs: ['Another Name <PERSONA@NOREPLY.GITHUB.COM>'],
    };
    expect(checkPublishIdentities([commit], ['<persona@noreply.github.com>'])).toEqual([]);
  });

  it('whitespace normalization: extra spaces trimmed before comparison', () => {
    const id = 'maintainer <persona@noreply.github.com>';
    const allowlist = [id];
    const commit: CommitIdentity = {
      sha: 'f'.repeat(40),
      author: '  maintainer <persona@noreply.github.com>  ',
      committer: id,
      signoffs: [id],
    };
    expect(checkPublishIdentities([commit], allowlist)).toEqual([]);
  });

  it('empty allowlist → every identity is a violation', () => {
    const violations = checkPublishIdentities([cleanCommit], []);
    // author + committer + 1 signoff = 3 violations
    expect(violations.length).toBeGreaterThan(0);
  });

  it('empty commit list → no violations', () => {
    expect(checkPublishIdentities([], ALLOWLIST)).toEqual([]);
  });
});

describe('checkSignedOffCommits — DCO floor', () => {
  it('rejects malformed Signed-off-by trailers when no persona allowlist is configured', () => {
    const violations = checkSignedOffCommits([
      {
        ...cleanCommit,
        signoffs: ['not-an-identity'],
      },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]!.field).toBe('signed-off-by');
    expect(violations[0]!.identity).toBe('not-an-identity');
    expect(violations[0]!.reason).toMatch(/malformed/i);
  });
});

// ---------------------------------------------------------------------------
// Config resolvers
// ---------------------------------------------------------------------------

describe('resolvePersonaAllowlist', () => {
  it('returns [] when unconfigured', () => {
    expect(resolvePersonaAllowlist('p-none')).toEqual([]);
  });

  it('returns the configured list when set at global scope', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_ALLOWLIST_KEY, [
      'Alice <alice@example.com>',
      'Bob <bob@example.com>',
    ]);
    cfg.close();
    configs.pop(); // closed above
    expect(resolvePersonaAllowlist('any-project')).toEqual([
      'Alice <alice@example.com>',
      'Bob <bob@example.com>',
    ]);
  });

  it('project override wins over global', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_ALLOWLIST_KEY, ['Global <g@example.com>']);
    cfg.setProjectOverride('p-override', IDENTITY_PERSONA_ALLOWLIST_KEY, [
      'Project <p@example.com>',
    ]);
    cfg.close();
    configs.pop();
    expect(resolvePersonaAllowlist('p-override')).toEqual(['Project <p@example.com>']);
  });

  it('non-array config value fails loud instead of disabling the guard', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_ALLOWLIST_KEY, 'not-an-array');
    cfg.close();
    configs.pop();
    expect(() => resolvePersonaAllowlist('p-bad')).toThrow(/identity\.persona_allowlist/i);
  });

  it('blank allowlist entries fail loud', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_ALLOWLIST_KEY, ['Persona <persona@noreply.github.com>', '  ']);
    cfg.close();
    configs.pop();
    expect(() => resolvePersonaAllowlist('p-blank')).toThrow(/identity\.persona_allowlist/i);
  });

  it('malformed allowlist entries fail loud', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_ALLOWLIST_KEY, ['not-an-identity']);
    cfg.close();
    configs.pop();
    expect(() => resolvePersonaAllowlist('p-malformed')).toThrow(/identity\.persona_allowlist/i);
  });
});

describe('resolvePersona', () => {
  it('returns undefined when unconfigured', () => {
    expect(resolvePersona('p-none')).toBeUndefined();
  });

  it('returns the configured persona object', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_KEY, {
      name: 'maintainer',
      email: '1+maintainer@users.noreply.github.com',
    });
    cfg.close();
    configs.pop();
    const persona = resolvePersona('any-project');
    expect(persona).toEqual({
      name: 'maintainer',
      email: '1+maintainer@users.noreply.github.com',
    });
  });

  it('project override wins over global', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_KEY, { name: 'Global', email: 'global@example.com' });
    cfg.setProjectOverride('p-override', IDENTITY_PERSONA_KEY, {
      name: 'Local',
      email: 'local@example.com',
    });
    cfg.close();
    configs.pop();
    expect(resolvePersona('p-override')).toEqual({ name: 'Local', email: 'local@example.com' });
  });

  it('non-object config value fails loud instead of disabling persona pinning', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_KEY, 'not-an-object');
    cfg.close();
    configs.pop();
    expect(() => resolvePersona('p-bad')).toThrow(/identity\.persona/i);
  });

  it('object missing required fields fails loud', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_KEY, { name: 'Only Name' }); // missing email
    cfg.close();
    configs.pop();
    expect(() => resolvePersona('p-incomplete')).toThrow(/identity\.persona/i);
  });

  it('malformed persona email fails loud', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_KEY, { name: 'CO Bot', email: 'not-an-email' });
    cfg.close();
    configs.pop();
    expect(() => resolvePersona('p-bad-email')).toThrow(/identity\.persona/i);
  });
});

describe('defaultCommitIdentityReader', () => {
  it('throws when git cannot inspect the requested range', () => {
    const repo = makeRepo();
    expect(() => defaultCommitIdentityReader.read(repo, `${'a'.repeat(40)}..HEAD`)).toThrow(
      /cannot inspect commit identities/i,
    );
  });

  it('reads Signed-off-by trailers case-insensitively', () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'case.txt'), 'case\n');
    git(repo, 'add', '.');
    git(
      repo,
      'commit',
      '-m',
      'feat: case signoff',
      '-m',
      'signed-off-by: Personal <personal@example.com>',
    );
    const commits = defaultCommitIdentityReader.read(repo, 'HEAD~1..HEAD');

    expect(commits[0]?.signoffs).toEqual(['Personal <personal@example.com>']);
  });
});
