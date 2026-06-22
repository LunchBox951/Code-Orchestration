import { describe, it, expect, afterEach } from 'vitest';
import { chdir, cwd } from 'node:process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { buildCoreRegistry } from './core-registry.js';
import { orientContent } from './orient-content.js';
import { BASE_ROLES } from './scoping.js';

// AC-L2-4: `co_orient` is workflow-only + role-scoped, and `co` never bakes project memory. Two
// assertions, mirroring the GREEN/RED discipline of mail/no-stub.test.ts:
//   (i)  the P5 anti-drift check — orient prose restates NO tool's field list (GREEN over the real
//        content, RED on an injected restatement, so the checker is provably not vacuous);
//   (ii) the prompting split — `orientContent` is a pure function of (role, topic): byte-identical
//        regardless of a `CLAUDE.md` fixture in cwd.

// ── (i) The P5 anti-drift checker, keyed on DISTINCTIVE field identifiers ──────────────────────────
// Single-word input field names are ordinary English, indistinguishable from prose. What survives is
// the DISTINCTIVE set: underscored compounds such as `in_reply_to`. These never occur in natural
// workflow prose, so finding one in orient text IS a tool field-list restatement. Collected LIVE from
// the registry so a new distinctive field is covered for free.

function distinctiveFieldIdentifiers(): string[] {
  const out = new Set<string>();
  for (const spec of buildCoreRegistry().list()) {
    const schema = spec.inputSchema;
    if (schema instanceof z.ZodObject) {
      for (const field of Object.keys(schema.shape)) {
        if (field.includes('_')) out.add(field);
      }
    }
  }
  return [...out];
}

/** The distinctive field identifiers restated in `text` — a field-list restatement. [] ⇒ clean. */
function fieldRestatementsIn(text: string, fields: readonly string[]): string[] {
  return fields.filter((f) => text.includes(f));
}

describe('AC-L2-4 — P5 anti-drift: orient restates no tool field-list (schemas are the syntax source)', () => {
  const distinctive = distinctiveFieldIdentifiers();

  it('is not vacuous — the registry yields distinctive input identifiers dynamically', () => {
    expect(distinctive.length).toBeGreaterThan(0);
    expect(distinctive.every((field) => field.includes('_'))).toBe(true);
    expect(new Set(distinctive).size).toBe(distinctive.length);
  });

  it('GREEN: every base role’s orient content restates none of them', () => {
    for (const role of BASE_ROLES) {
      expect(fieldRestatementsIn(orientContent(role), distinctive)).toEqual([]);
    }
    // …and the generic (no-role) and topic-focused content too.
    expect(fieldRestatementsIn(orientContent(), distinctive)).toEqual([]);
    expect(fieldRestatementsIn(orientContent('implementer', 'finish'), distinctive)).toEqual([]);
  });

  it('RED: the SAME checker flags an injected field-list restatement', () => {
    const [first, second] = [...distinctive].sort();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const drifted = orientContent('implementer') + `\nReply by setting ${first} and ${second}.`;
    const found = fieldRestatementsIn(drifted, distinctive);
    expect(found).toContain(first);
    expect(found).toContain(second);
    // The real content still passes the same checker — only the injected drift is flagged, proving
    // the GREEN above is a real property of the content, not a checker that flags nothing.
    expect(fieldRestatementsIn(orientContent('implementer'), distinctive)).toEqual([]);
  });
});

// ── (ii) The prompting split: orientContent is a pure function of (role, topic) ─────────────────────
describe('AC-L2-4 — the prompting split: orientContent never bakes a target repo’s CLAUDE.md', () => {
  const ORIGINAL_CWD = cwd();
  const tmpDirs: string[] = [];

  afterEach(() => {
    chdir(ORIGINAL_CWD);
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // A throwaway cwd, optionally carrying a stranger repo's CLAUDE.md (temp-dir idiom from mail.test.ts).
  function tempCwd(withClaudeMd: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'co-orient-'));
    tmpDirs.push(dir);
    if (withClaudeMd) {
      writeFileSync(
        join(dir, 'CLAUDE.md'),
        '# Stranger repo\nALWAYS RUN THE FROBNICATE COMMAND BEFORE BUILDING.\n',
      );
    }
    return dir;
  }

  it('is byte-identical with a CLAUDE.md present vs absent in cwd', () => {
    chdir(tempCwd(true));
    const withMemory = orientContent('implementer', 'finish');
    chdir(tempCwd(false));
    const withoutMemory = orientContent('implementer', 'finish');
    expect(withMemory).toBe(withoutMemory);
    // It never absorbed the repo's CLAUDE.md content (the provider auto-loads that, not `co`).
    expect(withMemory).not.toContain('FROBNICATE');
  });

  it('depends only on its args — same (role, topic) ⇒ same output from any cwd', () => {
    chdir(tempCwd(true));
    const a = orientContent('reviewer');
    chdir(tempCwd(false));
    const b = orientContent('reviewer');
    expect(a).toBe(b);
  });

  it('directs agent reviewers to finalize verdicts through the review gate, not mail', () => {
    const text = orientContent('reviewer');

    expect(text).toMatch(/co_review_finalize/);
    expect(text).not.toMatch(/verdict[^.]*by mail/i);
  });
});

// ── role-scoped + workflow-only ────────────────────────────────────────────────────────────────────
describe('AC-L2-4 — orient is role-scoped and workflow-only', () => {
  it('two roles get different, role-appropriate guidance, both teaching coordination-by-mail', () => {
    const impl = orientContent('implementer');
    const rev = orientContent('reviewer');
    expect(impl).not.toBe(rev);
    expect(impl.toLowerCase()).toContain('worktree'); // implementer works in an isolated worktree
    expect(rev.toLowerCase()).toContain('verdict'); // reviewer returns a verdict
    expect(impl.toLowerCase()).toContain('mail'); // both still teach the coordination workflow
    expect(rev.toLowerCase()).toContain('mail');
  });

  it('all five base roles produce distinct content', () => {
    const contents = BASE_ROLES.map((r) => orientContent(r));
    expect(new Set(contents).size).toBe(BASE_ROLES.length);
  });

  it('the coordinator arc NAMES the workflow verbs at each lifecycle step (F4 — drive from orient)', () => {
    const out = orientContent('coordinator');
    for (const verb of [
      'co_spec_draft',
      'co_plan_ingest',
      'co_sling',
      'co_kickback',
      'co_merge',
      'co_push',
      'co_pr_merge',
      'co_phase_update',
      'co_task_complete',
    ]) {
      expect(out, `coordinator orient should name ${verb}`).toContain(verb);
    }
    // The spec LOCK is the operator's surface — orient must say so, not name a self-lock verb.
    expect(out.toLowerCase()).toContain('locked by the operator');
    // Naming verbs must NOT drift into restating their fields (P5 is asserted separately above).
  });

  it('the lead arc NAMES its workflow verbs (F4 — drive every arc from orient, not just coordinator)', () => {
    const out = orientContent('lead');
    for (const verb of [
      'co_sling',
      'co_merge',
      'co_kickback',
      'co_push',
      'co_pr_merge',
      'co_finish',
    ]) {
      expect(out, `lead orient should name ${verb}`).toContain(verb);
    }
    expect(out).toContain('finish only your own phase branch');
    expect(out).not.toContain('You do not finish through the gate yourself');
  });

  it('the implementer arc NAMES co_finish as the verb that advances the gate (F4)', () => {
    const out = orientContent('implementer');
    expect(out).toContain('co_finish');
  });

  it('the researcher arc NAMES co_research_finalize as its record verb (F4)', () => {
    const out = orientContent('researcher');
    expect(out).toContain('co_research_finalize');
  });

  it('the generic (unknown-role) arc stays role-neutral and does not name unavailable tools', () => {
    const out = orientContent();
    expect(out).toContain('completion or finalization path');
    expect(out).not.toContain('co_finish');
  });

  it('reviewer and researcher arcs do not point at co_finish, which they cannot call', () => {
    expect(orientContent('reviewer')).not.toContain('co_finish');
    expect(orientContent('researcher')).not.toContain('co_finish');
    expect(orientContent('reviewer', 'finish')).not.toContain('co_finish');
    expect(orientContent('researcher', 'finish')).not.toContain('co_finish');
    expect(orientContent('reviewer', 'finish')).toContain('completion or finalization verb');
    expect(orientContent('researcher', 'finish')).toContain('completion or finalization verb');
  });

  it('known sub-role input adds the shipped approach while preserving base lifecycle guidance', () => {
    const reviewer = orientContent('reviewer:pr');
    expect(reviewer).toContain('co_review_finalize');
    expect(reviewer).toContain('Sub-role focus (reviewer:pr)');
    expect(reviewer).toContain('PR review');
    expect(reviewer).not.toContain('co_finish');

    const implementer = orientContent('implementer:test');
    expect(implementer).toContain('co_finish');
    expect(implementer).toContain('Sub-role focus (implementer:test)');
    expect(implementer).toContain('test-first');
  });

  it('an unknown role gets generic workflow guidance, not an error (lenient input)', () => {
    const out = orientContent('wizard');
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('wizard'); // the header names what was asked
    expect(out.toLowerCase()).toContain('mail'); // generic coordination guidance
  });

  it('finish topic says finish records and notifies, not that it dispatches review', () => {
    const out = orientContent('implementer', 'finish');
    expect(out).toContain('records the finish');
    expect(out).toContain('notifies your parent');
    expect(out).not.toMatch(/dispatches review/i);
  });

  it('is case/whitespace lenient — a padded, mixed-case role resolves to that role’s arc', () => {
    const padded = orientContent('  Implementer ');
    expect(padded).toContain('change code in your own isolated worktree'); // the implementer arc…
    expect(padded).not.toContain('is the job of the owner above you'); // …NOT the generic fallback
  });
});
