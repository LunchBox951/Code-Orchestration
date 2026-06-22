import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolvePersona } from '../permissions/identity-guard.js';
import { projectDataDir } from '../store/paths.js';
import { detectBaseRef, defaultGitReader, resolveRefSha, type GitReader } from './detect-base.js';
import type { TestOutcome } from './events.js';
import { provisionWorktree, resolveProvisioningManifest, type Provisioner } from './provision.js';
import type { WorktreeStore } from './worktree-store.js';
import { rollbackError, throwWithRollbackErrors } from '../rollback-errors.js';

/**
 * Mutating git seam (e.g. `git worktree add`). Unlike {@link GitReader}, a failure THROWS (fail
 * loud — Principle 9): a worktree that could not be created must never be silently recorded as if
 * it were. Injectable so the orchestration is testable, though the worktree-creation path is best
 * exercised against a real temp repo.
 */
export type GitExec = (cwd: string, args: readonly string[]) => void;

/** Flags whose VALUE can carry free text or secrets — masked in exec-failure logs (#7 §5 #11). */
const VALUE_BEARING_FLAGS = new Set([
  '-m',
  '--message',
  '-F',
  '--file',
  '--body',
  '-b',
  '--title',
  '-t',
  '-f',
  '--field',
  '--raw-field',
  '--input',
]);

/**
 * Render an argv for an error/log message with value-bearing flags MASKED (#7 §5 #11): a
 * `gh pr create --body <text>` or `git merge -m <text>` failure must not leak the message
 * (which can carry pasted command output, paths, or credentials) into transcripts. Flag NAMES
 * stay so the failure is still diagnosable; only their value tokens become `[redacted]`. Handles
 * both separate-token (`--body x`) and equals (`--body=x`) forms.
 */
export function redactExecArgs(args: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const eq = /^(--?[A-Za-z][\w-]*)=/u.exec(token);
    if (eq != null && VALUE_BEARING_FLAGS.has(eq[1]!)) {
      out.push(`${eq[1]}=[redacted]`);
      continue;
    }
    out.push(token);
    if (VALUE_BEARING_FLAGS.has(token) && i + 1 < args.length) {
      out.push('[redacted]');
      i++;
    }
  }
  return out.join(' ');
}

/**
 * A safe one-line diagnostic from a failed `execFileSync`: prefer the child's stderr (the genuine
 * git/gh error), else the exit status/signal — never the Node error message, which embeds the full
 * unredacted argv (#7 §5 #11).
 */
export function execFailureDetail(cause: unknown): string {
  if (cause != null && typeof cause === 'object') {
    const e = cause as { stderr?: unknown; status?: unknown; signal?: unknown };
    const stderr = e.stderr == null ? '' : String(e.stderr).trim();
    if (stderr.length > 0) return stderr;
    if (e.status != null) return `exit code ${String(e.status)}`;
    if (e.signal != null) return `signal ${String(e.signal)}`;
  }
  return 'command failed';
}

/** The production {@link GitExec}: run `git <args>` in `cwd`, surfacing a non-zero exit as a throw. */
export const defaultGitExec: GitExec = (cwd, args) => {
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (cause) {
    throw new Error(
      `co worktrees: \`git ${redactExecArgs(args)}\` failed in '${cwd}': ${execFailureDetail(cause)}`,
      { cause },
    );
  }
};

/** What a {@link BaselineProbe} is handed about the just-created sandbox. */
export interface BaselineProbeContext {
  /** The main repo the sandbox was cut from (the agent's current cwd). */
  readonly repoCwd: string;
  /** Absolute path of the freshly created worktree sandbox. */
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseSha: string;
}

/**
 * The injectable baseline probe (mirrors the injectable-prober idea). It produces the structured
 * test snapshot captured at branch-off; the seam lets headless tests inject a recorded snapshot
 * without running anything.
 */
export type BaselineProbe = (ctx: BaselineProbeContext) => readonly TestOutcome[];

/**
 * The DEFAULT probe: capture an EMPTY baseline. By the time the baseline is captured the sandbox has
 * already been provisioned (phase B runs first), so it IS runnable — but actually RUNNING the suite to
 * record pre-existing failures is the honest-verification step L5 owns. So the default stays empty (the
 * honest "no pre-existing failures recorded" starting point) and L5 injects a runnable probe once it
 * wires the comparison. This layer's job is only to RECORD a baseline (per project+branch) that is
 * readable; L5 does the comparing.
 */
export const emptyBaselineProbe: BaselineProbe = () => [];

/** Inputs to {@link slingWorktree}. `base` overrides auto-detect; omit it to auto-detect. */
export interface SlingParams {
  /** The spawner this sandbox is created for — recorded as the worktree's parent. Required. */
  readonly parent: string;
  /** The assigned child agent that is allowed to mount this sandbox. */
  readonly agent?: string;
  /** The intended base role for the child agent mounted into this sandbox. */
  readonly role?: string;
  /** Optional intended child sub-role name, when dispatch used a sub-role such as `reviewer:pr`. */
  readonly subRole?: string;
  /** The new branch to create; must start with `co/`. */
  readonly branch: string;
  /** Optional base ref override; when omitted the base is auto-detected. */
  readonly base?: string;
  /** The main repo to cut the worktree from (the agent's cwd). */
  readonly repoCwd: string;
  /** The project id, used to place the sandbox under program-data. */
  readonly projectId: string;
}

/** Injectable seams for {@link slingWorktree}; all default to the production implementations. */
export interface SlingDeps {
  readonly gitReader?: GitReader;
  readonly gitExec?: GitExec;
  readonly probe?: BaselineProbe;
  /**
   * Environment provisioning, run after `git worktree add` (phase B). Defaults to the real
   * manifest-applying {@link defaultProvisioner}; inject a no-op/recording one in headless tests
   * whose `gitExec` is faked (so no real sandbox dir exists to place into).
   */
  readonly provisioner?: Provisioner;
}

/** The recorded facts of a created sandbox (the structured result `co_sling` returns). */
export interface SlingResult {
  readonly branch: string;
  readonly baseRef: string;
  readonly baseSha: string;
  readonly worktreePath: string;
  readonly baselineCaptured: boolean;
}

/** Branches must be `co/…` (the frozen naming rule); reject anything else fail-loud (Principle 9). */
export const CO_BRANCH_PREFIX = 'co/';

/**
 * Compute the program-data sandbox path for `branch`: `${projectDataDir}/worktrees/<branch>`, with
 * the branch's `/`-segments kept as nested path segments (mirroring how git lays out `refs/heads/`).
 * Nesting is INJECTIVE — distinct branches always yield distinct paths (WT-1: two parallel slings
 * never collide) — where collapsing `/`→`-` would not. A traversal guard keeps the resolved path
 * bounded under the worktrees root (Principle 12 — nothing escapes program-data).
 */
export function worktreePathFor(projectId: string, branch: string): string {
  const root = resolve(join(projectDataDir(projectId), 'worktrees'));
  const segments = branch.split('/');
  if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) {
    throw new Error(`co_sling: refusing unsafe branch '${branch}' (empty or traversal segment).`);
  }
  const path = resolve(join(root, ...segments));
  if (path !== root && !path.startsWith(root + '/')) {
    throw new Error(`co_sling: branch '${branch}' escapes the worktrees root (Principle 12).`);
  }
  return path;
}

/**
 * Create + RECORD an isolated worktree+branch sandbox from an auto-detected (or overridden) base
 * ref, and capture the branch-off test baseline. This is the L3 foundation `co_sling` dispatches to.
 *
 * Steps: resolve the base (auto-detect unless `base` given) → resolve its sha (fail loud) → create
 * the worktree+branch under program-data (`git worktree add -b <branch> <path> <baseRef>`) →
 * PROVISION the gitignored working essentials into the sandbox (phase B — so it is runnable before
 * the baseline is captured) → record the worktree → capture + record the baseline → return the facts.
 *
 * It does NOT spawn an agent into the sandbox (that is L7). Provisioning READS from the main repo and
 * WRITES only the sandbox, so the source repo stays pristine (Principle 12). The worktree lives under
 * program-data, NEVER in the repo; the only git-side write is git's own `.git/worktrees/…`
 * administration in the main repo, which is git's bookkeeping, not orchestration state.
 */
export function slingWorktree(
  store: WorktreeStore,
  params: SlingParams,
  deps: SlingDeps = {},
): SlingResult {
  const gitReader = deps.gitReader ?? defaultGitReader;
  const gitExec = deps.gitExec ?? defaultGitExec;
  const probe = deps.probe ?? emptyBaselineProbe;
  const { parent, agent, role, subRole, branch, base, repoCwd, projectId } = params;
  if (parent.length === 0) {
    throw new Error('co_sling: `parent` is required (the spawner; there is no @operator default).');
  }
  if (!branch.startsWith(CO_BRANCH_PREFIX)) {
    throw new Error(`co_sling: branch '${branch}' must start with '${CO_BRANCH_PREFIX}'.`);
  }

  // 1) Resolve the base — auto-detect unless explicitly overridden — then its commit sha.
  const baseRef = base ?? detectBaseRef(repoCwd, gitReader);
  const baseSha = resolveRefSha(repoCwd, baseRef, gitReader);
  // Resolve persona before creating git state, so a malformed identity config cannot leave behind an
  // unrecorded worktree/branch.
  const persona = resolvePersona(projectId);
  // Resolve the default provisioning manifest before creating git state, so malformed config cannot
  // leave behind an unrecorded worktree/branch. Custom test provisioners remain responsible for their
  // own validation because they are injected seams.
  const provisionManifest =
    deps.provisioner == null ? resolveProvisioningManifest(projectId) : undefined;
  const provisioner =
    deps.provisioner ?? ((ctx) => provisionWorktree({ ...ctx, manifest: provisionManifest ?? [] }));

  // 2) Create the worktree+branch under program-data (never in the repo).
  const worktreePath = worktreePathFor(projectId, branch);
  mkdirSync(dirname(worktreePath), { recursive: true });

  try {
    // `git worktree add -b` creates the branch ref FIRST and only then materializes the dir; if the
    // dir step fails (e.g. an occupied path left by a prior crash) git leaves the branch behind. Keep
    // it INSIDE the try so the rollback below (worktree remove + branch -D) reaches it — otherwise the
    // branch leaks unrecorded and permanently blocks re-sling of that branch (Principle 9).
    gitExec(repoCwd, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);

    // 2b) Pin the operator persona git identity in the new sandbox (AC-L6a-7): prevents `git commit -s`
    //     from falling through to the global config and leaking personal email in Signed-off-by.
    //     `extensions.worktreeConfig` is a git-admin write in the source repo's .git/config that enables
    //     per-worktree config; it is not orchestration state. The actual persona writes go only to the
    //     sandbox's worktree-local config, so parallel sandboxes cannot overwrite each other.
    //     No-op when identity.persona is unconfigured (non-breaking).
    if (persona !== undefined) {
      gitExec(repoCwd, ['config', 'extensions.worktreeConfig', 'true']);
      gitExec(worktreePath, ['config', '--worktree', 'user.email', persona.email]);
      gitExec(worktreePath, ['config', '--worktree', 'user.name', persona.name]);
    }

    // 2c) Provision the gitignored working essentials into the sandbox (phase B): reads from the main
    //     repo, writes only the sandbox, so it is runnable before the baseline is captured.
    const provisionResult = provisioner({ repoCwd, worktreePath, projectId });

    // 3) Capture the branch-off baseline (L5 compares; we only capture + store).
    const tests = probe({ repoCwd, worktreePath, branch, baseRef, baseSha });

    // 4) Record the sandbox + baseline atomically so replay never preserves a live worktree
    //    without its required branch-off baseline.
    store.recordWorktreeAndBaseline(
      {
        branch,
        baseRef,
        baseSha,
        path: worktreePath,
        parent,
        ...(agent != null ? { agent } : {}),
        ...(role != null ? { role } : {}),
        ...(subRole != null ? { subRole } : {}),
        provisioned: [...(provisionResult?.provisioned ?? [])],
      },
      { branch, baseRef, baseSha, tests: [...tests] },
    );
  } catch (error) {
    const rollbackErrors: Error[] = [];
    try {
      gitExec(repoCwd, ['worktree', 'remove', '--force', worktreePath]);
    } catch (cause) {
      rollbackErrors.push(rollbackError(`git worktree remove '${worktreePath}'`, cause));
    }
    try {
      gitExec(repoCwd, ['branch', '-D', branch]);
    } catch (cause) {
      rollbackErrors.push(rollbackError(`git branch -D '${branch}'`, cause));
    }
    throwWithRollbackErrors('co_sling: setup failed', error, rollbackErrors);
  }

  return { branch, baseRef, baseSha, worktreePath, baselineCaptured: true };
}
