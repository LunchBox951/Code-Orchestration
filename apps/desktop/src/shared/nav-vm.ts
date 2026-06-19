import { assertNever } from '@co/core';

export type NavView = 'dashboard' | 'agents' | 'mail' | 'source' | 'usage';

export const NAV_VIEWS = [
  'dashboard',
  'agents',
  'mail',
  'source',
  'usage',
] as const satisfies ReadonlyArray<NavView>;

export interface NavState {
  readonly activeView: NavView;
}

type NavAction = { kind: 'navigate'; view: NavView };

function applyNavAction(state: NavState, action: NavAction): NavState {
  switch (action.kind) {
    case 'navigate':
      return { ...state, activeView: action.view };
    default:
      return assertNever(action.kind);
  }
}

export class NavVM {
  private _state: NavState = { activeView: 'dashboard' };
  private readonly listeners = new Set<(state: NavState) => void>();

  get state(): NavState {
    return this._state;
  }

  navigate(view: NavView): void {
    this._state = applyNavAction(this._state, { kind: 'navigate', view });
    this.emit();
  }

  subscribe(listener: (state: NavState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this._state;
    for (const listener of [...this.listeners]) listener(state);
  }
}
