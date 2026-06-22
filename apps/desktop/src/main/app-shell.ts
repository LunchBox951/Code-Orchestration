import { operatorIpcSocketPath } from '@co/mcp';
import type {
  ApprovalReply,
  ConfigStore,
  CostRollup,
  DeliveredMail,
  OperatorIpcTick,
  OperatorMailRef,
  OperatorObservation,
  ProjectId,
  RendererRegistry,
  ReplyDraft,
  SettingValidation,
  UsageAccountStatus,
  UsageBucket,
} from '@co/core';
import {
  createRendererRegistry,
  MAIL_APPROVAL,
  MAIL_CLARIFY_REQUEST,
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  OPERATOR,
  openConfigStore,
  openDispatchStore,
  openMailStore,
  projectDataDir,
  settingsDescriptors,
  validateSettingValue,
} from '@co/core';
import { ConductorUnavailableError, OperatorIpcClient } from '@co/mcp';
import { NavVM } from '../shared/nav-vm.js';
import { ConnectionVM } from '../shared/connection-vm.js';
import { DashboardVM } from '../shared/dashboard-vm.js';
import { LimitsCostVM } from '../shared/limits-cost-vm.js';
import { MailVM } from '../shared/mail-vm.js';
import { AgentsConsoleVM } from '../shared/agents-console-vm.js';
import { ReviewVM } from '../shared/review-vm.js';
import { SettingsVM } from '../shared/settings-vm.js';
import type { SettingsState, SettingsLayer } from '../shared/settings-vm.js';
import type { ConnectionState } from '../shared/connection-vm.js';
import type { NavState } from '../shared/nav-vm.js';
import type { DashboardState } from '../shared/dashboard-vm.js';
import type { LimitsCostState } from '../shared/limits-cost-vm.js';
import type { MailState } from '../shared/mail-vm.js';
import type { AgentsConsoleState } from '../shared/agents-console-vm.js';
import type { ReviewState } from '../shared/review-vm.js';

/**
 * The canonical socket path the server listens on for a given project.
 * Exported so tests can assert client↔server path agreement without
 * relying on the internal formula surviving a refactor silently.
 */
export function defaultOperatorSocketPath(projectId: ProjectId): string {
  return operatorIpcSocketPath(projectDataDir(projectId));
}

export interface AppShellDeps {
  readonly projectId: ProjectId;
  readonly socketPath?: string;
  /** Injectable for tests — production leaves this undefined (creates a real client). */
  readonly client?: OperatorIpcClient;
  /** Injectable for tests — production opens a real MailStore. */
  readonly actionablesReader?: () => readonly DeliveredMail[];
  /** Injectable for tests — reads a recipient's inbox (default: real MailStore). */
  readonly inboxReader?: (recipient: string) => readonly DeliveredMail[];
  /** Injectable for tests — reads a sender's outbox (default: real MailStore sentBy). */
  readonly outboxReader?: (sender: string) => readonly DeliveredMail[];
  /** Injectable for tests — provides the renderer registry (default: one with built-in type cards). */
  readonly registry?: RendererRegistry;
  /** Injectable for tests — reads usage buckets (default: real DispatchStore). */
  readonly bucketsReader?: () => readonly UsageBucket[];
  /** Injectable for tests — reads account statuses (default: real DispatchStore). */
  readonly accountStatusesReader?: () => readonly UsageAccountStatus[];
  /** Injectable for tests — reads cost rollups (default: real DispatchStore). */
  readonly rollupsReader?: () => readonly CostRollup[];
  /** Injectable for tests — the config cascade store (default: real openConfigStore()). */
  readonly configStore?: ConfigStore;
  readonly onNavState?: (state: NavState) => void;
  readonly onConnectionState?: (state: ConnectionState) => void;
  readonly onConnectionError?: (message: string) => void;
  readonly onDashboardState?: (state: DashboardState) => void;
  readonly onMailState?: (state: MailState) => void;
  readonly onMailError?: (message: string) => void;
  readonly onLimitsCostState?: (state: LimitsCostState) => void;
  readonly onAgentsConsoleState?: (state: AgentsConsoleState) => void;
  readonly onReviewState?: (state: ReviewState) => void;
  readonly onReviewError?: (message: string) => void;
  readonly onSettingsState?: (state: SettingsState) => void;
}

export interface AppShell {
  readonly nav: NavVM;
  readonly connection: ConnectionVM;
  readonly dashboard: DashboardVM;
  readonly mail: MailVM;
  readonly limitsCost: LimitsCostVM;
  readonly agentsConsole: AgentsConsoleVM;
  readonly client: OperatorIpcClient;
  start(): Promise<void>;
  close(): Promise<void>;
  refreshMail(busId?: string): void;
  refreshLimitsCost(): void;
  selectAgent(agentId: string | null): void;
  reviewSelect(reviewId: string): ReviewState;
  reviewBeginVerdict(verdict: 'PASS' | 'ISSUES'): ReviewState;
  reviewUpdateComposerBody(text: string): ReviewState;
  reviewCancelVerdict(): ReviewState;
  reviewSubmitVerdict(): Promise<ReviewState>;
  reviewRefresh(): ReviewState;
  readonly settings: SettingsVM;
  getSettingsState(): SettingsState;
  /** Validate then persist a setting to the given layer; returns the validation result (no throw). */
  setSetting(layer: SettingsLayer, key: string, value: unknown): SettingValidation;
  /** Clear a setting from the given layer (reset to inherited/default); returns the result (no throw). */
  clearSetting(layer: SettingsLayer, key: string): SettingValidation;
  setSettingsLayer(layer: SettingsLayer): void;
  refreshSettings(): void;
}

function buildRegistry(override?: RendererRegistry): RendererRegistry {
  if (override != null) return override;
  const registry = createRendererRegistry();
  registry.register(
    MAIL_APPROVAL,
    (m) =>
      `### Approval Request\n\n**Subject:** ${m.subject}\n\n${m.body}\n\n> Approve or decline this request.`,
  );
  registry.register(
    MAIL_CLARIFY_REQUEST,
    (m) =>
      `### Clarification Request\n\n**Subject:** ${m.subject}\n\n${m.body}\n\n> Reply with your clarification.`,
  );
  registry.register(
    MAIL_REVIEW_REQUEST,
    (m) =>
      `### Review Request\n\n**Subject:** ${m.subject}\n\n${m.body}\n\n> Open the Reviews view to inspect the diff and submit PASS or ISSUES.`,
  );
  registry.register(MAIL_REVIEW_RESPONSE, (m) => {
    const verdict = m.reviewVerdict ?? 'UNKNOWN';
    return `### Review Response — ${verdict}\n\n**Subject:** ${m.subject}\n\n${m.body}`;
  });
  return registry;
}

function safeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createAppShell(deps: AppShellDeps): AppShell {
  const socketPath = deps.socketPath ?? defaultOperatorSocketPath(deps.projectId);

  // Open the mail store for the app's lifetime (D5 hybrid: static reads go direct,
  // daemon-down-safe). Only opened when no readers are injected (production mode).
  // Tests that inject actionablesReader get ownedStore=null; mail reads return [] safely.
  const ownedStore = deps.actionablesReader == null ? openMailStore(deps.projectId) : null;
  const readActionables: () => readonly DeliveredMail[] =
    deps.actionablesReader ?? (() => ownedStore!.outstanding('@operator'));
  // Reuse ownedStore for mail reads in production; fall back to empty arrays in test mode.
  const readInbox: (r: string) => readonly DeliveredMail[] =
    deps.inboxReader ?? (ownedStore != null ? (r) => ownedStore.inbox(r) : () => []);
  const readOutbox: (s: string) => readonly DeliveredMail[] =
    deps.outboxReader ?? (ownedStore != null ? (s) => ownedStore.sentBy(s) : () => []);

  // Open the dispatch store for usage/cost static reads (D5: daemon-down-safe pure reads).
  // Opened when no readers are injected (production mode); tests inject reader fns directly.
  const ownedDispatchStore = deps.bucketsReader == null ? openDispatchStore(deps.projectId) : null;
  const readBuckets: () => readonly UsageBucket[] =
    deps.bucketsReader ??
    (ownedDispatchStore != null ? () => ownedDispatchStore.readBuckets() : () => []);
  const readAccountStatuses: () => readonly UsageAccountStatus[] =
    deps.accountStatusesReader ??
    (ownedDispatchStore != null ? () => ownedDispatchStore.readAccountStatuses() : () => []);
  const readRollups: () => readonly CostRollup[] =
    deps.rollupsReader ??
    (ownedDispatchStore != null ? () => ownedDispatchStore.readRollups() : () => []);

  // Open the config cascade store for the app's lifetime (D5 hybrid: static reads go direct,
  // daemon-down-safe). Opened in production; tests inject a fake. The global store is project-agnostic
  // (resolveLayers reads both the global base and this project's overrides).
  const ownedConfigStore = deps.configStore == null ? openConfigStore() : null;
  const configStore: ConfigStore | null = deps.configStore ?? ownedConfigStore;

  let closed = false;
  const shellSubscriptions: Array<() => void> = [];
  const publish = <T>(cb: ((state: T) => void) | undefined, state: T): void => {
    if (!closed) cb?.(state);
  };
  const publishError = (cb: ((message: string) => void) | undefined, message: string): void => {
    if (!closed) cb?.(message);
  };

  const dash = new DashboardVM();
  const limitsCostVm = new LimitsCostVM();
  const agentsConsoleVm = new AgentsConsoleVM();
  const settingsVm = new SettingsVM();
  settingsVm.subscribe((state) => deps.onSettingsState?.(state));

  function doRefreshSettings(): void {
    if (configStore == null) {
      settingsVm.setData({
        descriptors: settingsDescriptors(),
        global: {},
        project: {},
        projectId: null,
        hasProject: false,
      });
      return;
    }
    const layers = configStore.resolveLayers(deps.projectId);
    settingsVm.setData({
      descriptors: settingsDescriptors(),
      global: layers.global,
      project: layers.project,
      projectId: deps.projectId,
      hasProject: true,
    });
  }

  function doSetSetting(layer: SettingsLayer, key: string, value: unknown): SettingValidation {
    const verdict = validateSettingValue(key, value);
    if (!verdict.ok) return verdict;
    if (configStore == null) return { ok: false, error: 'config store unavailable' };
    if (layer === 'global') configStore.setGlobal(key, value);
    else configStore.setProjectOverride(deps.projectId, key, value);
    doRefreshSettings();
    return { ok: true };
  }

  function doClearSetting(layer: SettingsLayer, key: string): SettingValidation {
    if (configStore == null) return { ok: false, error: 'config store unavailable' };
    if (layer === 'global') configStore.clearGlobal(key);
    else configStore.clearProjectOverride(deps.projectId, key);
    doRefreshSettings();
    return { ok: true };
  }
  let transcriptRequestSeq = 0;
  shellSubscriptions.push(
    agentsConsoleVm.subscribe((state) => publish(deps.onAgentsConsoleState, state)),
  );

  function refreshSelectedTranscript(opts: { resetGeneration?: boolean } = {}): void {
    if (closed) return;
    const agentId = agentsConsoleVm.state.selectedAgentId;
    if (agentId == null) return;
    if (opts.resetGeneration === true) agentsConsoleVm.clearSelectedTranscript();
    const requestSeq = ++transcriptRequestSeq;
    void client
      .transcript(agentId)
      .then((tail) => {
        if (
          !closed &&
          requestSeq === transcriptRequestSeq &&
          agentsConsoleVm.state.selectedAgentId === agentId
        ) {
          agentsConsoleVm.setTranscriptTail(tail);
        }
      })
      .catch(() => {});
  }

  function updateAgentsConsole(
    observation: OperatorObservation | null,
    backfill: 'none' | 'live' | 'live-transition',
  ): void {
    if (closed) return;
    const wasLive = agentsConsoleVm.state.connection === 'live';
    agentsConsoleVm.update(observation);
    if (
      observation?.kind === 'live' &&
      (backfill === 'live' || (backfill === 'live-transition' && !wasLive))
    ) {
      refreshSelectedTranscript({ resetGeneration: true });
    }
  }

  function doRefreshLimitsCost(): void {
    if (closed) return;
    limitsCostVm.update({
      buckets: readBuckets(),
      accountStatuses: readAccountStatuses(),
      rollups: readRollups(),
    });
    publish(deps.onLimitsCostState, limitsCostVm.state);
  }

  // Declare the ref before the client so the onState closure is TDZ-safe and
  // refactor-safe: the handler always resolves through the ref, not the variable.
  const connVmRef: { current?: ConnectionVM } = {};

  const client =
    deps.client ??
    new OperatorIpcClient({
      projectId: deps.projectId,
      socketPath,
      onState: (s) => {
        if (closed) return;
        if (s === 'disconnected') {
          void connVmRef.current?.refresh();
        }
      },
      onError: (e) => {
        publishError(deps.onConnectionError, `operator IPC connection error: ${safeError(e)}`);
      },
    });

  shellSubscriptions.push(
    client.onTranscript((t) => {
      if (closed) return;
      if (agentsConsoleVm.appendChunk(t) === 'gap') {
        refreshSelectedTranscript({ resetGeneration: true });
      }
    }),
  );

  const mailVm = new MailVM({
    registry: buildRegistry(deps.registry),
    onMarkRead: (recipient, seq) => {
      void client
        .markRead(recipient, seq)
        .then(() => {
          doRefreshMail();
        })
        .catch((e: unknown) => {
          if (closed) return;
          // Conductor down or gone mid-call — show a clear message, never crash.
          if (!(e instanceof ConductorUnavailableError)) {
            publishError(deps.onMailError, safeError(e));
          }
        });
    },
    onReply: async (target: OperatorMailRef, draft: ReplyDraft) => {
      try {
        await client.reply(target, draft);
        doRefreshMail();
      } catch (e: unknown) {
        publishError(
          deps.onMailError,
          e instanceof ConductorUnavailableError
            ? 'Conductor not running — start `co-mcp serve <projectId>` to send mail.'
            : safeError(e),
        );
        throw e;
      }
    },
    onApprove: async (approvalSeq: number, reply: ApprovalReply) => {
      try {
        await client.approve(approvalSeq, reply);
        doRefreshMail();
        // Refresh dashboard to update outstandingCount after actionable clears.
        void connVmRef.current?.refresh();
      } catch (e: unknown) {
        publishError(
          deps.onMailError,
          e instanceof ConductorUnavailableError
            ? 'Conductor not running — start `co-mcp serve <projectId>` to approve/decline.'
            : safeError(e),
        );
        throw e;
      }
    },
    onSelectBus: (busId: string) => {
      doRefreshMail(busId);
    },
  });

  function doRefreshMail(busId?: string): void {
    if (closed) return;
    const bus = busId ?? mailVm.state.activeBus;
    const inbox = readInbox(bus);
    const outbox = readOutbox(bus);
    mailVm.update(inbox, outbox);
  }

  shellSubscriptions.push(mailVm.subscribe((state) => publish(deps.onMailState, state)));

  let reviewContextRequestSeq = 0;
  const reviewVm = new ReviewVM({
    onFetchReviewContext: (reviewId) => {
      if (closed) return;
      const seq = ++reviewContextRequestSeq;
      void client
        .reviewContext(reviewId)
        .then((ctx) => {
          if (!closed && seq === reviewContextRequestSeq) reviewVm.setReviewContext(reviewId, ctx);
        })
        .catch(() => {});
    },
    onSubmitVerdict: async (target, draft) => {
      try {
        await client.reply(target, draft);
        doRefreshReviews();
        void connVmRef.current?.refresh();
      } catch (e) {
        publishError(
          deps.onReviewError,
          e instanceof ConductorUnavailableError
            ? 'Conductor not running — start `co-mcp serve <projectId>` to submit a verdict.'
            : safeError(e),
        );
        throw e;
      }
    },
  });

  function doRefreshReviews(): void {
    if (closed) return;
    reviewVm.update(readInbox(OPERATOR));
  }

  shellSubscriptions.push(reviewVm.subscribe((state) => publish(deps.onReviewState, state)));

  const nav = new NavVM();
  if (deps.onNavState) {
    shellSubscriptions.push(nav.subscribe((state) => publish(deps.onNavState, state)));
  }

  const connVm = new ConnectionVM({
    client,
    onState: (state: ConnectionState) => {
      if (closed) return;
      publish(deps.onConnectionState, state);
      dash.update(state.observation, readActionables());
      publish(deps.onDashboardState, dash.state);
      updateAgentsConsole(state.observation, 'live');
      doRefreshMail();
      doRefreshReviews();
      doRefreshLimitsCost();
    },
    onTick: (tick: OperatorIpcTick) => {
      if (closed) return;
      const liveObs: OperatorObservation = { kind: 'live', snapshot: tick.snapshot };
      dash.update(liveObs, readActionables());
      publish(deps.onDashboardState, dash.state);
      updateAgentsConsole(liveObs, 'live-transition');
      doRefreshMail();
      doRefreshReviews();
      doRefreshLimitsCost();
    },
  });
  connVmRef.current = connVm;

  doRefreshReviews();
  doRefreshSettings();

  return {
    nav,
    connection: connVm,
    dashboard: dash,
    mail: mailVm,
    limitsCost: limitsCostVm,
    agentsConsole: agentsConsoleVm,
    client,
    refreshMail: doRefreshMail,
    refreshLimitsCost: doRefreshLimitsCost,
    selectAgent(agentId: string | null): void {
      agentsConsoleVm.selectAgent(agentId);
      refreshSelectedTranscript();
    },
    reviewSelect(reviewId: string): ReviewState {
      reviewVm.selectReview(reviewId);
      return reviewVm.state;
    },
    reviewBeginVerdict(verdict: 'PASS' | 'ISSUES'): ReviewState {
      reviewVm.beginVerdict(verdict);
      return reviewVm.state;
    },
    reviewUpdateComposerBody(text: string): ReviewState {
      reviewVm.updateComposerBody(text);
      return reviewVm.state;
    },
    reviewCancelVerdict(): ReviewState {
      reviewVm.cancelVerdict();
      return reviewVm.state;
    },
    async reviewSubmitVerdict(): Promise<ReviewState> {
      try {
        await reviewVm.submitVerdict();
      } catch {
        // onReviewError already fired from onSubmitVerdict; return current state.
      }
      return reviewVm.state;
    },
    reviewRefresh(): ReviewState {
      doRefreshReviews();
      return reviewVm.state;
    },
    settings: settingsVm,
    getSettingsState(): SettingsState {
      return settingsVm.state;
    },
    setSetting(layer: SettingsLayer, key: string, value: unknown): SettingValidation {
      return doSetSetting(layer, key, value);
    },
    clearSetting(layer: SettingsLayer, key: string): SettingValidation {
      return doClearSetting(layer, key);
    },
    setSettingsLayer(layer: SettingsLayer): void {
      settingsVm.setActiveLayer(layer);
    },
    refreshSettings(): void {
      doRefreshSettings();
    },
    async start() {
      if (closed) return;
      await connVm.start();
    },
    async close() {
      if (closed) return;
      closed = true;
      transcriptRequestSeq += 1;
      reviewContextRequestSeq += 1;
      for (const unsubscribe of shellSubscriptions.splice(0)) unsubscribe();
      connVm.close();
      await client.close();
      ownedStore?.close();
      ownedDispatchStore?.close();
      ownedConfigStore?.close();
    },
  };
}
