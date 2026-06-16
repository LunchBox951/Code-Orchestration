export function renderCoMcpHelp(): string {
  return [
    'Usage:',
    '  co-mcp                         Start the stdio MCP server',
    '  co-mcp serve <projectId>       Start the operator Conductor daemon',
    '  co-mcp host-proof <provider> [projectId]',
    '                                 Run the host-live proof harness',
    '  co-mcp bridge <socketPath>     Start the provider-side socket bridge',
    '  co-mcp start-session <projectId> (--prompt "…" | --spec <path>)',
    '                                 Launch a root coordinator (operator-only)',
    '',
    'Notes:',
    '  serve requires the explicit registered project id. It does not infer from cwd.',
    '  start-session requires exactly one of --prompt / --spec (both/neither fails loud).',
    '  stdout is reserved for MCP protocol output except for this help text.',
  ].join('\n');
}
