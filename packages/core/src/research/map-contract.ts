/**
 * L6b H — the codebase-locator map output contract (research.md §"Sub-roles"): a locator answers
 * "what's relevant to X?" with a focused map — **files + a one-line *why* each + key symbols + a
 * suggested read order. Pointers, not a content dump.** This module is the static half of the
 * locator: the structured contract a `researcher:codebase` must return and the validation that
 * rejects content dumps. The live "agent reads a stranger repo and produces the map" needs the
 * hosted session and is L7-coupled (the `SH-4` stranger-repo proof lands with/after L7).
 */
import { z } from 'zod';

/** The one-line budget for an entry's *why* — beyond this it's a dump, not a pointer. */
const WHY_MAX_LENGTH = 200;

/** One pointer in a locator map: a file, why it matters (one line), and its key symbols. */
export const locatorMapEntrySchema = z
  .object({
    path: z.string().min(1).describe('Repo-relative path of the relevant file.'),
    why: z
      .string()
      .min(1)
      .max(WHY_MAX_LENGTH)
      .refine((s) => !/[\r\n]/u.test(s), 'why must be a single line (pointers, not a dump)')
      .describe('One line on why this file is relevant to the question.'),
    symbols: z
      .array(z.string().min(1))
      .describe('Key symbols (functions, classes, constants) to look at in this file.'),
  })
  .strict();
export type LocatorMapEntry = z.infer<typeof locatorMapEntrySchema>;

/** The locator map: the focused, structured answer to "what's relevant to X?". */
export const locatorMapSchema = z
  .object({
    question: z.string().min(1).describe('The scoped question this map answers.'),
    entries: z
      .array(locatorMapEntrySchema)
      .min(1)
      .describe('The relevant files — each with a one-line why and key symbols.'),
    readOrder: z
      .array(z.string().min(1))
      .min(1)
      .describe('Suggested read order over the entry paths.'),
  })
  .strict();
export type LocatorMap = z.infer<typeof locatorMapSchema>;

/** A cited answer — the non-map research result shape (decision/external/diagnostic kinds). */
export const citedAnswerSchema = z
  .object({
    text: z.string().min(1).describe('The focused, clean conclusion — never the search noise.'),
    citations: z
      .array(
        z
          .object({
            source: z.string().min(1).describe('The cited source (path, URL, or document).'),
            detail: z.string().optional().describe('Optional locator within the source.'),
          })
          .strict(),
      )
      .min(1)
      .describe('At least one citation — research is read-only, cited (research.md).'),
  })
  .strict();
export type CitedAnswer = z.infer<typeof citedAnswerSchema>;

export interface LocatorMapViolation {
  readonly reason: string;
}

/**
 * Structural rules a shape-valid map must still satisfy — pure, returns `[]` when green or one
 * violation per failure (mirrors `checkToolCompleteness` / `checkRoleProfileCompleteness`):
 *   (a) every read-order item references an entry path (a read order over ghost files is noise),
 *   (b) entry paths are unique (a duplicated pointer is a dump artifact).
 */
export function checkLocatorMap(map: LocatorMap): LocatorMapViolation[] {
  const violations: LocatorMapViolation[] = [];
  const paths = new Set<string>();
  for (const entry of map.entries) {
    if (paths.has(entry.path)) {
      violations.push({ reason: `duplicate entry path '${entry.path}'` });
    }
    paths.add(entry.path);
  }
  for (const item of map.readOrder) {
    if (!paths.has(item)) {
      violations.push({
        reason:
          `readOrder item '${item}' references no map entry — the read order must point ` +
          'at the entries',
      });
    }
  }
  return violations;
}
