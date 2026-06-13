import {
  openRegistry,
  previewPlacementWithUsage,
  defaultProviderAccounts,
  defaultUsageSourceFactory,
  matchBlock,
  renderCostReport,
  renderDispatchResolution,
  renderUsageReport,
  providerSchema,
  reasoningBudgetSchema,
  workSizeSchema,
  queryObservability,
  runDoctor,
  openMailStore,
  OPERATOR,
  MAIL_TYPES,
  openSpecStore,
  openPlanStore,
  openWorktreeStore,
  CleanupGateImpl,
  defaultGitExec,
  defaultSandboxFs,
} from '@co/core';
import type {
  ProviderAccount,
  UsageSourceFactory,
  WorkSize,
  ReasoningBudget,
  ObservabilitySnapshot,
  DoctorReport,
  MailEnvelope,
  DeliveredMail,
  MailType,
  SpecRecord,
  PlanRecord,
  AgentRouterSeam,
  CleanupReport,
  UnstickReport,
  WorktreeRecord,
} from '@co/core';
import { readFileSync } from 'node:fs';

export interface RunResult {
  output: string;
  exitCode: number;
}

export interface RunOptions {
  readonly usageSourceFactory?: UsageSourceFactory;
  readonly stdin?: string;
}

const HELP_TEXT = `co — the orchestration CLI

Commands:
  co usage                  Show provider usage buckets for the current project
  co cost                   Show cost rollups and near-budget crossings
  co sling --dry-run        Preview dispatch placement; refreshes usage cache
    --role <role>           Agent role (default: implementer)
    --work-size <w>         simple|average|technical (default: average)
    --reasoning-budget <r>  economy|standard|deep (default: standard)
    --account <p:acct>      Provider account(s), comma-separated (default: claude:max,codex:pro)
  co hook codex-block-list  Run the Codex PreToolUse block-list hook
    --rules <path>          Path to the block-list rules JSON file

Observability (operator-only):
  co status                 Show roster, phase, review, and cost snapshot
  co doctor                 Run structural health checks

Mail (operator-only):
  co mail read              Show @operator inbox
    --recipient <r>         Read a specific recipient's inbox
  co mail send              Send a typed mail from @operator
    --to <recipient>        Recipient (required)
    --type <type>           Mail type (required): ${MAIL_TYPES.join('|')}
    --subject <subject>     Subject line (required)
    --body <body>           Body text (default: empty)

Spec/plan views (operator-only):
  co spec [<taskId>]        List all specs, or show a specific spec
  co plan [<taskId>]        List all plans, or show a specific plan with phases
  co phase <taskId>         Show phase status for a task's plan

Recovery verbs (operator-only):
  co cleanup <branch>       Dry-run removal of a proven-merged worktree (--execute to apply)
  co unstick <branch>       Recover a stuck/locked worktree [host-live: router seam]
  co nuke <branch>          Force-remove a condemned worktree (requires --confirm) [host-live]
  co pause <agentId>        Pause an agent's turns [host-live: router seam]
  co stop <agentId>         Stop (kill) an agent [host-live: router seam]

Options:
  --help                    Show this help text
`;

// ── [host-live] router seam ───────────────────────────────────────────────────
// The real Conductor router wires in at host-side runtime. In sandbox (and this
// CLI build), these throw a clear [host-live] message so the operator knows
// they require the Conductor to be running.

const HOST_LIVE_ROUTER: AgentRouterSeam = {
  revertStuck(): void {
    throw new Error('[host-live] router seam: Conductor not running (revertStuck).');
  },
  rewake(): void {
    throw new Error('[host-live] router seam: Conductor not running (rewake).');
  },
  pause(): void {
    throw new Error('[host-live] router seam: Conductor not running (pause).');
  },
  stop(): void {
    throw new Error('[host-live] router seam: Conductor not running (stop).');
  },
};

// ── Merge probe + repair seams ────────────────────────────────────────────────

function buildMergeProbe(cwd: string): (branch: string, targetRef: string) => boolean {
  return (branch: string, targetRef: string): boolean => {
    try {
      defaultGitExec(cwd, ['merge-base', '--is-ancestor', branch, targetRef]);
      return true;
    } catch {
      return false;
    }
  };
}

const defaultRepair: (repoCwd: string) => void = (repoCwd: string): void => {
  defaultGitExec(repoCwd, ['worktree', 'prune']);
};

// ── Render helpers ────────────────────────────────────────────────────────────

function renderObservabilitySnapshot(snap: ObservabilitySnapshot): string {
  const lines: string[] = [];

  lines.push(`Roster (${snap.agents.length} agents)`);
  for (const a of snap.agents) {
    const sr = a.subRole ? `:${a.subRole}` : '';
    lines.push(`  ${a.agentId}  ${a.role}${sr}  parent=${a.parent}`);
  }
  if (snap.agents.length === 0) lines.push('  (none)');
  lines.push('');

  lines.push(`Plans (${snap.plans.length})`);
  for (const p of snap.plans) {
    const total = p.phases.length;
    const done = p.phases.filter((ph) => ph.status === 'merged').length;
    lines.push(`  ${p.taskId}  ${done}/${total} merged  ${p.goal.slice(0, 60)}`);
  }
  if (snap.plans.length === 0) lines.push('  (none)');
  lines.push('');

  lines.push(`Reviews (${snap.reviews.length})`);
  for (const r of snap.reviews) {
    const verdict = r.verdict ?? 'pending';
    const extras: string[] = [];
    if (r.serialized) extras.push('serialized');
    if (r.overridden) extras.push('overridden');
    const tag = extras.length > 0 ? `  [${extras.join(',')}]` : '';
    lines.push(`  ${r.target}  ${r.branch}  ${r.scope}  ${verdict}  strikes=${r.strikes}${tag}`);
  }
  if (snap.reviews.length === 0) lines.push('  (none)');
  lines.push('');

  lines.push(`Cost (${snap.costRollups.length} entries)`);
  for (const c of snap.costRollups) {
    lines.push(`  ${c.kind}:${c.id}  $${c.totalCostUsd.toFixed(4)}`);
  }
  if (snap.costRollups.length === 0) lines.push('  (none)');

  return lines.join('\n') + '\n';
}

function renderDoctorReport(report: DoctorReport): string {
  const statusLabel = report.healthy ? 'healthy' : 'UNHEALTHY';
  const lines = [`co doctor — ${statusLabel}`, ''];
  for (const check of report.checks) {
    lines.push(`  [${check.status}]  ${check.name}: ${check.reason}`);
  }
  return lines.join('\n') + '\n';
}

function renderMailInbox(mails: readonly DeliveredMail[], recipient: string): string {
  if (mails.length === 0) {
    return `Inbox for ${recipient}: (empty)\n`;
  }
  const lines = [`Inbox for ${recipient} (${mails.length} messages)`, ''];
  for (const m of mails) {
    const resolved = m.resolved ? '[resolved]' : m.read ? '[read]' : '[unread]';
    lines.push(
      `  #${m.seq}  ${m.sender.padEnd(20)}  ${m.type.padEnd(22)}  ${m.subject}  ${resolved}`,
    );
  }
  return lines.join('\n') + '\n';
}

function renderMailSent(mail: DeliveredMail): string {
  return `Sent: seq=${mail.seq} to=${mail.recipient} type=${mail.type} subject=${JSON.stringify(mail.subject)}\n`;
}

function renderSpecList(specs: readonly SpecRecord[]): string {
  if (specs.length === 0) {
    return 'Specs: (none)\n';
  }
  const lines = [`Specs (${specs.length})`, ''];
  for (const s of specs) {
    lines.push(`  ${s.taskId.padEnd(30)}  ${s.state.padEnd(8)}  ${s.title}`);
  }
  return lines.join('\n') + '\n';
}

function renderSpec(spec: SpecRecord): string {
  const lines = [
    `Spec ${spec.taskId}`,
    `  State:   ${spec.state}`,
    `  Title:   ${spec.title}`,
    `  Goal:    ${spec.goal}`,
    `  Criteria (${spec.criteria.length}):`,
  ];
  for (const c of spec.criteria) {
    const verify = c.verify ? `  [verify: ${c.verify}]` : '';
    lines.push(`    - ${c.text}${verify}`);
  }
  if (spec.body) {
    const bodyLines = spec.body.split('\n');
    lines.push('  Body:');
    for (const line of bodyLines.slice(0, 20)) {
      lines.push(`    ${line}`);
    }
    if (bodyLines.length > 20) lines.push('    ...(truncated)');
  }
  return lines.join('\n') + '\n';
}

function renderPlanList(plans: readonly PlanRecord[]): string {
  if (plans.length === 0) {
    return 'Plans: (none)\n';
  }
  const lines = [`Plans (${plans.length})`, ''];
  for (const p of plans) {
    const done = p.phases.filter((ph) => ph.status === 'merged').length;
    lines.push(
      `  ${p.taskId.padEnd(30)}  ${done}/${p.phases.length} merged  ${p.goal.slice(0, 50)}`,
    );
  }
  return lines.join('\n') + '\n';
}

function renderPlan(plan: PlanRecord): string {
  const lines = [
    `Plan ${plan.taskId}`,
    `  Goal: ${plan.goal}`,
    `  Phases (${plan.phases.length}):`,
  ];
  for (const ph of plan.phases) {
    const vp = ph.verifiedPass !== undefined ? ` verified=${ph.verifiedPass}` : '';
    const dep = ph.deps.length > 0 ? ` deps=[${ph.deps.join(', ')}]` : '';
    lines.push(`    ${ph.status.padEnd(12)}  ${ph.phaseId}  ${ph.name}${vp}${dep}`);
  }
  return lines.join('\n') + '\n';
}

function renderPhaseStatus(plan: PlanRecord): string {
  const lines = [`Phase status for task ${plan.taskId}`, ''];
  for (const ph of plan.phases) {
    const vp = ph.verifiedPass !== undefined ? `  verified=${ph.verifiedPass}` : '';
    lines.push(`  ${ph.status.padEnd(12)}  ${ph.phaseId}  ${ph.name}${vp}`);
  }
  return lines.join('\n') + '\n';
}

function renderCleanupReport(report: CleanupReport): string {
  const lines: string[] = [];
  if (report.dryRun) {
    lines.push(`[dry-run] cleanup branch=${report.branch}`);
    lines.push(`  would-remove: ${report.wouldRemovePath}`);
    lines.push(`  orphans found: ${report.orphansFound.length}`);
    for (const o of report.orphansFound) {
      lines.push(`    - ${o.kind}: branch=${o.branch ?? '(unknown)'}  path=${o.path}`);
    }
  } else {
    lines.push(`cleanup branch=${report.branch} removed`);
    lines.push(`  path: ${report.removed.path}`);
    lines.push(`  orphans found: ${report.orphansFound.length}`);
    for (const o of report.orphansFound) {
      lines.push(`    - ${o.kind}: branch=${o.branch ?? '(unknown)'}  path=${o.path}`);
    }
  }
  return lines.join('\n') + '\n';
}

function renderUnstickReport(report: UnstickReport): string {
  return (
    [
      `unstick branch=${report.branch}`,
      `  repaired: ${report.repaired}`,
      `  agent-rewoken: ${report.agentRewoken}`,
    ].join('\n') + '\n'
  );
}

function renderNukeRecord(record: WorktreeRecord): string {
  return `nuke: branch=${record.branch}  removed  path=${record.path}\n`;
}

// ── Existing helpers ──────────────────────────────────────────────────────────

function hookDeny(reason: string): string {
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
      decision: 'block',
      reason,
    }) + '\n'
  );
}

function readHookStdin(options: RunOptions): string {
  return options.stdin ?? readFileSync(0, 'utf8');
}

function extractHookCommand(raw: string): string | undefined {
  const parsed = JSON.parse(raw) as {
    tool_name?: unknown;
    toolName?: unknown;
    tool_input?: unknown;
    toolInput?: unknown;
  };
  const toolName = parsed.tool_name ?? parsed.toolName;
  if (typeof toolName !== 'string') return undefined;
  const normalizedToolName = toolName.toLowerCase();
  if (normalizedToolName !== 'bash' && normalizedToolName !== 'shell') return undefined;
  const input = parsed.tool_input ?? parsed.toolInput;
  if (typeof input !== 'object' || input == null) return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

function readAllowedRuleIds(path: string): Set<string> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    version?: unknown;
    matcher?: unknown;
    rules?: unknown;
  };
  if (
    parsed.version !== 1 ||
    parsed.matcher !== '@co/core/permissions/matchBlock' ||
    !Array.isArray(parsed.rules)
  ) {
    throw new Error(`Invalid codex block-list rules file '${path}'.`);
  }
  return new Set(
    parsed.rules
      .map((rule) =>
        typeof rule === 'object' && rule != null ? (rule as { id?: unknown }).id : undefined,
      )
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
}

function runHookCommand(argv: string[], options: RunOptions): RunResult {
  const [hookName, ...rest] = argv;
  if (hookName !== 'codex-block-list') {
    return { output: `co hook: unknown hook '${hookName ?? ''}'.\n`, exitCode: 1 };
  }
  const rulesPath = requiredArg(rest, '--rules');
  if (rulesPath == null) {
    return { output: hookDeny('BLOCKED: missing codex block-list rules path.'), exitCode: 0 };
  }
  try {
    const allowedRuleIds = readAllowedRuleIds(rulesPath);
    const command = extractHookCommand(readHookStdin(options));
    if (command == null) return { output: '', exitCode: 0 };
    const blocked = matchBlock(command);
    if (blocked == null || !allowedRuleIds.has(blocked.id)) return { output: '', exitCode: 0 };
    return {
      output: hookDeny(`BLOCKED: '${command}' matches co hard-block rule '${blocked.id}'.`),
      exitCode: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: hookDeny(`BLOCKED: codex block-list hook failed closed: ${msg}`),
      exitCode: 0,
    };
  }
}

function requiredArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

const SLING_VALUE_FLAGS = new Set(['--role', '--work-size', '--reasoning-budget', '--account']);
const SLING_BOOLEAN_FLAGS = new Set(['--dry-run']);
const SLING_FLAGS = new Set([...SLING_VALUE_FLAGS, ...SLING_BOOLEAN_FLAGS]);

function validateSlingArgs(argv: string[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument '${arg}'.`);
    }
    if (!SLING_FLAGS.has(arg)) {
      throw new Error(`Unknown option '${arg}'.`);
    }
    if (seen.has(arg)) {
      throw new Error(`Duplicate option '${arg}'.`);
    }
    seen.add(arg);
    if (SLING_VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}.`);
      }
      i += 1;
    }
  }
}

function validateNoArgs(command: string, argv: string[]): void {
  if (argv.length === 0) return;
  const arg = argv[0]!;
  if (arg.startsWith('--')) {
    throw new Error(`co ${command}: unknown option '${arg}'.`);
  }
  throw new Error(`co ${command}: unexpected argument '${arg}'.`);
}

function parseAccounts(argv: string[]): readonly ProviderAccount[] | undefined {
  const raw = requiredArg(argv, '--account');
  if (raw === undefined) return undefined;
  return raw.split(',').map((pair) => {
    const colon = pair.indexOf(':');
    if (colon < 1)
      throw new Error(`Invalid --account format '${pair}'. Expected 'provider:account'.`);
    const provider = providerSchema.parse(pair.slice(0, colon));
    const suffix = pair.slice(colon + 1);
    if (suffix.length === 0) {
      throw new Error(`Invalid --account format '${pair}'. Account must be non-empty.`);
    }
    return {
      provider,
      account: pair,
    };
  });
}

function parseWorkSize(argv: string[]): WorkSize {
  return workSizeSchema.parse(requiredArg(argv, '--work-size') ?? 'average');
}

function parseReasoningBudget(argv: string[]): ReasoningBudget {
  return reasoningBudgetSchema.parse(requiredArg(argv, '--reasoning-budget') ?? 'standard');
}

// ── Mail sub-command handlers ─────────────────────────────────────────────────

function runMailCommand(projectId: string, argv: string[]): RunResult {
  const [subcmd, ...rest] = argv;

  if (subcmd === 'read') {
    try {
      const recipient = requiredArg(rest, '--recipient') ?? OPERATOR;
      const store = openMailStore(projectId);
      try {
        const mails = store.inbox(recipient);
        return { output: renderMailInbox(mails, recipient), exitCode: 0 };
      } finally {
        store.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `co mail read: ${msg}\n`, exitCode: 1 };
    }
  }

  if (subcmd === 'send') {
    try {
      const to = requiredArg(rest, '--to');
      if (!to) throw new Error('missing --to <recipient>.');
      const rawType = requiredArg(rest, '--type');
      if (!rawType) throw new Error('missing --type <type>.');
      if (!(MAIL_TYPES as readonly string[]).includes(rawType)) {
        throw new Error(`unknown mail type '${rawType}'. Valid types: ${MAIL_TYPES.join(', ')}.`);
      }
      const subject = requiredArg(rest, '--subject');
      if (!subject) throw new Error('missing --subject <subject>.');
      const body = requiredArg(rest, '--body') ?? '';

      const envelope: MailEnvelope = {
        type: rawType as MailType,
        from: OPERATOR,
        to,
        subject,
        body,
      };
      const store = openMailStore(projectId);
      try {
        const sent = store.send(envelope);
        return { output: renderMailSent(sent), exitCode: 0 };
      } finally {
        store.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `co mail send: ${msg}\n`, exitCode: 1 };
    }
  }

  return {
    output: `co mail: unknown sub-command '${subcmd ?? ''}'.\nUse: co mail read | co mail send\n`,
    exitCode: 1,
  };
}

/**
 * Run the co CLI. Accepts `argv` (defaults to `process.argv.slice(2)`) and `cwd` (defaults to
 * `process.cwd()`) for testability. Returns `{ output, exitCode }`. Exits 1 for an unregistered
 * cwd (P9 — fail-loud; never invent a project). AC8: usage/cost/placement are CLI only.
 * AC-S9-7: operator verb set (status/doctor/mail/spec/plan/phase/cleanup/unstick/nuke/pause/stop)
 * is CLI-only, thin adapters over @co/core (layering guard holds). AC-S9-8: CLI⊥MCP disjoint.
 */
export async function run(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  options: RunOptions = {},
): Promise<RunResult> {
  const [cmd, ...rest] = argv;

  if (cmd === '--help' || cmd === 'help' || cmd === undefined) {
    return { output: HELP_TEXT, exitCode: 0 };
  }

  if (cmd === 'hook') {
    return runHookCommand(rest, options);
  }

  // Resolve projectId from cwd — loud-fail (P9) if unregistered.
  const registry = openRegistry();
  let projectId: string | undefined;
  try {
    projectId = registry.resolve(cwd) ?? undefined;
  } finally {
    registry.close();
  }
  if (projectId === undefined) {
    return {
      output: `co: '${cwd}' is not a registered project. Register it in the CO project registry first.\n`,
      exitCode: 1,
    };
  }

  switch (cmd) {
    case 'usage': {
      try {
        validateNoArgs('usage', rest);
        return { output: renderUsageReport(projectId), exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `${msg}\n`, exitCode: 1 };
      }
    }

    case 'cost': {
      try {
        validateNoArgs('cost', rest);
        return { output: renderCostReport(projectId), exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `${msg}\n`, exitCode: 1 };
      }
    }

    case 'sling': {
      try {
        validateSlingArgs(rest);
        if (!rest.includes('--dry-run')) {
          return {
            output:
              `co sling: only --dry-run is supported from the CLI ` +
              `(co_sling is the agent tool).\n\n${HELP_TEXT}`,
            exitCode: 1,
          };
        }
        const role = requiredArg(rest, '--role') ?? 'implementer';
        const workSize = parseWorkSize(rest);
        const reasoningBudget = parseReasoningBudget(rest);
        const accounts = parseAccounts(rest) ?? defaultProviderAccounts();
        const resolution = await previewPlacementWithUsage({
          projectId,
          role,
          workSize,
          reasoningBudget,
          accounts,
          nowMs: Date.now(),
          usageSourceFactory: options.usageSourceFactory ?? defaultUsageSourceFactory,
        });
        return { output: renderDispatchResolution(resolution), exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co sling: ${msg}\n`, exitCode: 1 };
      }
    }

    // ── Observability (operator-only) ───────────────────────────────────────

    case 'status': {
      try {
        validateNoArgs('status', rest);
        const snap = queryObservability(projectId);
        return { output: renderObservabilitySnapshot(snap), exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co status: ${msg}\n`, exitCode: 1 };
      }
    }

    case 'doctor': {
      try {
        validateNoArgs('doctor', rest);
        const report = runDoctor({ projectId, repoRoot: cwd });
        return { output: renderDoctorReport(report), exitCode: report.healthy ? 0 : 1 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co doctor: ${msg}\n`, exitCode: 1 };
      }
    }

    // ── Mail (operator-only) ────────────────────────────────────────────────

    case 'mail': {
      return runMailCommand(projectId, rest);
    }

    // ── Spec / plan views (operator-only) ───────────────────────────────────

    case 'spec': {
      try {
        const taskId = rest.find((a) => !a.startsWith('--'));
        const store = openSpecStore(projectId);
        try {
          if (taskId !== undefined) {
            const spec = store.getSpec(taskId);
            if (spec === undefined) {
              return { output: `co spec: spec '${taskId}' not found.\n`, exitCode: 1 };
            }
            return { output: renderSpec(spec), exitCode: 0 };
          }
          return { output: renderSpecList(store.listSpecs()), exitCode: 0 };
        } finally {
          store.close();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co spec: ${msg}\n`, exitCode: 1 };
      }
    }

    case 'plan': {
      try {
        const taskId = rest.find((a) => !a.startsWith('--'));
        const store = openPlanStore(projectId);
        try {
          if (taskId !== undefined) {
            const plan = store.getPlan(taskId);
            if (plan === undefined) {
              return { output: `co plan: plan '${taskId}' not found.\n`, exitCode: 1 };
            }
            return { output: renderPlan(plan), exitCode: 0 };
          }
          return { output: renderPlanList(store.listPlans()), exitCode: 0 };
        } finally {
          store.close();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co plan: ${msg}\n`, exitCode: 1 };
      }
    }

    case 'phase': {
      try {
        const taskId = rest.find((a) => !a.startsWith('--'));
        if (!taskId) {
          return { output: `co phase: missing <taskId> argument.\n`, exitCode: 1 };
        }
        const store = openPlanStore(projectId);
        try {
          const plan = store.getPlan(taskId);
          if (plan === undefined) {
            return { output: `co phase: plan '${taskId}' not found.\n`, exitCode: 1 };
          }
          return { output: renderPhaseStatus(plan), exitCode: 0 };
        } finally {
          store.close();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co phase: ${msg}\n`, exitCode: 1 };
      }
    }

    // ── Recovery verbs (operator-only) ──────────────────────────────────────

    case 'cleanup': {
      const branch = rest.find((a) => !a.startsWith('--'));
      if (!branch) {
        return { output: `co cleanup: missing <branch> argument.\n`, exitCode: 1 };
      }
      const execute = rest.includes('--execute');
      const store = openWorktreeStore(projectId);
      try {
        const gate = new CleanupGateImpl({
          store,
          repoCwd: cwd,
          mergeProbe: buildMergeProbe(cwd),
          repair: defaultRepair,
          router: HOST_LIVE_ROUTER,
          gitExec: defaultGitExec,
          fs: defaultSandboxFs,
        });
        const report = gate.cleanup(branch, { dryRun: !execute });
        return { output: renderCleanupReport(report), exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co cleanup: ${msg}\n`, exitCode: 1 };
      } finally {
        store.close();
      }
    }

    case 'unstick': {
      const branch = rest.find((a) => !a.startsWith('--'));
      if (!branch) {
        return { output: `co unstick: missing <branch> argument.\n`, exitCode: 1 };
      }
      const store = openWorktreeStore(projectId);
      try {
        const gate = new CleanupGateImpl({
          store,
          repoCwd: cwd,
          mergeProbe: buildMergeProbe(cwd),
          repair: defaultRepair,
          router: HOST_LIVE_ROUTER,
          gitExec: defaultGitExec,
          fs: defaultSandboxFs,
        });
        const report = gate.unstick(branch, { repoCwd: cwd });
        return { output: renderUnstickReport(report), exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co unstick: ${msg}\n`, exitCode: 1 };
      } finally {
        store.close();
      }
    }

    case 'nuke': {
      const branch = rest.find((a) => !a.startsWith('--'));
      if (!branch) {
        return { output: `co nuke: missing <branch> argument.\n`, exitCode: 1 };
      }
      if (!rest.includes('--confirm')) {
        return {
          output: `co nuke: explicit confirmation required. Pass --confirm to force-remove branch '${branch}'.\n`,
          exitCode: 1,
        };
      }
      const store = openWorktreeStore(projectId);
      try {
        const gate = new CleanupGateImpl({
          store,
          repoCwd: cwd,
          mergeProbe: buildMergeProbe(cwd),
          repair: defaultRepair,
          router: HOST_LIVE_ROUTER,
          gitExec: defaultGitExec,
          fs: defaultSandboxFs,
        });
        const record = gate.nuke(branch, { confirm: true });
        return { output: renderNukeRecord(record), exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co nuke: ${msg}\n`, exitCode: 1 };
      } finally {
        store.close();
      }
    }

    case 'pause': {
      const agentId = rest.find((a) => !a.startsWith('--'));
      if (!agentId) {
        return { output: `co pause: missing <agentId> argument.\n`, exitCode: 1 };
      }
      const store = openWorktreeStore(projectId);
      try {
        const gate = new CleanupGateImpl({
          store,
          repoCwd: cwd,
          mergeProbe: buildMergeProbe(cwd),
          repair: defaultRepair,
          router: HOST_LIVE_ROUTER,
          gitExec: defaultGitExec,
          fs: defaultSandboxFs,
        });
        gate.pause(agentId);
        return { output: `pause: ${agentId} paused.\n`, exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co pause: ${msg}\n`, exitCode: 1 };
      } finally {
        store.close();
      }
    }

    case 'stop': {
      const agentId = rest.find((a) => !a.startsWith('--'));
      if (!agentId) {
        return { output: `co stop: missing <agentId> argument.\n`, exitCode: 1 };
      }
      const store = openWorktreeStore(projectId);
      try {
        const gate = new CleanupGateImpl({
          store,
          repoCwd: cwd,
          mergeProbe: buildMergeProbe(cwd),
          repair: defaultRepair,
          router: HOST_LIVE_ROUTER,
          gitExec: defaultGitExec,
          fs: defaultSandboxFs,
        });
        gate.stop(agentId);
        return { output: `stop: ${agentId} stopped.\n`, exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co stop: ${msg}\n`, exitCode: 1 };
      } finally {
        store.close();
      }
    }

    default: {
      return { output: `co: unknown command '${cmd}'.\n\n${HELP_TEXT}`, exitCode: 1 };
    }
  }
}
