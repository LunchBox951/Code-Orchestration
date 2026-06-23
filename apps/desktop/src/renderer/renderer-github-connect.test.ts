import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(join(here, 'renderer.ts'), 'utf8');
const preloadSource = readFileSync(join(here, '../preload/preload.cts'), 'utf8');

describe('renderer GitHub Connect wiring', () => {
  it('renders and wires the real GitHub token controls, not only the shared VM helper', () => {
    expect(rendererSource).toContain('id="gh-token-input"');
    expect(rendererSource).toContain("closest('#gh-connect-btn')");
    expect(rendererSource).toContain("closest('#gh-disconnect-btn')");
    expect(rendererSource).toContain('githubConnect(token)');
    expect(rendererSource).toContain('githubDisconnect()');
  });

  it('clears the token input before invoking githubConnect', () => {
    const clickBlock = rendererSource.slice(
      rendererSource.indexOf("closest('#gh-connect-btn')"),
      rendererSource.indexOf("closest('#gh-disconnect-btn')"),
    );
    expect(clickBlock.indexOf("input.value = ''")).toBeLessThan(
      clickBlock.indexOf('githubConnect(token)'),
    );
  });

  it('surfaces unreadable stored credentials in the actual renderer status copy', () => {
    expect(rendererSource).toContain("source === 'stored-unreadable'");
    expect(rendererSource).toContain('GitHub needs attention');
    expect(rendererSource).toContain('cannot be decrypted');
  });

  it('preload exposes GitHub status/connect/disconnect bridge methods', () => {
    expect(preloadSource).toContain('githubStatus()');
    expect(preloadSource).toContain("'github:status'");
    expect(preloadSource).toContain('githubConnect(token: string)');
    expect(preloadSource).toContain("'github:connect'");
    expect(preloadSource).toContain('githubDisconnect()');
    expect(preloadSource).toContain("'github:disconnect'");
  });
});
