# Complete CLI Command Reference

The CLI is reframed as a **human power-user / scripting surface only — not an agent
surface.** It is a thin adapter over the same core the desktop app and the agent MCP
server use (see [MCP-TOOLS](mcp-tools.md)), so it can't drift in logic. Agents are **permission-denied**
from invoking `co` in the shell, which is what prevents the prototype's "CLI fallback
masks MCP gaps" failure from recurring.

The **desktop app is the primary operator surface**; the CLI serves CI, debugging, and
scripting. The concrete verb set is derived once the operator-facing topics are locked
(it will largely mirror the app's actions over the shared core) rather than ported
wholesale from the prototype's table above.
