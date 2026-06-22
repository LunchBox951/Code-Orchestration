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

  it('git-force-push: git push --force-with-lease=<ref> origin feat', () => {
    expect(matchBlock('git push --force-with-lease=refs/heads/main origin feat')?.id).toBe(
      'git-force-push',
    );
  });

  it('git-force-push: git -C repo push --force origin main', () => {
    expect(matchBlock('git -C repo push --force origin main')?.id).toBe('git-force-push');
  });

  it('git-force-push: wrapped/path git push variants', () => {
    expect(matchBlock('env git push --force origin main')?.id).toBe('git-force-push');
    expect(matchBlock('command git push --force origin main')?.id).toBe('git-force-push');
    expect(matchBlock('/usr/bin/git push --force origin main')?.id).toBe('git-force-push');
  });

  it('git-force-push: inline git alias that can expand to push fails closed', () => {
    expect(matchBlock("git -c alias.p='push --force origin main' p")?.id).toBe('git-force-push');
    expect(matchBlock("git -c Alias.p='push --force origin main' p")?.id).toBe('git-force-push');
    expect(matchBlock("git -c alias.P='push --force origin main' P")?.id).toBe('git-force-push');
    expect(
      matchBlock(
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0="push --force origin main" git p',
      )?.id,
    ).toBe('git-force-push');
    expect(
      matchBlock(
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=ALIAS.p GIT_CONFIG_VALUE_0="push --force origin main" git p',
      )?.id,
    ).toBe('git-force-push');
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

  it('rm-rf-root-or-home: quoted/trailing home targets and root globs', () => {
    expect(matchBlock('rm -rf ~/')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf "$HOME"')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf ~/*')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf ~/.*')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf /*')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf /.*')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf "$HOME"/')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf "$HOME"/*')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf "$HOME"/.*')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf ${HOME}/.??*')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf "/"*')?.id).toBe('rm-rf-root-or-home');
  });

  it('rm-rf-root-or-home: symbolic HOME remains dangerous with runtime variable context', () => {
    const variables = new Map([['HOME', '/home/alice']]);
    expect(matchBlock('rm -rf $HOME', { variables })?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf ${HOME}', { variables })?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf $HOME/*', { variables })?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('HOME=/home/alice; rm -rf $HOME')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf ${HOME:?}')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf ${HOME:?must be set}/*')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('HOME=/home/alice; rm -rf ${HOME:-/tmp}')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('HOME=/home/alice; rm -rf ${HOME-/tmp}')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf ${HOME:-/tmp}', { variables })?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('rm -rf ${HOME:=/tmp}', { variables })?.id).toBe('rm-rf-root-or-home');
  });

  it('raw-git-merge: git merge feature', () => {
    expect(matchBlock('git merge feature')?.id).toBe('raw-git-merge');
  });

  it('raw-git-merge: git -c advice.detachedHead=false merge feature', () => {
    expect(matchBlock('git -c advice.detachedHead=false merge feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('git merge -- --help')?.id).toBe('raw-git-merge');
  });

  it('raw-git-merge: wrapped/path git merge variants', () => {
    expect(matchBlock('env git merge feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('command git merge feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('/usr/bin/git merge feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('nice git merge feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('/usr/lib/git-core/git-merge feature')?.id).toBe('raw-git-merge');
    expect(
      matchBlock(
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.m GIT_CONFIG_VALUE_0="merge feature" git m',
      )?.id,
    ).toBe('raw-git-merge');
  });

  it('raw-git-merge: recovery-only merge commands are permitted', () => {
    expect(matchBlock('git merge --abort')).toBeNull();
    expect(matchBlock('git merge --quit')).toBeNull();
  });

  it('raw-git-merge: git pull can merge into the current branch', () => {
    expect(matchBlock('git pull origin main')?.id).toBe('raw-git-merge');
    expect(matchBlock('git pull . co/feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('git -C repo pull upstream main')?.id).toBe('raw-git-merge');
  });

  it('raw-git-push: git push origin main (non-force)', () => {
    expect(matchBlock('git push origin main')?.id).toBe('raw-git-push');
  });

  it('raw-git-push: help-only forms are not publishing', () => {
    expect(matchBlock('git push --help')).toBeNull();
    expect(matchBlock('git --help push')).toBeNull();
    expect(matchBlock('git push --force origin -- --help')?.id).toBe('git-force-push');
    expect(matchBlock('git push origin -- -h')?.id).toBe('raw-git-push');
  });

  it('raw-git-push: git -C repo push origin main (non-force)', () => {
    expect(matchBlock('git -C repo push origin main')?.id).toBe('raw-git-push');
  });

  it('raw-git-push: git send-pack can update remote refs directly', () => {
    expect(matchBlock('git send-pack origin HEAD:refs/heads/main')?.id).toBe('raw-git-push');
    expect(matchBlock('git -C repo send-pack origin co/feature:refs/heads/main')?.id).toBe(
      'raw-git-push',
    );
  });

  it('raw-git-push: wrapped/path git push variants', () => {
    expect(matchBlock('env git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('command git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('/usr/bin/git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('/usr/bin/g?t push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('timeout 30 git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('/usr/lib/git-core/git-push origin main')?.id).toBe('raw-git-push');
    expect(
      matchBlock(
        'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0="push origin main" git p',
      )?.id,
    ).toBe('raw-git-push');
  });

  it('raw-git-push: inline git alias that can expand to push fails closed', () => {
    expect(matchBlock("git -c alias.p='push origin main' p")?.id).toBe('raw-git-push');
    expect(matchBlock("git -c Alias.p='push origin main' p")?.id).toBe('raw-git-push');
    expect(matchBlock("git -c alias.P='push origin main' P")?.id).toBe('raw-git-push');
    expect(matchBlock('git -c include.path=/tmp/gitcfg p')?.id).toBe('raw-git-push');
    expect(matchBlock('git -c includeIf.onbranch:main.path=/tmp/gitcfg p')?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('git -c include.path=/tmp/gitcfg status')).toBeNull();
    expect(matchBlock('git config alias.p "push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('git config Alias.p "push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock(`git config alias.x '!git "$@"'; git x push origin main`)?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock("git config alias.x '!git $*'; git x push origin main")?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('GIT_CONFIG_GLOBAL=/tmp/gitcfg git x push origin main')?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('HOME=/tmp/evil git x push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('XDG_CONFIG_HOME=/tmp/evil git x push origin main')?.id).toBe('raw-git-push');
    expect(
      matchBlock(
        'env -u HOME GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin main',
      )?.id,
    ).toBe('raw-git-push');
    expect(
      matchBlock(
        'env -S "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p origin main"',
      )?.id,
    ).toBe('raw-git-push');
    expect(matchBlock(`GIT_CONFIG_PARAMETERS="'alias.p=push'" git p origin main`)?.id).toBe(
      'raw-git-push',
    );
  });

  it('raw-gh-pr-merge: gh pr merge 5', () => {
    expect(matchBlock('gh pr merge 5')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh pr create --fill')?.id).toBe('raw-gh-pr-merge');
  });

  it('raw-gh-pr-merge: help-only forms are not publishing', () => {
    expect(matchBlock('gh pr merge --help')).toBeNull();
    expect(matchBlock('gh --help pr merge 18')).toBeNull();
  });

  it('raw-gh-pr-merge: gh -R owner/repo pr merge 5', () => {
    expect(matchBlock('gh -R owner/repo pr merge 5')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh -R owner/repo pr create --fill')?.id).toBe('raw-gh-pr-merge');
  });

  it('raw-gh-pr-merge: gh pr merge with interleaved repo flags', () => {
    expect(matchBlock('gh pr --repo owner/repo merge 5')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh pr -R owner/repo merge 5')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh pr --repo owner/repo create --fill')?.id).toBe('raw-gh-pr-merge');
  });

  it('raw-gh-pr-merge: gh api can create or merge pull requests directly', () => {
    expect(matchBlock('gh api repos/owner/repo/pulls/18/merge --method PUT')?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(matchBlock('gh api /repos/owner/repo/pulls --method POST -f head=co/x')?.id).toBe(
      'raw-gh-pr-merge',
    );
  });

  it('raw-gh-pr-merge: gh api graphql publishing mutations bypass the gate (#64)', () => {
    expect(
      matchBlock(
        `gh api graphql -f query='mutation{ mergePullRequest(input:{pullRequestId:"x"}){clientMutationId} }'`,
      )?.id,
    ).toBe('raw-gh-pr-merge');
    expect(
      matchBlock(
        `gh api graphql -f query='mutation{ createPullRequest(input:{repositoryId:"x"}){pullRequest{id}} }'`,
      )?.id,
    ).toBe('raw-gh-pr-merge');
    expect(
      matchBlock(
        `gh api graphql --raw-field query='mutation{ enablePullRequestAutoMerge(input:{pullRequestId:"x"}){clientMutationId} }'`,
      )?.id,
    ).toBe('raw-gh-pr-merge');
    // interleaved repo/host flags must not let the mutation slip past
    expect(
      matchBlock(
        `gh -R owner/repo api graphql -F query='mutation{ mergePullRequest(input:{pullRequestId:"x"}){clientMutationId} }'`,
      )?.id,
    ).toBe('raw-gh-pr-merge');
  });

  it('raw-gh-pr-merge: gh api graphql read-only queries stay permitted (#64)', () => {
    expect(matchBlock(`gh api graphql -f query='query{ viewer{ login } }'`)).toBeNull();
    expect(matchBlock(`gh api graphql -f query='{ repository(owner:"o",name:"r"){ id } }'`)).toBeNull();
  });

  it('raw-gh-pr-merge: gh api repos/.../pulls implicit POST via field flags (#64)', () => {
    // gh auto-POSTs when -f/-F/--field/--raw-field/--input are present, even without -X POST.
    expect(matchBlock('gh api repos/owner/repo/pulls -f title=x -f head=co/x -f base=dev')?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(matchBlock('gh api /repos/owner/repo/pulls -F title=x')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh api repos/owner/repo/pulls --field title=x')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh api repos/owner/repo/pulls --raw-field title=x')?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(matchBlock('gh api repos/owner/repo/pulls --input body.json')?.id).toBe(
      'raw-gh-pr-merge',
    );
    // a bare GET (no body fields) on the collection is read-only and stays permitted
    expect(matchBlock('gh api repos/owner/repo/pulls')).toBeNull();
  });

  it('raw-gh-pr-merge: Codex block-list parity with the Claude `gh api` deny for publish vectors (#64)', () => {
    // The Claude pane denies all of these via the blanket `Bash(gh api*)` pattern; the Codex
    // surface (matchBlock) must block the same publishing vectors so enforcement is equivalent.
    const publishVectors = [
      `gh api graphql -f query='mutation{ mergePullRequest(input:{pullRequestId:"x"}){clientMutationId} }'`,
      `gh api graphql -f query='mutation{ createPullRequest(input:{repositoryId:"x"}){pullRequest{id}} }'`,
      `gh api graphql -f query='mutation{ enablePullRequestAutoMerge(input:{pullRequestId:"x"}){clientMutationId} }'`,
      'gh api repos/owner/repo/pulls -f title=x -f head=co/x -f base=dev',
      'gh api repos/owner/repo/pulls/18/merge --method PUT',
    ];
    for (const vector of publishVectors) {
      expect(matchBlock(vector)?.id, vector).toBe('raw-gh-pr-merge');
    }
  });

  it('raw-gh-pr-merge: wrapped/path gh pr merge variants', () => {
    expect(matchBlock('env gh pr merge 5')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('env gh pr create --fill')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('command gh pr merge 5')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('/usr/bin/gh pr merge 5')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('setsid gh pr merge 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh alias set pm "pr merge"; gh pm 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh alias set pc "pr create --fill"; gh pc')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh alias set gp "!git push origin main"; gh gp')?.id).toBe('raw-git-push');
    expect(matchBlock('gh alias set gp "!git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('GH_CONFIG_DIR=/tmp/evil gh pm 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('HOME=/tmp/evil gh pm 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh alias set --shell gp "git push origin main"; gh gp')?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('gh alias set gp "git push origin main" --shell; gh gp')?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('gh alias set gp "git push origin main" --shell=true; gh gp')?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('gh alias set -s pm "gh pr merge 18"; gh pm')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock("printf 'pm: pr merge\\n' | gh alias import -; gh pm 18")?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(matchBlock('gh alias import - <<EOF\npm: pr merge\nEOF\ngh pm 18')?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(matchBlock('gh alias import - <<EOF\npm: |\n  pr merge\nEOF\ngh pm 18')?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(
      matchBlock("printf 'gp: |\\n  !git push origin main\\n' | gh alias import -; gh gp")?.id,
    ).toBe('raw-git-push');
    expect(matchBlock("printf '{pm: pr merge}\\n' | gh alias import -; gh pm 18")?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(matchBlock("printf 'pm: !!str pr merge\\n' | gh alias import -; gh pm 18")?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(matchBlock('cat <<EOF | gh alias import -\npm: pr merge\nEOF\ngh pm 18')?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(matchBlock("gh alias import - < <(printf 'pm: pr merge\\n'); gh pm 18")?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(matchBlock("gh alias import - <<< 'pm: pr merge'; gh pm 18")?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(matchBlock('cat <<OUT\ngh alias import - <<EOF\npm: pr merge\nEOF\nOUT')).toBeNull();
  });

  it('co-in-shell: co sling --topic foo', () => {
    expect(matchBlock('co sling --topic foo')?.id).toBe('co-in-shell');
  });

  it('co-in-shell: co --config /tmp/co.yaml sling --topic foo', () => {
    expect(matchBlock('co --config /tmp/co.yaml sling --topic foo')?.id).toBe('co-in-shell');
  });

  it('daemon-direct: co run', () => {
    expect(matchBlock('co run')?.id).toBe('daemon-direct');
  });

  it('daemon-direct: co --config /tmp/co.yaml run', () => {
    expect(matchBlock('co --config /tmp/co.yaml run')?.id).toBe('daemon-direct');
  });

  it('co-in-shell and daemon-direct: wrapped/path co variants', () => {
    expect(matchBlock('co')?.id).toBe('co-in-shell');
    expect(matchBlock('co --help')?.id).toBe('co-in-shell');
    expect(matchBlock('co --version')?.id).toBe('co-in-shell');
    expect(matchBlock('env co sling --topic foo')?.id).toBe('co-in-shell');
    expect(matchBlock('command co run')?.id).toBe('daemon-direct');
    expect(matchBlock('/usr/local/bin/co run')?.id).toBe('daemon-direct');
    expect(matchBlock('stdbuf -oL co run')?.id).toBe('daemon-direct');
    expect(matchBlock('node packages/cli/dist/index.js sling --dry-run')?.id).toBe('co-in-shell');
    expect(matchBlock('node --enable-source-maps packages/cli/dist/index.js run')?.id).toBe(
      'daemon-direct',
    );
    expect(matchBlock('node -- packages/cli/dist/index.js run')?.id).toBe('daemon-direct');
    expect(matchBlock('node --trace-warnings packages/cli/dist/index.js sling --dry-run')?.id).toBe(
      'co-in-shell',
    );
    expect(matchBlock('node --env-file /dev/null packages/cli/dist/index.js run')?.id).toBe(
      'daemon-direct',
    );
    expect(matchBlock('node --conditions development packages/cli/dist/index.js run')?.id).toBe(
      'daemon-direct',
    );
    expect(
      matchBlock('node --experimental-loader ts-node packages/cli/dist/index.js run')?.id,
    ).toBe('daemon-direct');
    expect(matchBlock('node -C development packages/cli/dist/index.js run')?.id).toBe(
      'daemon-direct',
    );
    expect(matchBlock('pnpm node packages/cli/dist/index.js run')?.id).toBe('daemon-direct');
    expect(matchBlock('pnpm node ./packages/cli/dist/index.js sling --dry-run')?.id).toBe(
      'co-in-shell',
    );
    expect(matchBlock('pnpm exec co sling --dry-run')?.id).toBe('co-in-shell');
    expect(matchBlock('pnpm exec -- co run')?.id).toBe('daemon-direct');
    expect(matchBlock('pnpm -c exec "git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('pnpm --shell-mode "git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('pnpm --shell-mode "gh pr merge 18"')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('pnpm --filter @co/cli exec co sling --dry-run')?.id).toBe('co-in-shell');
    expect(matchBlock('npm exec -- git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('npm exec --call="git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('npm exec co run')?.id).toBe('daemon-direct');
    expect(matchBlock('npx --no-install co run')?.id).toBe('daemon-direct');
    expect(matchBlock('npx --yes gh pr merge 18')?.id).toBe('raw-gh-pr-merge');
  });

  it('blocks commands whose names are shell ANSI-C or locale quoted', () => {
    expect(matchBlock("git $'push' origin main")?.id).toBe('raw-git-push');
    expect(matchBlock("git $'pu\\163h' origin main")?.id).toBe('raw-git-push');
    expect(matchBlock("git $'merge' feature")?.id).toBe('raw-git-merge');
    expect(matchBlock("gh $'pr' merge 18")?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock("co $'run'")?.id).toBe('daemon-direct');
    expect(matchBlock("$'sudo' apt install foo")?.id).toBe('sudo');
    expect(matchBlock("$'su\\144o' apt install foo")?.id).toBe('sudo');
    expect(matchBlock("rm -rf $'\\057'")?.id).toBe('rm-rf-root-or-home');
  });

  it('blocks commands hidden behind shell control operators', () => {
    expect(matchBlock('git status && git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('true; gh pr merge 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('printf ok || co run')?.id).toBe('daemon-direct');
    expect(matchBlock('git status | git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('true | gh pr merge 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('printf ok & co run')?.id).toBe('daemon-direct');
    expect(matchBlock('git status\ngit push origin main')?.id).toBe('raw-git-push');
  });

  it('blocks commands hidden behind shell grouping and substitutions', () => {
    expect(matchBlock('(git push origin main)')?.id).toBe('raw-git-push');
    expect(matchBlock('{ git push origin main; }')?.id).toBe('raw-git-push');
    expect(matchBlock('if git push origin main; then true; fi')?.id).toBe('raw-git-push');
    expect(matchBlock('case x in x) git push origin main;; esac')?.id).toBe('raw-git-push');
    expect(matchBlock('case x in x) git merge feature;; esac')?.id).toBe('raw-git-merge');
    expect(matchBlock('case x in x) gh pr merge 18;; esac')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('echo $(gh pr merge 18)')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('echo $(git push origin main; true)')?.id).toBe('raw-git-push');
    expect(matchBlock('echo $(git status && gh pr merge 18)')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('echo $(printf ok | sudo id)')?.id).toBe('sudo');
    expect(matchBlock('echo $(git status\ngit push origin main)')?.id).toBe('raw-git-push');
    expect(matchBlock('printf `co run`')?.id).toBe('daemon-direct');
  });

  it('blocks commands hidden behind shell reserved-word wrappers', () => {
    expect(matchBlock('! git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('coproc git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('for p in push; do git $p origin main; done')?.id).toBe('raw-git-push');
    expect(matchBlock('for m in merge; do gh pr $m 18; done')?.id).toBe('raw-gh-pr-merge');
  });

  it('blocks commands hidden behind shell -c wrappers', () => {
    expect(matchBlock("bash -lc 'git push origin main'")?.id).toBe('raw-git-push');
    expect(matchBlock("bash --norc -c 'git push origin main'")?.id).toBe('raw-git-push');
    expect(matchBlock("sh -c 'gh pr merge 5'")?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock("zsh -c 'sudo apt install foo'")?.id).toBe('sudo');
    expect(matchBlock("fish -c 'gh pr merge 18'")?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('fish --command "git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('fish --command="git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('fish -C "git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock("ksh -c 'git push origin main'")?.id).toBe('raw-git-push');
    expect(matchBlock("bash -lc 'co run'")?.id).toBe('daemon-direct');
    expect(matchBlock("bash -lc '{ co run; }'")?.id).toBe('daemon-direct');
    expect(matchBlock("bash -lc 'true | git push origin main'")?.id).toBe('raw-git-push');
    expect(matchBlock("bash +O extglob -c 'git push origin main'")?.id).toBe('raw-git-push');
    expect(matchBlock("bash +o posix -c 'git push origin main'")?.id).toBe('raw-git-push');
    expect(matchBlock('bash -lc "exec git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('bash -lc "builtin command git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('p=push bash -c "git $p origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('p=pr m=merge bash -c "gh $p $m 18"')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('c=run bash -c "co $c"')?.id).toBe('daemon-direct');
    expect(matchBlock('s=sudo bash -c "$s id"')?.id).toBe('sudo');
    expect(matchBlock("env -- p=push bash -c 'git $p origin main'")?.id).toBe('raw-git-push');
  });

  it('blocks env -S split-string wrappers', () => {
    expect(matchBlock('env -S "git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('env -S"git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('env -iS "git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('env -viS "gh pr merge 18"')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('env -iS "git push --force origin main"')?.id).toBe('git-force-push');
    expect(matchBlock('env --split-string "gh pr merge 5"')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('env --split-string="gh pr merge 5"')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('env --chdir=/tmp git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('env --unset=HOME git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('env -uHOME git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('env -v git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('env -a x gh pr merge 18')?.id).toBe('raw-gh-pr-merge');
  });

  it('blocks transparent wrapper invocations', () => {
    expect(matchBlock('exec git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('exec -cl git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('nohup gh pr merge 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('command -p -- git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('timeout -s TERM 30 git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('nice -10 git push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('time git merge feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('time -p co run')?.id).toBe('daemon-direct');
    expect(matchBlock('stdbuf --output L git push origin main')?.id).toBe('raw-git-push');
  });

  it('blocks shell commands hidden behind git bang aliases', () => {
    expect(matchBlock('git -c alias.p=\'!sh -c "git push origin main"\' p')?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock(`X="!sh -c 'git push origin main'" git --config-env=alias.p=X p`)?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock(`X="push origin main" git --config-env=Alias.p=X p`)?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('git --config-env=alias.p=MISSING p')?.id).toBe('raw-git-push');
    expect(matchBlock('git -c alias.x=\'!git "$@"\' x push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock("git -c alias.p='push origin main' -c alias.q='p' q")?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock("git -c alias.p='push origin main' -c alias.q='!git p' q")?.id).toBe(
      'raw-git-push',
    );
  });

  it('blocks shell commands hidden behind eval, aliases, and functions', () => {
    expect(matchBlock('eval "git push origin main"')?.id).toBe('raw-git-push');
    expect(matchBlock('bash -lc "f(){ git push origin main; }; f"')?.id).toBe('raw-git-push');
    expect(matchBlock('bash -lc "alias gp=\'git push origin main\'; gp"')?.id).toBe('raw-git-push');
    expect(matchBlock("bash -ic $'alias g=git\\ng push origin main'")?.id).toBe('raw-git-push');
    expect(matchBlock("bash -ic $'alias h=gh\\nh pr merge 18'")?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock(`alias gp='git "$@"'; gp push origin main`)?.id).toBe('raw-git-push');
    expect(matchBlock(`alias hp='gh "$@"'; hp pr merge 18`)?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('sh -c \'git "$@"\' _ push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('sh -c \'gh "$@"\' _ pr merge 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gp(){ git "$@"; }; gp push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('gp() ( git "$@" ); gp push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('gm(){ git "$@"; }; gm merge feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('hp(){ gh "$@"; }; hp pr merge 18')?.id).toBe('raw-gh-pr-merge');
  });

  it('blocks shell wrappers fed by literal stdin forms', () => {
    expect(matchBlock("printf 'git push origin main' | sh")?.id).toBe('raw-git-push');
    expect(matchBlock("printf 'git\\040push origin main' | sh")?.id).toBe('raw-git-push');
    expect(matchBlock("printf 'git %s origin main\\n' push | sh")?.id).toBe('raw-git-push');
    expect(matchBlock("printf 'gh\\040pr merge 18' | sh")?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock("printf 'gh pr %s 18\\n' merge | sh")?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock("bash <<< 'gh pr merge 18'")?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock("bash<<<'git push origin main'")?.id).toBe('raw-git-push');
    expect(matchBlock("sh<<<'gh pr merge 18'")?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('printf push | xargs git')?.id).toBe('raw-git-push');
    expect(matchBlock("printf 'pr merge 18' | xargs gh")?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock("printf 'git push origin main' | cat | sh")?.id).toBe('raw-git-push');
    expect(matchBlock("printf 'git push origin main' | env bash")?.id).toBe('raw-git-push');
    expect(matchBlock("bash -s <<< 'git push origin main'")?.id).toBe('raw-git-push');
    expect(matchBlock('cat <<EOF | env bash\ngit push origin main\nEOF')?.id).toBe('raw-git-push');
    expect(matchBlock("printf 'git push origin main | cat' | sh")?.id).toBe('raw-git-push');
    expect(matchBlock('printf push | xargs -I{} git {} origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('printf merge | xargs -I{} gh pr {} 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('printf push | xargs -i git {} origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('printf merge | xargs -iX gh pr X 18')?.id).toBe('raw-gh-pr-merge');
  });

  it('blocks shell commands hidden behind simple command variable indirection', () => {
    expect(matchBlock('g=git; $g push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('g=git; ${g} merge feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('g=gh; $g pr merge 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('c=co; $c run')?.id).toBe('daemon-direct');
    expect(matchBlock('g=gi; ${g}t push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('p=push; git $p origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('m=merge; git $m feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('p=pr; m=merge; gh $p $m 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('c=c; ${c}o run')?.id).toBe('daemon-direct');
    expect(matchBlock('git${IFS}push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('gh${IFS}pr${IFS}merge 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('IFS=,; X=git,push; $X origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('IFS=,; X=gh,pr,merge; $X 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('IFS=,; X=co,run; $X')?.id).toBe('daemon-direct');
  });

  it('does not split quoted variable values into protected argv positions', () => {
    expect(matchBlock('p="push origin main"; git "$p"')).toBeNull();
    expect(matchBlock('p="pr merge"; gh "$p" 18')).toBeNull();
    expect(matchBlock('p="co run"; "$p"')).toBeNull();
  });

  it('blocks shell parameter defaults and brace expansion in protected command positions', () => {
    expect(matchBlock('git ${x:-push} origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('gh pr ${x:-merge} 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('p=1; git ${p:+push} origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('p=push; git ${p:?missing} origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('p=push; git ${p:0:4} origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('p=xxpush; git ${p#xx} origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('p=pushx; git ${p%x} origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('m=1; gh pr ${m:+merge} 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('s=sudo; ${s:?missing} id')?.id).toBe('sudo');
    expect(matchBlock('h=HOME; rm -rf ${!h}')?.id).toBe('rm-rf-root-or-home');
    expect(matchBlock('git {pu,}sh origin main')?.id).toBe('raw-git-push');
  });

  it('blocks commands hidden behind exported shell variable declarations', () => {
    expect(matchBlock('export p=push; git $p origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('declare m=merge; git $m feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('typeset p=pr m=merge; gh $p $m 18')?.id).toBe('raw-gh-pr-merge');
  });

  it('can evaluate injected persisted git and gh aliases supplied by the enforcement hook', () => {
    expect(matchBlock('git p', { gitAliases: new Map([['p', 'push origin main']]) })?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('git P', { gitAliases: new Map([['P', 'push origin main']]) })?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('git m feature', { gitAliases: new Map([['m', 'merge']]) })?.id).toBe(
      'raw-git-merge',
    );
    expect(matchBlock('gh pm 18', { ghAliases: new Map([['pm', 'pr merge']]) })?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(
      matchBlock('gh pr m', { ghAliases: new Map([['pr m', '!git push origin main']]) })?.id,
    ).toBe('raw-git-push');
  });

  it('fails closed when command substitutions synthesize protected command positions', () => {
    expect(matchBlock('git $(printf push) origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('$(printf git) push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('gh pr $(printf merge) 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('$(printf sudo) id')?.id).toBe('sudo');
    expect(matchBlock('git $(cat /tmp/subcmd) origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('gh $(cat /tmp/pr) merge 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh $(cat /tmp/pr-merge) 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh $(cat /tmp/pr) create --fill')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh $(cat /tmp/pr-create) --fill')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock("gh alias set pm '!gh $(cat /tmp/pr-merge) 18'; gh pm")?.id).toBe(
      'raw-gh-pr-merge',
    );
    expect(matchBlock('$(cat /tmp/cmd) push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('$(cat /tmp/cmd) origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('$(cat /tmp/gitbin) merge feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('$(cat /tmp/gitpush) --force origin main')?.id).toBe('git-force-push');
    expect(matchBlock('$(cat /tmp/gh-pr-merge) 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('gh pr $(cat /tmp/subcmd) 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('$(which echo) hello')).toBeNull();
    expect(matchBlock("$(which sed) -n '1p'")).toBeNull();
    expect(matchBlock('$(command -v echo) --help')).toBeNull();
    expect(matchBlock('$(which echo) origin main')).toBeNull();
    expect(matchBlock('$(which echo) push origin main')).toBeNull();
  });

  it('fails closed when shell variables carry command substitutions into protected positions', () => {
    expect(matchBlock('P="$(cat /tmp/subcmd)"; git $P origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('M=$(cat /tmp/subcmd); gh pr $M 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('G="$(cat /tmp/cmd)"; $G push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('G=`cat /tmp/cmd`; $G push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('G=$(cat /tmp/gitbin); $G merge feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('G=$(cat /tmp/gitpush); $G --force-with-lease origin main')?.id).toBe(
      'git-force-push',
    );
    expect(matchBlock('CMD=$(which echo); $CMD origin main')).toBeNull();
    expect(matchBlock('CMD=$(which echo); $CMD push origin main')).toBeNull();
    expect(matchBlock('CMD=$(which echo); $CMD merge feature')).toBeNull();
    expect(matchBlock('CMD=$(which echo); $CMD pr merge 18')).toBeNull();
  });

  it('blocks commands and subcommands split by shell line continuations', () => {
    expect(matchBlock('git pu\\\nsh origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('git mer\\\nge feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('gh pr mer\\\nge 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('co r\\\nun')?.id).toBe('daemon-direct');
    expect(matchBlock('su\\\ndo id')?.id).toBe('sudo');
  });

  it('blocks commands with attached shell redirections', () => {
    expect(matchBlock('git push>/tmp/out origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('git merge>/tmp/out feature')?.id).toBe('raw-git-merge');
    expect(matchBlock('git>/tmp/out push origin main')?.id).toBe('raw-git-push');
  });

  it('does not hide later commands after heredoc delimiters with punctuation', () => {
    expect(matchBlock('cat <<END-MARKER\ndata\nEND-MARKER\ngit push origin main')?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('cat <<END.MARKER\ndata\nEND.MARKER\ngh pr merge 18')?.id).toBe(
      'raw-gh-pr-merge',
    );
  });

  it('honors tab-stripped <<- heredoc terminators before later commands', () => {
    expect(matchBlock('cat <<-EOF\ndata\n\tEOF\ngit push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('bash <<-EOF\ngit push origin main\n\tEOF')?.id).toBe('raw-git-push');
  });

  it('keeps heredoc bodies executed by source /dev/stdin', () => {
    expect(matchBlock('source /dev/stdin <<EOF\ngit push origin main\nEOF')?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('. /dev/stdin <<EOF\ngh pr merge 18\nEOF')?.id).toBe('raw-gh-pr-merge');
  });

  it('carries literal command substitutions assigned into protected command positions', () => {
    expect(matchBlock('P=$(printf push); git $P origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('G=$(printf git); $G push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('M=$(printf merge); gh pr $M 18')?.id).toBe('raw-gh-pr-merge');
    expect(matchBlock('P="$(printf push)"; git $P origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('G="$(printf git)"; $G push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('M="$(printf merge)"; gh pr $M 18')?.id).toBe('raw-gh-pr-merge');
  });

  it('blocks literal stdin routed through transparent shell stream wrappers', () => {
    expect(matchBlock('cat <<< "git push origin main" | sh')?.id).toBe('raw-git-push');
    expect(matchBlock('sh < <(printf "git push origin main")')?.id).toBe('raw-git-push');
    expect(matchBlock('bash <(printf "git push origin main")')?.id).toBe('raw-git-push');
    expect(matchBlock('bash <(cat <<< "git push origin main")')?.id).toBe('raw-git-push');
    expect(matchBlock('source <(printf "git push origin main")')?.id).toBe('raw-git-push');
    expect(matchBlock('. <(printf "git push origin main")')?.id).toBe('raw-git-push');
    expect(matchBlock('bash <(printf "git push origin main") ignored-arg')?.id).toBe(
      'raw-git-push',
    );
    expect(matchBlock('source <(printf "git push origin main") ignored-arg')?.id).toBe(
      'raw-git-push',
    );
  });

  it('still evaluates commands after shell comments on later lines', () => {
    expect(matchBlock('git status # safe comment\ngit push origin main')?.id).toBe('raw-git-push');
    expect(matchBlock('echo ok # <<EOF\ngit push origin main\nEOF')?.id).toBe('raw-git-push');
  });
});

describe('matchBlock — non-listed commands are NOT blocked (AC-L6a-6)', () => {
  it('git status returns null', () => {
    expect(matchBlock('git status')).toBeNull();
    expect(matchBlock('git "$(printf status)"')).toBeNull();
    expect(matchBlock('git status # ; git push origin main')).toBeNull();
    expect(matchBlock('echo ok # $(git push origin main)')).toBeNull();
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

  it('read-only git config alias queries return null', () => {
    expect(matchBlock('git config --get alias.p "push origin main"')).toBeNull();
    expect(matchBlock('git config --get-all alias.p')).toBeNull();
    expect(matchBlock('git config --get-regexp "^alias\\."')).toBeNull();
    expect(matchBlock('git config --list')).toBeNull();
  });

  it('shell script invocation with a later -c argument returns null', () => {
    expect(matchBlock("bash ./script -c 'git push origin main'")).toBeNull();
  });

  it('shell -s treats a process substitution as an argument rather than the script file', () => {
    expect(matchBlock('bash -s <(printf "git push origin main")')).toBeNull();
  });

  it('shell rcfile options treat a process substitution as option data, not the script file', () => {
    expect(matchBlock('bash --rcfile <(printf "git push origin main")')).toBeNull();
    expect(matchBlock('bash --init-file <(printf "git push origin main")')).toBeNull();
    expect(matchBlock('bash -O <(printf "git push origin main")')).toBeNull();
  });

  it('non-shell heredoc bodies are data, not commands', () => {
    expect(matchBlock('cat <<EOF\ngit push origin main\nEOF')).toBeNull();
  });
});
