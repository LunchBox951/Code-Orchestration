/**
 * Surgical suppression of the `node:sqlite` ExperimentalWarning (AC-L0-6).
 *
 * On Node >=24, importing `node:sqlite` makes the runtime emit a process
 * 'warning' whose `name` is `ExperimentalWarning` and whose message names
 * SQLite. We replace `process.emit` with a shim that swallows ONLY that one
 * warning and delegates every other event untouched — far narrower than a
 * blanket `--disable-warning=ExperimentalWarning`, which would also hide
 * unrelated, legitimate warnings.
 *
 * Import this module BEFORE `node:sqlite` so the shim is installed before the
 * warning fires. It travels with the store module, so suppression works under
 * vitest, the CLI and the MCP server with no per-invocation node flags.
 */
const originalEmit = process.emit.bind(process);

process.emit = (event: string | symbol, ...args: unknown[]): boolean => {
  const warning = args[0];
  if (
    event === 'warning' &&
    warning instanceof Error &&
    warning.name === 'ExperimentalWarning' &&
    /SQLite/i.test(warning.message)
  ) {
    return false;
  }
  return originalEmit(event, ...args);
};

export {};
