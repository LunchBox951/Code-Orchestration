import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(here, 'index.ts'), 'utf8');

describe('main GitHub Connect recovery copy', () => {
  it('does not point only at header Retry when automatic Conductor reprovisioning fails', () => {
    expect(mainSource).toContain(
      'GitHub connected, but the Conductor could not restart automatically',
    );
    expect(mainSource).toContain(
      'Reopen the project or restart the app so the Conductor picks up the change.',
    );
    expect(mainSource).not.toContain('Use Retry from the header.');
  });
});
