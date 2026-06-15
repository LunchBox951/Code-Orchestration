import { describe, it, expect, vi } from 'vitest';
import { createRendererRegistry } from '@co/core';
import type { DeliveredMail, MailType } from '@co/core';
import { MailVM } from './mail-vm.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeMail(overrides: Partial<DeliveredMail> = {}): DeliveredMail {
  return {
    seq: 1,
    recipient: '@operator',
    sender: 'lead-1',
    type: 'clarify_request' as MailType,
    subject: 'Need help',
    body: 'can you help?',
    ts: 1000,
    kind: 'actionable',
    read: false,
    resolved: false,
    ...overrides,
  } as DeliveredMail;
}

function makeInfoMail(overrides: Partial<DeliveredMail> = {}): DeliveredMail {
  return makeMail({
    seq: 10,
    type: 'chat' as MailType,
    subject: 'Hello',
    body: 'just a note',
    kind: 'informational',
    read: false,
    ...overrides,
  });
}

function makeApprovalMail(overrides: Partial<DeliveredMail> = {}): DeliveredMail {
  return makeMail({
    seq: 20,
    type: 'approval' as MailType,
    subject: 'Publish?',
    body: 'can we merge?',
    kind: 'actionable',
    ...overrides,
  });
}

// ── MailVM — initial state ─────────────────────────────────────────────────────

describe('MailVM — initial state', () => {
  it('starts with @operator bus, inbox tab, empty lists, no selection', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    expect(vm.state.activeBus).toBe('@operator');
    expect(vm.state.tab).toBe('inbox');
    expect(vm.state.inbox).toHaveLength(0);
    expect(vm.state.outbox).toHaveLength(0);
    expect(vm.state.selected).toBeNull();
    expect(vm.state.composer.active).toBe(false);
  });

  it('respects initialBus override', () => {
    const vm = new MailVM({ registry: createRendererRegistry(), initialBus: 'agent-42' });
    expect(vm.state.activeBus).toBe('agent-42');
  });
});

// ── MailVM — update + renderer ─────────────────────────────────────────────────

describe('MailVM — update and per-type rendering', () => {
  it('renders inbox rows via the default renderer', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    const mail = makeMail({ seq: 5, subject: 'clarify me' });
    vm.update([mail], []);
    expect(vm.state.inbox).toHaveLength(1);
    const row = vm.state.inbox[0]!;
    expect(row.seq).toBe(5);
    expect(row.type).toBe('clarify_request');
    expect(row.subject).toBe('clarify me');
    expect(row.renderedBody).toContain('clarify_request');
  });

  it('uses a registered per-type renderer instead of the default (SF-6 plug-point)', () => {
    const registry = createRendererRegistry();
    registry.register('approval', (m) => `APPROVAL_CARD: ${m.subject}`);
    const vm = new MailVM({ registry });
    const approval = makeApprovalMail({ seq: 99, subject: 'Merge it?' });
    vm.update([approval], []);
    const row = vm.state.inbox[0]!;
    expect(row.renderedBody).toBe('APPROVAL_CARD: Merge it?');
    expect(row.renderedBody).not.toContain('### approval');
  });

  it('falls back to defaultMailRenderer for unregistered types', () => {
    const registry = createRendererRegistry();
    registry.register('approval', () => 'CARD');
    const vm = new MailVM({ registry });
    const chat = makeInfoMail({ type: 'chat' as MailType });
    vm.update([chat], []);
    expect(vm.state.inbox[0]!.renderedBody).toContain('chat');
  });

  it('derives kind correctly — clarify_request is actionable', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    vm.update([makeMail()], []);
    expect(vm.state.inbox[0]!.kind).toBe('actionable');
  });

  it('derives kind correctly — chat is informational', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    vm.update([makeInfoMail()], []);
    expect(vm.state.inbox[0]!.kind).toBe('informational');
  });

  it('populates outbox rows', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    const sent = makeMail({ seq: 77, sender: '@operator', recipient: 'lead-1' });
    vm.update([], [sent]);
    expect(vm.state.outbox).toHaveLength(1);
    expect(vm.state.outbox[0]!.seq).toBe(77);
  });

  it('refreshes rows on subsequent update calls', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    vm.update([makeMail({ seq: 1 })], []);
    expect(vm.state.inbox).toHaveLength(1);
    vm.update([makeMail({ seq: 1 }), makeMail({ seq: 2 })], []);
    expect(vm.state.inbox).toHaveLength(2);
  });
});

// ── MailVM — selectMail and markRead (MNR #1) ─────────────────────────────────

describe('MailVM — selectMail + MNR #1 (actionable stays sticky)', () => {
  it('selectMail sets the selected row', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    const mail = makeInfoMail({ seq: 3 });
    vm.update([mail], []);
    vm.selectMail(3);
    expect(vm.state.selected?.seq).toBe(3);
  });

  it('informational mail in @operator inbox fires markRead on view', () => {
    const onMarkRead = vi.fn();
    const vm = new MailVM({ registry: createRendererRegistry(), onMarkRead });
    const info = makeInfoMail({ seq: 5, recipient: '@operator', read: false });
    vm.update([info], []);
    vm.selectMail(5);
    expect(onMarkRead).toHaveBeenCalledOnce();
    expect(onMarkRead).toHaveBeenCalledWith('@operator', 5);
  });

  it('MNR #1: actionable mail does NOT fire markRead on view', () => {
    const onMarkRead = vi.fn();
    const vm = new MailVM({ registry: createRendererRegistry(), onMarkRead });
    const action = makeMail({ seq: 7, type: 'clarify_request' as MailType, read: false });
    vm.update([action], []);
    vm.selectMail(7);
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it('MNR #1: approval mail does NOT fire markRead on view', () => {
    const onMarkRead = vi.fn();
    const vm = new MailVM({ registry: createRendererRegistry(), onMarkRead });
    const approval = makeApprovalMail({ seq: 8, read: false });
    vm.update([approval], []);
    vm.selectMail(8);
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it('agent-bus view: informational mail does NOT fire markRead (read-only)', () => {
    const onMarkRead = vi.fn();
    const vm = new MailVM({ registry: createRendererRegistry(), onMarkRead });
    vm.selectBus('agent-42');
    const info = makeInfoMail({ seq: 9, recipient: 'agent-42', read: false });
    vm.update([info], []);
    vm.selectMail(9);
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it('already-read informational mail does NOT fire markRead again', () => {
    const onMarkRead = vi.fn();
    const vm = new MailVM({ registry: createRendererRegistry(), onMarkRead });
    const info = makeInfoMail({ seq: 11, read: true });
    vm.update([info], []);
    vm.selectMail(11);
    expect(onMarkRead).not.toHaveBeenCalled();
  });

  it('selectMail on unknown seq is a no-op', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    vm.update([makeMail({ seq: 1 })], []);
    expect(() => vm.selectMail(999)).not.toThrow();
    expect(vm.state.selected).toBeNull();
  });
});

// ── MailVM — selectBus (agent-bus toggle) ─────────────────────────────────────

describe('MailVM — selectBus (agent-bus toggle)', () => {
  it('switching bus changes activeBus and clears selection', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    vm.update([makeMail({ seq: 1 })], []);
    vm.selectMail(1);
    expect(vm.state.selected).not.toBeNull();

    vm.selectBus('agent-xyz');
    expect(vm.state.activeBus).toBe('agent-xyz');
    expect(vm.state.selected).toBeNull();
  });

  it('switching bus clears stale rows until the refreshed bus rows arrive', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    vm.update([makeMail({ seq: 1 })], [makeMail({ seq: 2, sender: '@operator' })]);

    vm.selectBus('agent-xyz');

    expect(vm.state.inbox).toHaveLength(0);
    expect(vm.state.outbox).toHaveLength(0);
  });

  it('fires onSelectBus callback so the main process can re-fetch', () => {
    const onSelectBus = vi.fn();
    const vm = new MailVM({ registry: createRendererRegistry(), onSelectBus });
    vm.selectBus('agent-xyz');
    expect(onSelectBus).toHaveBeenCalledOnce();
    expect(onSelectBus).toHaveBeenCalledWith('agent-xyz');
  });

  it('after selectBus, update changes the rows for the new bus', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    vm.selectBus('agent-xyz');
    const agentMail = makeInfoMail({ seq: 99, recipient: 'agent-xyz' });
    vm.update([agentMail], []);
    expect(vm.state.inbox).toHaveLength(1);
    expect(vm.state.inbox[0]!.seq).toBe(99);
  });
});

// ── MailVM — reply composer ────────────────────────────────────────────────────

describe('MailVM — reply composer', () => {
  it('openComposer activates the composer with target info', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    vm.openComposer(42, 'lead-1', 'clarify_response', 're: clarify me');
    const c = vm.state.composer;
    expect(c.active).toBe(true);
    expect(c.targetSeq).toBe(42);
    expect(c.targetRecipient).toBe('lead-1');
    expect(c.type).toBe('clarify_response');
    expect(c.subject).toBe('re: clarify me');
    expect(c.body).toBe('');
  });

  it('updateComposerField updates the body', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    vm.openComposer(1, 'lead-1', 'clarify_response', 're: X');
    vm.updateComposerField('body', 'my answer');
    expect(vm.state.composer.body).toBe('my answer');
  });

  it('closeComposer deactivates the composer', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    vm.openComposer(1, 'lead-1', 'clarify_response', 're: X');
    vm.closeComposer();
    expect(vm.state.composer.active).toBe(false);
  });

  it('submitReply fires onReply with correct target and draft', () => {
    const onReply = vi.fn();
    const vm = new MailVM({ registry: createRendererRegistry(), onReply });
    vm.openComposer(5, 'lead-1', 'clarify_response', 're: help');
    vm.updateComposerField('body', 'here is my answer');
    vm.submitReply();
    expect(onReply).toHaveBeenCalledOnce();
    const [target, draft] = onReply.mock.calls[0] as [
      { seq: number; recipient: string },
      { type: string; subject: string; body: string },
    ];
    expect(target.seq).toBe(5);
    expect(target.recipient).toBe('lead-1');
    expect(draft.type).toBe('clarify_response');
    expect(draft.subject).toBe('re: help');
    expect(draft.body).toBe('here is my answer');
  });

  it('submitReply closes the composer after firing', () => {
    const vm = new MailVM({ registry: createRendererRegistry(), onReply: vi.fn() });
    vm.openComposer(5, 'lead-1', 'clarify_response', 're: X');
    vm.submitReply();
    expect(vm.state.composer.active).toBe(false);
  });

  it('submitReply is a no-op when composer is inactive', () => {
    const onReply = vi.fn();
    const vm = new MailVM({ registry: createRendererRegistry(), onReply });
    vm.submitReply();
    expect(onReply).not.toHaveBeenCalled();
  });
});

// ── MailVM — approve / decline quick-actions ──────────────────────────────────

describe('MailVM — approve/decline quick-actions', () => {
  it('approve fires onApprove with decision approve', () => {
    const onApprove = vi.fn();
    const vm = new MailVM({ registry: createRendererRegistry(), onApprove });
    vm.approve(20);
    expect(onApprove).toHaveBeenCalledOnce();
    const [seq, reply] = onApprove.mock.calls[0] as [number, { decision: string }];
    expect(seq).toBe(20);
    expect(reply.decision).toBe('approve');
  });

  it('decline fires onApprove with decision decline', () => {
    const onApprove = vi.fn();
    const vm = new MailVM({ registry: createRendererRegistry(), onApprove });
    vm.decline(20);
    const [, reply] = onApprove.mock.calls[0] as [number, { decision: string }];
    expect(reply.decision).toBe('decline');
  });

  it('approveWithComposer uses composer body + closes composer', () => {
    const onApprove = vi.fn();
    const vm = new MailVM({ registry: createRendererRegistry(), onApprove });
    vm.openComposer(20, '@operator', 'clarify_response', 'approve?');
    vm.updateComposerField('body', 'lgtm!');
    vm.approveWithComposer(20);
    const [seq, reply] = onApprove.mock.calls[0] as [number, { decision: string; body: string }];
    expect(seq).toBe(20);
    expect(reply.decision).toBe('approve');
    expect(reply.body).toBe('lgtm!');
    expect(vm.state.composer.active).toBe(false);
  });
});

// ── MailVM — subscribe / emit ─────────────────────────────────────────────────

describe('MailVM — subscribe / emit', () => {
  it('notifies subscribers on update', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    const listener = vi.fn();
    vm.subscribe(listener);
    vm.update([makeMail()], []);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ inbox: expect.any(Array) }));
  });

  it('allows multiple subscribers', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    const a = vi.fn();
    const b = vi.fn();
    vm.subscribe(a);
    vm.subscribe(b);
    vm.update([], []);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops notifications', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    const listener = vi.fn();
    const unsub = vm.subscribe(listener);
    unsub();
    vm.update([], []);
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies subscribers on selectBus', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    const listener = vi.fn();
    vm.subscribe(listener);
    vm.selectBus('agent-1');
    expect(listener).toHaveBeenCalledOnce();
  });
});

// ── MailVM — selected stays fresh after update ────────────────────────────────

describe('MailVM — selected refreshes on subsequent update', () => {
  it('selected row is updated when new data arrives', () => {
    const registry = createRendererRegistry();
    const vm = new MailVM({ registry });
    const initial = makeInfoMail({ seq: 5, subject: 'old subject' });
    vm.update([initial], []);
    vm.selectMail(5);
    expect(vm.state.selected?.subject).toBe('old subject');

    const updated = makeInfoMail({ seq: 5, subject: 'new subject' });
    vm.update([updated], []);
    expect(vm.state.selected?.subject).toBe('new subject');
  });

  it('selected is cleared when the item disappears from the list', () => {
    const vm = new MailVM({ registry: createRendererRegistry() });
    vm.update([makeInfoMail({ seq: 5 })], []);
    vm.selectMail(5);
    expect(vm.state.selected).not.toBeNull();
    vm.update([], []);
    expect(vm.state.selected).toBeNull();
  });
});
