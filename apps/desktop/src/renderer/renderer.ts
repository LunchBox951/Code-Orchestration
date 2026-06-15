// Renderer entry: wires DOM nav switching and connection-state display to the
// coShell bridge exposed by the preload via contextBridge.

const NAV_VIEWS = ['dashboard', 'agents', 'mail', 'review', 'source', 'cost'] as const;
type NavView = (typeof NAV_VIEWS)[number];

function isNavView(v: unknown): v is NavView {
  return typeof v === 'string' && (NAV_VIEWS as ReadonlyArray<string>).includes(v);
}

function activateView(view: NavView): void {
  for (const el of document.querySelectorAll('.nav-item')) {
    el.classList.toggle('active', el.getAttribute('data-view') === view);
  }
  for (const el of document.querySelectorAll('.view')) {
    el.classList.toggle('active', el.id === `view-${view}`);
  }
}

function setLiveStatus(status: string): void {
  const dot = document.getElementById('live-dot');
  const label = document.getElementById('live-label');
  if (dot) dot.classList.toggle('live', status === 'live');
  if (label) label.textContent = status === 'live' ? 'live' : 'offline';
}

document.addEventListener('DOMContentLoaded', () => {
  const bridge = window.coShell;

  // Nav clicks → bridge
  document.getElementById('nav-rail')?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.nav-item');
    const view = item?.dataset['view'];
    if (isNavView(view)) {
      activateView(view);
      bridge.navigate(view);
    }
  });

  // Main → renderer state pushes
  bridge.onNavState((state) => {
    if (isNavView(state.activeView)) activateView(state.activeView);
  });

  bridge.onConnectionState((state) => {
    setLiveStatus(state.status);
  });
});
