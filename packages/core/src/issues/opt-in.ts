/**
 * L6b G layered opt-in policy (specs-and-issues.md §"Layered opt-in"): the issue pipeline is
 * gated by three independent switches — `capture` (local) → `publish` (GitHub) → `self-assign` —
 * each more invasive, each its own config key, **all OFF by default** so a stranger repo never
 * auto-files. A later layer has effect only when every earlier layer is on: publishing requires
 * capture, self-assign requires publish.
 *
 * The switches ride the existing L0 config cascade (global ⊕ project-overrides, project wins) —
 * no new config machinery. Only the JSON boolean `true` enables a layer; any other value
 * (including truthy strings) stays OFF, so a malformed value can never silently enable an outward
 * surface.
 */
import { openConfigStore, type ConfigStore } from '../config/config-store.js';

/** Config key: enable LOCAL friction capture (`issue.captured` records). Default OFF. */
export const ISSUE_CAPTURE_KEY = 'issues.capture' as const;

/** Config key: enable OUTWARD publishing (GitHub filing, still per-post approved). Default OFF. */
export const ISSUE_PUBLISH_KEY = 'issues.publish' as const;

/** Config key: enable the owner-only self-assign/self-heal loop. Default OFF. */
export const ISSUE_SELF_ASSIGN_KEY = 'issues.selfAssign' as const;

/** The effective, layered opt-in switches for the issue pipeline. */
export interface IssueOptIns {
  readonly capture: boolean;
  readonly publish: boolean;
  readonly selfAssign: boolean;
}

/**
 * Apply the layering rule to raw config values (pure): a switch counts only as the boolean
 * `true`, and a later layer is effective only when every earlier layer is on.
 */
export function layerIssueOptIns(raw: {
  readonly capture?: unknown;
  readonly publish?: unknown;
  readonly selfAssign?: unknown;
}): IssueOptIns {
  const capture = raw.capture === true;
  const publish = capture && raw.publish === true;
  const selfAssign = publish && raw.selfAssign === true;
  return { capture, publish, selfAssign };
}

/**
 * Resolve the effective opt-ins for `projectId` from the config cascade. `config` is injectable
 * for headless tests / reuse of an already-open store; the default opens + closes one internally
 * (mirrors `resolveMaxActiveChildren` / `resolveRepoMode`).
 */
export function resolveIssueOptIns(projectId: string, config?: ConfigStore): IssueOptIns {
  const store = config ?? openConfigStore();
  const ownsStore = config === undefined;
  try {
    const effective = store.resolveEffective(projectId);
    return layerIssueOptIns({
      capture: effective[ISSUE_CAPTURE_KEY],
      publish: effective[ISSUE_PUBLISH_KEY],
      selfAssign: effective[ISSUE_SELF_ASSIGN_KEY],
    });
  } finally {
    if (ownsStore) store.close();
  }
}
