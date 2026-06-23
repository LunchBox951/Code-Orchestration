import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(join(here, 'renderer.ts'), 'utf8');

function sourceBetween(start: string, end: string): string {
  const startIndex = rendererSource.indexOf(start);
  const endIndex = rendererSource.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return rendererSource.slice(startIndex, endIndex);
}

const limitsPopoverSource = sourceBetween('function renderLimitsPopover', '// ── Mission Control');
const usageSource = sourceBetween('function renderUsage', '// ── Settings');

describe('renderer limits and usage labels', () => {
  it('renders display labels instead of raw provider window keys', () => {
    expect(limitsPopoverSource).toContain('${esc(row.displayLabel)}');
    expect(usageSource).toContain('${esc(row.displayLabel)}');
    expect(limitsPopoverSource).not.toContain('${esc(row.windowKind)}');
    expect(usageSource).not.toContain('${esc(row.windowKind)}');
  });

  it('surfaces unknown headroom reasons and avoids provider-specific window copy', () => {
    expect(limitsPopoverSource).toContain('${esc(row.headroom.reason)}');
    expect(usageSource).toContain('row.headroom.reason');
    expect(rendererSource).toContain('paces when session or weekly headroom runs low');
    expect(rendererSource).not.toContain('paces when a 5-hour window runs low');
  });
});
