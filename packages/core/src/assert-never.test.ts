import { describe, it, expect } from 'vitest';
import { assertNever } from './assert-never.js';

describe('assertNever', () => {
  it('throws with the unexpected value in the message', () => {
    // @ts-expect-error — deliberately passing a non-never value at runtime
    expect(() => assertNever('surprise')).toThrowError(/unexpected value: "surprise"/);
  });
});
