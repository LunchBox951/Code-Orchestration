import { z } from 'zod';

/** One acceptance criterion: a human-readable outcome + the verification command that proves it. */
export const criterionSchema = z
  .object({
    text: z.string().min(1), // the concrete, checkable outcome, e.g. "expired tokens rejected (401)"
    verify: z.string().optional(), // the wired verification command, e.g. "pnpm vitest run packages/core/x"
  })
  .strict();
export type Criterion = z.infer<typeof criterionSchema>;
