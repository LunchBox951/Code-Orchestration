/**
 * #7 §5 #16/#17 — renderer HTML-escaping hardening. The renderer module has DOM/IPC import
 * side-effects, so (matching renderer-accessibility.test.ts) these assert against the source text:
 *   #16 — esc() must also encode the single quote (single-quoted-attribute safety).
 *   #17 — sourceMessage() must escape its interpolated args before innerHTML, not pass them raw.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(join(here, 'renderer.ts'), 'utf8');

describe('renderer HTML escaping (#7 §5 #16/#17)', () => {
  it('esc() encodes all five HTML-significant characters, including the single quote (#16)', () => {
    expect(rendererSource).toContain(".replace(/&/g, '&amp;')");
    expect(rendererSource).toContain(".replace(/</g, '&lt;')");
    expect(rendererSource).toContain(".replace(/>/g, '&gt;')");
    expect(rendererSource).toContain(".replace(/\"/g, '&quot;')");
    expect(rendererSource).toContain(".replace(/'/g, '&#39;')");
  });

  it('sourceMessage() escapes its interpolated args before innerHTML (#17)', () => {
    expect(rendererSource).toContain('<span class="glyph">${esc(glyph)}</span>');
    expect(rendererSource).toContain('<span class="lead">${esc(lead)}</span>');
    expect(rendererSource).toContain('<span class="sub">${esc(sub)}</span>');
    // The pre-fix raw interpolations must be gone.
    expect(rendererSource).not.toContain('<span class="glyph">${glyph}</span>');
    expect(rendererSource).not.toContain('<span class="lead">${lead}</span>');
    expect(rendererSource).not.toContain('<span class="sub">${sub}</span>');
  });
});
