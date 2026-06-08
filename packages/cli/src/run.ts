import {
  openRegistry,
  previewPlacementWithUsage,
  defaultProviderAccounts,
  defaultUsageSourceFactory,
  renderCostReport,
  renderDispatchResolution,
  renderUsageReport,
  providerSchema,
  reasoningBudgetSchema,
  workSizeSchema,
} from '@co/core';
import type { ProviderAccount, UsageSourceFactory, WorkSize, ReasoningBudget } from '@co/core';

export interface RunResult {
  output: string;
  exitCode: number;
}

export interface RunOptions {
  readonly usageSourceFactory?: UsageSourceFactory;
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

Options:
  --help                    Show this help text
`;

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
  const seenProviders = new Set<string>();
  return raw.split(',').map((pair) => {
    const colon = pair.indexOf(':');
    if (colon < 1)
      throw new Error(`Invalid --account format '${pair}'. Expected 'provider:account'.`);
    const provider = providerSchema.parse(pair.slice(0, colon));
    if (seenProviders.has(provider)) {
      throw new Error(
        `Duplicate provider '${provider}' in --account; same-provider multi-subscription routing is not yet supported.`,
      );
    }
    seenProviders.add(provider);
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

/**
 * Run the co CLI. Accepts `argv` (defaults to `process.argv.slice(2)`) and `cwd` (defaults to
 * `process.cwd()`) for testability. Returns `{ output, exitCode }`. Exits 1 for an unregistered
 * cwd (P9 — fail-loud; never invent a project). AC8: usage/cost/placement are CLI only.
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

    default: {
      return { output: `co: unknown command '${cmd}'.\n\n${HELP_TEXT}`, exitCode: 1 };
    }
  }
}
