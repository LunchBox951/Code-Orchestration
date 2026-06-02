import type { SchemaMap } from '../replay/decode.js';
import type { CompletionPredicate, MailKind } from './events.js';

/**
 * The L1-local mail-type no-stub assertion (AC-L1-7, spec §3.3; MC-1, Principle 4 —
 * declared-not-stubbed). A declared mail type that has no live flow is exactly the banned
 * stub; this is the integrity gate that proves the seed enum is complete and would catch
 * a type added to the enum without wiring it.
 *
 * L1 owns this LOCAL assertion (run as a test over the real registries); the full
 * build-time completeness gate across the whole system is DEFERRED to L2 (spec §2 DEFER),
 * which can build on this same reusable check. It is a pure function of the registries +
 * a `handles` probe — it does no I/O — so the test can prove it both GREEN (the real enum)
 * and RED (a synthetic declared-but-unflowed type).
 */

/** A declared type that fails the completeness check, with a human reason. */
export interface MailTypeViolation {
  readonly type: string;
  readonly reason: string;
}

/**
 * Check that every declared participant type is COMPLETE — not a stub. Iterate `types` (the
 * participant enum, i.e. `MAIL_TYPES` — NOT the infrastructure `mail.read` event). A type is
 * complete iff:
 *   (a) it has a registered zod schema (`schemas`),
 *   (b) it has a flow — it is classified (`kinds`) AND folded by the projector
 *       (`handles(type) === true`),
 *   (c) if actionable, it has a registered completion predicate (`predicates`); if
 *       informational, it has NONE.
 *
 * Returns one {@link MailTypeViolation} per failed condition (so a fully-unwired stub surfaces
 * several, each naming the type); an empty array ⇒ every declared type is complete.
 */
export function checkMailTypeCompleteness(args: {
  types: readonly string[];
  schemas: SchemaMap;
  kinds: ReadonlyMap<string, MailKind>;
  predicates: ReadonlyMap<string, CompletionPredicate>;
  handles: (type: string) => boolean;
}): MailTypeViolation[] {
  const { types, schemas, kinds, predicates, handles } = args;
  const violations: MailTypeViolation[] = [];

  for (const type of types) {
    // (a) schema — a declared type with no schema can't be validated on append/replay.
    if (!schemas.has(type)) {
      violations.push({ type, reason: 'missing zod schema (mailSchemas)' });
    }

    // (b) flow = classified AND folded. Both halves are required for a real flow: a type
    // must be classified (so its kind is known) and folded by the projector (so a `send`
    // actually lands in the read-model).
    const kind = kinds.get(type);
    if (kind == null) {
      violations.push({
        type,
        reason: 'missing classification (mailKinds — actionable|informational)',
      });
    }
    if (!handles(type)) {
      violations.push({ type, reason: 'not folded by the projector (handles returned false)' });
    }

    // (c) predicate iff actionable. Only meaningful once the type is classified; an
    // unclassified type is already flagged in (b), so we don't double-report it here.
    const hasPredicate = predicates.has(type);
    if (kind === 'actionable' && !hasPredicate) {
      violations.push({
        type,
        reason: 'actionable but missing completion predicate (completionPredicates)',
      });
    }
    if (kind === 'informational' && hasPredicate) {
      violations.push({
        type,
        reason: 'informational but has a completion predicate (should have none)',
      });
    }
  }

  return violations;
}
