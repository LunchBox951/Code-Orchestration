/**
 * Exhaustiveness guard for discriminated unions (mail types, agent states, …).
 * Calling it is a type error unless every variant has been handled; at runtime
 * it throws, so an unhandled variant fails loudly (Principle 9 — no-silent-failures).
 */
export function assertNever(value: never): never {
  throw new Error(`assertNever: unexpected value: ${JSON.stringify(value)}`);
}
