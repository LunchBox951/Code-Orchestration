/** Render an unknown thrown value for rollback diagnostics. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wrap a failed rollback step with a deterministic operation label. */
export function rollbackError(operation: string, cause: unknown): Error {
  return new Error(`${operation} failed: ${errorMessage(cause)}`, { cause });
}

/**
 * Throw `primary` unless rollback also failed. When rollback failures exist, surface both the
 * original cause and the cleanup residue as an AggregateError.
 */
export function throwWithRollbackErrors(
  context: string,
  primary: unknown,
  rollbackErrors: readonly Error[],
): never {
  if (rollbackErrors.length === 0) throw primary;
  throw new AggregateError(
    [primary, ...rollbackErrors],
    `${context}: ${errorMessage(primary)}; rollback also failed: ${rollbackErrors
      .map((e) => e.message)
      .join('; ')}`,
  );
}
