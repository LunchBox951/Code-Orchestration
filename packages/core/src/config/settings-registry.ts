import { z } from 'zod';
import { MAX_ACTIVE_CHILDREN_KEY, MAX_ACTIVE_CHILDREN_DEFAULT } from '../plans/child-cap.js';
import { REPO_MODE_CONFIG_KEY } from '../worktrees/repo-mode.js';
import { reviewReviewerKey } from '../review/human-review.js';
import { REVIEW_ROUND_BUDGET_KEY, REVIEW_ROUND_BUDGET_DEFAULT } from '../review/strikes.js';
import {
  CLARIFY_TIMEOUT_SECONDS_KEY,
  CLARIFY_TIMEOUT_SECONDS_DEFAULT,
} from '../mail/escalation.js';
import { IDENTITY_PERSONA_KEY, isEmailAddress } from '../permissions/identity-guard.js';
import { ISSUE_CAPTURE_KEY, ISSUE_PUBLISH_KEY, ISSUE_SELF_ASSIGN_KEY } from '../issues/opt-in.js';
import { MAXED_THRESHOLD_PCT_DEFAULT } from '../dispatch/throttle.js';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  workSizeSchema,
  reasoningBudgetSchema,
  type WorkSize,
} from '../dispatch/tier.js';
import type { Provider } from '../dispatch/usage-source.js';
import {
  DISPATCH_ENABLED_PROVIDERS_KEY,
  DISPATCH_MAXED_THRESHOLD_PCT_KEY,
  DISPATCH_MODELS_CLAUDE_KEY,
  DISPATCH_MODELS_CODEX_KEY,
  DISPATCH_DEFAULT_WORK_SIZE_KEY,
  DISPATCH_DEFAULT_REASONING_BUDGET_KEY,
  ALL_PROVIDERS,
  ENABLED_PROVIDERS_DEFAULT,
  DEFAULT_WORK_SIZE_DEFAULT,
  DEFAULT_REASONING_BUDGET_DEFAULT,
  // Shared validation schemas — the SAME predicates the dispatch resolvers fail loud on (AC-SET-4).
  enabledProvidersSchema,
  modelTierSchema,
  maxedThresholdPctSchema,
} from '../dispatch/dispatch-config.js';

/**
 * The authoritative catalog of operator-editable settings for the desktop Settings tab (AC-SET-1).
 * ONE entry per config key — the single definition the renderer renders from (via the serializable
 * {@link settingsDescriptors}) AND the main process validates writes against (via
 * {@link validateSettingValue}). Validators mirror the existing per-domain resolver rules so the UI
 * rejects exactly what the resolver would fail loud on (Principle 9), but fails gracefully inline
 * instead. No setting here is a safety invariant (the merge gate, required capabilities, and the
 * review ladder are deliberately NOT editable).
 */

export const SETTINGS_SECTIONS = [
  'Providers',
  'Headroom & Concurrency',
  'Models & Effort',
  'Review & Merge',
  'Timeouts & Identity',
  'Issues',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The control to render for a setting; plain data so it is JSON-serializable across IPC. */
export type SettingControl =
  | { readonly kind: 'toggle' }
  | {
      readonly kind: 'integer';
      readonly min: number;
      readonly max?: number;
      readonly unit?: string;
    }
  | {
      readonly kind: 'enum';
      readonly options: readonly { value: string; label: string }[];
      readonly clearable?: boolean;
    }
  | { readonly kind: 'persona' }
  | { readonly kind: 'provider-set'; readonly providers: readonly Provider[] }
  | {
      readonly kind: 'model-tier';
      readonly provider: Provider;
      readonly tiers: readonly { readonly key: WorkSize; readonly label: string }[];
      readonly suggestions: readonly string[];
    };

/** Serializable metadata for one setting (everything the renderer needs; no functions). */
export interface SettingDescriptor {
  readonly key: string;
  readonly section: SettingsSection;
  readonly label: string;
  readonly description: string;
  readonly control: SettingControl;
  readonly defaultValue: unknown;
  readonly perProject: boolean;
  readonly primaryLayer: 'global' | 'project';
  /**
   * Gating: this setting is inert unless the named key currently equals `equals`. Restricted to
   * JSON primitives so the consumer's `===` comparison is sound (a non-primitive sentinel would
   * never compare equal across a JSON round-trip).
   */
  readonly dependsOn?: { readonly key: string; readonly equals: string | number | boolean | null };
}

/** A descriptor plus its write-path validator (core-side only; not serialized). */
export interface SettingEntry extends SettingDescriptor {
  readonly validate: (value: unknown) => SettingValidation;
}

export type SettingValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

const MODEL_TIERS: readonly { readonly key: WorkSize; readonly label: string }[] = [
  { key: 'simple', label: 'Simple' },
  { key: 'average', label: 'Average' },
  { key: 'technical', label: 'Technical' },
];

// Persona reuses identity-guard's canonical email predicate so the UI rejects exactly what the
// worktree-identity guard would (one rule, not a re-spelled regex).
const personaSchema = z
  .object({
    name: z.string().trim().min(1),
    email: z.string().refine(isEmailAddress, 'invalid email'),
  })
  .strict();

/**
 * Turn a zod schema into a value validator that reports a single friendly, setting-specific message
 * on failure (zod's own per-issue text is too low-level for the Settings UI). The schema is the
 * gate; `message` is the human explanation shown inline.
 */
function zodValidate(schema: z.ZodType, message: string): (value: unknown) => SettingValidation {
  return (value) =>
    schema.safeParse(value).success ? { ok: true } : { ok: false, error: message };
}

const REVIEWER_OPTIONS = [
  { value: 'agent', label: 'Agent (automated)' },
  { value: 'human', label: 'Human (you review)' },
] as const;

/** One reviewer-kind entry per merge scope (agent vs human). */
function reviewerEntry(
  scope: 'worker_merge' | 'phase_merge' | 'pr_merge',
  label: string,
): SettingEntry {
  return {
    key: reviewReviewerKey(scope),
    section: 'Review & Merge',
    label: `Reviewer — ${label}`,
    description: `Who reviews at the ${label.toLowerCase()} gate: an automated agent, or you (the gate waits for your verdict).`,
    control: { kind: 'enum', options: REVIEWER_OPTIONS },
    defaultValue: 'agent',
    perProject: true,
    primaryLayer: 'project',
    validate: zodValidate(z.enum(['agent', 'human']), 'choose agent or human'),
  };
}

/** Per-provider model-tier table entry. */
function modelEntry(
  key: string,
  provider: 'claude' | 'codex',
  label: string,
  defaults: Record<string, string>,
): SettingEntry {
  return {
    key,
    section: 'Models & Effort',
    label: `${label} models`,
    description: `Which ${label} model each work-size tier uses. Unset tiers keep the built-in default.`,
    control: {
      kind: 'model-tier',
      provider,
      tiers: MODEL_TIERS,
      suggestions: Object.values(defaults),
    },
    defaultValue: defaults,
    perProject: true,
    primaryLayer: 'project',
    validate: zodValidate(
      modelTierSchema,
      'each tier must map to a non-empty model id (simple/average/technical only)',
    ),
  };
}

/** Layered issue opt-in toggle (publish requires capture; self-assign requires publish). */
function issueToggle(
  key: string,
  label: string,
  description: string,
  dependsOn?: { key: string; equals: string | number | boolean | null },
): SettingEntry {
  return {
    key,
    section: 'Issues',
    label,
    description,
    control: { kind: 'toggle' },
    defaultValue: false,
    perProject: true,
    primaryLayer: 'project',
    ...(dependsOn ? { dependsOn } : {}),
    validate: zodValidate(z.boolean(), 'must be true or false'),
  };
}

export const SETTINGS_REGISTRY: readonly SettingEntry[] = [
  // ── Providers ───────────────────────────────────────────────────────────────
  {
    key: DISPATCH_ENABLED_PROVIDERS_KEY,
    section: 'Providers',
    label: 'Enabled providers',
    description:
      'Which providers may run work. Disabling one stops new work floating to it. At least one must stay enabled.',
    control: { kind: 'provider-set', providers: ALL_PROVIDERS },
    defaultValue: ENABLED_PROVIDERS_DEFAULT,
    perProject: true,
    primaryLayer: 'global',
    validate: zodValidate(enabledProvidersSchema, 'enable at least one known provider'),
  },
  // ── Headroom & Concurrency ────────────────────────────────────────────────────
  {
    key: DISPATCH_MAXED_THRESHOLD_PCT_KEY,
    section: 'Headroom & Concurrency',
    label: 'Window-full threshold (%)',
    description:
      'Subscription-usage headroom: above this utilization a provider window is treated as full and stops taking new work.',
    control: { kind: 'integer', min: 0, max: 100, unit: '%' },
    defaultValue: MAXED_THRESHOLD_PCT_DEFAULT,
    perProject: true,
    primaryLayer: 'project',
    validate: zodValidate(maxedThresholdPctSchema, 'must be a number between 0 and 100'),
  },
  {
    key: MAX_ACTIVE_CHILDREN_KEY,
    section: 'Headroom & Concurrency',
    label: 'Max parallel agents',
    description:
      'How many subagents run in parallel under one parent. Higher spends subscription headroom faster.',
    control: { kind: 'integer', min: 1 },
    defaultValue: MAX_ACTIVE_CHILDREN_DEFAULT,
    perProject: true,
    primaryLayer: 'project',
    validate: zodValidate(z.number().int().min(1), 'must be a whole number of 1 or more'),
  },
  // ── Models & Effort ───────────────────────────────────────────────────────────
  modelEntry(DISPATCH_MODELS_CLAUDE_KEY, 'claude', 'Claude', CLAUDE_MODELS),
  modelEntry(DISPATCH_MODELS_CODEX_KEY, 'codex', 'Codex', CODEX_MODELS),
  {
    key: DISPATCH_DEFAULT_WORK_SIZE_KEY,
    section: 'Models & Effort',
    label: 'Default work size',
    description: 'The work-size tier applied to a dispatch that does not specify one.',
    control: {
      kind: 'enum',
      options: [
        { value: 'simple', label: 'Simple' },
        { value: 'average', label: 'Average' },
        { value: 'technical', label: 'Technical' },
      ],
    },
    defaultValue: DEFAULT_WORK_SIZE_DEFAULT,
    perProject: true,
    primaryLayer: 'project',
    validate: zodValidate(workSizeSchema, 'choose a work size'),
  },
  {
    key: DISPATCH_DEFAULT_REASONING_BUDGET_KEY,
    section: 'Models & Effort',
    label: 'Default reasoning budget',
    description: 'The reasoning-depth preference applied to a dispatch that does not specify one.',
    control: {
      kind: 'enum',
      options: [
        { value: 'economy', label: 'Economy' },
        { value: 'standard', label: 'Standard' },
        { value: 'deep', label: 'Deep' },
      ],
    },
    defaultValue: DEFAULT_REASONING_BUDGET_DEFAULT,
    perProject: true,
    primaryLayer: 'project',
    validate: zodValidate(reasoningBudgetSchema, 'choose a reasoning budget'),
  },
  // ── Review & Merge ──────────────────────────────────────────────────────────
  {
    key: REPO_MODE_CONFIG_KEY,
    section: 'Review & Merge',
    label: 'Repository mode',
    description:
      'How work is published: owner (merge/push to the default branch), contributor (fork → PR), or offline (local merge only). Auto-detect clears the override.',
    control: {
      kind: 'enum',
      clearable: true,
      options: [
        { value: 'owner', label: 'Owner' },
        { value: 'contributor', label: 'Contributor' },
        { value: 'offline', label: 'Offline' },
      ],
    },
    defaultValue: null, // unset → auto-detected
    perProject: true,
    primaryLayer: 'project',
    validate: zodValidate(
      z.enum(['owner', 'contributor', 'offline']),
      'choose owner, contributor, or offline',
    ),
  },
  reviewerEntry('worker_merge', 'Worker merge'),
  reviewerEntry('phase_merge', 'Phase merge'),
  reviewerEntry('pr_merge', 'PR merge'),
  {
    key: REVIEW_ROUND_BUDGET_KEY,
    section: 'Review & Merge',
    label: 'Fix-loop budget',
    description:
      'How many consecutive ISSUES review rounds a worker gets before the gate escalates to you.',
    control: { kind: 'integer', min: 1 },
    defaultValue: REVIEW_ROUND_BUDGET_DEFAULT,
    perProject: true,
    primaryLayer: 'project',
    validate: zodValidate(z.number().int().min(1), 'must be a whole number of 1 or more'),
  },
  // ── Timeouts & Identity ───────────────────────────────────────────────────────
  {
    key: CLARIFY_TIMEOUT_SECONDS_KEY,
    section: 'Timeouts & Identity',
    label: 'Clarify timeout (seconds)',
    description:
      'How long an unanswered clarify question waits before it escalates up the chain. 0 disables the timer.',
    control: { kind: 'integer', min: 0, unit: 's' },
    defaultValue: CLARIFY_TIMEOUT_SECONDS_DEFAULT,
    perProject: true,
    primaryLayer: 'project',
    validate: zodValidate(z.number().finite().min(0), 'must be a number of seconds (0 or more)'),
  },
  {
    key: IDENTITY_PERSONA_KEY,
    section: 'Timeouts & Identity',
    label: 'Commit identity',
    description:
      'Name and email stamped into worktree commits (Signed-off-by). Leave unset to inherit your global git identity.',
    control: { kind: 'persona' },
    defaultValue: null,
    perProject: true,
    primaryLayer: 'project',
    validate: zodValidate(personaSchema, 'enter a name and a valid email address'),
  },
  // ── Issues (layered) ──────────────────────────────────────────────────────────
  issueToggle(
    ISSUE_CAPTURE_KEY,
    'Capture friction as issues',
    'Record local issue notes when work hits friction.',
  ),
  issueToggle(
    ISSUE_PUBLISH_KEY,
    'Publish issues to GitHub',
    'File captured issues outward to GitHub (each still approved per post). Requires capture.',
    { key: ISSUE_CAPTURE_KEY, equals: true },
  ),
  issueToggle(
    ISSUE_SELF_ASSIGN_KEY,
    'Self-assign published issues',
    'Owner self-heal loop: assign published issues back for autonomous fixing. Requires publish.',
    { key: ISSUE_PUBLISH_KEY, equals: true },
  ),
];

/** Index for O(1) lookups by key. */
const BY_KEY = new Map<string, SettingEntry>(SETTINGS_REGISTRY.map((e) => [e.key, e]));

/** Project a registry entry down to its serializable descriptor (drops the validator function). */
function toDescriptor(e: SettingEntry): SettingDescriptor {
  return {
    key: e.key,
    section: e.section,
    label: e.label,
    description: e.description,
    control: e.control,
    defaultValue: e.defaultValue,
    perProject: e.perProject,
    primaryLayer: e.primaryLayer,
    ...(e.dependsOn ? { dependsOn: e.dependsOn } : {}),
  };
}

/** The serializable descriptors (validators stripped) for the renderer / IPC. */
export function settingsDescriptors(): readonly SettingDescriptor[] {
  return SETTINGS_REGISTRY.map(toDescriptor);
}

/** Validate a value for one setting key against its registry rule (the write gate). */
export function validateSettingValue(key: string, value: unknown): SettingValidation {
  const entry = BY_KEY.get(key);
  if (entry === undefined) return { ok: false, error: `unknown setting '${key}'` };
  return entry.validate(value);
}
