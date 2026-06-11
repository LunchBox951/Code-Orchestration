/**
 * L6b H event definitions for the durable research record. A Researcher does expensive
 * information-gathering in its own context and returns the clean conclusion (research.md); this
 * record makes that conclusion **durable, queryable program-data** — the requester (and any later
 * agent) reads the finalized map/answer instead of re-searching. Lives in the PROJECT store
 * (Principle 12 — pristine-repo).
 *
 * One stream per research request, keyed `research:<researchId>`, with a single event type:
 * `research.finalized`. (Research *dispatch* — spawning the researcher — is the Conductor's job
 * and therefore L7; at L6b only the finalize record exists. The heir to the prototype's
 * `research-report` verb.)
 */
import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';
import {
  citedAnswerSchema,
  locatorMapSchema,
  type CitedAnswer,
  type LocatorMap,
} from './map-contract.js';

/** Current payload schema version — v1; no upcasters yet. */
export const RESEARCH_EVENT_V = 1;

/** A researcher finalized its result (map or cited answer). */
export const EVENT_RESEARCH_FINALIZED = 'research.finalized' as const;

/** Scope prefix for the per-research event stream; suffix is the research id. */
export const RESEARCH_SCOPE_PREFIX = 'research:';

/** The per-research stream scope: `research:<researchId>`. */
export function researchScope(researchId: string): string {
  return RESEARCH_SCOPE_PREFIX + researchId;
}

/** The two research result kinds: a locator map, or a cited answer. */
export const RESEARCH_KINDS = ['map', 'answer'] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

/**
 * The `research.finalized` payload. `kind` discriminates the result: `map` carries a
 * {@link LocatorMap}, `answer` a {@link CitedAnswer} — exactly one is present (enforced).
 */
export const researchFinalizedSchema = z
  .object({
    researchId: z.string().min(1),
    question: z.string().min(1),
    requestedBy: z.string().min(1),
    researcher: z.string().min(1),
    kind: z.enum(RESEARCH_KINDS),
    map: locatorMapSchema.optional(),
    answer: citedAnswerSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.kind === 'map' && (val.map == null || val.answer != null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "kind 'map' requires `map` and forbids `answer`",
      });
    }
    if (val.kind === 'answer' && (val.answer == null || val.map != null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "kind 'answer' requires `answer` and forbids `map`",
      });
    }
  });
export type ResearchFinalized = z.infer<typeof researchFinalizedSchema>;

/** Current-version schema map for research events — validated on append AND on read (decode). */
export const researchSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_RESEARCH_FINALIZED, researchFinalizedSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const researchUpcasters: UpcasterRegistry = new Map();

/** Build + validate a `research.finalized` NewEvent. The researcher is the event `actor`. */
export function makeResearchFinalizedEvent(projectId: string, rec: ResearchFinalized): NewEvent {
  const payload = researchFinalizedSchema.parse(rec);
  return {
    projectId,
    scope: researchScope(payload.researchId),
    type: EVENT_RESEARCH_FINALIZED,
    v: RESEARCH_EVENT_V,
    payload,
    actor: payload.researcher,
  };
}

/**
 * A persisted, read-back research record — the read-model shape the research store facade
 * returns. Timestamps come from `event.ts` on replay (freeze #6 — never wall-clock).
 */
export interface ResearchRecord {
  readonly researchId: string;
  readonly question: string;
  readonly requestedBy: string;
  readonly researcher: string;
  readonly kind: ResearchKind;
  readonly map?: LocatorMap;
  readonly answer?: CitedAnswer;
  readonly finalizedTs: number;
}
