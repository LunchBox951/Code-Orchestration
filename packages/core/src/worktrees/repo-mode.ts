import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNever } from '../assert-never.js';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import { defaultGitReader } from './detect-base.js';
import { defaultGitExec, type GitExec } from './sling.js';

/**
 * Mutating `gh` seam — runs `gh <args>` in `cwd` and returns the trimmed stdout string (e.g. a
 * PR URL from `gh pr create`). Throws on a non-zero exit (fail loud — Principle 9). Injectable so
 * the PR-creation path is headless-testable with a fake that records calls + returns a fixture URL,
 * with NO real network activity in `pnpm test` (AC-L5-6).
 */
export type GhExec = (cwd: string, args: readonly string[]) => string;

/** The production {@link GhExec}: run `gh <args>` in `cwd`, return trimmed stdout. */
export const defaultGhExec: GhExec = (cwd, args) => {
  try {
    return execFileSync('gh', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`co repo-mode: \`gh ${args.join(' ')}\` failed in '${cwd}': ${detail}`, {
      cause,
    });
  }
};

/**
 * Repository-relationship modes (AC-L3-4) — `docs/architecture/worktrees.md` §"Repository-relationship
 * modes". A **per-project mode** reshapes the publishing surface; the **review gate applies in all
 * three** — the mode only changes *where* reviewed work goes:
 *
 *   - `owner`        — gated `co_merge` / `co_push` to your default branch; PRs optional; `co` house style.
 *   - `contributor`  — fork → PR to upstream; PRs required; yields to the host repo's conventions.
 *   - `offline`      — `co_merge` lands locally; **push / PR disabled**; `co` house style.
 *
 * This module builds the detection + capability half (read-only detection prober, the pure detection
 * order, override-beats-detection resolution persisted in the config cascade, the Offline push/PR
 * capability, the minimal Contributor host-convention probe) AND — as of L5 — the **owner + offline
 * merge enactment** the gated `co_merge` uses ({@link CoRepoModeGate.enactPublish}), plus the real
 * remote push / PR creation enactment the gated `co_push` and `co_pr_merge` use. The rich
 * `CONTRIBUTING.md`/PR-template parse ({@link CoRepoModeGate.parseHostConventions}) remains L9 and
 * fails loud rather than no-opping (Principle 7 — gated-by-default; Principle 9 — no silent stub).
 *
 * Pristine (Principle 12): detection and host-convention reads are READ-ONLY over the repo (the
 * prober wraps read-only `git ls-remote` + `gh`, reusing the `--no-optional-locks` discipline; the
 * host-convention probe only stats repo files). Mode persistence is the **config cascade**
 * (program-data, per project) — never a repo write. The whole path is provable under
 * `assertRepoPristine(repoCwd, …)`.
 */
export type RepoMode = 'owner' | 'contributor' | 'offline';

/** The valid {@link RepoMode} values, used to validate a config override fail-loud. */
const REPO_MODES: readonly RepoMode[] = ['owner', 'contributor', 'offline'];

/** Narrow an arbitrary config value to a {@link RepoMode}, or `undefined` if it is not one. */
function asRepoMode(value: unknown): RepoMode | undefined {
  return typeof value === 'string' && (REPO_MODES as readonly string[]).includes(value)
    ? (value as RepoMode)
    : undefined;
}

/** The config-cascade key the per-project `repo.mode` override lives under. */
export const REPO_MODE_CONFIG_KEY = 'repo.mode';

/**
 * The detection signals a {@link RemoteProbe} produces — the recorded-signal table the headless tests
 * drive detection from (the L3 analogue of L1's in-process delivery double / L3-A's injectable git
 * reader). Each field is a single read-only fact about the repo's relationship to its remote.
 */
export interface RemoteSignals {
  /** Is there a reachable `origin` remote? (read-only `git ls-remote`). */
  readonly hasRemote: boolean;
  /** Is `origin` a fork whose upstream is owned by someone else? (`gh repo view`). */
  readonly isForkOfDifferentOwner: boolean;
  /** Do you have push access to `origin`? (`gh` viewer permission). */
  readonly canPush: boolean;
}

/** Produce the detection {@link RemoteSignals} for the repo at `cwd`. Injectable so detection is
 * testable headless against a recorded signals table, with no real git / `gh`. */
export type RemoteProbe = (cwd: string) => RemoteSignals;

/**
 * Run a READ-ONLY command in `cwd` and return its trimmed stdout, or `null` on a non-zero exit / a
 * missing binary. Returning `null` rather than throwing lets the prober fall through a missing signal
 * to a conservative default (no remote / no access) instead of crashing detection — a repo with no
 * `gh` installed is still detectable (it reads as "no fork, no push access"). We pass
 * `--no-optional-locks` to `git` so even a status-touching read never writes `.git` (Principle 12 —
 * pristine-repo; same discipline as `detect-base.ts` / `tools/worktree.ts`). `gh` is read-only here
 * (`repo view`), writing nothing into the repo.
 */
function readonlyCapture(cmd: string, args: readonly string[], cwd: string): string | null {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The production {@link RemoteProbe}: read-only `git ls-remote` (remote presence/reachability) + `gh`
 * (fork-of-different-owner + push access). It writes NOTHING into the repo (Principle 12). A missing
 * or failing `gh` degrades conservatively — `isForkOfDifferentOwner` and `canPush` read `false`,
 * which (with a remote present) detects `contributor`, the safe non-publishing default rather than a
 * false `owner`.
 */
export const defaultRemoteProbe: RemoteProbe = (cwd) => {
  // 1) Remote presence/reachability — read-only; `git ls-remote origin` lists the remote's refs.
  const hasRemote =
    readonlyCapture('git', ['--no-optional-locks', 'ls-remote', 'origin'], cwd) != null;
  if (!hasRemote) {
    // No reachable remote ⇒ nothing else to ask `gh` about; the other signals are vacuously false.
    return { hasRemote: false, isForkOfDifferentOwner: false, canPush: false };
  }

  // 2) Fork-of-different-owner + push access — `gh repo view` as JSON (read-only). The fields:
  //    `isFork` + `parent.owner.login` (≠ our `owner.login` ⇒ different-owner fork), and
  //    `viewerPermission` (ADMIN / MAINTAIN / WRITE ⇒ push access).
  const json = readonlyCapture(
    'gh',
    ['repo', 'view', '--json', 'isFork,owner,parent,viewerPermission'],
    cwd,
  );
  return {
    hasRemote: true,
    isForkOfDifferentOwner: parseIsForkOfDifferentOwner(json),
    canPush: parseCanPush(json),
  };
};

/** Push-granting `gh` viewer permissions (anything that can write the remote). */
const PUSH_PERMISSIONS: ReadonlySet<string> = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/** Parse `gh repo view --json …` output for the fork-of-different-owner signal; `false` on any gap. */
function parseIsForkOfDifferentOwner(json: string | null): boolean {
  const view = parseRepoView(json);
  if (!view?.isFork) return false;
  const ourOwner = view.owner?.login;
  const upstreamOwner = view.parent?.owner?.login;
  // A fork whose upstream owner is known AND differs from ours ⇒ a different-owner fork.
  return upstreamOwner != null && upstreamOwner !== ourOwner;
}

/** Parse `gh repo view --json …` output for the push-access signal; `false` on any gap. */
function parseCanPush(json: string | null): boolean {
  const view = parseRepoView(json);
  return view?.viewerPermission != null && PUSH_PERMISSIONS.has(view.viewerPermission);
}

/** The slice of `gh repo view --json` output the prober reads. */
interface RepoView {
  readonly isFork?: boolean;
  readonly owner?: { readonly login?: string };
  readonly parent?: { readonly owner?: { readonly login?: string } } | null;
  readonly viewerPermission?: string;
}

/** Parse `gh` JSON defensively — a missing/garbled payload yields `null` (read as "no signal"). */
function parseRepoView(json: string | null): RepoView | null {
  if (json == null || json.length === 0) return null;
  try {
    return JSON.parse(json) as RepoView;
  } catch {
    return null;
  }
}

/**
 * Auto-detection — the D2 order (exact). A PURE function of the recorded {@link RemoteSignals}, so it
 * is exhaustively testable from a signals table:
 *
 *   1. no remote                 → `offline`     (nothing to push/PR to)
 *   2. fork of a different owner  → `contributor` (origin is someone else's repo's fork)
 *   3. push access                → `owner`       (you can publish to your own remote)
 *   4. else                       → `contributor` (a remote you cannot push to ⇒ contribute via PR)
 */
export function detectRepoMode(s: RemoteSignals): RepoMode {
  if (!s.hasRemote) return 'offline';
  if (s.isForkOfDifferentOwner) return 'contributor';
  if (s.canPush) return 'owner';
  return 'contributor';
}

/** Injectable dependencies for {@link resolveRepoMode}: tests pass their own; the defaults open the
 * config store + use the default prober. */
export interface ResolveRepoModeDeps {
  /** The detection prober (default {@link defaultRemoteProbe}). */
  readonly probe?: RemoteProbe;
  /** An already-open config store (default: open + close one internally). */
  readonly config?: ConfigStore;
}

/**
 * Resolve the effective {@link RepoMode} for a project: **the `repo.mode` project-override beats
 * detection** (freeze #3 — this is how the operator pins a mode), otherwise auto-detect from the
 * prober.
 *
 * The override is read from the config cascade (`resolveEffective(projectId)` — global ⊕
 * project-overrides, project wins) and only wins if it names a VALID {@link RepoMode}. An absent
 * override falls through to `detectRepoMode(probe(cwd))`; a present-but-malformed override fails loud
 * so a typo in an intended Offline pin can never silently enable publishing. The override **persists
 * per project** because it lives in the per-project config layer (program-data) — that is the
 * persistence mechanism, with NO repo write (Principle 12). `config`/`probe` are injectable for
 * headless tests.
 */
export function resolveRepoMode(
  projectId: string,
  cwd: string,
  deps: ResolveRepoModeDeps = {},
): RepoMode {
  const probe = deps.probe ?? defaultRemoteProbe;
  const config = deps.config ?? openConfigStore();
  const ownsConfig = deps.config === undefined;
  try {
    const effective = config.resolveEffective(projectId);
    const rawOverride = effective[REPO_MODE_CONFIG_KEY];
    const override = asRepoMode(rawOverride);
    if (Object.prototype.hasOwnProperty.call(effective, REPO_MODE_CONFIG_KEY)) {
      if (override === undefined) {
        throw new Error(
          `repo.mode override '${String(rawOverride)}' is invalid; expected one of ` +
            REPO_MODES.join(', '),
        );
      }
      return override;
    }
    return detectRepoMode(probe(cwd));
  } finally {
    if (ownsConfig) config.close();
  }
}

/** Whether a mode permits pushing to a remote and/or opening a PR — the publishing surface a mode
 * reshapes. */
export interface RepoModeCapabilities {
  /** May reviewed work be pushed to a remote? (`owner` → your default branch · `contributor` → your fork). */
  readonly push: boolean;
  /** May a PR be opened? (`owner` optional · `contributor` required · `offline` n/a). */
  readonly pr: boolean;
}

/**
 * The capability a mode grants — **the tested L3-ownable invariant: Offline disables push/PR.** Owner
 * and Contributor both allow push (owner → default branch, contributor → fork) and a PR per the table; only
 * Offline refuses both. This is a pure capability LOOKUP — it does NOT enact anything. The *enactment*
 * is {@link CoRepoModeGate}: local merge, remote push, and PR creation are all real gated paths.
 * Exhaustive over {@link RepoMode} via {@link assertNever} — a new mode forces a decision here (no
 * silent default).
 */
export function repoModeCapabilities(mode: RepoMode): RepoModeCapabilities {
  switch (mode) {
    case 'owner':
      return { push: true, pr: true }; // push to your default branch; PRs optional (allowed).
    case 'contributor':
      return { push: true, pr: true }; // push to your fork; PRs required (allowed).
    case 'offline':
      return { push: false, pr: false }; // ← the tested L3 invariant: Offline disables push/PR.
    default:
      return assertNever(mode);
  }
}

/**
 * Minimal Contributor host-convention adaptation (D3) — a small, READ-ONLY probe of TWO signals and
 * nothing more, used when a Contributor-mode PR must yield to the host repo's conventions:
 *
 *   - `hasPrTemplate`     — does a PR-template file exist (one of the common GitHub/GitLab variants)?
 *   - `requiresSignOff`   — a MINIMAL sign-off indicator (a `Signed-off-by`/DCO mention in a
 *                           `CONTRIBUTING.md`), NOT a rich parse.
 *
 * The **rich `CONTRIBUTING.md` / PR-template parse** (extracting the actual template body, checklist
 * items, required trailers, etc.) is explicitly DEFERRED to L9 — see
 * {@link CoRepoModeGate.parseHostConventions}. This probe READS repo files and writes nothing
 * (Principle 12 — pristine holds).
 */
export interface HostConventions {
  /** Does the repo ship a pull-request template? (presence only — not its contents.) */
  readonly hasPrTemplate: boolean;
  /** Does the repo signal a sign-off / DCO requirement? (minimal indicator — not a rich parse.) */
  readonly requiresSignOff: boolean;
}

/** Common PR-template locations across hosts (GitHub + GitLab), in the order GitHub itself resolves. */
const PR_TEMPLATE_PATHS: readonly string[] = [
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
  '.gitlab/merge_request_templates', // GitLab MR-template dir (presence of the dir).
];

/** Common `CONTRIBUTING.md` locations — where a minimal sign-off signal is looked for. */
const CONTRIBUTING_PATHS: readonly string[] = [
  'CONTRIBUTING.md',
  '.github/CONTRIBUTING.md',
  'docs/CONTRIBUTING.md',
];

/** A minimal, case-insensitive sign-off / DCO indicator — deliberately NOT a rich CONTRIBUTING parse. */
const SIGN_OFF_INDICATOR = /signed-off-by|--signoff|\bDCO\b|developer certificate of origin/i;

/**
 * Detect the minimal host conventions for the repo at `cwd` (D3). Read-only: it stats the common
 * PR-template paths and scans the common `CONTRIBUTING.md` paths for a minimal sign-off indicator.
 * Writes nothing — pristine holds. `readFile` is injectable so the scan is testable without a fixture
 * tree (default: read the file if it exists, else `null`).
 */
export function detectHostConventions(
  cwd: string,
  readFile: (path: string) => string | null = defaultReadFileOrNull,
): HostConventions {
  const hasPrTemplate = PR_TEMPLATE_PATHS.some((rel) => existsSync(join(cwd, rel)));
  const requiresSignOff = CONTRIBUTING_PATHS.some((rel) => {
    const text = readFile(join(cwd, rel));
    return text != null && SIGN_OFF_INDICATOR.test(text);
  });
  return { hasPrTemplate, requiresSignOff };
}

/** Default file reader for {@link detectHostConventions}: the file's UTF-8 text, or `null` if absent
 * / unreadable. Read-only (Principle 12 holds). */
function defaultReadFileOrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * What {@link RepoModeGate.enactPublish} is handed to enact a gated merge: the reviewed source `branch`,
 * the `into` target it lands on, the house-style merge commit `message` (rendered by the review gate via
 * {@link import('./messages.js').renderMergeMessage}, NOT here — Principle 3), and the `repoCwd` git
 * runs in. Voice never reaches the artifact: this seam receives an already-rendered message.
 */
export interface PublishRequest {
  /** The reviewed source branch being integrated (e.g. `co/l5-phase-a`). */
  readonly branch: string;
  /** The target branch the merge lands on (e.g. `co/l5-review-gate`). */
  readonly into: string;
  /** The already-rendered house-style merge commit message. */
  readonly message: string;
  /** The repository the merge runs in (the lead's worktree cwd). */
  readonly repoCwd: string;
}

/** The structured result of an enacted publish — the merge commit's facts + the mode it ran in. */
export interface PublishResult {
  readonly merged: boolean;
  readonly commitSha: string;
  readonly mode: RepoMode;
}

/** Injectable git seams for {@link RepoModeGate.enactPublish}; both default to production. */
export interface EnactPublishDeps {
  /** Mutating git seam (checkout + merge). Defaults to {@link defaultGitExec}. */
  readonly gitExec?: GitExec;
  /** Read the post-merge HEAD sha. Defaults to a read-only `git rev-parse HEAD` (fail loud on a gap). */
  readonly headReader?: (repoCwd: string) => string;
}

/** The default post-merge HEAD reader: read-only `git rev-parse HEAD`, fail loud (Principle 9) on a gap. */
function defaultHeadReader(repoCwd: string): string {
  const sha = defaultGitReader(repoCwd, ['rev-parse', 'HEAD']);
  if (sha == null || sha.length === 0) {
    throw new Error(
      `RepoModeGate.enactPublish: cannot read HEAD after merge in '${repoCwd}' ` +
        '(git unavailable or not a repository).',
    );
  }
  return sha;
}

/**
 * What {@link RepoModeGate.enactPush} is handed: the reviewed `branch`, the integration `into` target,
 * and the `repoCwd`. The push target differs by mode: owner pushes `into` (the integration branch
 * carrying the merge commit) to the remote; contributor pushes `branch` (the feature branch) to origin
 * (the fork). `remote` defaults to `'origin'`.
 */
export interface EnactPushRequest {
  /** The reviewed source branch (for contributor: this is pushed to the fork). */
  readonly branch: string;
  /** The integration target branch (for owner: this is pushed to origin). */
  readonly into: string;
  /** The repository the push runs in. */
  readonly repoCwd: string;
  /** Remote to push to. Defaults to `'origin'`. */
  readonly remote?: string;
}

/** The structured result of a push enacted by {@link RepoModeGate.enactPush}. */
export interface EnactPushResult {
  readonly pushed: boolean;
  readonly remote: string;
  readonly mode: RepoMode;
}

/** Injectable git seam for {@link RepoModeGate.enactPush}; defaults to production. */
export interface EnactPushDeps {
  /** Mutating git seam (`git push`). Defaults to {@link defaultGitExec}. */
  readonly gitExec?: GitExec;
}

/**
 * What {@link RepoModeGate.enactPrMerge} is handed: the `branch` to open the PR from, the `into`
 * base branch, an already-rendered `description` (from `renderPrMessage`), and a `title`. The
 * `description` is NEVER authored by the provider — the caller renders it from a structured intent
 * before this seam is called (Principle 3).
 */
export interface EnactPrMergeRequest {
  /** The head branch to open the PR from. */
  readonly branch: string;
  /** The base branch the PR targets. */
  readonly into: string;
  /** The PR title (one line). */
  readonly title: string;
  /** The already-rendered PR body (from {@link import('./messages.js').renderPrMessage}). */
  readonly description: string;
  /** The repository the PR creation runs in. */
  readonly repoCwd: string;
}

/** The structured result of a PR enactment by {@link RepoModeGate.enactPrMerge}. */
export interface EnactPrMergeResult {
  readonly prUrl: string;
  readonly mode: RepoMode;
}

/** Injectable seams for {@link RepoModeGate.enactPrMerge}; both default to production. */
export interface EnactPrMergeDeps {
  /** Mutating `gh` seam (`gh pr create`). Defaults to {@link defaultGhExec}. */
  readonly ghExec?: GhExec;
  /**
   * File reader for {@link detectHostConventions} — injectable so contributor-mode convention
   * detection is testable headless without a fixture tree. Defaults to `defaultReadFileOrNull`.
   */
  readonly readFile?: (path: string) => string | null;
}

/**
 * The repository-mode enactment gate. As of Phase C the push + PR verbs are REAL:
 *
 *   - {@link enactPublish} — owner + offline: a local `--no-ff` merge (the `co_merge` path). Contributor
 *     (fork→PR) throws loud — use `enactPush` + `enactPrMerge` instead.
 *   - {@link enactPush} — owner: `git push origin <into>` (push the integration branch); contributor:
 *     `git push origin <branch>` (push the feature branch to fork); offline: refuse (Principle 9).
 *   - {@link enactPrMerge} — owner + contributor: `gh pr create` with the pre-rendered description;
 *     offline: refuse. Contributor additionally probes host conventions via {@link detectHostConventions}
 *     (the minimal Phase C probe; the rich parse is L9 — {@link parseHostConventions} stays loud-failing).
 *   - {@link parseHostConventions} — the rich `CONTRIBUTING.md`/PR-template parse remains **L9**.
 *
 * The only repo writes are: a merge commit (enactPublish), a git push (enactPush), and a gh PR
 * (enactPrMerge). Orchestration state lands in program-data (Principle 12).
 */
export interface RepoModeGate {
  /**
   * Enact a gated merge in `mode`. Real for `owner` + `offline` (local merge); throws for `contributor`
   * (fork→PR publishing — use `enactPush` + `enactPrMerge`). The PASS gate is applied by the review gate
   * BEFORE this is called — this seam only enacts the merge for an already-blessed branch.
   */
  enactPublish(req: PublishRequest, mode: RepoMode, deps?: EnactPublishDeps): PublishResult;
  /**
   * Enact a gated push in `mode`. Owner pushes the integration branch to origin; contributor pushes
   * the feature branch to the fork remote; offline refuses loud (AC-L5-6, Principle 9).
   */
  enactPush(req: EnactPushRequest, mode: RepoMode, deps?: EnactPushDeps): EnactPushResult;
  /**
   * Enact a gated PR creation in `mode`. Owner + contributor create a PR via `gh`; offline refuses
   * loud (AC-L5-6, Principle 9). Contributor additionally probes host conventions (minimal Phase C
   * probe — {@link detectHostConventions}; the rich parse is {@link parseHostConventions}, L9).
   */
  enactPrMerge(
    req: EnactPrMergeRequest,
    mode: RepoMode,
    deps?: EnactPrMergeDeps,
  ): EnactPrMergeResult;
  /**
   * The RICH host-convention parse a Contributor PR yields to — extract the actual PR-template body,
   * required checklist items, and trailers from `CONTRIBUTING.md` / the PR template. Returns `never`:
   * the rich parse is L9 (this layer ships only the minimal presence/sign-off probe above).
   */
  parseHostConventions(cwd: string): never;
}

/**
 * The production {@link RepoModeGate}. As of Phase C, `enactPublish` (local merge), `enactPush`
 * (remote push), and `enactPrMerge` (PR creation) are all REAL; `parseHostConventions` stays the
 * loud-failing L9 seam (never a silent no-op — Principle 9).
 */
export class CoRepoModeGate implements RepoModeGate {
  enactPublish(req: PublishRequest, mode: RepoMode, deps: EnactPublishDeps = {}): PublishResult {
    const gitExec = deps.gitExec ?? defaultGitExec;
    const headReader = deps.headReader ?? defaultHeadReader;
    switch (mode) {
      case 'owner':
      case 'offline': {
        // Owner + offline both land a LOCAL merge in L5: check out the target, then a `--no-ff` merge
        // of the reviewed branch with the already-rendered house-style message. Owner's remote PUSH is
        // Phase C (`co_push`); Offline never pushes (repoModeCapabilities). The merge commit is the
        // only repo write — orchestration state is recorded to program-data (Principle 12).
        gitExec(req.repoCwd, ['checkout', req.into]);
        gitExec(req.repoCwd, ['merge', '--no-ff', '-m', req.message, req.branch]);
        return { merged: true, commitSha: headReader(req.repoCwd), mode };
      }
      case 'contributor':
        throw new Error(
          'RepoModeGate.enactPublish: contributor mode cannot locally merge; publish through the ' +
            'gated co_push / co_pr_merge path, or resolve the repo mode to owner/offline for a ' +
            'local merge.',
        );
      default:
        return assertNever(mode);
    }
  }

  enactPush(req: EnactPushRequest, mode: RepoMode, deps: EnactPushDeps = {}): EnactPushResult {
    const gitExec = deps.gitExec ?? defaultGitExec;
    const remote = req.remote ?? 'origin';
    switch (mode) {
      case 'owner':
        // Owner: push the integration branch (into) — which already carries the merge commit — to origin.
        gitExec(req.repoCwd, ['push', remote, req.into]);
        return { pushed: true, remote, mode: 'owner' };
      case 'contributor':
        // Contributor: push the feature branch to origin (the fork); the PR creation is enactPrMerge.
        gitExec(req.repoCwd, ['push', remote, req.branch]);
        return { pushed: true, remote, mode: 'contributor' };
      case 'offline':
        throw new Error(
          'RepoModeGate.enactPush: refused — push capability is false in offline mode ' +
            '(repoModeCapabilities.push === false). Configure owner or contributor mode to enable ' +
            'remote push (AC-L5-6, Principle 9 — no silent no-op).',
        );
      default:
        return assertNever(mode);
    }
  }

  enactPrMerge(
    req: EnactPrMergeRequest,
    mode: RepoMode,
    deps: EnactPrMergeDeps = {},
  ): EnactPrMergeResult {
    const ghExec = deps.ghExec ?? defaultGhExec;
    switch (mode) {
      case 'owner': {
        const prUrl = ghExec(req.repoCwd, [
          'pr',
          'create',
          '--base',
          req.into,
          '--head',
          req.branch,
          '--title',
          req.title,
          '--body',
          req.description,
        ]);
        return { prUrl, mode: 'owner' };
      }
      case 'contributor': {
        // Detect minimal host conventions (PR-template presence + sign-off indicator). The rich
        // CONTRIBUTING.md / PR-template parse is deferred to L9 (parseHostConventions stays loud-failing).
        // Phase C: we probe and note conventions; the agent has already surfaced them in PrIntent.conventions.
        void detectHostConventions(req.repoCwd, deps.readFile);
        const prUrl = ghExec(req.repoCwd, [
          'pr',
          'create',
          '--base',
          req.into,
          '--head',
          req.branch,
          '--title',
          req.title,
          '--body',
          req.description,
        ]);
        return { prUrl, mode: 'contributor' };
      }
      case 'offline':
        throw new Error(
          'RepoModeGate.enactPrMerge: refused — PR capability is false in offline mode ' +
            '(repoModeCapabilities.pr === false). Configure owner or contributor mode to enable ' +
            'PR creation (AC-L5-6, Principle 9 — no silent no-op).',
        );
      default:
        return assertNever(mode);
    }
  }

  parseHostConventions(): never {
    throw new Error(
      'RepoModeGate.parseHostConventions: the rich CONTRIBUTING.md / PR-template parse is not ' +
        'implemented (deferred to L9): extract the template body, checklist, and required trailers a ' +
        'Contributor PR must yield to. This module detects PR-template presence + a minimal sign-off ' +
        'signal only (detectHostConventions).',
    );
  }
}
