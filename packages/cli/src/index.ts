#!/usr/bin/env node
import { run } from './run.js';

const result = await run(process.argv.slice(2), process.cwd());
if (!process.stdout.write(result.output)) {
  await new Promise<void>((resolve) => process.stdout.once('drain', resolve));
}
process.exitCode = result.exitCode;
