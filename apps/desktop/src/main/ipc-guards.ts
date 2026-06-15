import { MAIL_TYPES, type MailType, type Steer } from '@co/core';
import { NAV_VIEWS, type NavView } from '../shared/nav-vm.js';

export type MailTab = 'inbox' | 'outbox';
export type ComposerField = 'type' | 'subject' | 'body';

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`Invalid ${label}: ${String(value)}`);
}

export function requireNavView(value: unknown): NavView {
  return requireOneOf(value, NAV_VIEWS, 'nav view');
}

export function requireMailTab(value: unknown): MailTab {
  return requireOneOf(value, ['inbox', 'outbox'] as const, 'mail tab');
}

export function requireMailType(value: unknown): MailType {
  return requireOneOf(value, MAIL_TYPES, 'mail type');
}

export function requireComposerField(value: unknown): ComposerField {
  return requireOneOf(value, ['type', 'subject', 'body'] as const, 'composer field');
}

export function requireFiniteSeq(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value) && value > 0) {
    return value;
  }
  throw new Error(`Invalid ${label}: expected a positive integer sequence number.`);
}

export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new Error(`Invalid ${label}: expected a non-empty string.`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Invalid ${label}: expected an object.`);
}

function requireNonBlankString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  throw new Error(`Invalid ${label}: expected a non-empty string.`);
}

export function requireAgentId(value: unknown): string {
  return requireNonBlankString(value, 'agentId').trim();
}

export function requireSteer(value: unknown): Steer {
  const obj = asRecord(value, 'steer');
  const kind = obj['kind'];
  if (kind === 'answer' || kind === 'redirect') {
    const text = requireNonBlankString(obj['text'], 'steer text');
    return { kind, text };
  }
  if (kind === 'interrupt') {
    return { kind: 'interrupt' };
  }
  throw new Error(`Invalid steer kind: ${String(kind)}`);
}
