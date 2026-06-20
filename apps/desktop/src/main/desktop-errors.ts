import { ConductorUnavailableError } from '@co/mcp';

export function desktopErrorMessage(error: unknown, action: string): string {
  if (error instanceof ConductorUnavailableError) {
    return (
      'Conductor unavailable — the app manages the daemon; check the status badge in the header ' +
      `(use Retry if it failed) to ${action}.`
    );
  }
  return error instanceof Error ? error.message : String(error);
}
