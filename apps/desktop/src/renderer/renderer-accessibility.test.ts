import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(join(here, 'renderer.ts'), 'utf8');
const htmlSource = readFileSync(join(here, 'index.html'), 'utf8');
const appShellSource = readFileSync(join(here, '../main/app-shell.ts'), 'utf8');

describe('review view', () => {
  it('review view markup has required structural elements', () => {
    expect(htmlSource).toContain('id="view-review"');
    expect(htmlSource).toContain('aria-label="Pending reviews"');
    expect(htmlSource).toContain('aria-label="Review diff"');
    expect(htmlSource).toContain('id="review-badge"');
  });

  it('renderer wires review bridge methods', () => {
    expect(rendererSource).toContain('bridge.reviewSelect(');
    expect(rendererSource).toContain('bridge.reviewSubmitVerdict(');
    expect(rendererSource).toContain('bridge.reviewBeginVerdict(');
    expect(rendererSource).toContain('bridge.reviewUpdateComposerBody(');
    expect(rendererSource).toContain('bridge.reviewCancelVerdict(');
    expect(rendererSource).toContain('bridge.reviewRefresh(');
  });

  it('review list rows use ARIA option roles', () => {
    expect(rendererSource).toContain('role="option"');
    expect(rendererSource).toContain("aria-selected=\"${isSelected ? 'true' : 'false'}\"");
  });

  it('review view has activate hook', () => {
    expect(rendererSource).toContain("if (view === 'review' && latestReviewState != null)");
    expect(rendererSource).toContain('renderReview(latestReviewState)');
  });

  it('verdict buttons have aria-labels', () => {
    expect(rendererSource).toContain('aria-label="Submit PASS verdict"');
    expect(rendererSource).toContain('aria-label="Submit ISSUES verdict"');
  });

  it('gates the verdict-composer detail rebuild to preserve the caret while typing (review #316)', () => {
    // The detail pane must NOT be unconditionally rebuilt: typing in #review-composer-body would
    // recreate the focused textarea and drop the caret. renderReview gates the rebuild on the pure
    // reviewDetailNeedsRebuild helper, keyed on whether that textarea is focused.
    expect(rendererSource).toContain('reviewDetailNeedsRebuild(');
    expect(rendererSource).toContain("document.activeElement?.id === 'review-composer-body'");
  });

  it('points operator-facing conductor guidance at the shipped co-mcp binary', () => {
    expect(rendererSource).toContain('start \\`co-mcp serve <projectId>\\`');
    expect(appShellSource).toContain('start `co-mcp serve <projectId>`');
    expect(rendererSource).not.toContain('start \\`co serve\\`');
    expect(appShellSource).not.toContain('start `co serve`');
  });

  it('only exposes verdict actions when the Review view has diff and locked criteria evidence', () => {
    expect(rendererSource).toContain(
      "const canSubmitVerdict = diff.kind === 'patch' && criteria.kind === 'criteria';",
    );
    expect(rendererSource).toContain('!composer.active && canSubmitVerdict');
  });
});

describe('agents console', () => {
  it('agents view markup has required structural elements', () => {
    expect(htmlSource).toContain('id="agents-transcript"');
    expect(htmlSource).toContain('aria-label="Agent transcript"');
    expect(htmlSource).toContain('id="agents-roster"');
    expect(htmlSource).toContain('role="listbox"');
    expect(htmlSource).toContain('aria-label="Agents"');
    expect(htmlSource).toContain('id="steer-input"');
    expect(htmlSource).toContain('aria-label="Answer agent"');
    expect(htmlSource).toContain('aria-label="Redirect agent"');
    expect(htmlSource).toContain('aria-label="Interrupt agent"');
  });

  it('renderer wires agents console bridge methods and xterm', () => {
    expect(rendererSource).toContain('bridge.agentsSteer(');
    expect(rendererSource).toContain('bridge.agentsSelect(');
    expect(rendererSource).toContain('window.Terminal');
    expect(rendererSource).toContain('role="option"');
    expect(rendererSource).toContain('aria-selected="${isSelected');
  });

  it('defers xterm open until the Agents view is visible', () => {
    expect(rendererSource).toContain('function isAgentsViewActive()');
    expect(rendererSource).toContain('if (!isAgentsViewActive()) return;');
    expect(rendererSource).toContain("if (view === 'agents' && latestAgentsState != null)");
  });

  it('only enables steer controls for a selected warm live agent', () => {
    expect(rendererSource).toContain("state.selectedStatus === 'warm'");
  });
});

describe('renderer accessibility states', () => {
  it('surfaces active mail tab and bus state with ARIA attributes', () => {
    expect(htmlSource).toContain('role="tablist"');
    expect(htmlSource).toContain('aria-selected="true"');
    expect(htmlSource).toContain('aria-pressed="true"');
    expect(rendererSource).toContain("setAttribute('aria-selected'");
    expect(rendererSource).toContain('aria-pressed');
  });

  it('keeps the limits popover expanded state in sync', () => {
    expect(htmlSource).toContain('aria-controls="limits-popover"');
    expect(htmlSource).toContain('aria-haspopup="dialog"');
    expect(htmlSource).toContain('role="dialog"');
    expect(rendererSource).toContain("setAttribute('aria-expanded', 'true')");
    expect(rendererSource).toContain("setAttribute('aria-expanded', 'false')");
  });

  it('labels the icon-only composer close button', () => {
    expect(rendererSource).toContain('aria-label="Close composer"');
  });

  it('opens non-approval replies against the selected mail recipient inbox', () => {
    const nonApprovalBranch = rendererSource.slice(
      rendererSource.indexOf('} else if (isActionable)'),
    );
    expect(nonApprovalBranch).toContain('data-recipient="${esc(selected.recipient)}"');
    expect(nonApprovalBranch).not.toContain('data-recipient="${esc(selected.sender)}"');
  });

  it('opens review requests as structured review responses', () => {
    expect(rendererSource).toContain('mailType === MAIL_REVIEW_REQUEST ? MAIL_REVIEW_RESPONSE');
    expect(rendererSource).toContain('data-type="${replyType}"');
    expect(rendererSource).toContain("'Submit verdict'");
  });

  it('populates the agent-bus selector from dashboard agents', () => {
    expect(rendererSource).toContain('function rememberMailBuses(state: DashboardState)');
    expect(rendererSource).toContain('knownMailBuses.add(agentId)');
    expect(rendererSource).toContain('if (latestMailState != null) renderMail(latestMailState)');
  });
});
