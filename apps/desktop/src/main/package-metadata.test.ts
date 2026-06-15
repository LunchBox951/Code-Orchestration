import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..');
const packageJson = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
};
const builderYaml = readFileSync(join(appRoot, 'electron-builder.yml'), 'utf8');

describe('desktop package metadata', () => {
  it('keeps Electron tooling out of runtime dependencies and package globs', () => {
    expect(packageJson.dependencies?.['electron']).toBeUndefined();
    expect(packageJson.devDependencies?.['electron']).toBeDefined();
    expect(builderYaml).toContain('!node_modules/electron/**');
    expect(builderYaml).toContain('!node_modules/electron-builder/**');
    expect(builderYaml).toContain('!node_modules/.bin/**');
  });
});
