import {
  openRegistry,
  previewPlacement,
  renderCostReport,
  renderDispatchResolution,
  renderUsageReport,
} from '@co/core';
import type { ProviderAccount, WorkSize, ReasoningBudget } from '@co/core';

export interface RunResult {
  output: string;
  exitCode: number;
}

const HELP_TEXT = `co — the orchestration CLI

Commands:
  co usage                  Show provider usage buckets for the current project
  co cost                   Show cost rollups and near-budget crossings
  co sling --dry-run        Preview where a dispatch would land (read-only)
    --role <role>           Agent role (default: implementer)
    --work-size <w>         simple|average|technical (default: average)
    --reasoning-budget <r>  economy|standard|deep (default: standard)
    --account <p:acct>      Provider account to consider (default: claude:default)

Options:
  --help                    Show this help text
`;

function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

function parseAccounts(argv: string[]): readonly ProviderAccount[] | undefined {
  const raw = getArg(argv, '--account');
  if (raw === undefined) return undefined;
  return raw.split(',').map((pair) => {
    const colon = pair.indexOf(':');
    if (colon < 1)
      throw new Error(`Invalid --account format '${pair}'. Expected 'provider:account'.`);
    return {
      provider: pair.slice(0, colon) as 'claude' | 'codex',
      account: pair.slice(colon + 1),
    };
  });
}

const DEFAULT_ACCOUNTS: readonly ProviderAccount[] = [{ provider: 'claude', account: 'default' }];

/**
 * Run the co CLI. Accepts `argv` (defaults to `process.argv.slice(2)`) and `cwd` (defaults to
 * `process.cwd()`) for testability. Returns `{ output, exitCode }`. Exits 1 for an unregistered
 * cwd (P9 — fail-loud; never invent a project). AC8: usage/cost/placement are CLI only.
 */
export function run(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): RunResult {
  const [cmd, ...rest] = argv;

  if (cmd === '--help' || cmd === 'help' || cmd === undefined) {
    return { output: HELP_TEXT, exitCode: 0 };
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
      output: `co: '${cwd}' is not a registered project. Run 'co init' to register it.\n`,
      exitCode: 1,
    };
  }

  switch (cmd) {
    case 'usage': {
      return { output: renderUsageReport(projectId), exitCode: 0 };
    }

    case 'cost': {
      return { output: renderCostReport(projectId), exitCode: 0 };
    }

    case 'sling': {
      if (!rest.includes('--dry-run')) {
        return {
          output:
            `co sling: only --dry-run is supported from the CLI ` +
            `(co_sling is the agent tool).\n\n${HELP_TEXT}`,
          exitCode: 0,
        };
      }
      try {
        const role = getArg(rest, '--role') ?? 'implementer';
        const workSize = (getArg(rest, '--work-size') ?? 'average') as WorkSize;
        const reasoningBudget = (getArg(rest, '--reasoning-budget') ??
          'standard') as ReasoningBudget;
        const accounts = parseAccounts(rest) ?? DEFAULT_ACCOUNTS;
        const resolution = previewPlacement({
          projectId,
          role,
          workSize,
          reasoningBudget,
          accounts,
          nowMs: Date.now(),
        });
        return { output: renderDispatchResolution(resolution), exitCode: 0 };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { output: `co sling: ${msg}\n`, exitCode: 1 };
      }
    }

    default: {
      return { output: `co: unknown command '${cmd}'.\n\n${HELP_TEXT}`, exitCode: 0 };
    }
  }
}
