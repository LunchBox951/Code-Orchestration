import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertNever } from '../assert-never.js';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';

/**
 * Repository-relationship modes (AC-L3-4) — `docs/architecture/worktrees.md` §"Repository-relationship
 * modes". A **per-project mode** reshapes the publishing surface; the **review gate applies in all
 * three** — the mode only changes *where* reviewed work goes:
 *
 *   - `owner`        — gated `co_merge` / `co_push` to your default branch; PRs optional; `co` house style.
 *   - `contributor`  — fork → PR to upstream; PRs required; yields to the host repo's conventions.
 *   - `offline`      — `co_merge` lands locally; **push / PR disabled**; `co` house style.
 *
 * This module builds the **L3-ownable half**: the read-only detection prober, the pure detection
 * order, the override-beats-detection resolution (persisted in the config cascade), the Offline
 * push/PR capability, and the minimal Contributor host-convention probe. The gated verbs that *act*
 * on a mode (`co_merge` / `co_push` / `co_pr_merge`, the Contributor fork→PR enactment, "the gate
 * applies in all three") are **L5** — marked here by the loud-failing {@link RepoModeGateStub}, never
 * built and never declared as an MCP tool (Principle 7 — gated-by-default holds because the gated
 * verbs are simply NOT BUILT here).
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
 * project-overrides, project wins) and only wins if it names a VALID {@link RepoMode}; a malformed or
 * absent override falls through to `detectRepoMode(probe(cwd))`. The override **persists per project**
 * because it lives in the per-project config layer (program-data) — that is the persistence mechanism,
 * with NO repo write (Principle 12). `config`/`probe` are injectable for headless tests.
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
    const override = asRepoMode(config.resolveEffective(projectId)[REPO_MODE_CONFIG_KEY]);
    if (override !== undefined) return override; // project-override wins over detection.
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
 * (the gated verbs that consult it, the Contributor fork→PR flow, "the gate applies in all three") is
 * L5: see {@link RepoModeGateStub}. Exhaustive over {@link RepoMode} via {@link assertNever} — a new
 * mode forces a decision here (no silent default).
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
 * items, required trailers, etc.) is explicitly DEFERRED to L5/L9 — see {@link RepoModeGateStub}. This
 * probe READS repo files and writes nothing (Principle 12 — pristine holds).
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
 * The L5 plug-point — the gated verbs + Contributor fork→PR enactment + "the gate applies in all
 * three" + the rich CONTRIBUTING/PR-template parse that L3 STOPS short of (freeze #2). A TYPED stub
 * marking the seam — copied from L1's `LiveDeliveryStub` / L3-C's `FinishReviewGateStub`: it fails
 * loud (Principle 9) rather than being a silent no-op, because a silent stub is exactly the fallback
 * that hid the prototype's gaps. NOTHING in L3 calls it — it exists so the L5 boundary is a real,
 * typed thing rather than an absence, and so the absence of any gated merge/push/PR verb in L3 is a
 * deliberate, documented boundary (Principle 7 — gated-by-default holds because the gated verbs are
 * simply NOT BUILT here, and NO `co_*` tool is declared for them — Principle 4).
 */
export interface RepoModeGate {
  /**
   * Enact the publishing surface for a reviewed branch in `mode` — the gated `co_merge`/`co_push`
   * (Owner → default branch · Offline → local only) and the Contributor fork→PR flow, with the review gate
   * applied in all three. Returns `never`: L5 finalizes the params + lifecycle; this only marks the
   * seam.
   */
  enactPublish(branch: string, mode: RepoMode): never;
  /**
   * The RICH host-convention parse a Contributor PR yields to — extract the actual PR-template body,
   * required checklist items, and trailers from `CONTRIBUTING.md` / the PR template. Returns `never`:
   * the rich parse is L5/L9 (this layer ships only the minimal presence/sign-off probe above).
   */
  parseHostConventions(cwd: string): never;
}

/** The L5 STUB gate. Both methods fail loud (Principle 9) until L5/L9 own enactment + the rich parse —
 * never a silent no-op. They throw regardless of arguments. */
export class RepoModeGateStub implements RepoModeGate {
  // L5 PLUG-POINT (review-gates.md). The production gate must:
  //  (1) enact the gated publish per mode — Owner → gated co_merge/co_push to default branch; Contributor →
  //      fork→PR to upstream; Offline → local co_merge only (push/PR refused per repoModeCapabilities);
  //  (2) apply the review gate in ALL THREE modes (no path to master/remote/PR without a PASS);
  //  (3) yield a Contributor PR to the RICH host conventions (parse CONTRIBUTING.md / the PR template,
  //      not just the minimal presence/sign-off signal detectHostConventions returns).
  // Until then this stub fails loud (Principle 9).
  enactPublish(): never {
    throw new Error(
      'RepoModeGateStub.enactPublish: the gated publish (co_merge / co_push / fork→PR) is not ' +
        'implemented at L3. This is the L5 plug-point: enact the publishing surface per repository- ' +
        'relationship mode, with the review gate applied in all three (no un-gated merge/push/PR verb ' +
        'is exposed in L3 — Principle 7). L3 only resolves the mode + its capabilities.',
    );
  }

  parseHostConventions(): never {
    throw new Error(
      'RepoModeGateStub.parseHostConventions: the rich CONTRIBUTING.md / PR-template parse is not ' +
        'implemented at L3. This is the L5/L9 plug-point: extract the template body, checklist, and ' +
        'required trailers a Contributor PR must yield to. L3 only detects PR-template presence + a ' +
        'minimal sign-off signal (detectHostConventions).',
    );
  }
}
