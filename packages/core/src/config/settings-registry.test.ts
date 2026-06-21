import { describe, it, expect } from 'vitest';
import {
  SETTINGS_REGISTRY,
  SETTINGS_SECTIONS,
  settingsDescriptors,
  validateSettingValue,
} from './settings-registry.js';
import { MAX_ACTIVE_CHILDREN_KEY } from '../plans/child-cap.js';
import { REPO_MODE_CONFIG_KEY } from '../worktrees/repo-mode.js';
import { reviewReviewerKey } from '../review/human-review.js';
import { REVIEW_ROUND_BUDGET_KEY } from '../review/strikes.js';
import { CLARIFY_TIMEOUT_SECONDS_KEY } from '../mail/escalation.js';
import { IDENTITY_PERSONA_KEY } from '../permissions/identity-guard.js';
import { ISSUE_CAPTURE_KEY, ISSUE_PUBLISH_KEY, ISSUE_SELF_ASSIGN_KEY } from '../issues/opt-in.js';
import {
  DISPATCH_ENABLED_PROVIDERS_KEY,
  DISPATCH_MAXED_THRESHOLD_PCT_KEY,
  DISPATCH_MODELS_CLAUDE_KEY,
  DISPATCH_MODELS_CODEX_KEY,
  DISPATCH_DEFAULT_WORK_SIZE_KEY,
  DISPATCH_DEFAULT_REASONING_BUDGET_KEY,
} from '../dispatch/dispatch-config.js';

const EXPECTED_KEYS = [
  DISPATCH_ENABLED_PROVIDERS_KEY,
  DISPATCH_MAXED_THRESHOLD_PCT_KEY,
  MAX_ACTIVE_CHILDREN_KEY,
  DISPATCH_MODELS_CLAUDE_KEY,
  DISPATCH_MODELS_CODEX_KEY,
  DISPATCH_DEFAULT_WORK_SIZE_KEY,
  DISPATCH_DEFAULT_REASONING_BUDGET_KEY,
  REPO_MODE_CONFIG_KEY,
  reviewReviewerKey('worker_merge'),
  reviewReviewerKey('phase_merge'),
  reviewReviewerKey('pr_merge'),
  REVIEW_ROUND_BUDGET_KEY,
  CLARIFY_TIMEOUT_SECONDS_KEY,
  IDENTITY_PERSONA_KEY,
  ISSUE_CAPTURE_KEY,
  ISSUE_PUBLISH_KEY,
  ISSUE_SELF_ASSIGN_KEY,
];

describe('settings registry (AC-SET-1)', () => {
  it('catalogs exactly the 17 v1 keys, each in a known section', () => {
    const keys = SETTINGS_REGISTRY.map((e) => e.key);
    expect(keys.length).toBe(17);
    expect(new Set(keys)).toEqual(new Set(EXPECTED_KEYS));
    for (const e of SETTINGS_REGISTRY) expect(SETTINGS_SECTIONS).toContain(e.section);
  });

  it('has no duplicate keys', () => {
    const keys = SETTINGS_REGISTRY.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('descriptors are JSON-serializable (no functions cross the IPC boundary)', () => {
    const d = settingsDescriptors();
    expect(d.length).toBe(17);
    const json = JSON.stringify(d);
    expect(() => JSON.parse(json)).not.toThrow();
    // round-trips to plain data, and the validator function is stripped
    expect(JSON.parse(json)).toEqual(d.map((x) => JSON.parse(JSON.stringify(x))));
    for (const desc of d) expect('validate' in desc).toBe(false);
  });

  it('issue toggles declare their gating dependencies', () => {
    const byKey = new Map(settingsDescriptors().map((d) => [d.key, d]));
    expect(byKey.get(ISSUE_CAPTURE_KEY)?.dependsOn).toBeUndefined();
    expect(byKey.get(ISSUE_PUBLISH_KEY)?.dependsOn).toEqual({ key: ISSUE_CAPTURE_KEY, equals: true });
    expect(byKey.get(ISSUE_SELF_ASSIGN_KEY)?.dependsOn).toEqual({ key: ISSUE_PUBLISH_KEY, equals: true });
  });
});

describe('validateSettingValue (AC-SET-4) — mirrors resolver rules', () => {
  it('rejects unknown keys', () => {
    expect(validateSettingValue('nope.key', 1).ok).toBe(false);
  });

  it('integers: max parallel agents / fix-loop budget require >= 1', () => {
    expect(validateSettingValue(MAX_ACTIVE_CHILDREN_KEY, 0).ok).toBe(false);
    expect(validateSettingValue(MAX_ACTIVE_CHILDREN_KEY, 1.5).ok).toBe(false);
    expect(validateSettingValue(MAX_ACTIVE_CHILDREN_KEY, 3).ok).toBe(true);
    expect(validateSettingValue(REVIEW_ROUND_BUDGET_KEY, 0).ok).toBe(false);
    expect(validateSettingValue(REVIEW_ROUND_BUDGET_KEY, 3).ok).toBe(true);
  });

  it('threshold: 0..100', () => {
    expect(validateSettingValue(DISPATCH_MAXED_THRESHOLD_PCT_KEY, 95).ok).toBe(true);
    expect(validateSettingValue(DISPATCH_MAXED_THRESHOLD_PCT_KEY, 150).ok).toBe(false);
    expect(validateSettingValue(DISPATCH_MAXED_THRESHOLD_PCT_KEY, -1).ok).toBe(false);
  });

  it('enabled providers: non-empty, known members', () => {
    expect(validateSettingValue(DISPATCH_ENABLED_PROVIDERS_KEY, ['claude']).ok).toBe(true);
    expect(validateSettingValue(DISPATCH_ENABLED_PROVIDERS_KEY, []).ok).toBe(false);
    expect(validateSettingValue(DISPATCH_ENABLED_PROVIDERS_KEY, ['bogus']).ok).toBe(false);
  });

  it('repo mode: enum', () => {
    expect(validateSettingValue(REPO_MODE_CONFIG_KEY, 'owner').ok).toBe(true);
    expect(validateSettingValue(REPO_MODE_CONFIG_KEY, 'nope').ok).toBe(false);
  });

  it('reviewer kind: agent|human', () => {
    expect(validateSettingValue(reviewReviewerKey('pr_merge'), 'human').ok).toBe(true);
    expect(validateSettingValue(reviewReviewerKey('pr_merge'), 'robot').ok).toBe(false);
  });

  it('persona: name + valid email', () => {
    expect(validateSettingValue(IDENTITY_PERSONA_KEY, { name: 'A', email: 'a@b.co' }).ok).toBe(true);
    expect(validateSettingValue(IDENTITY_PERSONA_KEY, { name: 'A', email: 'bad' }).ok).toBe(false);
    expect(validateSettingValue(IDENTITY_PERSONA_KEY, { name: '', email: 'a@b.co' }).ok).toBe(false);
  });

  it('model tier: non-empty model ids, no unknown tiers', () => {
    expect(validateSettingValue(DISPATCH_MODELS_CLAUDE_KEY, { technical: 'x' }).ok).toBe(true);
    expect(validateSettingValue(DISPATCH_MODELS_CLAUDE_KEY, { technical: '' }).ok).toBe(false);
    expect(validateSettingValue(DISPATCH_MODELS_CLAUDE_KEY, { huge: 'x' }).ok).toBe(false);
  });

  it('issue toggles: boolean', () => {
    expect(validateSettingValue(ISSUE_CAPTURE_KEY, true).ok).toBe(true);
    expect(validateSettingValue(ISSUE_CAPTURE_KEY, 'yes').ok).toBe(false);
  });
});
