import { CORE_PACKAGE } from '@co/core';

export function describeServer(): { surface: 'mcp'; core: string } {
  return { surface: 'mcp', core: CORE_PACKAGE };
}
