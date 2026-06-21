#!/usr/bin/env node
import { run } from './run.js';

try {
  const result = await run(process.argv.slice(2), process.cwd());
  if (!process.stdout.write(result.output)) {
    await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
  }
  process.exitCode = result.exitCode;
} catch (err) {
  // run() is contracted to always resolve with {output, exitCode}; a rejection is a leaked failure.
  // Surface it on stderr (never stdout — hooks read deny JSON there) and exit non-zero rather than
  // crashing with a raw unhandled-rejection trace and no adapter output (Principle 9).
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`co: internal error: ${msg}\n`);
  process.exitCode = 1;
}
