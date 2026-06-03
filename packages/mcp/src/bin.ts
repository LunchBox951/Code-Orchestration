#!/usr/bin/env node
import { serve } from './serve.js';

/**
 * The `co-mcp` executable: the stdio MCP server entry. A fatal startup error (missing identity,
 * unregistered worktree, transport failure) fails loud to stderr and exits non-zero — never a
 * silent degrade (Principle 9). stdout is reserved for the MCP protocol stream.
 */
serve().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
