import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..');
const repoRoot = join(appRoot, '..', '..');
const packageJson = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly files?: readonly string[];
};
const corePackageJson = JSON.parse(
  readFileSync(join(repoRoot, 'packages/core/package.json'), 'utf8'),
) as {
  readonly files?: readonly string[];
};
const mcpPackageJson = JSON.parse(
  readFileSync(join(repoRoot, 'packages/mcp/package.json'), 'utf8'),
) as {
  readonly files?: readonly string[];
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

  it('packages workspace runtime dependencies as built artifacts, not source trees', () => {
    expect(packageJson.files).toEqual(
      expect.arrayContaining(['dist', 'electron-builder.yml', 'package.json']),
    );
    expect(packageJson.files).not.toContain('src');

    expect(corePackageJson.files).toEqual(expect.arrayContaining(['dist', 'package.json']));
    expect(mcpPackageJson.files).toEqual(expect.arrayContaining(['dist', 'package.json']));
    expect(corePackageJson.files).not.toContain('src');
    expect(mcpPackageJson.files).not.toContain('src');

    expect(builderYaml).toContain('!node_modules/@co/*/src/**');
    expect(builderYaml).toContain('!node_modules/@co/*/tsconfig*.json');
    expect(builderYaml).toContain('!node_modules/@co/*/*.tsbuildinfo');
  });
});
