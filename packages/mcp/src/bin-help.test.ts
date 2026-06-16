import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderCoMcpHelp } from './bin-help.js';

const here = dirname(fileURLToPath(import.meta.url));
const runbook = readFileSync(join(process.cwd(), 'docs', 'sh1-runbook.md'), 'utf8');
const hostProof = readFileSync(join(process.cwd(), 'docs', 'host-proof.md'), 'utf8');
const hostSource = readFileSync(join(here, 'conductor', 'host.ts'), 'utf8');

describe('co-mcp binary help', () => {
  it('documents the operator serve invocation and other modes', () => {
    const help = renderCoMcpHelp();
    expect(help).toContain('co-mcp serve <projectId>');
    expect(help).toContain('co-mcp host-proof <provider> [projectId]');
    expect(help).toContain('co-mcp bridge <socketPath>');
  });

  it('routes --help to the help renderer instead of the stdio MCP server', () => {
    const source = readFileSync(join(here, 'bin.ts'), 'utf8');
    expect(source).toContain("mode === '--help'");
    expect(source).toContain('renderCoMcpHelp()');
  });

  it('keeps the SH-1 runbook honest about current live serve boundaries', () => {
    expect(runbook).toContain('co-mcp serve <projectId>');
    expect(runbook).toContain('does not yet auto-discover a freshly locked spec');
    expect(runbook).toMatch(/There is no public\s+`co spec lock` CLI command yet/);
    expect(runbook).toContain('For SH-1 evidence, submit from the Review view');
    expect(runbook).not.toContain(
      'picks up the task on its next tick and drives the full lifecycle autonomously',
    );
    expect(runbook).not.toContain('either the\n> Review view or the Mail view reply');
    expect(runbook).not.toContain('wait for the Reviewer agent to finish');
    expect(runbook).not.toContain('visible in `co doctor` output');
    expect(runbook).not.toContain('## Step 5 — Verify zero prototype involvement');
  });

  it('keeps host-live docs and runtime prefixes aligned with the co-mcp binary', () => {
    expect(hostProof).toContain('## Running `co-mcp serve <projectId>` and observing the daemon');
    expect(hostProof).toContain('[co-mcp serve] tick 1');
    expect(hostProof).not.toContain('[co serve]');
    expect(hostSource).not.toContain("console.error('[co serve]");
    expect(hostSource).not.toContain('`[co serve] tick');
    expect(hostSource).not.toContain("'co serve: a project id is required");
  });
});
