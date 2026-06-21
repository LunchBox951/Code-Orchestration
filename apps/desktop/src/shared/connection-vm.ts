import type { OperatorObservation, OperatorIpcTick } from '@co/core';
import type { OperatorIpcClient } from '@co/mcp';

export type ConnectionStatus = 'connecting' | 'live' | 'degraded';

export interface ConnectionState {
  readonly status: ConnectionStatus;
  readonly observation: OperatorObservation | null;
}

export interface ConnectionVMDeps {
  readonly client: OperatorIpcClient;
  readonly onState?: (state: ConnectionState) => void;
  readonly onTick?: (tick: OperatorIpcTick) => void;
}

/**
 * Headless-testable view-model that wraps the P1 OperatorIpcClient and owns the
 * connection state machine for the desktop app. The renderer learns about updates
 * via the contextBridge bridge (preload → main → this VM).
 */
export class ConnectionVM {
  private _state: ConnectionState = { status: 'connecting', observation: null };
  private readonly client: OperatorIpcClient;
  private readonly onState: ((state: ConnectionState) => void) | undefined;
  private readonly onTickCb: ((tick: OperatorIpcTick) => void) | undefined;
  private unsubTick: (() => void) | null = null;
  private closed = false;
  private refreshGeneration = 0;

  constructor(deps: ConnectionVMDeps) {
    this.client = deps.client;
    this.onState = deps.onState;
    this.onTickCb = deps.onTick;
  }

  get state(): ConnectionState {
    return this._state;
  }

  async start(): Promise<void> {
    this.closed = false;
    this.unsubTick = this.client.onTick((tick) => {
      if (this.closed) return;
      this.onTickCb?.(tick);
    });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const observation = await this.client.observe();
    if (this.closed || generation !== this.refreshGeneration) return;
    const status: ConnectionStatus = observation.kind === 'live' ? 'live' : 'degraded';
    this._state = { status, observation };
    this.onState?.(this._state);
  }

  close(): void {
    this.closed = true;
    this.refreshGeneration += 1;
    this.unsubTick?.();
    this.unsubTick = null;
  }
}
