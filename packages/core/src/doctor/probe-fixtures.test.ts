/**
 * AC-S10-4·4 — probe fixtures: drive the provider-probe parsers with representative real-binary
 * output shapes, verifying the parsers accept the byte-signature patterns the live binaries emit.
 *
 * Each fixture under `./fixtures/` was synthesized from the current real-binary output signatures
 * (verified against live `claude`/`codex` builds). The parsers are defensive (tolerate structural
 * noise), so these fixtures assert minimum-contract expectations.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeAuthStatus } from '../dispatch/claude-source.js';
import { parseCodexDoctor } from '../dispatch/codex-source.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

// ── claude --version ─────────────────────────────────────────────────────────

describe('probe fixture: claude --version', () => {
  it('has a non-empty version line', () => {
    const raw = readFixture('claude-version.txt').trim();
    expect(raw.length).toBeGreaterThan(0);
    // The real binary prints a version string on the first line.
    expect(raw).toMatch(/\d+\.\d+/);
  });
});

// ── claude auth status --json ─────────────────────────────────────────────────

describe('probe fixture: claude auth status --json', () => {
  it('parseClaudeAuthStatus: logged_in=true → loggedIn true', () => {
    const raw = readFixture('claude-auth-status.json');
    const parsed = parseJson(raw);
    const result = parseClaudeAuthStatus(parsed);
    expect(result.loggedIn).toBe(true);
  });

  it('parseClaudeAuthStatus: account.plan → scoped account label', () => {
    const raw = readFixture('claude-auth-status.json');
    const parsed = parseJson(raw);
    const result = parseClaudeAuthStatus(parsed);
    // The parser derives the label from account.plan ('max' → 'claude:max').
    expect(result.account).toMatch(/claude:/);
  });
});

// ── codex --version ───────────────────────────────────────────────────────────

describe('probe fixture: codex --version', () => {
  it('has a non-empty version line', () => {
    const raw = readFixture('codex-version.txt').trim();
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).toMatch(/\d+\.\d+/);
  });
});

// ── codex doctor --json ───────────────────────────────────────────────────────

describe('probe fixture: codex doctor --json', () => {
  it('parseCodexDoctor: authenticated=true + status=ok → healthy true', () => {
    const raw = readFixture('codex-doctor.json');
    const parsed = parseJson(raw);
    const result = parseCodexDoctor(parsed);
    expect(result.healthy).toBe(true);
  });

  it('parseCodexDoctor: account.plan → scoped account label', () => {
    const raw = readFixture('codex-doctor.json');
    const parsed = parseJson(raw);
    const result = parseCodexDoctor(parsed);
    // 'pro' → 'codex:pro'
    expect(result.account).toMatch(/codex:/);
  });
});

// ── defaultProviderProbe round-trip via fake command ─────────────────────────

import type { ProviderProbeCommand } from './doctor.js';
import { defaultProviderProbe, REQUIRED_CAPABILITIES } from './doctor.js';

describe('defaultProviderProbe: fake command using fixture payloads', () => {
  const fakeCommand: ProviderProbeCommand = (command, args) => {
    if (command === 'claude' && args.includes('--version')) {
      return { stdout: readFixture('claude-version.txt'), stderr: '', status: 0 };
    }
    if (command === 'claude' && args.includes('status')) {
      return { stdout: readFixture('claude-auth-status.json'), stderr: '', status: 0 };
    }
    if (command === 'codex' && args.includes('--version')) {
      return { stdout: readFixture('codex-version.txt'), stderr: '', status: 0 };
    }
    if (command === 'codex' && args.includes('doctor')) {
      return { stdout: readFixture('codex-doctor.json'), stderr: '', status: 0 };
    }
    return { stdout: '', stderr: 'unknown', status: 1 };
  };

  const probe = defaultProviderProbe({ command: fakeCommand });

  it('claude probe: all required capabilities present, version extracted', () => {
    const result = probe('claude');
    expect(result.version).toBeDefined();
    expect(result.version).toMatch(/\d+\.\d+/);
    for (const cap of REQUIRED_CAPABILITIES) {
      expect(result.capabilities).toContain(cap);
    }
  });

  it('codex probe: all required capabilities present, version extracted', () => {
    const result = probe('codex');
    expect(result.version).toBeDefined();
    expect(result.version).toMatch(/\d+\.\d+/);
    for (const cap of REQUIRED_CAPABILITIES) {
      expect(result.capabilities).toContain(cap);
    }
  });
});
