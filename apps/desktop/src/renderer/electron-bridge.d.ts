interface CoShellBridge {
  navigate(view: string): void;
  refreshConnection(): Promise<{ status: string; observation: unknown } | null>;
  onNavState(listener: (state: { activeView: string }) => void): () => void;
  onConnectionState(
    listener: (state: { status: string; observation: unknown }) => void,
  ): () => void;
}

interface Window {
  coShell: CoShellBridge;
}
