import { describe, expect, it } from 'vitest';
import {
  ghCommandPathEnv,
  githubHttpsCredentialEnv,
  resolveGhTokenFromEnv,
} from './github-auth.js';

describe('resolveGhTokenFromEnv — shared token-precedence policy', () => {
  it('CO_GH_TOKEN wins, then GH_TOKEN, then GITHUB_TOKEN (gh-native order); trims + omits blanks', () => {
    expect(
      resolveGhTokenFromEnv({ CO_GH_TOKEN: '  co  ', GH_TOKEN: 'gh', GITHUB_TOKEN: 'ci' }),
    ).toBe('co');
    // gh-native: GH_TOKEN beats GITHUB_TOKEN (matches what `gh` itself would pick).
    expect(resolveGhTokenFromEnv({ GH_TOKEN: 'gh', GITHUB_TOKEN: 'ci' })).toBe('gh');
    expect(resolveGhTokenFromEnv({ GITHUB_TOKEN: 'ci' })).toBe('ci');
    expect(resolveGhTokenFromEnv({})).toBeUndefined();
    expect(resolveGhTokenFromEnv({ CO_GH_TOKEN: '   ' })).toBeUndefined();
  });
});

describe('githubHttpsCredentialEnv — daemon-side GitHub HTTPS auth (RC-3/RC-4)', () => {
  it('authenticates both gh (GH_TOKEN) and git push (credential helper) for github.com', () => {
    const env = githubHttpsCredentialEnv('ghp_abc');
    // gh reads GH_TOKEN directly.
    expect(env['GH_TOKEN']).toBe('ghp_abc');
    expect(env['GITHUB_TOKEN']).toBe('ghp_abc');
    // git push HTTPS needs a credential helper scoped to github.com.
    expect(env['GIT_CONFIG_COUNT']).toBe('2');
    expect(env['GIT_CONFIG_KEY_0']).toBe('credential.https://github.com.helper');
    expect(env['GIT_CONFIG_VALUE_0']).toContain('password=$GH_TOKEN');
    expect(env['GIT_CONFIG_VALUE_0']).toContain('username=x-access-token');
    expect(env['GIT_CONFIG_KEY_1']).toBe('credential.https://github.com.useHttpPath');
    expect(env['GIT_CONFIG_VALUE_1']).toBe('false');
    // A missing/expired token must fail loud, never hang on a prompt.
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
  });

  it('trims the token and never embeds the secret literal in the helper value', () => {
    const env = githubHttpsCredentialEnv('  ghp_xyz  ');
    expect(env['GH_TOKEN']).toBe('ghp_xyz');
    // The helper reads $GH_TOKEN at credential time, so the secret is not baked into the config value.
    expect(env['GIT_CONFIG_VALUE_0']).not.toContain('ghp_xyz');
  });

  it('returns nothing for a blank token (no empty/partial credential config)', () => {
    expect(githubHttpsCredentialEnv('')).toEqual({});
    expect(githubHttpsCredentialEnv('   ')).toEqual({});
  });

  it('COMPOSES with an existing GIT_CONFIG_COUNT instead of clobbering it', () => {
    const base = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Existing',
    } as NodeJS.ProcessEnv;
    const env = githubHttpsCredentialEnv('ghp_abc', base);
    // Appends at index 1 and 2, count becomes 3; index 0 is left for the caller's existing entry.
    expect(env['GIT_CONFIG_COUNT']).toBe('3');
    expect(env['GIT_CONFIG_KEY_1']).toBe('credential.https://github.com.helper');
    expect(env['GIT_CONFIG_KEY_2']).toBe('credential.https://github.com.useHttpPath');
    expect(env).not.toHaveProperty('GIT_CONFIG_KEY_0');
  });

  it('treats a malformed/zero inbound GIT_CONFIG_COUNT as 0 (appends at index 0)', () => {
    for (const bad of ['abc', '0', '-1', '']) {
      const env = githubHttpsCredentialEnv('ghp_abc', { GIT_CONFIG_COUNT: bad });
      expect(env['GIT_CONFIG_COUNT']).toBe('2');
      expect(env['GIT_CONFIG_KEY_0']).toBe('credential.https://github.com.helper');
    }
  });
});

describe('ghCommandPathEnv — make an absolute gh fallback available to later bare gh calls', () => {
  it('prepends the absolute gh command directory when it is missing from PATH', () => {
    expect(ghCommandPathEnv('/usr/local/bin/gh', { PATH: '/usr/bin:/bin' })).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
    });
  });

  it('returns no env change for PATH hits or already-present absolute dirs', () => {
    expect(ghCommandPathEnv('gh', { PATH: '/usr/bin:/bin' })).toEqual({});
    expect(ghCommandPathEnv('/usr/bin/gh', { PATH: '/usr/bin:/bin' })).toEqual({});
  });
});
