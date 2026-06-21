import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('multi-coordinator design acceptance ladder', () => {
  it('documents each local task label and maps the work back to v1 criteria', () => {
    const spec = readFileSync(
      join(process.cwd(), 'docs', 'superpowers', 'specs', '2026-06-20-multi-coordinator-design.md'),
      'utf8',
    );

    expect(spec).toContain('## 7. Local acceptance criteria ladder');
    for (const id of [
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'A6',
      'B1',
      'B2',
      'B3',
      'B4',
      'B5',
      'C1',
      'C2',
      'C3',
      'C4',
      'C5',
    ]) {
      expect(spec).toContain(`\`${id}\``);
    }
    for (const id of ['SH-1', 'SH-2', 'SF-5', 'WT-1', 'WT-3', 'ST-1', 'ST-2', 'ST-3', 'MC-2']) {
      expect(spec).toContain(`\`${id}\``);
    }
  });

  it('describes spec locking as an operator-owned CLI gate until the app lock button ships', () => {
    const quickstart = readFileSync(join(process.cwd(), 'docs', 'alpha-quickstart.md'), 'utf8');

    expect(quickstart).toContain('operator-owned `co spec lock <taskId>` gate');
    expect(quickstart).not.toContain('co_spec_lock` app-surface gap');
  });

  it('documents rewake as mail commit before clearing suppression', () => {
    const spec = readFileSync(
      join(process.cwd(), 'docs', 'superpowers', 'specs', '2026-06-20-multi-coordinator-design.md'),
      'utf8',
    );
    const contract = readFileSync(
      join(process.cwd(), 'packages', 'core', 'src', 'operator-ipc', 'contract.ts'),
      'utf8',
    );

    expect(spec).toContain('Commit the actionable mail before clearing skip flags');
    expect(contract).toContain('post the actionable mail first, then clear suppression state');
    expect(contract).not.toContain('ALWAYS clears suppression first, then posts');
  });

  it('keeps the SH-1 runbook aligned with required coordinator names', () => {
    const runbook = readFileSync(join(process.cwd(), 'docs', 'sh1-runbook.md'), 'utf8');

    expect(runbook).toContain('enter a coordinator name');
  });
});
