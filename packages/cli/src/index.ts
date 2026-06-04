#!/usr/bin/env node
import { run } from './run.js';

const result = run();
process.stdout.write(result.output);
process.exit(result.exitCode);
