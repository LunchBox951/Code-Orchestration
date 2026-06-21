/**
 * Pure helpers for the operator-named coordinator id `coord-<slug>-<6hex>`. DETERMINISM: this module
 * generates NO entropy and reads NO clock — the unique 6-hex suffix is minted by the effectful adapter
 * (packages/mcp) and passed in, so the core start primitive stays replay-stable (Principle: no
 * Math.random / wall-clock in core).
 */

/** Lowercase, collapse non-alphanumerics to single dashes, trim dashes. Empty → 'coordinator'. */
export function slugifyCoordinatorName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'coordinator';
}

/** Compose `coord-<slug(name)>-<hex>`. `hex` is the caller-supplied unique suffix (entropy lives there). */
export function coordinatorIdFromParts(name: string, hex: string): string {
  return `coord-${slugifyCoordinatorName(name)}-${hex}`;
}
