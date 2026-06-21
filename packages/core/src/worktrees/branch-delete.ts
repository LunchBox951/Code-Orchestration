/** Return every message in an error chain, including `cause` chains from wrapped git errors. */
function errorMessages(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const messages = [error.message];
  let cause: unknown = error.cause;
  while (cause instanceof Error) {
    messages.push(cause.message);
    cause = cause.cause;
  }
  return messages;
}

/**
 * Detect the idempotent half-success case for `git branch -D <branch>`: the branch has already been
 * deleted, so callers may safely remove the durable archive record that was left behind.
 */
export function isMissingBranchDeleteError(error: unknown, branch: string): boolean {
  const needle = `branch '${branch}' not found`;
  return errorMessages(error).some((message) => message.includes(needle));
}
