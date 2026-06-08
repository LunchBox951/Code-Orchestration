import { describe, it, expect } from 'vitest';
import {
  EVENT_MERGE_SERIALIZED,
  EVENT_REVIEW_OVERRIDE,
  EVENT_REVIEW_REQUESTED,
  EVENT_REVIEW_STRIKE,
  EVENT_REVIEW_VERDICT,
} from './events.js';
import { ReviewProjector } from './review-projector.js';

// The projector claims the seam for ALL FIVE L5 event types now (so B–F add only writers, never reshape
// the table — keeping replay-equality, proven byte-for-byte in review-store.test.ts). It folds nothing
// it does not own.

describe('ReviewProjector.handles', () => {
  const projector = new ReviewProjector();

  it('owns the reviews read-model table', () => {
    expect(projector.name).toBe('reviews');
  });

  it('handles all five L5 review/merge event types', () => {
    for (const type of [
      EVENT_REVIEW_REQUESTED,
      EVENT_REVIEW_VERDICT,
      EVENT_REVIEW_STRIKE,
      EVENT_MERGE_SERIALIZED,
      EVENT_REVIEW_OVERRIDE,
    ]) {
      expect(projector.handles(type)).toBe(true);
    }
  });

  it('does not handle foreign event types (mail / worktree / config)', () => {
    for (const type of ['mail.delivered', 'worktree.created', 'finish.recorded', 'config.set']) {
      expect(projector.handles(type)).toBe(false);
    }
  });
});
