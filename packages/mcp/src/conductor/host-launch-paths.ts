import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { sanitizeClaudeStateJson, type CoMcpPaths } from './placement-launch.js';

export interface HostLaunchPathOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly nodeCommand?: string;
  readonly includeProviderAuth?: boolean;
  readonly homeDir?: string;
}

export function defaultCoMcpPaths(opts: HostLaunchPathOptions = {}): CoMcpPaths {
  const argv = opts.argv ?? process.argv;
  const env = opts.env ?? process.env;
  const coMcpBin = currentCoMcpBin(argv);
  const homeDir = opts.homeDir ?? homedir();
  const coCli = resolveCoCliCommand(coMcpBin, env, opts.nodeCommand ?? process.execPath);
  // F3: source the GitHub token for the gated publish path from the daemon's env. CO_GH_TOKEN is the
  // co-specific channel (set by the desktop "Connect GitHub" UI, issue #71); GITHUB_TOKEN/GH_TOKEN
  // are honored as fallbacks for a CLI/CI launch. Empty/whitespace is treated as absent.
  const ghToken = [env['CO_GH_TOKEN'], env['GITHUB_TOKEN'], env['GH_TOKEN']]
    .map((v) => v?.trim())
    .find((v) => v != null && v.length > 0);
  return {
    coMcpCommand: opts.nodeCommand ?? process.execPath,
    coMcpArgs: [coMcpBin],
    coCliCommand: coCli.command,
    ...(coCli.args.length > 0 ? { coCliArgs: coCli.args } : {}),
    coMcpBridgeSocketPath: defaultBridgeSocketPath,
    ...(ghToken != null ? { ghToken } : {}),
    ...(opts.includeProviderAuth
      ? {
          ...readOptionalAuthFile(
            'claudeCredentialsJson',
            join(homeDir, '.claude', '.credentials.json'),
          ),
          ...readOptionalClaudeStateFile(join(homeDir, '.claude.json')),
          ...readOptionalAuthFile('codexAuthJson', join(homeDir, '.codex', 'auth.json')),
        }
      : {}),
  };
}

export interface CoCliCommandResolution {
  readonly command: string;
  readonly args: readonly string[];
}

export function defaultBridgeSocketPath(isolatedHomeDir: string, agent = 'agent'): string {
  const hash = createHash('sha256')
    .update(isolatedHomeDir)
    .update('\0')
    .update(agent)
    .digest('hex')
    .slice(0, 16);
  return resolve(tmpdir(), `co-mcp-${hash}`, 'bridge.sock');
}

export function currentCoMcpBin(argv: readonly string[] = process.argv): string {
  const raw = argv[1];
  if (raw == null || raw.trim().length === 0) {
    throw new Error('co-mcp: cannot resolve current co-mcp executable path.');
  }
  return resolve(raw);
}

export function resolveCoCliCommand(
  coMcpBin: string,
  env: NodeJS.ProcessEnv = process.env,
  nodeCommand = process.execPath,
): CoCliCommandResolution {
  const override = env['CO_CLI_COMMAND']?.trim();
  if (override != null && override.length > 0) {
    if (!isAbsolute(override)) {
      throw new Error(`co-mcp: CO_CLI_COMMAND must be absolute, got '${override}'.`);
    }
    return { command: override, args: [] };
  }

  const siblingDist = resolve(dirname(coMcpBin), '../../cli/dist/index.js');
  if (existsSync(siblingDist)) {
    if (!isAbsolute(nodeCommand)) {
      throw new Error(`co-mcp: node command must be absolute, got '${nodeCommand}'.`);
    }
    return { command: nodeCommand, args: [siblingDist] };
  }

  const pathHit = resolveCommandOnPath('co', env);
  if (pathHit != null) return { command: pathHit, args: [] };

  throw new Error(
    'co-mcp: cannot resolve an absolute co CLI command for the Codex block-list hook. ' +
      'Set CO_CLI_COMMAND=/absolute/path/to/co.',
  );
}

function resolveCommandOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = resolve(dir, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return undefined;
}

function readOptionalAuthFile(
  key: 'claudeCredentialsJson' | 'claudeStateJson' | 'codexAuthJson',
  path: string,
): Partial<Pick<CoMcpPaths, 'claudeCredentialsJson' | 'claudeStateJson' | 'codexAuthJson'>> {
  try {
    return { [key]: readFileSync(path, 'utf8') };
  } catch {
    return {};
  }
}

function readOptionalClaudeStateFile(path: string): Partial<Pick<CoMcpPaths, 'claudeStateJson'>> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  try {
    const claudeStateJson = sanitizeClaudeStateJson(raw);
    return claudeStateJson == null ? {} : { claudeStateJson };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`co-mcp: failed to sanitize Claude state file '${path}': ${detail}`, {
      cause,
    });
  }
}
