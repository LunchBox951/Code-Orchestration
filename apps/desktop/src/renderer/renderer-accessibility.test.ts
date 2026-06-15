import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(join(here, 'renderer.ts'), 'utf8');
const htmlSource = readFileSync(join(here, 'index.html'), 'utf8');

describe('agents console', () => {
  it('agents view markup has required structural elements', () => {
    expect(htmlSource).toContain('id="agents-transcript"');
    expect(htmlSource).toContain('aria-label="Agent transcript"');
    expect(htmlSource).toContain('id="agents-roster"');
    expect(htmlSource).toContain('id="steer-input"');
    expect(htmlSource).toContain('aria-label="Answer agent"');
    expect(htmlSource).toContain('aria-label="Redirect agent"');
    expect(htmlSource).toContain('aria-label="Interrupt agent"');
  });

  it('renderer wires agents console bridge methods and xterm', () => {
    expect(rendererSource).toContain('bridge.agentsSteer(');
    expect(rendererSource).toContain('bridge.agentsSelect(');
    expect(rendererSource).toContain('window.Terminal');
    expect(rendererSource).toContain('aria-selected="${isSelected');
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
