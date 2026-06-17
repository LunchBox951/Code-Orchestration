import { operatorIpcSocketPath } from '@co/mcp';
import type {
  ApprovalReply,
  CostRollup,
  DeliveredMail,
  OperatorIpcTick,
  OperatorMailRef,
  OperatorObservation,
  ProjectId,
  RendererRegistry,
  ReplyDraft,
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
  openDispatchStore,
  openMailStore,
  projectDataDir,
} from '@co/core';
import { ConductorUnavailableError, OperatorIpcClient } from '@co/mcp';
import { NavVM } from '../shared/nav-vm.js';
import { ConnectionVM } from '../shared/connection-vm.js';
import { DashboardVM } from '../shared/dashboard-vm.js';
import { LimitsCostVM } from '../shared/limits-cost-vm.js';
import { MailVM } from '../shared/mail-vm.js';
import { AgentsConsoleVM } from '../shared/agents-console-vm.js';
import { ReviewVM } from '../shared/review-vm.js';
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
  refreshTranscript(): void;
  reviewSelect(reviewId: string): ReviewState;
  reviewBeginVerdict(verdict: 'PASS' | 'ISSUES'): ReviewState;
  reviewUpdateComposerBody(text: string): ReviewState;
  reviewCancelVerdict(): ReviewState;
  reviewSubmitVerdict(): Promise<ReviewState>;
  reviewRefresh(): ReviewState;
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

/** Map a fetch failure to operator-facing copy: the conductor-down guidance, else the raw message. */
function conductorOrError(e: unknown): string {
  return e instanceof ConductorUnavailableError
    ? 'Conductor unavailable — the app manages the daemon; check the status badge in the header (use Retry if it failed) to load review context.'
    : safeError(e);
}

/**
 * How long a review-context fetch may stay pending before the pane gives up and shows an in-pane error +
 * Retry (Principle 9 — no-silent-failures). A hung fetch would otherwise leave "Loading review context…"
 * on screen forever. Main-process code, so a real timer is fine; it is always cleared once the fetch settles.
 */
const REVIEW_CONTEXT_TIMEOUT_MS = 10_000;

export function createAppShell(deps: AppShellDeps): AppShell {
  const socketPath = deps.socketPath ?? defaultOperatorSocketPath(deps.projectId);
  let closed = false;

  // Open the mail store for the app's lifetime (D5 hybrid: static reads go direct,
  // daemon-down-safe). Only opened in production mode. Tests commonly inject only
  // the operator IPC client, so an injected client defaults static readers to [].
  const testMode = deps.client != null;
  const ownedStore =
    !testMode && deps.actionablesReader == null ? openMailStore(deps.projectId) : null;
  const readActionables: () => readonly DeliveredMail[] =
    deps.actionablesReader ??
    (ownedStore != null ? () => ownedStore.outstanding('@operator') : () => []);
  // Reuse ownedStore for mail reads in production; fall back to empty arrays in test mode.
  const readInbox: (r: string) => readonly DeliveredMail[] =
    deps.inboxReader ?? (ownedStore != null ? (r) => ownedStore.inbox(r) : () => []);
  const readOutbox: (s: string) => readonly DeliveredMail[] =
    deps.outboxReader ?? (ownedStore != null ? (s) => ownedStore.sentBy(s) : () => []);

  // Open the dispatch store for usage/cost static reads (D5: daemon-down-safe pure reads).
  // Opened in production mode only; injected-client tests default to empty readers.
  const ownedDispatchStore =
    !testMode && deps.bucketsReader == null ? openDispatchStore(deps.projectId) : null;
  const readBuckets: () => readonly UsageBucket[] =
    deps.bucketsReader ??
    (ownedDispatchStore != null ? () => ownedDispatchStore.readBuckets() : () => []);
  const readAccountStatuses: () => readonly UsageAccountStatus[] =
    deps.accountStatusesReader ??
    (ownedDispatchStore != null ? () => ownedDispatchStore.readAccountStatuses() : () => []);
  const readRollups: () => readonly CostRollup[] =
    deps.rollupsReader ??
    (ownedDispatchStore != null ? () => ownedDispatchStore.readRollups() : () => []);

  const dash = new DashboardVM();
  const limitsCostVm = new LimitsCostVM();
  const agentsConsoleVm = new AgentsConsoleVM();
  let transcriptRequestSeq = 0;
  agentsConsoleVm.subscribe((state) => {
    if (!closed) deps.onAgentsConsoleState?.(state);
  });

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
      .catch((e: unknown) => {
        // Never swallow (Principle 9): surface a persistent in-pane error + Retry. Guard on the
        // request-seq + selected agent so a stale or again-switched request cannot clobber a newer pane.
        if (
          !closed &&
          requestSeq === transcriptRequestSeq &&
          agentsConsoleVm.state.selectedAgentId === agentId
        ) {
          agentsConsoleVm.setTranscriptError(agentId, safeError(e));
        }
      });
  }

  function updateAgentsConsole(
    observation: OperatorObservation | null,
    backfill: 'none' | 'live' | 'live-transition',
  ): void {
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
    deps.onLimitsCostState?.(limitsCostVm.state);
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
        if (closed) return;
        deps.onConnectionError?.(`operator IPC connection error: ${safeError(e)}`);
      },
    });

  const unsubscribeTranscript = client.onTranscript((t) => {
    if (!closed) agentsConsoleVm.appendChunk(t);
  });

  const mailVm = new MailVM({
    registry: buildRegistry(deps.registry),
    onMarkRead: (recipient, seq) => {
      void client
        .markRead(recipient, seq)
        .then(() => {
          if (closed) return;
          doRefreshMail();
        })
        .catch((e: unknown) => {
          // Conductor down or gone mid-call — show a clear message, never crash.
          if (!closed && !(e instanceof ConductorUnavailableError)) {
            deps.onMailError?.(safeError(e));
          }
        });
    },
    onReply: async (target: OperatorMailRef, draft: ReplyDraft) => {
      try {
        await client.reply(target, draft);
        if (closed) return;
        doRefreshMail();
      } catch (e: unknown) {
        if (!closed) {
          deps.onMailError?.(
            e instanceof ConductorUnavailableError
              ? 'Conductor unavailable — the app manages the daemon; check the status badge in the header (use Retry if it failed) to send mail.'
              : safeError(e),
          );
        }
        throw e;
      }
    },
    onApprove: async (approvalSeq: number, reply: ApprovalReply) => {
      try {
        await client.approve(approvalSeq, reply);
        if (closed) return;
        doRefreshMail();
        // Refresh dashboard to update outstandingCount after actionable clears.
        void connVmRef.current?.refresh();
      } catch (e: unknown) {
        if (!closed) {
          deps.onMailError?.(
            e instanceof ConductorUnavailableError
              ? 'Conductor unavailable — the app manages the daemon; check the status badge in the header (use Retry if it failed) to approve or decline.'
              : safeError(e),
          );
        }
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

  mailVm.subscribe((state) => {
    if (!closed) deps.onMailState?.(state);
  });

  let reviewContextRequestSeq = 0;
  const reviewContextTimers = new Set<ReturnType<typeof setTimeout>>();
  const reviewVm = new ReviewVM({
    onFetchReviewContext: (reviewId) => {
      if (closed) return;
      const seq = ++reviewContextRequestSeq;
      // Race the fetch against a timeout so a hung conductor cannot leave the pane on "Loading…" forever
      // (Site 4). The timer only acts while this request is still the latest AND still loading; it is
      // always cleared once the fetch settles, so no dangling timer survives.
      const timer = setTimeout(() => {
        if (
          !closed &&
          seq === reviewContextRequestSeq &&
          reviewVm.state.context?.status === 'loading'
        ) {
          reviewVm.setReviewContextError(
            reviewId,
            'Timed out loading review context — the conductor may be busy or unreachable.',
          );
        }
      }, REVIEW_CONTEXT_TIMEOUT_MS);
      reviewContextTimers.add(timer);
      void client
        .reviewContext(reviewId)
        .then((ctx) => {
          if (!closed && seq === reviewContextRequestSeq) {
            reviewVm.setReviewContext(reviewId, ctx);
          }
        })
        .catch((e: unknown) => {
          // Never swallow (Principle 9): surface BOTH the in-pane error state AND the existing toast.
          if (!closed && seq === reviewContextRequestSeq) {
            const message = conductorOrError(e);
            reviewVm.setReviewContextError(reviewId, message);
            deps.onReviewError?.(message);
          }
        })
        .finally(() => {
          clearTimeout(timer);
          reviewContextTimers.delete(timer);
        });
    },
    onSubmitVerdict: async (target, draft) => {
      try {
        await client.reply(target, draft);
        if (closed) return;
        doRefreshReviews();
        void connVmRef.current?.refresh();
      } catch (e) {
        if (!closed) {
          deps.onReviewError?.(
            e instanceof ConductorUnavailableError
              ? 'Conductor unavailable — the app manages the daemon; check the status badge in the header (use Retry if it failed) to submit a verdict.'
              : safeError(e),
          );
        }
        throw e;
      }
    },
  });

  function doRefreshReviews(): void {
    if (closed) return;
    reviewVm.update(readInbox(OPERATOR));
  }

  reviewVm.subscribe((state) => {
    if (!closed) deps.onReviewState?.(state);
  });

  const nav = new NavVM();
  if (deps.onNavState) {
    nav.subscribe((state) => {
      if (!closed) deps.onNavState?.(state);
    });
  }

  const connVm = new ConnectionVM({
    client,
    onState: (state: ConnectionState) => {
      if (closed) return;
      deps.onConnectionState?.(state);
      dash.update(state.observation, readActionables());
      deps.onDashboardState?.(dash.state);
      updateAgentsConsole(state.observation, 'live');
      doRefreshMail();
      doRefreshReviews();
      doRefreshLimitsCost();
    },
    onTick: (tick: OperatorIpcTick) => {
      if (closed) return;
      const liveObs: OperatorObservation = { kind: 'live', snapshot: tick.snapshot };
      dash.update(liveObs, readActionables());
      deps.onDashboardState?.(dash.state);
      updateAgentsConsole(liveObs, 'live-transition');
      doRefreshMail();
      doRefreshReviews();
      doRefreshLimitsCost();
    },
  });
  connVmRef.current = connVm;

  doRefreshReviews();

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
      if (closed) return;
      agentsConsoleVm.selectAgent(agentId);
      refreshSelectedTranscript();
    },
    refreshTranscript(): void {
      // Retry for the in-pane transcript error: re-invoke the same fetch. A plain re-select of the same
      // agent is a no-op (selectAgent guards same-id), so the renderer routes Retry through here.
      refreshSelectedTranscript();
    },
    reviewSelect(reviewId: string): ReviewState {
      if (closed) return reviewVm.state;
      reviewVm.selectReview(reviewId);
      return reviewVm.state;
    },
    reviewBeginVerdict(verdict: 'PASS' | 'ISSUES'): ReviewState {
      if (closed) return reviewVm.state;
      reviewVm.beginVerdict(verdict);
      return reviewVm.state;
    },
    reviewUpdateComposerBody(text: string): ReviewState {
      if (closed) return reviewVm.state;
      reviewVm.updateComposerBody(text);
      return reviewVm.state;
    },
    reviewCancelVerdict(): ReviewState {
      if (closed) return reviewVm.state;
      reviewVm.cancelVerdict();
      return reviewVm.state;
    },
    async reviewSubmitVerdict(): Promise<ReviewState> {
      if (closed) return reviewVm.state;
      try {
        await reviewVm.submitVerdict();
      } catch {
        // onReviewError already fired from onSubmitVerdict; return current state.
      }
      return reviewVm.state;
    },
    reviewRefresh(): ReviewState {
      if (closed) return reviewVm.state;
      doRefreshReviews();
      return reviewVm.state;
    },
    async start() {
      await connVm.start();
    },
    async close() {
      if (closed) return;
      closed = true;
      transcriptRequestSeq++;
      reviewContextRequestSeq++;
      unsubscribeTranscript();
      for (const timer of reviewContextTimers) clearTimeout(timer);
      reviewContextTimers.clear();
      connVm.close();
      try {
        await client.close();
      } finally {
        ownedStore?.close();
        ownedDispatchStore?.close();
      }
    },
  };
}
