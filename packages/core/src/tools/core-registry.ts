import { createToolRegistry, type ToolRegistry } from './registry.js';
import {
  mailAckTool,
  mailGetTool,
  mailInboxTool,
  mailRetractTool,
  mailSendTool,
  mailThreadTool,
} from './specs/mail.js';
import { statusTool } from './specs/status.js';
import { worktreeInfoTool } from './specs/worktree-info.js';
import { orientTool } from './specs/orient.js';
import { slingTool } from './specs/sling.js';
import { finishTool } from './specs/finish.js';
import { mergeTool } from './specs/merge.js';
import { reviewFinalizeTool } from './specs/review-finalize.js';
import { pushTool } from './specs/push.js';
import { prMergeTool } from './specs/pr-merge.js';
import { kickbackTool } from './specs/kickback.js';
import { specGetTool } from './specs/spec-get.js';
import { specDraftTool } from './specs/spec-draft.js';
import { specLockTool } from './specs/spec-lock.js';
import { specArchiveTool } from './specs/spec-archive.js';
import { planIngestTool } from './specs/plan-ingest.js';
import { phaseStatusTool } from './specs/phase-status.js';
import { phaseUpdateTool } from './specs/phase-update.js';
import { taskCompleteTool } from './specs/task-complete.js';
import { issueCaptureTool } from './specs/issue-capture.js';
import { issueListTool } from './specs/issue-list.js';
import { issueDiagnoseTool } from './specs/issue-diagnose.js';
import { issueFileTool } from './specs/issue-file.js';
import { researchFinalizeTool } from './specs/research-finalize.js';
import { researchGetTool } from './specs/research-get.js';

/**
 * Build the canonical core registry: a fresh {@link ToolRegistry} with every real core tool
 * registered, in a stable order. This is the SINGLE SOURCE OF TRUTH the MCP adapter (B2)
 * mounts, the completeness gate (C) checks, and the role-scoper (D) filters — every real tool
 * is declared exactly once, here. Each spec carries self-describing zod schemas and a handler
 * that dispatches to @co/core (never the `notImplemented` stub).
 *
 * Callers get their OWN instance (no shared mutable singleton), so the MCP mount, a headless
 * test harness, and the gate can each build one independently. Tools are registered one at a
 * time (rather than from a `ToolSpec[]` literal) so each keeps its precise input/output types
 * through the generic `register<I, O>` — collapsing them into one array would erase those types.
 */
export function buildCoreRegistry(): ToolRegistry {
  const registry = createToolRegistry();
  registry.register(mailSendTool);
  registry.register(mailInboxTool);
  registry.register(mailGetTool);
  registry.register(mailThreadTool);
  registry.register(mailAckTool);
  registry.register(mailRetractTool);
  registry.register(statusTool);
  registry.register(worktreeInfoTool);
  registry.register(orientTool);
  registry.register(slingTool);
  registry.register(finishTool);
  registry.register(mergeTool);
  registry.register(reviewFinalizeTool);
  registry.register(pushTool);
  registry.register(prMergeTool);
  registry.register(kickbackTool);
  registry.register(specGetTool);
  registry.register(specDraftTool);
  registry.register(specLockTool);
  registry.register(specArchiveTool);
  registry.register(planIngestTool);
  registry.register(phaseStatusTool);
  registry.register(phaseUpdateTool);
  registry.register(taskCompleteTool);
  registry.register(issueCaptureTool);
  registry.register(issueListTool);
  registry.register(issueDiagnoseTool);
  registry.register(issueFileTool);
  registry.register(researchFinalizeTool);
  registry.register(researchGetTool);
  return registry;
}
