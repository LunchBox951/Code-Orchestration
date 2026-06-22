/**
 * The single source of truth for the Claude statusLine payload-path env-var NAME — a cross-module
 * contract between the launch config (which SETS it on the pane) and the source reader (which READS the
 * file it points at). A leaf module with NO dispatch dependency so the permissions module can import the
 * name without pulling in dispatch logic.
 */
export const CO_CLAUDE_STATUSLINE_PATH_ENV = 'CO_CLAUDE_STATUSLINE_PATH';
