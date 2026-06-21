import { describe, it, expect } from 'vitest';
import { isBranchMerged, isWorktreeDirty, snapshotDirtyWorktree } from './branch-state.js';
import type { GitReader } from './detect-base.js';
import type { GitExec } from './sling.js';

describe('branch-state git helpers', () => {
  describe('isBranchMerged', () => {
    it('uses merge-base --is-ancestor exit code (null=not merged, empty string=merged)', () => {
      const fakeGitReader: GitReader = (cwd: string, args: readonly string[]) => {
        if (cwd === '/repo' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
          if (args[2] === 'co/x' && args[3] === 'main') return ''; // exit 0 → merged
          if (args[2] === 'co/y' && args[3] === 'main') return null; // exit 1 → not merged
        }
        return null;
      };

      const merged = isBranchMerged('/repo', 'co/x', 'main', fakeGitReader);
      const notMerged = isBranchMerged('/repo', 'co/y', 'main', fakeGitReader);

      expect(merged).toBe(true);
      expect(notMerged).toBe(false);
    });

    it('returns true when gitReader returns empty string (exit 0)', () => {
      const fakeGitReader: GitReader = () => '';
      expect(isBranchMerged('/repo', 'branch', 'main', fakeGitReader)).toBe(true);
    });

    it('returns false when gitReader returns null (exit 1)', () => {
      const fakeGitReader: GitReader = () => null;
      expect(isBranchMerged('/repo', 'branch', 'main', fakeGitReader)).toBe(false);
    });
  });

  describe('isWorktreeDirty', () => {
    it('is true when status --porcelain has output', () => {
      const fakeGitReader: GitReader = (cwd: string, args: readonly string[]) => {
        if (cwd === '/sbx' && args[0] === 'status' && args[1] === '--porcelain') {
          return ' M file.ts';
        }
        return '';
      };

      expect(isWorktreeDirty('/sbx', fakeGitReader)).toBe(true);
    });

    it('is false when status --porcelain is empty', () => {
      const fakeGitReader: GitReader = (cwd: string, args: readonly string[]) => {
        if (cwd === '/sbx' && args[0] === 'status' && args[1] === '--porcelain') {
          return '';
        }
        return null;
      };

      expect(isWorktreeDirty('/sbx', fakeGitReader)).toBe(false);
    });

    it('is false when status --porcelain returns only whitespace', () => {
      const fakeGitReader: GitReader = () => '   \n  ';
      expect(isWorktreeDirty('/sbx', fakeGitReader)).toBe(false);
    });
  });

  describe('snapshotDirtyWorktree', () => {
    it('runs add -A then commit -s then returns head sha', () => {
      const cmdLog: string[] = [];

      const fakeGitExec: GitExec = (cwd: string, args: readonly string[]) => {
        cmdLog.push(args.join(' '));
        if (cwd !== '/sbx') throw new Error(`Expected cwd /sbx, got ${cwd}`);
      };

      const fakeGitReader: GitReader = (cwd: string, args: readonly string[]) => {
        if (cwd === '/sbx' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return 'abc123def456';
        }
        return null;
      };

      const result = snapshotDirtyWorktree(
        '/sbx',
        'test commit message',
        fakeGitExec,
        fakeGitReader,
      );

      expect(cmdLog).toEqual(['add -A', 'commit -s -m test commit message']);
      expect(result).toBe('abc123def456');
    });

    it('commits with DCO sign-off (-s flag)', () => {
      const cmdLog: string[] = [];

      const fakeGitExec: GitExec = (cwd, args) => {
        cmdLog.push(args.join(' '));
      };

      const fakeGitReader: GitReader = () => 'abc123';

      snapshotDirtyWorktree('/sbx', 'msg', fakeGitExec, fakeGitReader);

      expect(cmdLog[1]).toContain('-s');
      expect(cmdLog[1]).toContain('-m');
    });

    it('trims whitespace from head sha', () => {
      const fakeGitExec: GitExec = () => {};

      const fakeGitReader: GitReader = (cwd: string, args: readonly string[]) => {
        if (args[0] === 'rev-parse') return '  abc123  \n';
        return null;
      };

      const result = snapshotDirtyWorktree('/sbx', 'msg', fakeGitExec, fakeGitReader);

      expect(result).toBe('abc123');
    });
  });
});
