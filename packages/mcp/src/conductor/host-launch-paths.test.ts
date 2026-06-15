import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  currentCoMcpBin,
  defaultBridgeSocketPath,
  defaultCoMcpPaths,
  resolveCoCliCommand,
} from './host-launch-paths.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('host launch path resolution', () => {
  it('builds co MCP paths from the current executable and an explicit co CLI override', () => {
    const paths = defaultCoMcpPaths({
      argv: ['node', '/tmp/repo/packages/mcp/dist/bin.js'],
      env: { CO_CLI_COMMAND: '/tmp/repo/packages/cli/dist/index.js' },
      nodeCommand: '/usr/bin/node',
    });

    expect(paths).toEqual({
      coMcpCommand: '/usr/bin/node',
      coMcpArgs: ['/tmp/repo/packages/mcp/dist/bin.js'],
      coCliCommand: '/tmp/repo/packages/cli/dist/index.js',
      coMcpBridgeSocketPath: defaultBridgeSocketPath,
    });
    expect(paths.coMcpBridgeSocketPath?.('/tmp/co-home', 'impl-x')).toMatch(
      /^\/tmp\/co-mcp-[0-9a-f]{16}\/bridge\.sock$/,
    );
  });

  it('optionally reads provider auth files for isolated host launch materialization', () => {
    const home = mkdtempSync(join(tmpdir(), 'co-home-'));
    dirs.push(home);
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.claude', '.credentials.json'), '{"claude":true}\n');
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: true,
        hasCompletedOnboarding: true,
        projects: { '/repo': { allowedTools: ['Bash'] } },
        mcpServers: { userConfigured: true },
        history: ['do not copy'],
      }) + '\n',
    );
    writeFileSync(join(home, '.codex', 'auth.json'), '{"codex":true}\n');

    const paths = defaultCoMcpPaths({
      argv: ['node', '/tmp/repo/packages/mcp/dist/bin.js'],
      env: { CO_CLI_COMMAND: '/tmp/repo/packages/cli/dist/index.js' },
      nodeCommand: '/usr/bin/node',
      includeProviderAuth: true,
      homeDir: home,
    });

    expect(paths.claudeCredentialsJson).toBe('{"claude":true}\n');
    expect(JSON.parse(paths.claudeStateJson ?? '{}')).toEqual({
      oauthAccount: true,
      hasCompletedOnboarding: true,
    });
    expect(paths.codexAuthJson).toBe('{"codex":true}\n');
  });

  it('finds co on PATH when no override or sibling dist file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'co-path-'));
    dirs.push(dir);
    const co = join(dir, 'co');
    writeFileSync(co, '#!/usr/bin/env sh\n');
    chmodSync(co, 0o755);

    expect(resolveCoCliCommand('/tmp/repo/packages/mcp/dist/bin.js', { PATH: dir })).toEqual({
      command: co,
      args: [],
    });
  });

  it('runs a sibling CLI dist bundle through node instead of requiring executable mode', () => {
    const repo = mkdtempSync(join(tmpdir(), 'co-sibling-'));
    dirs.push(repo);
    const mcpDist = join(repo, 'packages', 'mcp', 'dist');
    const cliDist = join(repo, 'packages', 'cli', 'dist');
    mkdirSync(mcpDist, { recursive: true });
    mkdirSync(cliDist, { recursive: true });
    const mcpBin = join(mcpDist, 'bin.js');
    const cliBin = join(cliDist, 'index.js');
    writeFileSync(mcpBin, 'console.log("mcp");\n');
    writeFileSync(cliBin, 'console.log("cli");\n');
    chmodSync(cliBin, 0o644);

    const resolved = resolveCoCliCommand(mcpBin, { PATH: '' }, '/usr/bin/node');

    expect(resolved).toEqual({ command: '/usr/bin/node', args: [cliBin] });
  });

  it('fails loud for missing argv[1] and relative CO_CLI_COMMAND', () => {
    expect(() => currentCoMcpBin(['node'])).toThrow(/cannot resolve/);
    expect(() =>
      resolveCoCliCommand('/tmp/repo/packages/mcp/dist/bin.js', {
        CO_CLI_COMMAND: 'co',
      }),
    ).toThrow(/absolute/);
  });
});
