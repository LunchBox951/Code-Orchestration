import { describe, expect, it } from 'vitest';
import { BLOCK_LIST, matchBlock } from './block-list.js';

describe('BLOCK_LIST', () => {
  it('contains exactly the 8 declared ids (AC-L6a-6)', () => {
    const ids = BLOCK_LIST.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'git-force-push',
        'rm-rf-root-or-home',
        'sudo',
        'daemon-direct',
        'raw-git-merge',
        'raw-git-push',
        'raw-gh-pr-merge',
        'co-in-shell',
      ]),
    );
    expect(ids).toHaveLength(8);
  });
});

describe('matchBlock — blocked commands', () => {
  it('git-force-push: git push --force origin main', () => {
    expect(matchBlock('git push --force origin main')?.id).toBe('git-force-push');
  });

  it('git-force-push: git push -f', () => {
    expect(matchBlock('git push -f')?.id).toBe('git-force-push');
  });

  it('git-force-push: git push --force-with-lease origin feat', () => {
    expect(matchBlock('git push --force-with-lease origin feat')?.id).toBe('git-force-push');
  });

  it('sudo: sudo apt install foo', () => {
    expect(matchBlock('sudo apt install foo')?.id).toBe('sudo');
  });

  it('rm-rf-root-or-home: rm -rf /', () => {
    expect(matchBlock('rm -rf /')?.id).toBe('rm-rf-root-or-home');
  });

  it('rm-rf-root-or-home: rm -rf ~', () => {
    expect(matchBlock('rm -rf ~')?.id).toBe('rm-rf-root-or-home');
  });

  it('rm-rf-root-or-home: rm -rf $HOME', () => {
    expect(matchBlock('rm -rf $HOME')?.id).toBe('rm-rf-root-or-home');
  });

  it('raw-git-merge: git merge feature', () => {
    expect(matchBlock('git merge feature')?.id).toBe('raw-git-merge');
  });

  it('raw-git-push: git push origin main (non-force)', () => {
    expect(matchBlock('git push origin main')?.id).toBe('raw-git-push');
  });

  it('raw-gh-pr-merge: gh pr merge 5', () => {
    expect(matchBlock('gh pr merge 5')?.id).toBe('raw-gh-pr-merge');
  });

  it('co-in-shell: co sling --topic foo', () => {
    expect(matchBlock('co sling --topic foo')?.id).toBe('co-in-shell');
  });

  it('daemon-direct: co run', () => {
    expect(matchBlock('co run')?.id).toBe('daemon-direct');
  });
});

describe('matchBlock — non-listed commands are NOT blocked (AC-L6a-6)', () => {
  it('git status returns null', () => {
    expect(matchBlock('git status')).toBeNull();
  });

  it('git commit -s -m x returns null', () => {
    expect(matchBlock('git commit -s -m x')).toBeNull();
  });

  it('rm -rf ./build returns null (not root/home)', () => {
    expect(matchBlock('rm -rf ./build')).toBeNull();
  });

  it('pnpm test returns null', () => {
    expect(matchBlock('pnpm test')).toBeNull();
  });

  it('ls returns null', () => {
    expect(matchBlock('ls')).toBeNull();
  });

  it('git add . returns null', () => {
    expect(matchBlock('git add .')).toBeNull();
  });

  it('git log --oneline returns null', () => {
    expect(matchBlock('git log --oneline')).toBeNull();
  });
});
